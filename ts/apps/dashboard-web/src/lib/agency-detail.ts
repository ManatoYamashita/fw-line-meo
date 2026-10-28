import type { DashboardUserItem, OwnerListItem } from './types';

// 代理店詳細（Issue #486・agency-dashboard Req 9）が、取得した値から計算する純粋関数。
// 画面の部品から切り離して単体で試験する。

// UUID の形（大小を問わない）。dashboard-api の UUID 検査（store-registration.ts の UUID_RE）と同じ形である。
const AGENCY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 経路の値を代理店 id として正規化する。UUID の形なら小文字にして返し、形でなければ null を返す（Req 9.6）。
 *
 * **形の判定で大小を許すなら、比べる側も同じ正規化済みの値を使う。** API が返す id は PostgreSQL 由来で
 * 常に小文字である。大文字の経路の値を素のまま厳密一致で比べると、API は大小を無視して実データを返すのに
 * 画面の側の絞り込み（usersOfAgency・代理店の存在判定）だけが一致せず、偽の 0 件や「見つかりません」になる
 * （dashboard-api の admin.ts が toLowerCase() で避けている罠と同じ型）。
 */
export function toAgencyId(value: string): string | null {
  return AGENCY_ID_RE.test(value) ? value.toLowerCase() : null;
}

/**
 * GET /dashboard-users の全件から、その代理店に属する代理店ロールの利用者だけを取り出す（Req 9.2）。
 * 運営の利用者（agencyId が null）は含めない。並びは API の順のまま保つ。
 * `agencyId` は toAgencyId で正規化した値を渡す（API の id は小文字）。
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
