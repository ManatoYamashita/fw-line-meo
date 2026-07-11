import type { Queryable } from './pool.js';
import type { PlaceStatus } from './types.js';

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
