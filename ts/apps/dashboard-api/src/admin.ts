import type {
  AgencyItem,
  DashboardRole,
  DashboardUserIdentity,
  DashboardUserItem,
  DisableOutcome,
} from '@fwlm/db';
import { authenticate, type AuthDeps } from './auth.js';
import { requireOperator } from './scope.js';
import { isUniqueViolation } from './invite-code-gen.js';
import { jsonError } from './http.js';

// 管理 API（運営専用）: GET/POST /agencies・GET/POST /dashboard-users・POST /dashboard-users/:id/disable
// の中核ロジック（依存注入でテスト可能・ルート配線は app 側の責務。Req 6.1–6.5）。
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
}

export interface DashboardUserDisableDeps {
  auth: AuthDeps;
  // disableDashboardUserGuarded（@fwlm/db）委譲。operator_id をスコープ列に含む保護付き無効化で、
  // 結果を判別共用体 DisableOutcome で返す（本ハンドラが 200 / 409 / 404 に写像する）:
  //   - 'disabled'（成功／既に無効・冪等）／'last_operator'（最後の有効な運営で拒否・Req 2.3）／
  //     'not_found'（不在・越権の秘匿・Req 1.5）。拒否時は DAL が ROLLBACK 済みで対象状態不変（Req 2.6）。
  disableUser: (id: string, operatorId: string) => Promise<DisableOutcome>;
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
      return jsonError(409, 'email_conflict', '既に登録済みのメールアドレスです');
    }
    return jsonError(500, 'internal', '利用者の登録に失敗しました。時間をおいて再試行してください');
  }
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

  // 自己無効化拒否（DB 到達前・Req 2.1）。運営が自分自身を無効化するとテナントごとロックアウトし得るため
  // 構造的に禁止する。guard.user.id は認証ユーザー由来（UUID）で、クライアント入力は信用しない。
  if (req.id === guard.user.id) {
    return jsonError(409, 'self_disable_forbidden', '自分自身は無効化できません');
  }

  // 保護付き無効化。結果を HTTP へ写像する（Req 2.3, 2.4, 2.6, 1.5）。拒否時は DAL が ROLLBACK 済みで
  // 対象状態は変わらない（成功と誤認されない明確な表示・Req 2.6）。
  const outcome = await deps.disableUser(req.id, guard.user.operatorId);
  if (outcome.kind === 'disabled') {
    // 無効化成功／既に無効（冪等）。現状の利用者行を 200 で返す（Req 2.4）。
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

function parseCreateUserBody(body: unknown): ParsedCreateUser | null {
  if (!isRecord(body)) return null;
  const { role, agencyId, email, displayName } = body;

  // role は 2 値のいずれか。
  if (role !== 'operator' && role !== 'agency') return null;

  // agencyId の整合（ck_dashboard_role_scope のアプリ側先取り・Req 6.3）:
  //   agency ⇒ agencyId 必須（UUID 形式）/ operator ⇒ agencyId は不在（undefined/null）のみ。
  let normalizedAgencyId: string | null;
  if (role === 'agency') {
    if (typeof agencyId !== 'string' || !UUID_RE.test(agencyId)) return null;
    normalizedAgencyId = agencyId;
  } else {
    if (agencyId !== undefined && agencyId !== null) return null;
    normalizedAgencyId = null;
  }

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

  return { role, agencyId: normalizedAgencyId, email: normalizedEmail, displayName: normalizedDisplayName };
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
