import type { Queryable } from './pool.js';
import type { OwnerRow } from './types.js';

const OWNER_COLUMNS =
  'id, agency_id, line_user_id, display_name, onboarding_status, created_at';

export interface CreateOwnerInput {
  agencyId: string;
  lineUserId: string;
  displayName?: string | null;
}

/** LINE ユーザー ID から owner を取得する（未登録・友だち追加前は null。Req 1.2, 5.2）。 */
export async function findOwnerByLineUserId(
  db: Queryable,
  lineUserId: string,
): Promise<OwnerRow | null> {
  const res = await db.query<OwnerRow>(
    `SELECT ${OWNER_COLUMNS} FROM owners WHERE line_user_id = $1`,
    [lineUserId],
  );
  return res.rows[0] ?? null;
}

/**
 * 有効な招待コード検証後に owner を新規作成する（Req 2.1）。
 * agency_id は非 null 必須（呼び出し側の型で強制・DB の NOT NULL とあわせて Req 2.4 を構造保証）。
 * onboarding_status は列デフォルト 'pending' のまま作成される。
 */
export async function createOwner(db: Queryable, input: CreateOwnerInput): Promise<OwnerRow> {
  const res = await db.query<OwnerRow>(
    `INSERT INTO owners (agency_id, line_user_id, display_name)
     VALUES ($1, $2, $3)
     RETURNING ${OWNER_COLUMNS}`,
    [input.agencyId, input.lineUserId, input.displayName ?? null],
  );
  const row = res.rows[0];
  if (!row) throw new Error('createOwner: insert did not return a row');
  return row;
}

/** 店舗確定完了時に owner を store_identified へ遷移させる（Req 4.2。confirmStore TX 内で使用）。 */
export async function markOwnerStoreIdentified(db: Queryable, ownerId: string): Promise<void> {
  await db.query(`UPDATE owners SET onboarding_status = 'store_identified' WHERE id = $1`, [
    ownerId,
  ]);
}
