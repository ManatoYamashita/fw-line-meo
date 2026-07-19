import type { Queryable } from './pool.js';
import type { PlaceStatus, StoreRow } from './types.js';

const STORE_COLUMNS =
  'id, owner_id, category_code, name, latitude, longitude, place_id, place_status, created_at';

// アンケート表示に必要な最小の店舗情報。
export interface SurveyStore {
  id: string;
  name: string;
  placeId: string | null;
  placeStatus: PlaceStatus;
}

// QR RBAC 判定用に owner 経由の agency を同梱した店舗情報。
export interface StoreWithAgency extends SurveyStore {
  ownerId: string;
  agencyId: string;
}

// UUID 形式でない storeId は DB を叩かず not-found 扱い（無効 URL → エラーページ用・Req 2.7）。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** アンケート用に店舗を取得（不在・無効 ID は null）。 */
export async function findStoreForSurvey(
  db: Queryable,
  id: string,
): Promise<SurveyStore | null> {
  if (!UUID_RE.test(id)) return null;
  const res = await db.query<{
    id: string;
    name: string;
    place_id: string | null;
    place_status: PlaceStatus;
  }>('SELECT id, name, place_id, place_status FROM stores WHERE id = $1', [id]);
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    placeId: row.place_id,
    placeStatus: row.place_status,
  };
}

/** QR 発行の RBAC 判定用に店舗＋担当代理店を取得（不在・無効 ID は null）。 */
export async function findStoreWithAgency(
  db: Queryable,
  id: string,
): Promise<StoreWithAgency | null> {
  if (!UUID_RE.test(id)) return null;
  const res = await db.query<{
    id: string;
    name: string;
    place_id: string | null;
    place_status: PlaceStatus;
    owner_id: string;
    agency_id: string;
  }>(
    `SELECT s.id, s.name, s.place_id, s.place_status, s.owner_id, o.agency_id
       FROM stores s
       JOIN owners o ON o.id = s.owner_id
      WHERE s.id = $1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    placeId: row.place_id,
    placeStatus: row.place_status,
    ownerId: row.owner_id,
    agencyId: row.agency_id,
  };
}

export interface CreateConfirmedStoreInput {
  ownerId: string;
  placeId: string;
  name: string;
  latitude?: number | null;
  longitude?: number | null;
  categoryCode?: string | null;
}

/**
 * 店舗確定オンボーディング（line-onboarding spec）が候補確定時に呼ぶ。place_status='confirmed'・
 * place_id 設定済みで作成する（既存 CHECK `ck_place_confirmed` を満たす。Req 4.2）。
 * stores テーブルに address/types の格納列は無いため、StoreCandidate のうち name/lat/lng/place_id のみ永続化する。
 */
export async function createConfirmedStore(
  db: Queryable,
  input: CreateConfirmedStoreInput,
): Promise<StoreRow> {
  const res = await db.query<StoreRow>(
    `INSERT INTO stores (owner_id, category_code, name, latitude, longitude, place_id, place_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'confirmed')
     RETURNING ${STORE_COLUMNS}`,
    [
      input.ownerId,
      input.categoryCode ?? null,
      input.name,
      input.latitude ?? null,
      input.longitude ?? null,
      input.placeId,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('createConfirmedStore: insert did not return a row');
  return row;
}

/** Place 確定済み店舗の最小情報（GBP 連携の対象候補・gbp-post-review-reply Req 1.1）。 */
export interface ConfirmedStoreSummary {
  id: string;
  name: string;
  /** place_status='confirmed' の店舗のみを返すため常に非 null。 */
  placeId: string;
}

/**
 * オーナーの Place 確定済み店舗を列挙する（gbp-post-review-reply Req 1.1, 1.3, 2.6）。
 * 連携誘導・店舗選択・連携状態確認の対象を「日次サマリーが稼働している店舗」に限るため、
 * place_status='confirmed' かつ place_id を持つ行のみを返す。
 *
 * owner_id を WHERE に置く所有検証込みのクエリ形状であり、この結果集合が
 * 「そのオーナーが GBP 操作を行える店舗の全体」の唯一の定義になる
 * （postback 由来の storeId は必ずこの集合との突合で検証する）。
 *
 * 並び順は postback の index 選択が安定するよう created_at → id の全順序で固定する。
 */
export async function listConfirmedStoresByOwner(
  db: Queryable,
  ownerId: string,
): Promise<ConfirmedStoreSummary[]> {
  if (!UUID_RE.test(ownerId)) return [];
  const res = await db.query<{ id: string; name: string; place_id: string }>(
    `SELECT id, name, place_id
       FROM stores
      WHERE owner_id = $1
        AND place_status = 'confirmed'
        AND place_id IS NOT NULL
      ORDER BY created_at ASC, id ASC`,
    [ownerId],
  );
  return res.rows.map((row) => ({ id: row.id, name: row.name, placeId: row.place_id }));
}

/**
 * place_id で既存店舗を検索する。既に他オーナーの店舗として登録済みかどうかの判定に使う
 * （Req 4.4: 登録済み Place は確定拒否）。未登録は null。
 */
export async function findStoreByPlaceId(db: Queryable, placeId: string): Promise<StoreRow | null> {
  const res = await db.query<StoreRow>(
    `SELECT ${STORE_COLUMNS} FROM stores WHERE place_id = $1`,
    [placeId],
  );
  return res.rows[0] ?? null;
}
