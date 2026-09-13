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
// 有効な運営の数を減らすすべての操作（無効化・降格）を、同じテナントの中で直列化する。
// 無効化と降格が別のクラスを取ると、有効な運営がちょうど 2 人のときに互いの未確定の変更を見ないまま
// 残数 2 と判定し、両方が確定して 0 人になる（write-skew・dashboard-user-edit design「並行ガードの拡張」）。
// 値は変えないこと。Cloud Run のリビジョン切替中は、旧コードの無効化と新コードの降格が並走する。
const OPERATOR_GUARD_LOCK_CLASS = 0x64756c31; // 'dul1'（dashboard-user-lifecycle）相当の固定 int4 定数

/**
 * 最後の有効な運営を保護する無効化（Req 2.3, 2.4, 2.5）。
 * トランザクション内でテナント（operator_id）単位の advisory ロックを取得して、同一テナントの
 * 有効な運営の数を減らす操作（無効化・updateDashboardUserGuarded の降格）を直列化し
 * （design「並行ガードの正当性」）、対象を無効化すると有効な運営（role=operator かつ
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
    // テナント単位の advisory ロックで、有効な運営の数を減らす操作（無効化・降格）を直列化する
    // （TX 終了で自動解放）。
    await client.query('SELECT pg_advisory_xact_lock($1::int4, hashtext($2)::int4)', [
      OPERATOR_GUARD_LOCK_CLASS,
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

// ロールと所属の組（DB の ck_dashboard_role_scope と同じ形を型で表す）。
export type DashboardUserScope =
  | { role: 'operator'; agencyId: null }
  | { role: 'agency'; agencyId: string };

// ロールと所属の変更の意図。「ロールを変える」と「代理店ロールのまま所属を移す」を区別する（Req 3.4）。
// 所属の移動を scope で表すと、古い画面から所属だけを変えたときに降格として実行されてしまう。
export type DashboardUserAssignmentChange =
  | { kind: 'scope'; scope: DashboardUserScope } // ロールを変える（所属は組で指定する）
  | { kind: 'agency'; agencyId: string }; // 代理店ロールのまま所属だけを移す

// 部分更新の入力。undefined の項目は変更しない（Req 3.1）。displayName の null は「未設定にする」。
export interface DashboardUserUpdateInput {
  assignment?: DashboardUserAssignmentChange;
  displayName?: string | null;
}

// 保護付き属性更新の結果（判別共用体・dashboard-user-edit design「DAL」）。
// 呼び出し側（ハンドラ）が 200 / 409 / 404 へ写像する。before と user はどちらも DB の行で、入力値ではない。
export type UpdateOutcome =
  | { kind: 'updated'; before: DashboardUserItem; user: DashboardUserItem } // 成功・変化なしを含む（Req 1.13）
  | { kind: 'last_operator' } // 最後の有効な運営の降格（Req 2.3）
  | { kind: 'role_changed' } // 所属の移動を求めたが、対象が代理店ロールでない（Req 3.4）
  | { kind: 'agency_not_found' } // 所属先が不在・他運営（Req 4.4）
  | { kind: 'not_found' }; // 対象が不在・他運営（Req 4.3, 4.5）

/**
 * 最後の有効な運営を保護する属性更新（dashboard-user-edit・Req 1.2〜1.5, 1.13, 2.3〜2.6, 3.1〜3.4,
 * 4.3〜4.5）。前提として、id は呼び出し側が形式を検証して小文字化し、operatorId は認証ユーザー由来である。
 *
 * - 最初に無効化と同じテナントロック（OPERATOR_GUARD_LOCK_CLASS）を取り、降格と無効化を互いに直列化する。
 * - 判定の順序は「対象の取得 → 所属の移動の前提 → 所属先の確認 → 残数の判定」で固定する。所属先を先に
 *   確かめると、他運営の利用者に他運営の代理店を指定したときに agency_not_found が返り、利用者の存在が
 *   漏れる（Req 4.5）。
 * - 更新するのは入力で指定された列（role・agency_id・display_name）だけで、disabled_at・email・
 *   auth_subject には触れない（Req 1.7, 1.8）。
 * - 差分の有無は DB が列の型（uuid など）で比べる。入力の文字列と比べると、大文字の UUID を
 *   「変化あり」と誤判定するためである。差分が無ければ行を書き換えず、before と user に同じ現在値を返す。
 * - 拒否はすべて ROLLBACK し、同じ入力に含まれていた表示名の変更も確定させない（Req 2.6, 3.4）。
 */
export async function updateDashboardUserGuarded(
  pool: TransactionCapable,
  id: string,
  operatorId: string,
  input: DashboardUserUpdateInput,
): Promise<UpdateOutcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 無効化と同じテナントロック。昇格・表示名だけの変更も同じ経路なので、結果としてロックの下で動く。
    await client.query('SELECT pg_advisory_xact_lock($1::int4, hashtext($2)::int4)', [
      OPERATOR_GUARD_LOCK_CLASS,
      operatorId,
    ]);

    // 対象を operator_id スコープで取得する（越権・不在は not_found）。
    const target = await client.query<DashboardUserItemRow>(
      `SELECT ${DASHBOARD_USER_COLUMNS} FROM dashboard_users WHERE id = $1 AND operator_id = $2`,
      [id, operatorId],
    );
    const row = target.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return { kind: 'not_found' };
    }

    const { assignment } = input;

    // 所属の移動は「代理店ロールであること」を前提にした操作である。前提が崩れていれば、降格として
    // 推測で実行せずに止める（Req 3.4）。所属先の確認より先に判定し、代理店の存在を応答から読ませない。
    if (assignment?.kind === 'agency' && row.role !== 'agency') {
      await client.query('ROLLBACK');
      return { kind: 'role_changed' };
    }

    // 所属先を operator_id スコープで確かめる（不在・他運営は同じ agency_not_found・Req 4.4）。
    // 複合 FK（fk_dashboard_agency_operator）の違反を 23503 の例外（500）にせず、業務上の結果へ写す。
    const nextAgencyId =
      assignment?.kind === 'agency'
        ? assignment.agencyId
        : assignment?.kind === 'scope'
          ? assignment.scope.agencyId
          : null;
    if (nextAgencyId !== null) {
      const agency = await client.query(
        'SELECT 1 FROM agencies WHERE id = $1 AND operator_id = $2',
        [nextAgencyId, operatorId],
      );
      if (agency.rowCount === 0) {
        await client.query('ROLLBACK');
        return { kind: 'agency_not_found' };
      }
    }

    // 有効な運営を代理店ロールへ変える場合だけ、残数を数える（保留運営も disabled_at IS NULL で計上）。
    // 無効化済みの運営の降格は有効な運営の数を変えないので判定しない（Req 2.4）。
    const demotesActiveOperator =
      assignment?.kind === 'scope' &&
      assignment.scope.role === 'agency' &&
      row.role === 'operator' &&
      row.disabled_at === null;
    if (demotesActiveOperator) {
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

    // 指定された列だけを SET する。WHERE に「どれかの列が現在値と異なる」を足し、差分が無ければ
    // 0 行更新＝行を書き換えない。比較は列の型へ明示的にキャストした値で DB が行う。
    const params: unknown[] = [id, operatorId];
    const assignments: string[] = [];
    const differs: string[] = [];
    const setColumn = (column: string, sqlType: string, value: string | null): void => {
      params.push(value);
      const placeholder = `$${params.length}::${sqlType}`;
      assignments.push(`${column} = ${placeholder}`);
      differs.push(`${column} IS DISTINCT FROM ${placeholder}`);
    };
    if (assignment?.kind === 'scope') {
      setColumn('role', 'dashboard_role', assignment.scope.role);
      setColumn('agency_id', 'uuid', assignment.scope.agencyId);
    } else if (assignment?.kind === 'agency') {
      // ロールは代理店のまま（上で確かめた）。所属の列だけを変える。
      setColumn('agency_id', 'uuid', assignment.agencyId);
    }
    if (input.displayName !== undefined) {
      setColumn('display_name', 'text', input.displayName);
    }

    const before = mapDashboardUser(row);
    if (assignments.length === 0) {
      // 変更する項目が 1 つも無い入力は、差分なしと同じ扱いにする（Req 1.13）。
      await client.query('COMMIT');
      return { kind: 'updated', before, user: mapDashboardUser(row) };
    }

    const updated = await client.query<DashboardUserItemRow>(
      `UPDATE dashboard_users SET ${assignments.join(', ')}
        WHERE id = $1 AND operator_id = $2 AND (${differs.join(' OR ')})
        RETURNING ${DASHBOARD_USER_COLUMNS}`,
      params,
    );
    await client.query('COMMIT');
    // 0 行は差分なしを意味する。対象はロックの下で取得済みで、利用者を削除する経路は無く、
    // role・agency_id・display_name を書くのはロックを取る本関数だけなので、取得時の行が現在値である。
    const updatedRow = updated.rows[0];
    return { kind: 'updated', before, user: mapDashboardUser(updatedRow ?? row) };
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
