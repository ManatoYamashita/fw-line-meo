import type {
  AgencyItem,
  AuditLogAction,
  AuditLogger,
  DashboardRole,
  DashboardUserAssignmentChange,
  DashboardUserIdentity,
  DashboardUserItem,
  DashboardUserScope,
  DashboardUserUpdateInput,
  DisableOutcome,
  UpdateOutcome,
} from '@fwlm/db';
import { authenticate, type AuthDeps } from './auth.js';
import { requireOperator } from './scope.js';
import { isUniqueViolation } from './invite-code-gen.js';
import { jsonError } from './http.js';

// 管理 API（運営専用）: GET/POST /agencies・GET/POST /dashboard-users・
// POST /dashboard-users/:id/{disable,enable,update} の中核ロジック（依存注入でテスト可能・
// ルート配線は app 側の責務。Req 6.1–6.5）。
// 全ハンドラ共通の前置ガード: 認証 → 401/403 → requireOperator（agency ロールは 403 forbidden・
// dep を一切呼ばない・Req 6.5）。以降の全 DAL 呼び出しは運営自身の operatorId でスコープする。
// operator の operatorId は認証ユーザー由来であり、クライアント入力は信用しない（Req 7.1）。

// --- JSON 出力形（Date は ISO 8601 文字列へ明示変換する）---

export interface AgencyItemJson {
  id: string;
  operatorId: string;
  name: string;
  createdAt: string; // ISO 8601
}

export interface DashboardUserItemJson {
  id: string;
  role: DashboardRole;
  operatorId: string;
  agencyId: string | null;
  email: string | null;
  displayName: string | null;
  disabled: boolean;
  createdAt: string; // ISO 8601
}

// --- 依存注入契約・入力型 ---

export interface AgencyCreateInput {
  operatorId: string;
  name: string;
}

export interface DashboardUserCreateInput {
  role: DashboardRole;
  operatorId: string;
  agencyId: string | null;
  email: string;
  displayName: string | null;
}

export interface AgenciesListDeps {
  auth: AuthDeps;
  // listAgencies（@fwlm/db）を部分適用した一覧取得（operator_id で絞り込み済み）。
  listAgencies: (operatorId: string) => Promise<AgencyItem[]>;
}

export interface AgencyCreateDeps {
  auth: AuthDeps;
  // createAgency（@fwlm/db）委譲。operatorId は認証ユーザー由来をハンドラが設定する。
  createAgency: (input: AgencyCreateInput) => Promise<AgencyItem>;
  auditLog?: AuditLogger;
}

export interface DashboardUsersListDeps {
  auth: AuthDeps;
  // listDashboardUsers（@fwlm/db）を部分適用した一覧取得（operator_id で絞り込み済み）。
  listUsers: (operatorId: string) => Promise<DashboardUserItem[]>;
}

export interface DashboardUserCreateDeps {
  auth: AuthDeps;
  // createPendingDashboardUser（@fwlm/db）委譲（保留行の事前登録・案B）。
  // email UNIQUE 衝突（pg 23505）は本ハンドラが 409 email_conflict に写像する。
  createUser: (input: DashboardUserCreateInput) => Promise<DashboardUserItem>;
  // 409 強化用のスコープ限定ルックアップ（findDashboardUserByEmailInOperator を委譲・Req 3.2）。
  // 一意違反（23505）捕捉時に、自運営（operatorId）配下の同一メールの無効化状態を引く。
  // 見つかり disabled なら 409 email_conflict_disabled（再有効化での復旧を案内）、そうでなければ
  // （有効な自運営衝突・または越境で null）汎用 email_conflict を維持し越境の存在を漏らさない（Req 4.4）。
  findUserByEmailInOperator: (
    operatorId: string,
    normalizedEmail: string,
  ) => Promise<{ id: string; disabled: boolean } | null>;
  auditLog?: AuditLogger;
}

export interface DashboardUserDisableDeps {
  auth: AuthDeps;
  // disableDashboardUserGuarded（@fwlm/db）委譲。operator_id をスコープ列に含む保護付き無効化で、
  // 結果を判別共用体 DisableOutcome で返す（本ハンドラが 200 / 409 / 404 に写像する）:
  //   - 'disabled'（成功／既に無効・冪等）／'last_operator'（最後の有効な運営で拒否・Req 2.3）／
  //     'not_found'（不在・越権の秘匿・Req 1.5）。拒否時は DAL が ROLLBACK 済みで対象状態不変（Req 2.6）。
  disableUser: (id: string, operatorId: string) => Promise<DisableOutcome>;
  auditLog?: AuditLogger;
}

export interface DashboardUserEnableDeps {
  auth: AuthDeps;
  // enableDashboardUser（@fwlm/db）委譲。operator_id をスコープ列に含む再有効化（disabled_at を
  // NULL に戻す）で、行があればその利用者を返す（既に有効でも冪等に行を返す・Req 1.1, 1.4）。
  // 不在・越権は null（本ハンドラが 404 に写像・存在の秘匿・Req 1.5, 4.1）。
  enableUser: (id: string, operatorId: string) => Promise<DashboardUserItem | null>;
  auditLog?: AuditLogger;
}

export interface DashboardUserUpdateDeps {
  auth: AuthDeps;
  // updateDashboardUserGuarded（@fwlm/db）委譲。無効化と同じテナントロックの下で、所属の移動の前提・
  // 所属先・最後の有効な運営を確かめてから部分更新し、結果を判別共用体 UpdateOutcome で返す
  // （本ハンドラが 200 / 409 / 404 に写像する）。拒否時は DAL が ROLLBACK 済みで、同じ入力の
  // 表示名の変更も含めて対象は変わらない（dashboard-user-edit Req 2.6, 3.4）。
  // id は本ハンドラが形式を検証して小文字化した値、operatorId は認証ユーザー由来である。
  updateUser: (
    id: string,
    operatorId: string,
    input: DashboardUserUpdateInput,
  ) => Promise<UpdateOutcome>;
  auditLog?: AuditLogger;
}

// --- リクエスト形 ---

export interface AgenciesListRequest {
  authorization: string | undefined;
}

export interface AgencyCreateRequest {
  authorization: string | undefined;
  body: unknown; // ルート層でパースした JSON body（形状は本ハンドラが検証する）。
}

export interface DashboardUsersListRequest {
  authorization: string | undefined;
}

export interface DashboardUserCreateRequest {
  authorization: string | undefined;
  body: unknown;
}

export interface DashboardUserDisableRequest {
  authorization: string | undefined;
  id: string; // パスパラメータ :id（UUID 形式を事前検証する）。
}

export interface DashboardUserEnableRequest {
  authorization: string | undefined;
  id: string; // パスパラメータ :id（UUID 形式を事前検証する・disable と同型）。
}

export interface DashboardUserUpdateRequest {
  authorization: string | undefined;
  id: string; // パスパラメータ :id（UUID 形式を事前検証し、小文字へ正規化する・disable と同型）。
  body: unknown; // ルート層の readJsonBody でパースした JSON body（形状は本ハンドラが検証する）。
}

// UUID 形式でない id は DB を叩かず 404 扱い（存在の探り当てを許さない・invite-codes と同じ規律）。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- GET /agencies ---

export async function handleAgenciesList(
  deps: AgenciesListDeps,
  req: AgenciesListRequest,
): Promise<Response> {
  const guard = await requireOperatorUser(deps.auth, req.authorization);
  if (!guard.ok) return guard.response;

  const items = await deps.listAgencies(guard.user.operatorId);
  return jsonOk(200, { agencies: items.map(toAgencyJson) });
}

// --- POST /agencies ---

export async function handleAgencyCreate(
  deps: AgencyCreateDeps,
  req: AgencyCreateRequest,
): Promise<Response> {
  const guard = await requireOperatorUser(deps.auth, req.authorization);
  if (!guard.ok) return guard.response;

  // name 検証（トリム後に非空の文字列のみ許可）。不正なら DAL を呼ばない。
  const name = parseName(req.body);
  if (name === null) {
    return jsonError(400, 'validation_failed', '代理店名を入力してください');
  }

  // operatorId は認証ユーザー由来（クライアント入力の operatorId は無視する・Req 7.1）。
  const agency = await deps.createAgency({ operatorId: guard.user.operatorId, name });
  await deps.auditLog?.({
    actorType: 'operator',
    actorId: guard.user.id,
    action: 'agency_created',
    targetType: 'agency',
    targetId: agency.id,
  });
  return jsonOk(201, { agency: toAgencyJson(agency) });
}

// --- GET /dashboard-users ---

export async function handleDashboardUsersList(
  deps: DashboardUsersListDeps,
  req: DashboardUsersListRequest,
): Promise<Response> {
  const guard = await requireOperatorUser(deps.auth, req.authorization);
  if (!guard.ok) return guard.response;

  const items = await deps.listUsers(guard.user.operatorId);
  return jsonOk(200, { users: items.map(toUserJson) });
}

// --- POST /dashboard-users ---

export async function handleDashboardUserCreate(
  deps: DashboardUserCreateDeps,
  req: DashboardUserCreateRequest,
): Promise<Response> {
  const guard = await requireOperatorUser(deps.auth, req.authorization);
  if (!guard.ok) return guard.response;

  // body 形状・整合検証（role・role別の agencyId・email・displayName）。ck_dashboard_role_scope を
  // アプリ側でも先取りして検証する（agency ⇒ agencyId 必須 / operator ⇒ agencyId 不可・Req 6.3）。
  const parsed = parseCreateUserBody(req.body);
  if (parsed === null) {
    return jsonError(400, 'validation_failed', '入力内容が正しくありません');
  }

  // operatorId は認証ユーザー由来（Req 7.1）。email は正規化済み（trim + 小文字化）を渡す。
  let user: DashboardUserItem;
  try {
    user = await deps.createUser({
      role: parsed.role,
      operatorId: guard.user.operatorId,
      agencyId: parsed.agencyId,
      email: parsed.email,
      displayName: parsed.displayName,
    });
  } catch (err) {
    // email UNIQUE 衝突（pg 23505）のみ 409 に写像。auth_subject は保留行では NULL のため
    // 衝突し得る UNIQUE は email に限られる。それ以外の障害は詳細を漏らさず 500（Req 7.4）。
    if (isUniqueViolation(err)) {
      // スコープ限定ルックアップで衝突相手の状態を引く（parsed.email は trim + 小文字化済み・
      // operatorId は認証ユーザー由来）。他運営配下の衝突は operator_id スコープで null が返るため
      // 自動的に汎用 email_conflict になり、越境相手の存在・状態を漏らさない（Req 4.4・越境秘匿）。
      const existing = await deps.findUserByEmailInOperator(guard.user.operatorId, parsed.email);
      if (existing !== null && existing.disabled) {
        // 自運営配下の無効化済みメール。復旧は再有効化に一本化するため専用コードで案内する（Req 3.2）。
        return jsonError(
          409,
          'email_conflict_disabled',
          'このメールアドレスは無効化済みの利用者です。復旧するには利用者管理から有効化してください',
        );
      }
      // 有効な自運営衝突・または越境（null）は汎用の重複案内を維持する（Req 3.1・越境秘匿 4.4）。
      return jsonError(409, 'email_conflict', '既に登録済みのメールアドレスです');
    }
    return jsonError(500, 'internal', '利用者の登録に失敗しました。時間をおいて再試行してください');
  }
  await deps.auditLog?.({
    actorType: 'operator',
    actorId: guard.user.id,
    action: 'dashboard_user_created',
    targetType: 'dashboard_user',
    targetId: user.id,
  });
  return jsonOk(201, { user: toUserJson(user) });
}

// --- POST /dashboard-users/:id/disable ---

export async function handleDashboardUserDisable(
  deps: DashboardUserDisableDeps,
  req: DashboardUserDisableRequest,
): Promise<Response> {
  const guard = await requireOperatorUser(deps.auth, req.authorization);
  if (!guard.ok) return guard.response;

  // UUID 事前ガード（DAL に到達させない）。不正形式は不在と同じ 404（存在の秘匿）。
  if (!UUID_RE.test(req.id)) {
    return jsonError(404, 'not_found', '利用者が見つかりません');
  }

  // UUID を小文字へ正規化してから自己判定・DAL へ渡す。UUID_RE は /i のため大文字表記も通過するが、
  // PostgreSQL の uuid 比較は大文字小文字を無視するため、厳密文字列一致だけでは大文字表記で
  // 自己無効化ガードを迂回できてしまう（guard.user.id は PG 由来で小文字正規形）。
  const targetId = req.id.toLowerCase();

  // 自己無効化拒否（DB 到達前・Req 2.1）。運営が自分自身を無効化するとテナントごとロックアウトし得るため
  // 構造的に禁止する。guard.user.id は認証ユーザー由来（UUID）で、クライアント入力は信用しない。
  if (targetId === guard.user.id) {
    return jsonError(409, 'self_disable_forbidden', '自分自身は無効化できません');
  }

  // 保護付き無効化。結果を HTTP へ写像する（Req 2.3, 2.4, 2.6, 1.5）。拒否時は DAL が ROLLBACK 済みで
  // 対象状態は変わらない（成功と誤認されない明確な表示・Req 2.6）。
  const outcome = await deps.disableUser(targetId, guard.user.operatorId);
  if (outcome.kind === 'disabled') {
    // 無効化成功／既に無効（冪等）。現状の利用者行を 200 で返す（Req 2.4）。
    await deps.auditLog?.({
      actorType: 'operator',
      actorId: guard.user.id,
      action: 'dashboard_user_disabled',
      targetType: 'dashboard_user',
      targetId: outcome.user.id,
    });
    return jsonOk(200, { user: toUserJson(outcome.user) });
  }
  if (outcome.kind === 'last_operator') {
    // 最後の有効な運営は無効化できない（ロックアウト防止・Req 2.3）。
    return jsonError(
      409,
      'last_operator',
      '最後の運営は無効化できないため、先に別の運営を追加してください',
    );
  }
  // outcome.kind === 'not_found'（不在・越権）は不在と同じ 404（存在の秘匿・Req 1.5）。
  return jsonError(404, 'not_found', '利用者が見つかりません');
}

// --- POST /dashboard-users/:id/enable ---

export async function handleDashboardUserEnable(
  deps: DashboardUserEnableDeps,
  req: DashboardUserEnableRequest,
): Promise<Response> {
  const guard = await requireOperatorUser(deps.auth, req.authorization);
  if (!guard.ok) return guard.response;

  // UUID 事前ガード（DAL に到達させない）。不正形式は不在と同じ 404（存在の秘匿・disable と同じ規律）。
  if (!UUID_RE.test(req.id)) {
    return jsonError(404, 'not_found', '利用者が見つかりません');
  }

  // 再有効化（disabled_at を NULL に戻す・既に有効でも冪等に行を返す・Req 1.1, 1.4）。
  // operator_id スコープで引くため、不在・越権は null（Req 1.5, 4.1）。紐付けの安全条件は不変で、
  // 保留行はこれにより初回ログイン紐付けの対象に再び入る（linkAuthSubjectByEmail は無変更・Req 4.3）。
  const user = await deps.enableUser(req.id, guard.user.operatorId);
  if (user === null) {
    // 不在・越権は不在と同じ 404（存在の秘匿・Req 1.5, 4.1）。
    return jsonError(404, 'not_found', '利用者が見つかりません');
  }
  await deps.auditLog?.({
    actorType: 'operator',
    actorId: guard.user.id,
    action: 'dashboard_user_enabled',
    targetType: 'dashboard_user',
    targetId: user.id,
  });
  return jsonOk(200, { user: toUserJson(user) });
}

// --- POST /dashboard-users/:id/update ---

export async function handleDashboardUserUpdate(
  deps: DashboardUserUpdateDeps,
  req: DashboardUserUpdateRequest,
): Promise<Response> {
  const guard = await requireOperatorUser(deps.auth, req.authorization);
  if (!guard.ok) return guard.response;

  // UUID 事前ガード（DAL に到達させない）。不正形式は不在と同じ 404（存在の秘匿・disable と同じ規律）。
  if (!UUID_RE.test(req.id)) {
    return jsonError(404, 'not_found', '利用者が見つかりません');
  }

  // UUID を小文字へ正規化してから自己判定・DAL へ渡す（無効化と同じ理由・dashboard-user-edit Req 4.6）。
  // UUID_RE は /i のため大文字表記も通過するが、PostgreSQL の uuid 比較は大文字小文字を無視するため、
  // 厳密文字列一致だけでは大文字表記で自分のロール変更の禁止を迂回できてしまう
  // （guard.user.id は PG 由来で小文字正規形）。
  const targetId = req.id.toLowerCase();

  // body を「ロールを変える」「代理店ロールのまま所属を移す」「表示名」へ写す。不正なら DAL を呼ばない。
  const input = parseUpdateUserBody(req.body);
  if (input === null) {
    return jsonError(400, 'validation_failed', '入力内容が正しくありません');
  }

  // 自分のロール・所属の変更の拒否（DB 到達前・Req 2.1）。行為者は必ず運営で所属を持たないので、
  // 自分に許す assignment は「運営のまま」だけである。代理店ロールへの変更と所属の移動はどちらも
  // 自分の権限を変える。表示名だけの変更と、変化の無い「運営」の指定は許す（Req 2.2）。
  if (targetId === guard.user.id && changesOwnAssignment(input.assignment)) {
    return jsonError(409, 'self_role_change_forbidden', '自分自身のロールは変更できません');
  }

  // 保護付き属性更新。結果を HTTP へ写像する。拒否時は DAL が ROLLBACK 済みで対象は変わらない（Req 2.6）。
  const outcome = await deps.updateUser(targetId, guard.user.operatorId, input);
  switch (outcome.kind) {
    case 'updated': {
      // 前後の DB 行の差分から action を導き、1 件ずつ記録する。変化なしは 0 件（Req 5.1, 5.3, 5.5）。
      // 監査は業務の書込を確定した後に書く（既存の書込と同じ形・失敗時の扱いは #250 が決める）。
      for (const action of auditActionsForUserUpdate(outcome.before, outcome.user)) {
        await deps.auditLog?.({
          actorType: 'operator',
          actorId: guard.user.id,
          action,
          targetType: 'dashboard_user',
          targetId: outcome.user.id,
        });
      }
      return jsonOk(200, { user: toUserJson(outcome.user) });
    }
    case 'last_operator':
      // 最後の有効な運営は代理店に変更できない（ロックアウト防止・Req 2.3）。
      return jsonError(
        409,
        'last_operator',
        '最後の運営は代理店に変更できないため、先に別の運営を追加してください',
      );
    case 'role_changed':
      // 所属の移動を求めたが、他の操作で対象が代理店ロールでなくなっていた。降格として推測で
      // 実行せず、画面の再読み込みを促す（Req 3.4）。
      return jsonError(
        409,
        'role_changed',
        '他の操作でロールが変わったため、所属代理店を変更できませんでした。画面を再読み込みしてください',
      );
    case 'agency_not_found':
      // 所属先の不在・他運営の代理店は同じ応答にする（存在の秘匿・Req 4.4）。
      return jsonError(404, 'agency_not_found', '所属代理店が見つかりません');
    case 'not_found':
      // 対象の不在・他運営の利用者は不在と同じ 404（存在の秘匿・Req 4.3, 4.5）。
      return jsonError(404, 'not_found', '利用者が見つかりません');
  }
}

/**
 * 前後の DB 行の差分から、記録すべき監査 action を並べる（dashboard-user-edit Req 5.1〜5.5）。
 *
 * - 出力の順序は「ロール・所属 → 表示名」で固定する。
 * - 降格は所属の設定を含めて `dashboard_user_demoted_to_agency` の 1 件にし、所属変更を重ねない
 *   （Req 5.3）。昇格で所属が外れる場合も同様に昇格の 1 件だけにする。
 * - 所属変更は代理店ロールのまま所属が変わった場合だけに出す（運営ロールは所属を持たない・
 *   ck_dashboard_role_scope）。
 * - 表示名は値を記録しない。action の名前だけで「表示名が変わった」ことを表す（Req 5.4）。
 * - 変化が無ければ空配列を返す（Req 5.5）。
 *
 * before と after はどちらも DB の行（PostgreSQL が返す正規形）であり、入力値ではない。そのため
 * 所属の UUID は厳密一致で比べてよい。入力の文字列と比べると、大文字の UUID を「変化あり」と誤る。
 */
export function auditActionsForUserUpdate(
  before: DashboardUserItem,
  after: DashboardUserItem,
): AuditLogAction[] {
  const actions: AuditLogAction[] = [];
  if (before.role === 'agency' && after.role === 'operator') {
    actions.push('dashboard_user_promoted_to_operator');
  } else if (before.role === 'operator' && after.role === 'agency') {
    actions.push('dashboard_user_demoted_to_agency');
  } else if (before.role === 'agency' && after.role === 'agency' && before.agencyId !== after.agencyId) {
    actions.push('dashboard_user_agency_updated');
  }
  if (before.displayName !== after.displayName) {
    actions.push('dashboard_user_display_name_updated');
  }
  return actions;
}

// 自分自身に対する assignment が、自分の権限を変えるか。行為者は必ず role = 'operator'・所属なしなので、
// 「scope で role が operator」（変化なし）以外はすべて自分の権限を変える（Req 2.1）。
function changesOwnAssignment(assignment: DashboardUserAssignmentChange | undefined): boolean {
  if (assignment === undefined) return false;
  return !(assignment.kind === 'scope' && assignment.scope.role === 'operator');
}

// --- 共通ガード ---

type OperatorResult =
  | { ok: true; user: DashboardUserIdentity }
  | { ok: false; response: Response };

// 管理 API 共通の前置ガード: 認証 → 未登録/無効化は同一 403 封筒 → operator 限定（Req 6.5）。
// agency ロールは未登録・無効化と同一の 403 封筒（存在有無を漏らさない）。
async function requireOperatorUser(
  auth: AuthDeps,
  authorization: string | undefined,
): Promise<OperatorResult> {
  const outcome = await authenticate(auth, authorization);
  if (outcome.kind === 'unauthenticated') {
    return { ok: false, response: jsonError(401, 'unauthenticated', 'ログインが必要です') };
  }
  if (outcome.kind === 'unregistered' || outcome.kind === 'disabled') {
    return { ok: false, response: jsonError(403, 'forbidden', 'アクセス権がありません') };
  }
  if (!requireOperator(outcome.user)) {
    return { ok: false, response: jsonError(403, 'forbidden', 'アクセス権がありません') };
  }
  return { ok: true, user: outcome.user };
}

// --- 入力検証（クライアント由来の unknown を狭める。any は使わない）---

function parseName(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const { name } = body;
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  return trimmed === '' ? null : trimmed;
}

interface ParsedCreateUser {
  role: DashboardRole;
  agencyId: string | null;
  email: string;
  displayName: string | null;
}

// ロールと所属の組み合わせの検証（ck_dashboard_role_scope のアプリ側先取り・Req 6.3）。作成と更新で共有する。
//   role は 2 値のいずれか。agency ⇒ agencyId 必須（UUID 形式）/ operator ⇒ agencyId は不在（undefined/null）のみ。
// 表示名の扱いは作成（trim しない）と更新（trim して空なら null）で異なるため、ここでは扱わない。
function parseRoleScope(role: unknown, agencyId: unknown): DashboardUserScope | null {
  if (role === 'agency') {
    if (typeof agencyId !== 'string' || !UUID_RE.test(agencyId)) return null;
    return { role: 'agency', agencyId };
  }
  if (role === 'operator') {
    if (agencyId !== undefined && agencyId !== null) return null;
    return { role: 'operator', agencyId: null };
  }
  return null;
}

function parseCreateUserBody(body: unknown): ParsedCreateUser | null {
  if (!isRecord(body)) return null;
  const { role, agencyId, email, displayName } = body;

  // role と agencyId の整合（更新と共有する規則）。
  const scope = parseRoleScope(role, agencyId);
  if (scope === null) return null;

  // email は必須・簡易な妥当性（非空・@ を含む・空白なし）。DAL/リンク照合と一貫させるため
  // trim + 小文字化して渡す（過剰な形式検証はしない）。
  if (typeof email !== 'string') return null;
  const normalizedEmail = email.trim().toLowerCase();
  if (normalizedEmail === '' || !normalizedEmail.includes('@') || /\s/.test(normalizedEmail)) {
    return null;
  }

  // displayName は省略可（undefined/null）または文字列。
  if (displayName !== undefined && displayName !== null && typeof displayName !== 'string') {
    return null;
  }
  const normalizedDisplayName = typeof displayName === 'string' ? displayName : null;

  return {
    role: scope.role,
    agencyId: scope.agencyId,
    email: normalizedEmail,
    displayName: normalizedDisplayName,
  };
}

// 更新の body を部分更新の入力へ写す（dashboard-user-edit design「API Contract」）。不正なら null（400）。
//   - role がある: ロールを変える。所属は parseRoleScope（作成と同じ規則）で検証する。
//   - role が無く agencyId がある: 代理店ロールのまま所属を移す。UUID 形式の文字列だけを受け付ける。
//     null は「所属を外す」意味になり代理店ロールと両立しないので 400（Req 3.4）。
//   - displayName: 無ければ変更しない。null なら未設定にする。文字列なら trim し、空なら null（Req 1.5）。
//   - どれも無い body は 400。operatorId・email・disabled などのキーは読まない（無視する）。
// 送らなかった項目は、undefined の値を持つキーではなくキーごと省く（exactOptionalPropertyTypes・Req 3.1）。
function parseUpdateUserBody(body: unknown): DashboardUserUpdateInput | null {
  if (!isRecord(body)) return null;
  const { role, agencyId, displayName } = body;

  let assignment: DashboardUserAssignmentChange | undefined;
  if (role !== undefined) {
    const scope = parseRoleScope(role, agencyId);
    if (scope === null) return null;
    assignment = { kind: 'scope', scope };
  } else if (agencyId !== undefined) {
    if (typeof agencyId !== 'string' || !UUID_RE.test(agencyId)) return null;
    assignment = { kind: 'agency', agencyId };
  }

  let nextDisplayName: string | null | undefined;
  if (displayName === null) {
    nextDisplayName = null;
  } else if (typeof displayName === 'string') {
    const trimmed = displayName.trim();
    nextDisplayName = trimmed === '' ? null : trimmed;
  } else if (displayName !== undefined) {
    return null;
  }

  if (assignment === undefined && nextDisplayName === undefined) return null;

  const input: DashboardUserUpdateInput = {};
  if (assignment !== undefined) input.assignment = assignment;
  if (nextDisplayName !== undefined) input.displayName = nextDisplayName;
  return input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// --- シリアライズ（DAL 型・Date 含む → JSON 形・ISO 文字列）---

function toAgencyJson(item: AgencyItem): AgencyItemJson {
  return {
    id: item.id,
    operatorId: item.operatorId,
    name: item.name,
    createdAt: item.createdAt.toISOString(),
  };
}

function toUserJson(item: DashboardUserItem): DashboardUserItemJson {
  return {
    id: item.id,
    role: item.role,
    operatorId: item.operatorId,
    agencyId: item.agencyId,
    email: item.email,
    displayName: item.displayName,
    disabled: item.disabled,
    createdAt: item.createdAt.toISOString(),
  };
}

function jsonOk(status: 200 | 201, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
