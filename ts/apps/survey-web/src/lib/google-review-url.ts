// Google クチコミ投稿画面を Place ID から直接開く URL を組み立てる。
// この形式は公式に保証されたものではない（research.md のリスク登録）ため、
// 変更追随はこのモジュール 1 箇所に隔離する。システムは代理投稿せず、遷移 URL のみ提供する。

const WRITEREVIEW_BASE = 'https://search.google.com/local/writereview';

/** Place ID からクチコミ投稿 URL を組み立てる（placeId は毎回 DB から読む・キャッシュしない）。 */
export function buildGoogleReviewUrl(placeId: string): string {
  if (!placeId) throw new Error('placeId is required');
  return `${WRITEREVIEW_BASE}?placeid=${encodeURIComponent(placeId)}`;
}
