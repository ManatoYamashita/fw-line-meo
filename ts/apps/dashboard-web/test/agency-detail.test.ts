import { describe, expect, it } from 'vitest';
import {
  ownersByInviteCode,
  toAgencyId,
  unrecordedOwnerCount,
  usersOfAgency,
} from '../src/lib/agency-detail';
import type { DashboardUserItem, OwnerListItem } from '../src/lib/types';

// 代理店詳細（Issue #486・agency-dashboard Req 9）が取得した値から計算する純粋関数。

// 英字を含める。数字だけの id は toUpperCase() で値が変わらず、大小の扱いの試験が空振りする。
const AGENCY = 'abcdef22-2222-2222-2222-222222222222';
const OTHER_AGENCY = '22222222-2222-2222-2222-222222222299';

function user(overrides: Partial<DashboardUserItem>): DashboardUserItem {
  return {
    id: 'u',
    role: 'agency',
    operatorId: 'op',
    agencyId: AGENCY,
    email: 'a@example.com',
    displayName: null,
    disabled: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function owner(id: string, inviteCodeId: string | null): OwnerListItem {
  return {
    id,
    displayName: id,
    onboardingStatus: 'pending',
    createdAt: '2026-10-01T00:00:00.000Z',
    inviteCode: inviteCodeId === null ? null : { id: inviteCodeId, code: `CODE-${inviteCodeId}`, disabled: false },
  };
}

describe('toAgencyId（Req 9.6）', () => {
  const MIXED = 'AbCdEf00-1111-2222-3333-444455556666';

  it('UUID の形なら小文字へ正規化して返す（大小を問わず同じ代理店を指す）', () => {
    expect(toAgencyId(AGENCY)).toBe(AGENCY);
    expect(toAgencyId(AGENCY.toUpperCase())).toBe(AGENCY);
    expect(toAgencyId(MIXED)).toBe(MIXED.toLowerCase());
  });

  it('UUID の形でない値は null（API を呼ばずに「見つかりません」へ回す）', () => {
    for (const value of ['', 'abc', `${AGENCY}x`, ` ${AGENCY}`, AGENCY.replaceAll('-', ''), '../stores']) {
      expect(toAgencyId(value), value).toBeNull();
    }
  });

  it('大文字の経路の値でも、正規化した id で利用者を取りこぼさない', () => {
    const id = toAgencyId(AGENCY.toUpperCase());
    expect(id).not.toBeNull();
    expect(usersOfAgency([user({ id: 'mine' })], id!).map((u) => u.id)).toEqual(['mine']);
  });
});

describe('usersOfAgency（Req 9.2）', () => {
  it('その代理店に属する代理店ロールの利用者だけを、元の並びのまま返す', () => {
    // 入力の並びを id の辞書順と逆にしておく（並べ替える改変を素通りさせない）。
    const users = [
      user({ id: 'mine-b' }),
      user({ id: 'other', agencyId: OTHER_AGENCY }),
      user({ id: 'operator', role: 'operator', agencyId: null }),
      user({ id: 'mine-a', disabled: true }),
    ];
    expect(usersOfAgency(users, AGENCY).map((u) => u.id)).toEqual(['mine-b', 'mine-a']);
  });

  it('該当が無ければ空配列（0 件の案内は呼び出し側が出す）', () => {
    expect(usersOfAgency([user({ agencyId: OTHER_AGENCY })], AGENCY)).toEqual([]);
  });
});

describe('ownersByInviteCode（Req 9.2・9.4）', () => {
  it('招待コードの id ごとに、そのコードで登録したオーナーを並べる', () => {
    // 同じコードの中の並びはオーナーの一覧の順のまま（id の辞書順と逆にしておく）。
    const byCode = ownersByInviteCode([owner('o3', 'c1'), owner('o2', 'c2'), owner('o1', 'c1')]);
    expect(byCode.get('c1')?.map((o) => o.id)).toEqual(['o3', 'o1']);
    expect(byCode.get('c2')?.map((o) => o.id)).toEqual(['o2']);
  });

  it('記録なしのオーナーはどのコードにも入れない（推定で結びつけない）', () => {
    const byCode = ownersByInviteCode([owner('o1', 'c1'), owner('unrecorded', null)]);
    const all = [...byCode.values()].flat().map((o) => o.id);
    expect(all).toEqual(['o1']);
    expect(byCode.size).toBe(1);
  });
});

describe('unrecordedOwnerCount（Req 9.4）', () => {
  it('招待コードの記録が無いオーナーの人数を数える', () => {
    expect(unrecordedOwnerCount([owner('a', null), owner('b', 'c1'), owner('c', null)])).toBe(2);
    expect(unrecordedOwnerCount([owner('b', 'c1')])).toBe(0);
    expect(unrecordedOwnerCount([])).toBe(0);
  });
});
