// 詳細の画面の経路と、経路の値の正規化（agency-dashboard Requirement 10.1–10.3・11.9・Issue #526）。
// 一覧の名前のリンクと詳細の画面が、経路をここ 1 か所から組み立てる。

// UUID の形（大小を問わない）。dashboard-api の各ハンドラの UUID 検査（store-suspension.ts などの UUID_RE）と同じ形である。
const ENTITY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 経路の値を、店舗・オーナー・代理店の id として正規化する。UUID の形なら小文字にして返し、形でなければ null を返す。
 * null のとき、画面は API を呼ばずに「見つかりません」を出す（Req 9.6・11.9）。
 *
 * **形の判定で大小を許すなら、比べる側も同じ正規化済みの値を使う。** API が返す id は PostgreSQL 由来で
 * 常に小文字である。大文字の経路の値を素のまま厳密一致で比べると、API は大小を無視して実データを返すのに
 * 画面の側の絞り込みだけが一致せず、偽の 0 件や「見つかりません」になる（Issue #486 で代理店詳細に入れた
 * toAgencyId をここへ移した）。
 */
export function toEntityId(value: string): string | null {
  return ENTITY_ID_RE.test(value) ? value.toLowerCase() : null;
}

// 経路の 1 段に閉じ込める（区切りを含む値が別の経路へ化けないようにする）。API の id は UUID だが、
// 呼び出し側の値を信じずに符号化する。
function segment(id: string): string {
  return encodeURIComponent(id);
}

/** 店舗の詳細の経路（Req 10.1）。 */
export function storePath(storeId: string): string {
  return `/stores/${segment(storeId)}`;
}

/** オーナーの詳細の経路（Req 10.2）。 */
export function ownerPath(ownerId: string): string {
  return `/owners/${segment(ownerId)}`;
}

/** 代理店の詳細の経路（Req 10.3・運営だけが使う）。 */
export function agencyPath(agencyId: string): string {
  return `/admin/agencies/${segment(agencyId)}`;
}
