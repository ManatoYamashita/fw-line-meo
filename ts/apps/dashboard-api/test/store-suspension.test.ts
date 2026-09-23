import { describe, it, expect, vi } from 'vitest';
import {
  handleStoreSuspension,
  type StoreSuspensionDeps,
  type StoreSuspensionJson,
} from '../src/store-suspension.js';
import type { AuthDeps } from '../src/auth.js';
import type {
  AuditLogInput,
  DashboardUserIdentity,
  SetStoreSuspensionInput,
  SetStoreSuspensionOutcome,
} from '@fwlm/db';
import { readJson, type ErrorEnvelope } from './support/json.js';

// POST /stores/:id/suspend・/resume の中核ロジックの単体試験（store-suspension Req 1.1–1.5, 7.1–7.3）。
// DB は setSuspension の注入で置き換え、範囲の決め方（運営は全店・代理店は自代理店）と
// 監査を呼ぶ条件（変化があったときだけ）を固定する。

const OP: DashboardUserIdentity = { id: 'u1', role: 'operator', operatorId: 'op1', agencyId: null };
const AG: DashboardUserIdentity = { id: 'u2', role: 'agency', operatorId: 'op1', agencyId: 'ag1' };

const STORE_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_STORE_ID = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const SUSPENDED_AT = new Date('2026-09-23T01:02:03.000Z');

// authenticate 依存のモック（invite-codes.test.ts と同型）。user=null で未登録、disabled で無効化。
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

type SetSuspension = (input: SetStoreSuspensionInput) => Promise<SetStoreSuspensionOutcome>;

function deps(
  setSuspension: SetSuspension,
  user: DashboardUserIdentity | null = OP,
  disabled = false,
) {
  const auditLog = vi.fn<(input: AuditLogInput) => Promise<void>>(() => Promise.resolve());
  const set = vi.fn<SetSuspension>(setSuspension);
  const d: StoreSuspensionDeps = { auth: authDeps(user, disabled), setSuspension: set, auditLog };
  return { d, set, auditLog };
}

const changedSuspend: SetSuspension = (input) =>
  Promise.resolve({ kind: 'changed', store: { id: input.storeId, suspendedAt: SUSPENDED_AT } });
const changedResume: SetSuspension = (input) =>
  Promise.resolve({ kind: 'changed', store: { id: input.storeId, suspendedAt: null } });
const notFound: SetSuspension = () => Promise.resolve({ kind: 'not_found' });

describe('handleStoreSuspension: 認証', () => {
  it('認証なしは 401（unauthenticated 封筒）で DB を呼ばない', async () => {
    const { d, set } = deps(changedSuspend);
    const res = await handleStoreSuspension(d, {
      authorization: undefined,
      id: STORE_ID,
      direction: 'suspend',
    });
    expect(res.status).toBe(401);
    expect((await readJson<ErrorEnvelope>(res)).error.code).toBe('unauthenticated');
    expect(set).not.toHaveBeenCalled();
  });

  it('未登録と無効化済みは同一の 403 封筒で DB を呼ばない', async () => {
    const unregistered = deps(changedSuspend, null);
    const disabled = deps(changedSuspend, AG, true);
    const r1 = await handleStoreSuspension(unregistered.d, {
      authorization: 'Bearer t',
      id: STORE_ID,
      direction: 'suspend',
    });
    const r2 = await handleStoreSuspension(disabled.d, {
      authorization: 'Bearer t',
      id: STORE_ID,
      direction: 'suspend',
    });
    expect(r1.status).toBe(403);
    expect(r2.status).toBe(403);
    expect(await r1.json()).toEqual(await r2.json());
    expect((await readJson<ErrorEnvelope>(
      await handleStoreSuspension(unregistered.d, { authorization: 'Bearer t', id: STORE_ID, direction: 'resume' }),
    )).error.code).toBe('forbidden');
    expect(unregistered.set).not.toHaveBeenCalled();
    expect(disabled.set).not.toHaveBeenCalled();
  });
});

describe('handleStoreSuspension: 範囲', () => {
  it('運営は範囲の制限なし（agencyId=null）で任意の店舗を停止できる（1.1）', async () => {
    const { d, set } = deps(changedSuspend, OP);
    const res = await handleStoreSuspension(d, {
      authorization: 'Bearer t',
      id: STORE_ID,
      direction: 'suspend',
    });
    expect(res.status).toBe(200);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({ storeId: STORE_ID, direction: 'suspend', agencyId: null });
    expect(await readJson<{ store: StoreSuspensionJson }>(res)).toEqual({
      store: { id: STORE_ID, suspendedAt: SUSPENDED_AT.toISOString() },
    });
  });

  it('代理店は自代理店の範囲（agencyId=自代理店）でだけ停止を要求する（1.2）', async () => {
    const { d, set } = deps(changedSuspend, AG);
    const res = await handleStoreSuspension(d, {
      authorization: 'Bearer t',
      id: STORE_ID,
      direction: 'suspend',
    });
    expect(res.status).toBe(200);
    expect(set).toHaveBeenCalledWith({ storeId: STORE_ID, direction: 'suspend', agencyId: 'ag1' });
  });

  it('再開は direction=resume を渡し、suspendedAt=null を返す（1.3）', async () => {
    const { d, set } = deps(changedResume, AG);
    const res = await handleStoreSuspension(d, {
      authorization: 'Bearer t',
      id: STORE_ID,
      direction: 'resume',
    });
    expect(res.status).toBe(200);
    expect(set).toHaveBeenCalledWith({ storeId: STORE_ID, direction: 'resume', agencyId: 'ag1' });
    expect(await readJson<{ store: StoreSuspensionJson }>(res)).toEqual({
      store: { id: STORE_ID, suspendedAt: null },
    });
  });

  it('範囲外・不存在・不正な ID はどれも同じ本文の 404 で、不正な ID は DB を呼ばない（1.4）', async () => {
    // 範囲外: 他代理店の店舗は DAL が not_found を返す。不存在も DAL が not_found を返す。
    const outOfScope = deps(notFound, AG);
    const missing = deps(notFound, AG);
    const invalid = deps(changedSuspend, AG);
    const rOut = await handleStoreSuspension(outOfScope.d, {
      authorization: 'Bearer t',
      id: OTHER_STORE_ID,
      direction: 'suspend',
    });
    const rMissing = await handleStoreSuspension(missing.d, {
      authorization: 'Bearer t',
      id: STORE_ID,
      direction: 'suspend',
    });
    const rInvalid = await handleStoreSuspension(invalid.d, {
      authorization: 'Bearer t',
      id: 'not-a-uuid',
      direction: 'suspend',
    });
    expect([rOut.status, rMissing.status, rInvalid.status]).toEqual([404, 404, 404]);
    const bOut = await rOut.text();
    expect(bOut).toBe(await rMissing.text());
    expect(bOut).toBe(await rInvalid.text());
    expect(JSON.parse(bOut)).toEqual({ error: { code: 'not_found', message: '店舗が見つかりません' } });
    expect(invalid.set).not.toHaveBeenCalled();
    expect(outOfScope.auditLog).not.toHaveBeenCalled();
    expect(missing.auditLog).not.toHaveBeenCalled();
  });
});

describe('handleStoreSuspension: 冪等と監査', () => {
  it('変化なし（既に停止中への停止・利用中への再開）は 200 で監査を呼ばない（1.5, 7.3）', async () => {
    const suspendAgain = deps(
      (input) =>
        Promise.resolve({ kind: 'unchanged', store: { id: input.storeId, suspendedAt: SUSPENDED_AT } }),
      OP,
    );
    const resumeAgain = deps(
      (input) => Promise.resolve({ kind: 'unchanged', store: { id: input.storeId, suspendedAt: null } }),
      AG,
    );
    const r1 = await handleStoreSuspension(suspendAgain.d, {
      authorization: 'Bearer t',
      id: STORE_ID,
      direction: 'suspend',
    });
    const r2 = await handleStoreSuspension(resumeAgain.d, {
      authorization: 'Bearer t',
      id: STORE_ID,
      direction: 'resume',
    });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(await readJson<{ store: StoreSuspensionJson }>(r1)).toEqual({
      store: { id: STORE_ID, suspendedAt: SUSPENDED_AT.toISOString() },
    });
    expect(await readJson<{ store: StoreSuspensionJson }>(r2)).toEqual({
      store: { id: STORE_ID, suspendedAt: null },
    });
    expect(suspendAgain.auditLog).not.toHaveBeenCalled();
    expect(resumeAgain.auditLog).not.toHaveBeenCalled();
  });

  it('停止の変化は store_suspended を操作者の役割つきで 1 回記録する（7.1）', async () => {
    const { d, auditLog } = deps(changedSuspend, AG);
    await handleStoreSuspension(d, { authorization: 'Bearer t', id: STORE_ID, direction: 'suspend' });
    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith({
      actorType: 'agency',
      actorId: 'u2',
      action: 'store_suspended',
      targetType: 'store',
      targetId: STORE_ID,
    });
  });

  it('再開の変化は store_resumed を操作者の役割つきで 1 回記録する（7.2）', async () => {
    const { d, auditLog } = deps(changedResume, OP);
    await handleStoreSuspension(d, { authorization: 'Bearer t', id: STORE_ID, direction: 'resume' });
    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith({
      actorType: 'operator',
      actorId: 'u1',
      action: 'store_resumed',
      targetType: 'store',
      targetId: STORE_ID,
    });
  });

  it('監査の対象 ID は要求の表記ではなく DAL が返した店舗の ID を使う', async () => {
    // 大文字の UUID でも uuid 比較は通る。監査には DB の正規表記を残す。
    const { d, auditLog } = deps(
      () => Promise.resolve({ kind: 'changed', store: { id: STORE_ID, suspendedAt: SUSPENDED_AT } }),
      OP,
    );
    const res = await handleStoreSuspension(d, {
      authorization: 'Bearer t',
      id: STORE_ID.toUpperCase(),
      direction: 'suspend',
    });
    expect(res.status).toBe(200);
    expect(auditLog.mock.calls[0]?.[0].targetId).toBe(STORE_ID);
  });

  it('監査の失敗は捕捉せず呼び出し元へ伝える（停止は成立している・design の決定）', async () => {
    const { d } = deps(changedSuspend, OP);
    d.auditLog = () => Promise.reject(new Error('audit down'));
    await expect(
      handleStoreSuspension(d, { authorization: 'Bearer t', id: STORE_ID, direction: 'suspend' }),
    ).rejects.toThrow('audit down');
  });
});
