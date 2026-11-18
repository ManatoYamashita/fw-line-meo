import type { DashboardUserItem, OwnerListItem } from './types';

// 代理店詳細（Issue #486・agency-dashboard Req 9）が、取得した値から計算する純粋関数。
// 画面の部品から切り離して単体で試験する。

/**
 * GET /dashboard-users の全件から、その代理店に属する代理店ロールの利用者だけを取り出す（Req 9.2）。
 * 運営の利用者（agencyId が null）は含めない。並びは API の順のまま保つ。
 * `agencyId` は toEntityId（lib/entity-paths.ts）で正規化した値を渡す（API の id は小文字）。
 */
export function usersOfAgency(
  users: readonly DashboardUserItem[],
  agencyId: string,
): DashboardUserItem[] {
  return users.filter((user) => user.role === 'agency' && user.agencyId === agencyId);
}

/**
 * 招待コードの id → そのコードで登録したオーナー（Req 9.2）。並びはオーナーの一覧の順のまま保つ。
 *
 * **記録なしのオーナー（inviteCode が null）はどのコードにも入れない**（Req 8.4・9.4）。同じ代理店に
 * 有効なコードが 1 つしか無くても、そのコードへ寄せない。推定値を事実として見せることになる。
 */
export function ownersByInviteCode(
  owners: readonly OwnerListItem[],
): ReadonlyMap<string, readonly OwnerListItem[]> {
  const byCode = new Map<string, OwnerListItem[]>();
  for (const owner of owners) {
    if (owner.inviteCode === null) continue;
    const list = byCode.get(owner.inviteCode.id);
    if (list === undefined) byCode.set(owner.inviteCode.id, [owner]);
    else list.push(owner);
  }
  return byCode;
}

/** 招待コードの記録が無いオーナーの人数（Req 9.4）。 */
export function unrecordedOwnerCount(owners: readonly OwnerListItem[]): number {
  return owners.filter((owner) => owner.inviteCode === null).length;
}
