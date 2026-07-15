import type { Queryable } from './pool.js';
import type { PlaceStatus, StoreListItem, StoreRow } from './types.js';

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

interface StoreListRow {
  id: string;
  name: string;
  place_status: PlaceStatus;
  competitor_configured: boolean;
  owner_id: string;
  owner_display_name: string | null;
  agency_id: string;
  agency_name: string;
  created_at: Date;
}

/**
 * ダッシュボードの店舗一覧を取得する（agency-dashboard spec）。
 * stores×owners×agencies を JOIN し、competitors(active) の EXISTS で competitorConfigured を導出する
 * （Req 4.1, 4.2, 4.3）。competitors は read のみ（本アクセサは競合を変更しない・Req 4.5）。
 * filter.agencyId 指定時は当該代理店の店舗のみ（agency スコープ・Req 2.1）、未指定時は全代理店（Req 2.2）。
 * 来店客系テーブルには一切触れない（Req 7.2）。
 */
export async function listStoresWithStatus(
  db: Queryable,
  filter: { agencyId?: string },
): Promise<StoreListItem[]> {
  const res = await db.query<StoreListRow>(
    `SELECT s.id,
            s.name,
            s.place_status,
            EXISTS (
              SELECT 1 FROM competitors c WHERE c.store_id = s.id AND c.active
            ) AS competitor_configured,
            s.owner_id,
            o.display_name AS owner_display_name,
            a.id           AS agency_id,
            a.name         AS agency_name,
            s.created_at
       FROM stores s
       JOIN owners o   ON o.id = s.owner_id
       JOIN agencies a ON a.id = o.agency_id
      WHERE $1::uuid IS NULL OR a.id = $1
      ORDER BY s.created_at DESC`,
    [filter.agencyId ?? null],
  );
  return res.rows.map((row) => ({
    id: row.id,
    name: row.name,
    placeStatus: row.place_status,
    competitorConfigured: row.competitor_configured,
    ownerId: row.owner_id,
    ownerDisplayName: row.owner_display_name,
    agencyId: row.agency_id,
    agencyName: row.agency_name,
    createdAt: row.created_at,
  }));
}
