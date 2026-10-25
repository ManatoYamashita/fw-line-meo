import { describe, it, expect, vi } from 'vitest';
import { handleOwnersList, type OwnersListDeps } from '../src/owners-list.js';
import type { DashboardUserIdentity, OwnerListItem } from '@fwlm/db';
import { readJson, type ErrorEnvelope } from './support/json.js';

const OP: DashboardUserIdentity = { id: 'u1', role: 'operator', operatorId: 'op1', agencyId: null };
const AG: DashboardUserIdentity = { id: 'u2', role: 'agency', operatorId: 'op1', agencyId: 'ag1' };

const CREATED_AT = new Date('2026-07-01T12:34:56.000Z');

function owner(over: Partial<OwnerListItem> = {}): OwnerListItem {
  return {
    id: '55555555-5555-5555-5555-555555555555',
    displayName: 'オーナー太郎',
    onboardingStatus: 'pending',
    createdAt: CREATED_AT,
    inviteCode: null,
    agencyId: 'ag1',
    agencyName: '代理店A',
    lineLink: 'linked',
    menuUnlinkPending: false,
    storeNames: [],
    takenOverBy: null,
    ...over,
  };
}

function deps(
  over: Partial<OwnersListDeps> = {},
  user: DashboardUserIdentity | null = OP,
  disabled = false,
): OwnersListDeps {
  return {
    auth: {
      verifier: {
        verifyIdToken: (t) =>
          Promise.resolve({ uid: `uid-${t}`, email: null, emailVerified: false, signInProvider: null }),
      },
      findUser: () => Promise.resolve(user === null ? null : { ...user, disabled }),
      linkByEmail: () => Promise.resolve(null),
    },
    listOwners: () => Promise.resolve([owner()]),
    ...over,
  };
}

function req(over: Partial<{ authorization: string | undefined; agencyId: string | undefined }> = {}) {
  return { authorization: 'Bearer tok', agencyId: undefined, ...over };
}

describe('handleOwnersList', () => {
  it('認証なしは 401（unauthenticated 封筒）', async () => {
    const res = await handleOwnersList(deps(), req({ authorization: undefined }));
    expect(res.status).toBe(401);
    expect((await readJson<ErrorEnvelope>(res)).error.code).toBe('unauthenticated');
  });

  it('未登録 UID は 403（同一封筒・存在を漏らさない）', async () => {
    const res = await handleOwnersList(deps({}, null), req());
    expect(res.status).toBe(403);
    expect((await readJson<ErrorEnvelope>(res)).error.code).toBe('forbidden');
  });

  it('agency が他代理店を指定したら 403 で、listOwners は呼ばれない（データアクセス前に遮断）', async () => {
    const listOwners = vi.fn(() => Promise.resolve([owner()]));
    const res = await handleOwnersList(deps({ listOwners }, AG), req({ agencyId: 'ag2' }));
    expect(res.status).toBe(403);
    expect((await readJson<ErrorEnvelope>(res)).error.code).toBe('forbidden');
    expect(listOwners).not.toHaveBeenCalled();
  });

  it('agency の未指定は自代理店のオーナー一覧（3.1）', async () => {
    const listOwners = vi.fn(() => Promise.resolve([owner()]));
    const res = await handleOwnersList(deps({ listOwners }, AG), req());
    expect(res.status).toBe(200);
    expect(listOwners).toHaveBeenCalledWith('ag1');
  });

  it('operator の agencyId 指定はその代理店のオーナー一覧（3.2）', async () => {
    const listOwners = vi.fn(() => Promise.resolve([owner()]));
    const res = await handleOwnersList(deps({ listOwners }), req({ agencyId: 'ag2' }));
    expect(res.status).toBe(200);
    expect(listOwners).toHaveBeenCalledWith('ag2');
  });

  it('operator の agencyId 未指定は 400（オーナー選択には代理店の指定が必要）で、listOwners は呼ばれない', async () => {
    const listOwners = vi.fn(() => Promise.resolve([owner()]));
    const res = await handleOwnersList(deps({ listOwners }), req());
    expect(res.status).toBe(400);
    expect((await readJson<ErrorEnvelope>(res)).error.code).toBe('validation_failed');
    expect(listOwners).not.toHaveBeenCalled();
  });

  it('0 件は 200 で空配列（UI が 3.3 の案内を出す・404 にしない）', async () => {
    const res = await handleOwnersList(deps({ listOwners: () => Promise.resolve([]) }, AG), req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ owners: [] });
  });

  it('各オーナーの createdAt は ISO 文字列で返す', async () => {
    const res = await handleOwnersList(deps({}, AG), req());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(await res.json()).toEqual({
      owners: [
        {
          id: '55555555-5555-5555-5555-555555555555',
          displayName: 'オーナー太郎',
          onboardingStatus: 'pending',
          createdAt: '2026-07-01T12:34:56.000Z',
          inviteCode: null,
        },
      ],
    });
  });

  it('登録に用いた招待コードの記録を返し、記録の無いオーナーは null のまま返す（agency-dashboard Req 8.5・#486）', async () => {
    const recorded = owner({
      id: '66666666-6666-6666-6666-666666666666',
      inviteCode: { id: '77777777-7777-7777-7777-777777777777', code: 'ABCD2345', disabled: true },
    });
    const legacy = owner({ inviteCode: null });
    const res = await handleOwnersList(deps({ listOwners: () => Promise.resolve([recorded, legacy]) }, AG), req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { owners: { id: string; inviteCode: unknown }[] };
    expect(body.owners.map((o) => [o.id, o.inviteCode])).toEqual([
      [
        '66666666-6666-6666-6666-666666666666',
        { id: '77777777-7777-7777-7777-777777777777', code: 'ABCD2345', disabled: true },
      ],
      ['55555555-5555-5555-5555-555555555555', null],
    ]);
  });

  it('招待コードの記録は id・code・disabled の 3 項目だけを返す（DAL の型に項目が増えても応答へ混ぜない）', async () => {
    // DAL が将来の項目を持った記録を返した場合を模す（型の外の項目なので as で渡す）。
    const withExtra = owner({
      inviteCode: {
        id: '77777777-7777-7777-7777-777777777777',
        code: 'ABCD2345',
        disabled: false,
        agencyId: 'ag1',
      } as OwnerListItem['inviteCode'],
    });
    const res = await handleOwnersList(deps({ listOwners: () => Promise.resolve([withExtra]) }, AG), req());
    const body = (await res.json()) as { owners: { inviteCode: unknown }[] };
    expect(body.owners[0]?.inviteCode).toEqual({
      id: '77777777-7777-7777-7777-777777777777',
      code: 'ABCD2345',
      disabled: false,
    });
  });
});
