import type { Queryable } from './pool.js';
import type { OnboardingStatus, OwnerListItem, OwnerRow } from './types.js';

const OWNER_COLUMNS =
  'id, agency_id, line_user_id, display_name, onboarding_status, created_at, invite_code_id, ' +
  'line_unlinked_at, menu_pending_line_user_id, taken_over_by_owner_id';

export interface CreateOwnerInput {
  agencyId: string;
  /**
   * 登録に用いた招待コードの行の id（agency-dashboard Req 8.1）。findActiveInviteCode の結果から渡す。
   * 必須にしてある。省略可能にすると、owners を作る経路を足したときに書き忘れても型検査を通り、
   * 導入後の登録なのに「記録なし」になる。
   */
  inviteCodeId: string;
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
 * owner id から owner を取得する（未存在は null）。
 * OAuth callback など「LINE の webhook 起点ではない経路」から通知先の line_user_id を
 * 解決するために使う（gbp-post-review-reply Req 1.4, 1.5, 1.6）。
 */
export async function findOwnerById(db: Queryable, ownerId: string): Promise<OwnerRow | null> {
  const res = await db.query<OwnerRow>(
    `SELECT ${OWNER_COLUMNS} FROM owners WHERE id = $1`,
    [ownerId],
  );
  return res.rows[0] ?? null;
}

/**
 * 有効な招待コード検証後に owner を新規作成する（Req 2.1）。
 * agency_id は非 null 必須（呼び出し側の型で強制・DB の NOT NULL とあわせて Req 2.4 を構造保証）。
 * 登録に用いた招待コードを同じ INSERT で invite_code_id に書く（agency-dashboard Req 8.1）。
 * 代理店と食い違うコードは複合 FK fk_owners_invite_code_same_agency が拒否する（Req 8.2）。
 * onboarding_status は列デフォルト 'pending' のまま作成される。
 */
export async function createOwner(db: Queryable, input: CreateOwnerInput): Promise<OwnerRow> {
  const res = await db.query<OwnerRow>(
    `INSERT INTO owners (agency_id, invite_code_id, line_user_id, display_name)
     VALUES ($1, $2, $3, $4)
     RETURNING ${OWNER_COLUMNS}`,
    [input.agencyId, input.inviteCodeId, input.lineUserId, input.displayName ?? null],
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

/**
 * ダッシュボードの店舗登録でオーナーを選ぶための一覧（agency-dashboard spec・Req 2.1）。
 * 指定代理店に属する owner のみを作成日時の降順で返す（他代理店は漏れない）。
 * 登録に用いられた招待コードを inviteCode として添える。記録の無いオーナー（0017 より前の登録）は
 * null で、推定で埋めない（Req 8.4, 8.5）。無効化されたコードも結びつきは残り、disabled: true で返す（Req 8.3）。
 */
export async function listOwnersByAgency(
  db: Queryable,
  agencyId: string,
): Promise<OwnerListItem[]> {
  const res = await db.query<{
    id: string;
    display_name: string | null;
    onboarding_status: OnboardingStatus;
    created_at: Date;
    invite_code_id: string | null;
    invite_code: string | null;
    invite_code_disabled_at: Date | null;
  }>(
    `SELECT o.id, o.display_name, o.onboarding_status, o.created_at,
            o.invite_code_id, c.code AS invite_code, c.disabled_at AS invite_code_disabled_at
       FROM owners o
       LEFT JOIN agency_invite_codes c ON c.id = o.invite_code_id
      WHERE o.agency_id = $1
      ORDER BY o.created_at DESC`,
    [agencyId],
  );
  return res.rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    onboardingStatus: row.onboarding_status,
    createdAt: row.created_at,
    inviteCode:
      row.invite_code_id !== null && row.invite_code !== null
        ? {
            id: row.invite_code_id,
            code: row.invite_code,
            disabled: row.invite_code_disabled_at !== null,
          }
        : null,
  }));
}

/**
 * owner の所属代理店を引く（店舗登録時のスコープ検証用・Req 2.4）。不在は null。
 */
export async function findOwnerWithAgency(
  db: Queryable,
  ownerId: string,
): Promise<{ id: string; agencyId: string } | null> {
  const res = await db.query<{ id: string; agency_id: string }>(
    'SELECT id, agency_id FROM owners WHERE id = $1',
    [ownerId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { id: row.id, agencyId: row.agency_id };
}
