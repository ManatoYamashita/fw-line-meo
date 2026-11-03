import { getOwners, getStores, type ApiClientOptions } from './api';
import type { OwnerListItem, StoreListItem } from './types';

// 1 代理店ぶんの「オーナー＋登録済み店舗」（Issue #485）。
// 店舗登録のオーナー選択と代理店詳細画面（Issue #486）が同じ形で使うので、画面の中に閉じ込めずここに置く。
//
// **取得の失敗を 0 件に化けさせない**（Req 7.4）。オーナーの失敗・店舗だけの失敗・成功を別々の形で
// 返し、画面が「対象オーナーがいません」「登録済みの店舗はありません」を成功のときだけ出せるようにする。

/** オーナー id → そのオーナーの店舗（API の並び順のまま）。店舗の無いオーナーはキーを持たない。 */
export type StoresByOwner = ReadonlyMap<string, readonly StoreListItem[]>;

/** 店舗の読み込み結果。オーナーは取れたが店舗だけ失敗した場合を表せるよう、オーナーとは別に持つ。 */
export type OwnerStoresLoad = { kind: 'loaded'; byOwner: StoresByOwner } | { kind: 'error' };

export type AgencyRosterLoad =
  | { kind: 'loaded'; owners: readonly OwnerListItem[]; stores: OwnerStoresLoad }
  | { kind: 'error' };

/**
 * 店舗をオーナーごとに振り分ける（純粋関数）。1 オーナーは N 店舗を持てる（stores.owner_id は一意でない）。
 * 停止中の店舗も除かない（登録済みであることに変わりはない）。
 */
export function groupStoresByOwner(stores: readonly StoreListItem[]): StoresByOwner {
  const byOwner = new Map<string, StoreListItem[]>();
  for (const store of stores) {
    const list = byOwner.get(store.ownerId);
    if (list === undefined) byOwner.set(store.ownerId, [store]);
    else list.push(store);
  }
  return byOwner;
}

/** そのオーナーの店舗（無ければ空配列）。 */
export function storesOfOwner(byOwner: StoresByOwner, ownerId: string): readonly StoreListItem[] {
  return byOwner.get(ownerId) ?? [];
}

/**
 * 1 代理店ぶんの店舗を読み、オーナーごとに振り分ける。店舗だけを読み直すときに使う。
 *
 * `agencyId` は運営が対象の代理店を指すときだけ渡す。代理店ロールは渡さない（サーバーが自代理店に固定する）。
 */
export async function loadStoresByOwner(
  params: { agencyId?: string },
  options: ApiClientOptions = {},
): Promise<OwnerStoresLoad> {
  const result = await getStores({ agencyId: params.agencyId }, options);
  return result.ok ? { kind: 'loaded', byOwner: groupStoresByOwner(result.value) } : { kind: 'error' };
}

/**
 * 1 代理店ぶんのオーナーと店舗を **並行に** 読む（直列にしない）。
 *
 * オーナーの取得に失敗したら全体を失敗にする（店舗だけでは表を組めない）。店舗だけの失敗は
 * オーナーの一覧を保ったまま `stores: { kind: 'error' }` で返す（選択は続けられる）。
 */
export async function loadAgencyRoster(
  params: { agencyId?: string },
  options: ApiClientOptions = {},
): Promise<AgencyRosterLoad> {
  const [owners, stores] = await Promise.all([
    getOwners({ agencyId: params.agencyId }, options),
    loadStoresByOwner(params, options),
  ]);
  if (!owners.ok) return { kind: 'error' };
  return { kind: 'loaded', owners: owners.value, stores };
}
