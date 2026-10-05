import { describe, it, expect, vi } from 'vitest';
import type {
  AuditLogAction,
  AuditLogInput,
  AuditLogger,
  DashboardUserIdentity,
  DashboardUserItem,
  InviteCodeItem,
} from '@fwlm/db';
import type { Sink } from '@fwlm/observability';
import { recordAudit } from '../src/audit.js';
import type { AuthDeps } from '../src/auth.js';
import {
  handleAgencyCreate,
  handleDashboardUserCreate,
  handleDashboardUserDisable,
  handleDashboardUserEnable,
  handleDashboardUserUpdate,
} from '../src/admin.js';
import { handleInviteCodeDisable, handleInviteCodeIssue } from '../src/invite-codes.js';
import { handleStoreRegister } from '../src/store-registration.js';
import { handleStoreSuspension } from '../src/store-suspension.js';

// Issue #250: 監査記録の書込が失敗しても、確定済みの業務の書込をエラー応答へ変えない。
// 監査を書く 9 経路すべてで、監査が reject する依存を注入し、次の 3 点を確かめる。
//   - 応答は監査が成功したときと同じ（状態コードと本文）
//   - 業務の書込は 1 回だけ呼ばれている（握った後に再実行しない）
//   - 警告 dashboard-api.audit_log_failed が 1 件、action と対象の識別子つきで残る

const OP: DashboardUserIdentity = { id: 'u1', role: 'operator', operatorId: 'op1', agencyId: null };
const CREATED_AT = new Date('2026-07-01T12:34:56.000Z');
const AGENCY_ID = 'a1a1a1a1-1111-4111-8111-111111111111';
const USER_ID = 'b2b2b2b2-2222-4222-8222-222222222222';
const OTHER_AGENCY_ID = 'a3a3a3a3-3333-4333-8333-333333333333';
const OWNER_ID = '55555555-5555-4555-8555-555555555555';
const STORE_ID = '66666666-6666-4666-8666-666666666666';
const CODE_ID = '77777777-7777-4777-8777-777777777777';

function authDeps(user: DashboardUserIdentity): AuthDeps {
  return {
    verifier: {
      verifyIdToken: (t) =>
        Promise.resolve({ uid: `uid-${t}`, email: null, emailVerified: false, signInProvider: null }),
    },
    findUser: () => Promise.resolve({ ...user, disabled: false }),
    linkByEmail: () => Promise.resolve(null),
  };
}

function userItem(over: Partial<DashboardUserItem> = {}): DashboardUserItem {
  return {
    id: USER_ID,
    role: 'agency',
    operatorId: 'op1',
    agencyId: AGENCY_ID,
    email: 'user@example.com',
    displayName: '担当者',
    disabled: false,
    createdAt: CREATED_AT,
    ...over,
  };
}

function codeItem(over: Partial<InviteCodeItem> = {}): InviteCodeItem {
  return { id: CODE_ID, agencyId: AGENCY_ID, code: 'ABCD2345', disabled: false, createdAt: CREATED_AT, ...over };
}

const auth = 'Bearer tok';

interface AuditPath {
  name: string;
  // 業務の書込（1 回だけ呼ばれることを確かめる）と監査を受け取り、応答を返す。
  run: (write: ReturnType<typeof vi.fn>, auditLog: AuditLogger, log: Sink) => Promise<Response>;
  // 業務の書込の依存が返す値。
  writeResult: unknown;
  status: number;
  // 監査の 1 件目の action と対象（警告に載る値）。
  action: AuditLogAction;
  targetId: string;
}

const paths: AuditPath[] = [
  {
    name: 'POST /stores（店舗登録）',
    writeResult: { kind: 'confirmed', storeId: STORE_ID },
    run: (write, auditLog, log) =>
      handleStoreRegister(
        {
          auth: authDeps(OP),
          findOwner: () => Promise.resolve({ id: OWNER_ID, agencyId: AGENCY_ID }),
          isValidCategory: () => Promise.resolve(true),
          registerStore: write,
          auditLog,
        },
        {
          authorization: auth,
          body: {
            ownerId: OWNER_ID,
            candidate: {
              placeId: 'ChIJ-test',
              name: 'テスト店',
              address: '東京都',
              latitude: 35.6,
              longitude: 139.7,
              types: ['restaurant'],
            },
          },
          log,
        },
      ),
    status: 201,
    action: 'store_registered',
    targetId: STORE_ID,
  },
  {
    name: 'POST /stores/:id/suspend（店舗の停止）',
    writeResult: { kind: 'changed', store: { id: STORE_ID, suspendedAt: CREATED_AT } },
    run: (write, auditLog, log) =>
      handleStoreSuspension(
        { auth: authDeps(OP), setSuspension: write, auditLog },
        { authorization: auth, id: STORE_ID, direction: 'suspend', log },
      ),
    status: 200,
    action: 'store_suspended',
    targetId: STORE_ID,
  },
  {
    name: 'POST /stores/:id/resume（店舗の再開）',
    writeResult: { kind: 'changed', store: { id: STORE_ID, suspendedAt: null } },
    run: (write, auditLog, log) =>
      handleStoreSuspension(
        { auth: authDeps(OP), setSuspension: write, auditLog },
        { authorization: auth, id: STORE_ID, direction: 'resume', log },
      ),
    status: 200,
    action: 'store_resumed',
    targetId: STORE_ID,
  },
  {
    name: 'POST /invite-codes（招待コードの発行）',
    writeResult: codeItem(),
    run: (write, auditLog, log) =>
      handleInviteCodeIssue(
        { auth: authDeps(OP), issueCode: write, auditLog },
        { authorization: auth, body: { agencyId: AGENCY_ID }, log },
      ),
    status: 201,
    action: 'invite_code_issued',
    targetId: CODE_ID,
  },
  {
    name: 'POST /invite-codes/:id/disable（招待コードの無効化）',
    writeResult: codeItem({ disabled: true }),
    run: (write, auditLog, log) =>
      handleInviteCodeDisable(
        { auth: authDeps(OP), disableCode: write, auditLog },
        { authorization: auth, id: CODE_ID, body: { agencyId: AGENCY_ID }, log },
      ),
    status: 200,
    action: 'invite_code_disabled',
    targetId: CODE_ID,
  },
  {
    name: 'POST /agencies（代理店の作成）',
    writeResult: { id: AGENCY_ID, operatorId: 'op1', name: 'テスト代理店', createdAt: CREATED_AT },
    run: (write, auditLog, log) =>
      handleAgencyCreate(
        { auth: authDeps(OP), createAgency: write, auditLog },
        { authorization: auth, body: { name: 'テスト代理店' }, log },
      ),
    status: 201,
    action: 'agency_created',
    targetId: AGENCY_ID,
  },
  {
    name: 'POST /dashboard-users（利用者の作成）',
    writeResult: { kind: 'created', user: userItem() },
    run: (write, auditLog, log) =>
      handleDashboardUserCreate(
        {
          auth: authDeps(OP),
          createUser: write,
          findUserByEmailInOperator: () => Promise.resolve(null),
          auditLog,
        },
        {
          authorization: auth,
          body: { role: 'agency', agencyId: AGENCY_ID, email: 'user@example.com' },
          log,
        },
      ),
    status: 201,
    action: 'dashboard_user_created',
    targetId: USER_ID,
  },
  {
    name: 'POST /dashboard-users/:id/disable（利用者の無効化）',
    writeResult: { kind: 'disabled', user: userItem({ disabled: true }) },
    run: (write, auditLog, log) =>
      handleDashboardUserDisable(
        { auth: authDeps(OP), disableUser: write, auditLog },
        { authorization: auth, id: USER_ID, log },
      ),
    status: 200,
    action: 'dashboard_user_disabled',
    targetId: USER_ID,
  },
  {
    name: 'POST /dashboard-users/:id/enable（利用者の再有効化）',
    writeResult: userItem(),
    run: (write, auditLog, log) =>
      handleDashboardUserEnable(
        { auth: authDeps(OP), enableUser: write, auditLog },
        { authorization: auth, id: USER_ID, log },
      ),
    status: 200,
    action: 'dashboard_user_enabled',
    targetId: USER_ID,
  },
  {
    name: 'POST /dashboard-users/:id/update（利用者の所属の変更）',
    writeResult: {
      kind: 'updated',
      before: userItem(),
      user: userItem({ agencyId: OTHER_AGENCY_ID }),
    },
    run: (write, auditLog, log) =>
      handleDashboardUserUpdate(
        { auth: authDeps(OP), updateUser: write, auditLog },
        { authorization: auth, id: USER_ID, body: { agencyId: OTHER_AGENCY_ID }, log },
      ),
    status: 200,
    action: 'dashboard_user_agency_updated',
    targetId: USER_ID,
  },
];

describe('監査記録の失敗は確定済みの業務の書込をエラー応答にしない（Issue #250）', () => {
  it.each(paths)('$name', async (path) => {
    // 対照: 監査が成功したときの応答。
    const okWrite = vi.fn(() => Promise.resolve(path.writeResult));
    const okLog = vi.fn<Sink>();
    const okRes = await path.run(okWrite, () => Promise.resolve(), okLog);
    expect(okRes.status).toBe(path.status);
    expect(okLog).not.toHaveBeenCalled();

    // 監査が reject する。
    const write = vi.fn(() => Promise.resolve(path.writeResult));
    const log = vi.fn<Sink>();
    const auditLog = vi.fn<AuditLogger>(() => Promise.reject(new TypeError('relation "audit_logs" does not exist')));
    const res = await path.run(write, auditLog, log);

    expect(res.status).toBe(path.status);
    expect(await res.text()).toBe(await okRes.text());
    expect(write).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('warn', 'dashboard-api.audit_log_failed', {
      errorKind: 'TypeError',
      auditAction: path.action,
      auditTargetId: path.targetId,
    });
  });

  it('対象の経路を漏れなく数えている（監査を書く経路を足したら、この表へも足す）', () => {
    expect(paths).toHaveLength(10);
  });

  it('利用者の更新で監査が 2 件のとき、1 件目が失敗しても 2 件目を書き、応答は 200', async () => {
    const auditLog = vi
      .fn<AuditLogger>()
      .mockRejectedValueOnce(new Error('audit down'))
      .mockResolvedValueOnce(undefined);
    const log = vi.fn<Sink>();
    const res = await handleDashboardUserUpdate(
      {
        auth: authDeps(OP),
        updateUser: () =>
          Promise.resolve({
            kind: 'updated',
            before: userItem(),
            user: userItem({ agencyId: OTHER_AGENCY_ID, displayName: '新しい名前' }),
          }),
        auditLog,
      },
      {
        authorization: auth,
        id: USER_ID,
        body: { agencyId: OTHER_AGENCY_ID, displayName: '新しい名前' },
        log,
      },
    );
    expect(res.status).toBe(200);
    expect(auditLog.mock.calls.map(([input]) => input.action)).toEqual([
      'dashboard_user_agency_updated',
      'dashboard_user_display_name_updated',
    ]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'warn',
      'dashboard-api.audit_log_failed',
      expect.objectContaining({ auditAction: 'dashboard_user_agency_updated' }),
    );
  });
});

describe('recordAudit', () => {
  const input: AuditLogInput = {
    actorType: 'operator',
    actorId: 'u1',
    action: 'agency_created',
    targetType: 'agency',
    targetId: AGENCY_ID,
  };

  it('成功したときは警告を残さない', async () => {
    const log = vi.fn<Sink>();
    const auditLog = vi.fn<AuditLogger>(() => Promise.resolve());
    await recordAudit(auditLog, log, input);
    expect(auditLog).toHaveBeenCalledWith(input);
    expect(log).not.toHaveBeenCalled();
  });

  it('失敗したときは例外を返さず、例外の本文を載せずに警告を 1 件残す', async () => {
    const log = vi.fn<Sink>();
    await expect(
      recordAudit(() => Promise.reject(new Error('password=secret host=10.0.0.1')), log, input),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('warn', 'dashboard-api.audit_log_failed', {
      errorKind: 'Error',
      auditAction: 'agency_created',
      auditTargetId: AGENCY_ID,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
  });

  it('Error 以外が投げられても種別を UnknownError として残す', async () => {
    const log = vi.fn<Sink>();
    await recordAudit(() => Promise.reject('boom'), log, input);
    expect(log).toHaveBeenCalledWith(
      'warn',
      'dashboard-api.audit_log_failed',
      expect.objectContaining({ errorKind: 'UnknownError' }),
    );
  });

  it('記録先が無くても例外を返さない', async () => {
    await expect(recordAudit(() => Promise.reject(new Error('x')), undefined, input)).resolves.toBeUndefined();
  });
});
