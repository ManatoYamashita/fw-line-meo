import { describe, it, expect, vi } from 'vitest';
import {
  handleOwnerLineUnlink,
  type OwnerLineUnlinkDeps,
  type OwnerLineUnlinkResponse,
} from '../src/owner-line-unlink.js';
import type { AuthDeps } from '../src/auth.js';
import type { UnlinkRichMenuResult } from '../src/line-richmenu.js';
import type {
  AuditLogInput,
  DashboardUserIdentity,
  UnlinkOwnerLineInput,
  UnlinkOwnerLineOutcome,
} from '@fwlm/db';
import type { Sink } from '@fwlm/observability';
import { readJson, type ErrorEnvelope } from './support/json.js';

// POST /owners/:id/unlink の中核ロジックの単体試験（owner-line-unlink Req 1.1–1.3, 1.5, 1.7, 3.1–3.4, 7.1, 7.3）。
// DB は unlinkOwnerLine・clearMenuPending の注入で、LINE はアダプタの注入で置き換える。
// 範囲の決め方（運営は全オーナー・代理店は自代理店）、監査を呼ぶ条件（変化があったときだけ）、
// メニューの結果の 3 値（外した・失敗・不要）と、応答・記録に LINE ユーザー ID が出ないことを固定する。

const OP: DashboardUserIdentity = { id: 'u1', role: 'operator', operatorId: 'op1', agencyId: null };
const AG: DashboardUserIdentity = { id: 'u2', role: 'agency', operatorId: 'op1', agencyId: 'ag1' };

const OWNER_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_OWNER_ID = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const LINE_USER_ID = 'U0123456789abcdef0123456789abcdef';

// authenticate 依存のモック（store-suspension.test.ts と同型）。user=null で未登録、disabled で無効化。
function authDeps(user: DashboardUserIdentity | null, disabled = false): AuthDeps {
  return {
    verifier: {
      verifyIdToken: (t) =>
        Promise.resolve({ uid: `uid-${t}`, email: null, emailVerified: false, signInProvider: null }),
    },
    findUser: () => Promise.resolve(user === null ? null : { ...user, disabled }),
    linkByEmail: () => Promise.resolve(null),
  };
}

type Unlink = (input: UnlinkOwnerLineInput) => Promise<UnlinkOwnerLineOutcome>;
type ClearPending = (input: { ownerId: string; lineUserId: string }) => Promise<void>;
type UnlinkMenu = (lineUserId: string) => Promise<UnlinkRichMenuResult>;

function deps(
  unlink: Unlink,
  options: {
    user?: DashboardUserIdentity | null;
    disabled?: boolean;
    menu?: UnlinkMenu;
    clear?: ClearPending;
  } = {},
) {
  const auditLog = vi.fn<(input: AuditLogInput) => Promise<void>>(() => Promise.resolve());
  const unlinkFn = vi.fn<Unlink>(unlink);
  const clearFn = vi.fn<ClearPending>(options.clear ?? (() => Promise.resolve()));
  const menuFn = vi.fn<UnlinkMenu>(options.menu ?? (() => Promise.resolve({ ok: true })));
  const d: OwnerLineUnlinkDeps = {
    auth: authDeps(options.user === undefined ? OP : options.user, options.disabled ?? false),
    unlinkOwnerLine: unlinkFn,
    clearMenuPending: clearFn,
    lineRichMenu: { unlinkUserRichMenu: menuFn },
    auditLog,
  };
  return { d, unlinkFn, clearFn, menuFn, auditLog };
}

const changedWithMenu: Unlink = (input) =>
  Promise.resolve({ kind: 'changed', ownerId: input.ownerId, menuTarget: LINE_USER_ID });
const changedWithoutMenu: Unlink = (input) =>
  Promise.resolve({ kind: 'changed', ownerId: input.ownerId, menuTarget: null });
const unchangedWithMenu: Unlink = (input) =>
  Promise.resolve({ kind: 'unchanged', ownerId: input.ownerId, menuTarget: LINE_USER_ID });
const unchangedWithoutMenu: Unlink = (input) =>
  Promise.resolve({ kind: 'unchanged', ownerId: input.ownerId, menuTarget: null });
const notFound: Unlink = () => Promise.resolve({ kind: 'not_found' });

const req = (log?: Sink, id: string = OWNER_ID) => ({ authorization: 'Bearer t', id, ...(log ? { log } : {}) });

describe('handleOwnerLineUnlink: 認証', () => {
  it('認証なしは 401（unauthenticated 封筒）で DB も LINE も呼ばない', async () => {
    const { d, unlinkFn, menuFn } = deps(changedWithMenu);
    const res = await handleOwnerLineUnlink(d, { authorization: undefined, id: OWNER_ID });
    expect(res.status).toBe(401);
    expect((await readJson<ErrorEnvelope>(res)).error.code).toBe('unauthenticated');
    expect(unlinkFn).not.toHaveBeenCalled();
    expect(menuFn).not.toHaveBeenCalled();
  });

  it('未登録と無効化済みは同一の 403 封筒で DB も LINE も呼ばない', async () => {
    const unregistered = deps(changedWithMenu, { user: null });
    const disabled = deps(changedWithMenu, { user: AG, disabled: true });
    const r1 = await handleOwnerLineUnlink(unregistered.d, req());
    const r2 = await handleOwnerLineUnlink(disabled.d, req());
    expect(r1.status).toBe(403);
    expect(r2.status).toBe(403);
    const b1 = await readJson<ErrorEnvelope>(r1);
    expect(b1).toEqual(await readJson<ErrorEnvelope>(r2));
    expect(b1.error.code).toBe('forbidden');
    for (const x of [unregistered, disabled]) {
      expect(x.unlinkFn).not.toHaveBeenCalled();
      expect(x.menuFn).not.toHaveBeenCalled();
    }
  });
});

describe('handleOwnerLineUnlink: 範囲', () => {
  it('運営は範囲の制限なし（agencyId=null）で任意のオーナーを解除できる（1.1）', async () => {
    const { d, unlinkFn } = deps(changedWithoutMenu, { user: OP });
    const res = await handleOwnerLineUnlink(d, req());
    expect(res.status).toBe(200);
    expect(unlinkFn).toHaveBeenCalledTimes(1);
    expect(unlinkFn).toHaveBeenCalledWith({ ownerId: OWNER_ID, agencyId: null });
  });

  it('代理店は自代理店の範囲（agencyId=自代理店）でだけ解除を要求する（1.2）', async () => {
    const { d, unlinkFn } = deps(changedWithoutMenu, { user: AG });
    const res = await handleOwnerLineUnlink(d, req());
    expect(res.status).toBe(200);
    expect(unlinkFn).toHaveBeenCalledWith({ ownerId: OWNER_ID, agencyId: 'ag1' });
  });

  it('範囲外・不存在・不正な ID はどれも同じ本文の 404 で、監査も LINE も呼ばない（1.3）', async () => {
    // 範囲外: 他代理店のオーナーは DAL が not_found を返す。不存在も DAL が not_found を返す。
    const outOfScope = deps(notFound, { user: AG });
    const missing = deps(notFound, { user: AG });
    const invalid = deps(changedWithMenu, { user: AG });
    const rOut = await handleOwnerLineUnlink(outOfScope.d, req(undefined, OTHER_OWNER_ID));
    const rMissing = await handleOwnerLineUnlink(missing.d, req());
    const rInvalid = await handleOwnerLineUnlink(invalid.d, req(undefined, 'not-a-uuid'));
    expect([rOut.status, rMissing.status, rInvalid.status]).toEqual([404, 404, 404]);
    const bOut = await rOut.text();
    expect(bOut).toBe(await rMissing.text());
    expect(bOut).toBe(await rInvalid.text());
    expect(JSON.parse(bOut)).toEqual({ error: { code: 'not_found', message: 'オーナーが見つかりません' } });
    // 不正な形式は DAL に到達させない（存在の探り当てを許さない）。
    expect(invalid.unlinkFn).not.toHaveBeenCalled();
    for (const x of [outOfScope, missing, invalid]) {
      expect(x.auditLog).not.toHaveBeenCalled();
      expect(x.menuFn).not.toHaveBeenCalled();
      expect(x.clearFn).not.toHaveBeenCalled();
    }
  });
});

describe('handleOwnerLineUnlink: 解除と監査', () => {
  it('変化したときは owner_line_unlinked を操作者の役割つきで 1 回記録する（7.1）', async () => {
    const { d, auditLog } = deps(changedWithoutMenu, { user: AG });
    await handleOwnerLineUnlink(d, req());
    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith({
      actorType: 'agency',
      actorId: 'u2',
      action: 'owner_line_unlinked',
      targetType: 'owner',
      targetId: OWNER_ID,
    });
  });

  it('監査の対象 ID は要求の表記ではなく DAL が返したオーナーの ID を使う', async () => {
    const { d, auditLog } = deps(
      () => Promise.resolve({ kind: 'changed', ownerId: OWNER_ID, menuTarget: null }),
      { user: OP },
    );
    const res = await handleOwnerLineUnlink(d, req(undefined, OWNER_ID.toUpperCase()));
    expect(res.status).toBe(200);
    expect(auditLog.mock.calls[0]?.[0].targetId).toBe(OWNER_ID);
    expect((await readJson<OwnerLineUnlinkResponse>(res)).owner.id).toBe(OWNER_ID);
  });

  it('既に解除済み（変化なし・印なし）は 200 の not_needed で、監査も LINE も呼ばない（1.5, 7.3）', async () => {
    const { d, auditLog, menuFn, clearFn } = deps(unchangedWithoutMenu, { user: OP });
    const res = await handleOwnerLineUnlink(d, req());
    expect(res.status).toBe(200);
    expect(await readJson<OwnerLineUnlinkResponse>(res)).toEqual({
      owner: { id: OWNER_ID, lineLink: 'unlinked', menuUnlinkPending: false },
      menu: 'not_needed',
    });
    expect(auditLog).not.toHaveBeenCalled();
    expect(menuFn).not.toHaveBeenCalled();
    expect(clearFn).not.toHaveBeenCalled();
  });

  it('監査の失敗は警告を残して握り、成立した解除を 200 で返し、メニューの解除も続ける（Issue #250）', async () => {
    const { d, menuFn } = deps(changedWithMenu, { user: OP });
    d.auditLog = () => Promise.reject(new Error('audit down'));
    const log = vi.fn<Sink>();
    const res = await handleOwnerLineUnlink(d, req(log));
    expect(res.status).toBe(200);
    expect((await readJson<OwnerLineUnlinkResponse>(res)).menu).toBe('removed');
    expect(menuFn).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'warn',
      'dashboard-api.audit_log_failed',
      expect.objectContaining({ auditAction: 'owner_line_unlinked', auditTargetId: OWNER_ID }),
    );
  });

  it('解除の DB の失敗は例外のまま返し（ルートが 500 にする）、監査も LINE も呼ばない（1.7）', async () => {
    const { d, auditLog, menuFn } = deps(() => Promise.reject(new Error('connection refused')), { user: OP });
    await expect(handleOwnerLineUnlink(d, req())).rejects.toThrow('connection refused');
    expect(auditLog).not.toHaveBeenCalled();
    expect(menuFn).not.toHaveBeenCalled();
  });
});

describe('handleOwnerLineUnlink: メニューの結果', () => {
  it('対象があり LINE が成功したら印を消して removed を返し、成功を記録する（3.1）', async () => {
    const log = vi.fn<Sink>();
    const { d, menuFn, clearFn } = deps(changedWithMenu, { user: OP });
    const res = await handleOwnerLineUnlink(d, req(log));
    expect(res.status).toBe(200);
    expect(await readJson<OwnerLineUnlinkResponse>(res)).toEqual({
      owner: { id: OWNER_ID, lineLink: 'unlinked', menuUnlinkPending: false },
      menu: 'removed',
    });
    expect(menuFn).toHaveBeenCalledTimes(1);
    expect(menuFn).toHaveBeenCalledWith(LINE_USER_ID);
    expect(clearFn).toHaveBeenCalledTimes(1);
    expect(clearFn).toHaveBeenCalledWith({ ownerId: OWNER_ID, lineUserId: LINE_USER_ID });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('info', 'dashboard-api.richmenu_unlinked');
  });

  it('LINE が失敗したら解除は取り消さず failed・menuUnlinkPending=true を 200 で返し、種別と状態コードを記録する（3.2）', async () => {
    const log = vi.fn<Sink>();
    const { d, clearFn, auditLog } = deps(changedWithMenu, {
      user: AG,
      menu: () => Promise.resolve({ ok: false, errorKind: 'http_error', httpStatus: 500 }),
    });
    const res = await handleOwnerLineUnlink(d, req(log));
    expect(res.status).toBe(200);
    expect(await readJson<OwnerLineUnlinkResponse>(res)).toEqual({
      owner: { id: OWNER_ID, lineLink: 'unlinked', menuUnlinkPending: true },
      menu: 'failed',
    });
    expect(clearFn).not.toHaveBeenCalled();
    // 解除そのものは成立しているので、監査は残る。
    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('warn', 'dashboard-api.richmenu_unlink_failed', {
      errorKind: 'http_error',
      status: 500,
    });
  });

  it('状態コードの無い失敗（トークン発行の通信の失敗など）は種別だけを記録する', async () => {
    const log = vi.fn<Sink>();
    const { d } = deps(changedWithMenu, {
      menu: () => Promise.resolve({ ok: false, errorKind: 'token_failed', httpStatus: null }),
    });
    const res = await handleOwnerLineUnlink(d, req(log));
    expect((await readJson<OwnerLineUnlinkResponse>(res)).menu).toBe('failed');
    expect(log).toHaveBeenCalledWith('warn', 'dashboard-api.richmenu_unlink_failed', { errorKind: 'token_failed' });
  });

  it('LINE は成功したが印を消せなかったときは failed・menuUnlinkPending=true として返し、失敗を記録する', async () => {
    const log = vi.fn<Sink>();
    const { d, menuFn } = deps(changedWithMenu, {
      clear: () => Promise.reject(new Error('connection reset')),
    });
    const res = await handleOwnerLineUnlink(d, req(log));
    expect(res.status).toBe(200);
    expect(await readJson<OwnerLineUnlinkResponse>(res)).toEqual({
      owner: { id: OWNER_ID, lineLink: 'unlinked', menuUnlinkPending: true },
      menu: 'failed',
    });
    expect(menuFn).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('warn', 'dashboard-api.richmenu_unlink_failed', {
      errorKind: 'pending_clear_failed',
    });
  });

  it('対象が無ければ（印なし・再登録済み）LINE を呼ばず not_needed を返し、メニューの事象を記録しない', async () => {
    const log = vi.fn<Sink>();
    const { d, menuFn, clearFn } = deps(changedWithoutMenu, { user: OP });
    const res = await handleOwnerLineUnlink(d, req(log));
    expect(await readJson<OwnerLineUnlinkResponse>(res)).toEqual({
      owner: { id: OWNER_ID, lineLink: 'unlinked', menuUnlinkPending: false },
      menu: 'not_needed',
    });
    expect(menuFn).not.toHaveBeenCalled();
    expect(clearFn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('外し直し（変化なし・印あり）は LINE を呼び直して removed を返し、監査を残さない（3.4, 7.3）', async () => {
    const { d, menuFn, clearFn, auditLog } = deps(unchangedWithMenu, { user: AG });
    const res = await handleOwnerLineUnlink(d, req());
    expect(res.status).toBe(200);
    expect(await readJson<OwnerLineUnlinkResponse>(res)).toEqual({
      owner: { id: OWNER_ID, lineLink: 'unlinked', menuUnlinkPending: false },
      menu: 'removed',
    });
    expect(menuFn).toHaveBeenCalledWith(LINE_USER_ID);
    expect(clearFn).toHaveBeenCalledWith({ ownerId: OWNER_ID, lineUserId: LINE_USER_ID });
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('外し直しが再び失敗しても 200 の failed で、監査を残さない（3.3）', async () => {
    const { d, auditLog } = deps(unchangedWithMenu, {
      menu: () => Promise.resolve({ ok: false, errorKind: 'network_error', httpStatus: null }),
    });
    const res = await handleOwnerLineUnlink(d, req());
    expect(res.status).toBe(200);
    expect((await readJson<OwnerLineUnlinkResponse>(res)).owner.menuUnlinkPending).toBe(true);
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('LINE ユーザー ID を応答にも記録にも出さない', async () => {
    for (const menu of [
      () => Promise.resolve<UnlinkRichMenuResult>({ ok: true }),
      () => Promise.resolve<UnlinkRichMenuResult>({ ok: false, errorKind: 'http_error', httpStatus: 400 }),
    ]) {
      const log = vi.fn<Sink>();
      const { d } = deps(changedWithMenu, { menu });
      d.auditLog = () => Promise.reject(new Error(`audit down ${LINE_USER_ID}`));
      const res = await handleOwnerLineUnlink(d, req(log));
      expect(await res.text()).not.toContain(LINE_USER_ID);
      expect(JSON.stringify(log.mock.calls)).not.toContain(LINE_USER_ID);
    }
  });
});
