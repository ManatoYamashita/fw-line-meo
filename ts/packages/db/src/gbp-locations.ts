import type { Queryable } from './pool.js';
import type { GbpLocationRow, Result } from './types.js';

// gbp_locations アクセサ（gbp-post-review-reply spec・Req 1.7, 2.6）。
// oauth-tokens.ts と同一のテナント隔離形状: ownerId 必須 + stores.owner_id 突合。
// gbp_locations の行は対応する oauth_tokens 行なしに存在させない（連携成立時に同時作成・
// 解除時に同時削除）が、その原子性はトランザクションを張る呼び出し側（line-webhook）の責務。

const LOCATION_COLUMNS =
  'id, store_id, account_name, location_name, place_id, can_operate_local_post, linked_at';

/** store を指す所有検証込みのキー。 */
export interface GbpLocationKey {
  ownerId: string;
  storeId: string;
}

export interface UpsertGbpLocationInput extends GbpLocationKey {
  accountName: string; // accounts/{accountId}
  locationName: string; // locations/{locationId}
  placeId: string; // 突合時点の stores.place_id
  canOperateLocalPost: boolean;
}

/**
 * GBP 上の身元を upsert する（store_id 一意・再連携は身元を置換し linked_at を更新）。
 * storeId が ownerId の所有でない（または存在しない）場合は STORE_NOT_OWNED（Req 2.6）。
 */
export async function upsertGbpLocation(
  db: Queryable,
  input: UpsertGbpLocationInput,
): Promise<Result<GbpLocationRow, 'STORE_NOT_OWNED'>> {
  const res = await db.query<GbpLocationRow>(
    `INSERT INTO gbp_locations (store_id, account_name, location_name, place_id, can_operate_local_post)
     SELECT s.id, $3, $4, $5, $6
       FROM stores s
      WHERE s.id = $1 AND s.owner_id = $2
     ON CONFLICT (store_id) DO UPDATE
        SET account_name = EXCLUDED.account_name,
            location_name = EXCLUDED.location_name,
            place_id = EXCLUDED.place_id,
            can_operate_local_post = EXCLUDED.can_operate_local_post,
            linked_at = now()
     RETURNING ${LOCATION_COLUMNS}`,
    [
      input.storeId,
      input.ownerId,
      input.accountName,
      input.locationName,
      input.placeId,
      input.canOperateLocalPost,
    ],
  );
  const row = res.rows[0];
  if (!row) return { ok: false, error: 'STORE_NOT_OWNED' };
  return { ok: true, value: row };
}

/**
 * GBP 上の身元を取得する。未連携・所有外・store 不在はいずれも null（fail-closed・Req 2.6）。
 */
export async function getGbpLocation(
  db: Queryable,
  key: GbpLocationKey,
): Promise<GbpLocationRow | null> {
  const res = await db.query<GbpLocationRow>(
    `SELECT l.id, l.store_id, l.account_name, l.location_name, l.place_id,
            l.can_operate_local_post, l.linked_at
       FROM gbp_locations l
       JOIN stores s ON s.id = l.store_id
      WHERE s.id = $1 AND s.owner_id = $2`,
    [key.storeId, key.ownerId],
  );
  return res.rows[0] ?? null;
}

/**
 * GBP 上の身元を削除する（連携解除・Req 2.4）。戻り値は行が消えたか。
 * 所有外・不在は削除せず false（冪等・Req 1.7）。
 */
export async function deleteGbpLocation(db: Queryable, key: GbpLocationKey): Promise<boolean> {
  const res = await db.query(
    `DELETE FROM gbp_locations l
      USING stores s
      WHERE s.id = l.store_id AND s.id = $1 AND s.owner_id = $2`,
    [key.storeId, key.ownerId],
  );
  return (res.rowCount ?? 0) > 0;
}
