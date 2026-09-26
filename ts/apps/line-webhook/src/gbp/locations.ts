// GBP ロケーション列挙と placeId 突合（gbp-post-review-reply spec task 3.1・GbpLocations）。
// Requirements: 1.6（認可された Google アカウントが対象店舗の管理権限を持たない場合は連携を成立させない）。
//
// 設計上の不変条件:
// - 「管理権限なし（no_permission）」と結論してよいのは **列挙が完全に成功した上で一致が 0 件** の
//   ときだけ。列挙の失敗・不完全（`incomplete_listing`）を no_permission に畳んではならない
//   （Req 1.6 の誤判定 = 正当な管理者に「権限のあるアカウントで再連携を」と誤案内する）。
// - 突合キーは Google Place ID の厳密一致（前後の空白のみ無視）。Place ID は大小文字を区別する
//   不透明な識別子であり、正規化・部分一致は行わない。
// - 空の placeId は「不明」であって「一致」ではない。両辺が空でも一致させない（誤連携の防止）。

import type { GbpAccountLocation, GbpApiError } from './client.js';

/** 本モジュールが必要とする GbpClient の最小面（テストでスタブ注入可能にする）。 */
export interface LocationLookupClient {
  listAccountsAndLocations(
    accessToken: string,
  ): Promise<
    { ok: true; value: GbpAccountLocation[] } | { ok: false; error: GbpApiError }
  >;
}

/**
 * 突合の失敗理由。いずれも「管理権限なし」ではなく **再試行導線** に倒すためのもの。
 * - `invalid_place_id`: 対象店舗の place_id が未確定・空（Req 1.1 の前提が崩れている）。
 * - `listing_incomplete`: ページ上限到達で列挙が不完全（部分結果で権限判定をしない）。
 * - `listing_failed`: 401/403/429/5xx・ネットワーク断など列挙自体の失敗。
 */
export type LocationLookupErrorReason =
  | 'invalid_place_id'
  | 'listing_incomplete'
  | 'listing_failed';

export type LocationMatchOutcome =
  | { kind: 'matched'; location: GbpAccountLocation }
  | { kind: 'no_permission' }
  | { kind: 'error'; reason: LocationLookupErrorReason };

function normalizePlaceId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 列挙済みロケーションから対象店舗の Place ID に一致するものを選ぶ。
 * 一致が複数ある場合（同一 Place を複数アカウントが保持しうる）は、投稿操作が可能な
 * ロケーションを優先する（機能2 が使えない身元を掴んで連携成立させないため）。
 */
export function matchLocationByPlaceId(
  locations: readonly GbpAccountLocation[],
  placeId: string,
): GbpAccountLocation | null {
  const target = normalizePlaceId(placeId);
  if (target === null) return null;

  const matches = locations.filter((location) => normalizePlaceId(location.placeId) === target);
  if (matches.length === 0) return null;
  return matches.find((location) => location.canOperateLocalPost) ?? matches[0] ?? null;
}

/**
 * 認可されたアカウント配下の全ロケーションを列挙し、対象店舗の Place ID と突合する。
 * `accessToken` は OAuth callback 時点の一時トークン（この時点では oauth_tokens 行が存在しない）。
 */
export async function findLocationForPlace(
  client: LocationLookupClient,
  input: { accessToken: string; placeId: string },
): Promise<LocationMatchOutcome> {
  const target = normalizePlaceId(input.placeId);
  // 照合対象が無い状態で列挙しても「一致なし」しか出ず、権限なしと誤判定するだけ。
  if (target === null) return { kind: 'error', reason: 'invalid_place_id' };

  const listing = await client.listAccountsAndLocations(input.accessToken);
  if (!listing.ok) {
    return {
      kind: 'error',
      reason: listing.error.kind === 'incomplete_listing' ? 'listing_incomplete' : 'listing_failed',
    };
  }

  const matched = matchLocationByPlaceId(listing.value, target);
  // ここに来たときだけ「列挙は完全に成功したが一致なし」= 管理権限なし（Req 1.6）。
  if (matched === null) return { kind: 'no_permission' };
  return { kind: 'matched', location: matched };
}
