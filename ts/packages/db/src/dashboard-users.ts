import type { Queryable, TransactionCapable } from './pool.js';
import type { DashboardRole, DashboardUserItem } from './types.js';

// RBAC 判定に必要な認証主体の身元（auth_subject = Identity Platform UID から解決）。
export interface DashboardUserIdentity {
  id: string;
  role: DashboardRole;
  operatorId: string;
  agencyId: string | null;
}

// findByAuthSubject の解決結果。Identity に無効化状態を加えた上位互換の拡張。
// 既存呼び出し元（qr 経路など）は DashboardUserIdentity としてそのまま扱え、
// 認証層（Task 2.1）は disabled: true をログイン拒否に写像する（Req 6.4）。
export interface DashboardUserResolution extends DashboardUserIdentity {
  disabled: boolean;
}

/**
 * Identity Platform の subject から dashboard_user を引く（未登録は null）。
 * disabled_at を同梱し、無効化済み（disabled: true）かどうかを呼び出し側が判定できる（Req 6.4）。
 */
export async function findByAuthSubject(
  db: Queryable,
  authSubject: string,
): Promise<DashboardUserResolution | null> {
  const res = await db.query<{
    id: string;
    role: DashboardRole;
    operator_id: string;
    agency_id: string | null;
    disabled_at: Date | null;
  }>(
    'SELECT id, role, operator_id, agency_id, disabled_at FROM dashboard_users WHERE auth_subject = $1',
    [authSubject],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    role: row.role,
    operatorId: row.operator_id,
    agencyId: row.agency_id,
    disabled: row.disabled_at !== null,
  };
}

/**
 * 初回 Google ログイン時に、事前登録された保留行へ auth_subject を原子的に埋める（案B・Req 6.2）。
 * 読取→書込ではなく単一の UPDATE...RETURNING で、auth_subject IS NULL かつ disabled_at IS NULL の
 * 行だけを対象にする（lower(email) 照合で大文字小文字を無視）。
 * - 一致する保留・有効行があればその身元を返す。
 * - 既にリンク済み（auth_subject 非 NULL）・無効化済み・該当メールなしは 0 行 → null。
 * normalizedEmail は呼び出し側で trim + 小文字化済みであることを前提とする。
 */
export async function linkAuthSubjectByEmail(
  db: Queryable,
  normalizedEmail: string,
  uid: string,
): Promise<DashboardUserIdentity | null> {
  const res = await db.query<{
    id: string;
    role: DashboardRole;
    operator_id: string;
    agency_id: string | null;
  }>(
    `UPDATE dashboard_users
        SET auth_subject = $2
      WHERE lower(email) = $1
        AND auth_subject IS NULL
        AND disabled_at IS NULL
      RETURNING id, role, operator_id, agency_id`,
    [normalizedEmail, uid],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    role: row.role,
    operatorId: row.operator_id,
    agencyId: row.agency_id,
  };
}

const DASHBOARD_USER_COLUMNS =
  'id, role, operator_id, agency_id, email, display_name, disabled_at, created_at';

interface DashboardUserItemRow {
  id: string;
  role: DashboardRole;
  operator_id: string;
  agency_id: string | null;
  email: string | null;
  display_name: string | null;
  disabled_at: Date | null;
  created_at: Date;
}

function mapDashboardUser(row: DashboardUserItemRow): DashboardUserItem {
  return {
    id: row.id,
    role: row.role,
    operatorId: row.operator_id,
    agencyId: row.agency_id,
    email: row.email,
    displayName: row.display_name,
    disabled: row.disabled_at !== null,
    createdAt: row.created_at,
  };
}

/**
 * 運営が未ログインのダッシュボード利用者を事前登録する（保留行・案B・Req 6.2, 6.3）。
 * auth_subject は NULL（初回ログインで linkAuthSubjectByEmail が埋める）、email を正規化保存する。
 * role/agency_id の整合（operator ⇒ agency_id NULL / agency ⇒ agency_id 非 NULL）は
 * ck_dashboard_role_scope が DB 側で強制する。agencyId は呼び出し側指定値をそのまま渡す。
 * email は trim + 小文字化して保存し、linkAuthSubjectByEmail の lower(email) 照合と一貫させる。
 */
export async function createPendingDashboardUser(
  db: Queryable,
  input: {
    role: DashboardRole;
    operatorId: string;
    agencyId: string | null;
    email: string;
    displayName?: string | null;
  },
): Promise<DashboardUserItem> {
  const normalizedEmail = input.email.trim().toLowerCase();
  const res = await db.query<DashboardUserItemRow>(
    `INSERT INTO dashboard_users (role, operator_id, agency_id, email, display_name)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${DASHBOARD_USER_COLUMNS}`,
    [input.role, input.operatorId, input.agencyId, normalizedEmail, input.displayName ?? null],
  );
  const row = res.rows[0];
  if (!row) throw new Error('createPendingDashboardUser: insert did not return a row');
  return mapDashboardUser(row);
}

/** 指定運営に属するダッシュボード利用者を作成日時の降順で一覧する（Req 6.1・operator スコープ）。 */
export async function listDashboardUsers(
  db: Queryable,
  operatorId: string,
): Promise<DashboardUserItem[]> {
  const res = await db.query<DashboardUserItemRow>(
    `SELECT ${DASHBOARD_USER_COLUMNS}
       FROM dashboard_users WHERE operator_id = $1 ORDER BY created_at DESC`,
    [operatorId],
  );
  return res.rows.map(mapDashboardUser);
}

// 保護付き無効化の結果（判別共用体・design「Component Contracts / DAL」）。
// 呼び出し側（ハンドラ）が 200 / 409 / 404 へ写像する。
export type DisableOutcome =
  | { kind: 'disabled'; user: DashboardUserItem } // 無効化成功／既に無効（冪等）
  | { kind: 'last_operator' } // 最後の有効な運営のため拒否（Req 2.3）
  | { kind: 'not_found' }; // 不在・越権（呼び出し側で 404 に写像）

// operator_id を鍵とする advisory ロックの名前空間（他用途の advisory ロックと衝突させない固定クラス）。
const DISABLE_LOCK_CLASS = 0x64756c31; // 'dul1'（dashboard-user-lifecycle）相当の固定 int4 定数

/**
 * 最後の有効な運営を保護する無効化（Req 2.3, 2.4, 2.5）。
 * トランザクション内でテナント（operator_id）単位の advisory ロックを取得して同一テナントの無効化を
 * 直列化し（design「並行ガードの正当性」）、対象を無効化すると有効な運営（role=operator かつ
 * disabled_at IS NULL・保留＝未ログイン運営を含む）が0人になる場合のみ 'last_operator' を返す。
 * ロックによる直列化のため残数判定は自明に正しく（write-skew を排除）、並行実行下でも0人化しない。
 * operator_id をスコープ列に含め、越権・不在は 'not_found'。既に無効な対象は現状を返し冪等（'disabled'）。
 */
export async function disableDashboardUserGuarded(
  pool: TransactionCapable,
  id: string,
  operatorId: string,
): Promise<DisableOutcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // テナント単位の advisory ロックで無効化操作を直列化する（TX 終了で自動解放）。
    await client.query('SELECT pg_advisory_xact_lock($1::int4, hashtext($2)::int4)', [
      DISABLE_LOCK_CLASS,
      operatorId,
    ]);

    // 対象行を operator_id スコープで取得（越権・不在は not_found）。
    const target = await client.query<DashboardUserItemRow>(
      `SELECT ${DASHBOARD_USER_COLUMNS} FROM dashboard_users WHERE id = $1 AND operator_id = $2`,
      [id, operatorId],
    );
    const row = target.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return { kind: 'not_found' };
    }

    // 既に無効なら冪等に現状を返す（有効運営数を減らさないためガード判定は不要）。
    if (row.disabled_at !== null) {
      await client.query('COMMIT');
      return { kind: 'disabled', user: mapDashboardUser(row) };
    }

    // 運営を無効化する場合のみ、最後の有効な運営の保護を判定する（保留運営も disabled_at IS NULL で計上）。
    if (row.role === 'operator') {
      const active = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM dashboard_users
          WHERE operator_id = $1 AND role = 'operator' AND disabled_at IS NULL`,
        [operatorId],
      );
      if ((active.rows[0]?.n ?? 0) <= 1) {
        await client.query('ROLLBACK');
        return { kind: 'last_operator' };
      }
    }

    const updated = await client.query<DashboardUserItemRow>(
      `UPDATE dashboard_users SET disabled_at = now()
        WHERE id = $1 AND operator_id = $2
        RETURNING ${DASHBOARD_USER_COLUMNS}`,
      [id, operatorId],
    );
    await client.query('COMMIT');
    const updatedRow = updated.rows[0];
    if (!updatedRow) throw new Error('disableDashboardUserGuarded: update did not return a row');
    return { kind: 'disabled', user: mapDashboardUser(updatedRow) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 無効化済みダッシュボード利用者を再有効化する（Req 1.1, 1.4）。disabled_at を NULL へ戻すのみ。
 * operator_id をスコープ列として WHERE に含め、越権（他運営の id 指定）・不在は 0 行更新 → null を返す
 * （呼び出し側は 404 に写像・Req 1.5, 4.1）。disabled_at をフィルタしないため、既に有効な行でも
 * 同じ内容を返して冪等に振る舞う（Req 1.4）。リンク済み行はロール・所属を保持したまま復帰し（Req 1.2）、
 * 保留行は disabled_at IS NULL 復帰により linkAuthSubjectByEmail（無変更）の対象へ再び入る（Req 1.3）。
 */
export async function enableDashboardUser(
  db: Queryable,
  id: string,
  operatorId: string,
): Promise<DashboardUserItem | null> {
  const res = await db.query<DashboardUserItemRow>(
    `UPDATE dashboard_users
        SET disabled_at = NULL
      WHERE id = $1 AND operator_id = $2
      RETURNING ${DASHBOARD_USER_COLUMNS}`,
    [id, operatorId],
  );
  const row = res.rows[0];
  return row ? mapDashboardUser(row) : null;
}

/**
 * 一意衝突時の 409 案内強化用スコープ限定ルックアップ（Req 3.2）。呼び出し運営（operator_id）配下に
 * 同一メール（lower(email) 照合）が存在する場合のみ { id, disabled } を返す。
 * operator_id をスコープ列に含めることで、他運営配下の同一メールは 0 行 → null で秘匿し越境を漏らさない
 * （Req 3.2, 4.1）。normalizedEmail は呼び出し側で trim + 小文字化済みである前提だが、照合自体は
 * lower(email) で行い格納値の大文字小文字を無視する。disabled は disabled_at の非 NULL 性で判定する。
 */
export async function findDashboardUserByEmailInOperator(
  db: Queryable,
  normalizedEmail: string,
  operatorId: string,
): Promise<{ id: string; disabled: boolean } | null> {
  const res = await db.query<{ id: string; disabled_at: Date | null }>(
    'SELECT id, disabled_at FROM dashboard_users WHERE lower(email) = $1 AND operator_id = $2',
    [normalizedEmail, operatorId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { id: row.id, disabled: row.disabled_at !== null };
}

/** 利用者の表示名を単一取得する（GET /me の displayName 用・不在は null）。 */
export async function findDashboardUserDisplayName(
  db: Queryable,
  userId: string,
): Promise<string | null> {
  const res = await db.query<{ display_name: string | null }>(
    'SELECT display_name FROM dashboard_users WHERE id = $1',
    [userId],
  );
  return res.rows[0]?.display_name ?? null;
}
