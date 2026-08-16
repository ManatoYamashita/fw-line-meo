import type { DashboardUserIdentity, InviteCodeItem } from '@fwlm/db';
import { authenticate, type AuthDeps } from './auth.js';
import { resolveAgencyScope } from './scope.js';
import { jsonError } from './http.js';

// GET /invite-codes・POST /invite-codes・POST /invite-codes/:id/disable の中核ロジック
// （依存注入でテスト可能・ルート配線は app 側の責務。Req 5.1–5.4）。
// 招待コードは代理店単位のため、3 ハンドラとも「具体的な 1 代理店」が定まっている必要がある:
// operator が agencyId 未指定（スコープ all）の場合は 400 で代理店の指定を促す（owners-list と同じ判断）。
// スコープ拒否はデータアクセスより前に行い、越権要求に DAL を呼ばせない（Req 2.3）。

// 一覧・発行・無効化で共通の JSON 形。Date は ISO 8601 文字列へ明示的に変換する。
export interface InviteCodeItemJson {
  id: string;
  agencyId: string;
  code: string;
  disabled: boolean;
  createdAt: string; // ISO 8601
}

// --- GET /invite-codes ---

export interface InviteCodesListDeps {
  auth: AuthDeps;
  // listInviteCodes（@fwlm/db）を部分適用した一覧取得（agency_id で絞り込み済み）。
  listInviteCodes: (agencyId: string) => Promise<InviteCodeItem[]>;
}

export interface InviteCodesListRequest {
  authorization: string | undefined;
  // クエリ ?agencyId=（operator は必須。agency が他代理店を指定したら 403）。
  agencyId: string | undefined;
}

export async function handleInviteCodesList(
  deps: InviteCodesListDeps,
  req: InviteCodesListRequest,
): Promise<Response> {
  // 1. 認証 → 2. スコープ解決（拒否時は DAL 不呼出）→ 3. 代理店確定の要求。
  const scoped = await resolveSingleAgency(deps.auth, req.authorization, req.agencyId);
  if (!scoped.ok) return scoped.response;

  // 4. 一覧取得。0 件は 200 + 空配列（有効・無効の別は disabled フラグで返す・5.1）。
  const items = await deps.listInviteCodes(scoped.agencyId);
  return jsonOk(200, { inviteCodes: items.map(toJson) });
}

// --- POST /invite-codes ---

export interface InviteCodeIssueDeps {
  auth: AuthDeps;
  // createUniqueInviteCode（invite-code-gen）＋ createInviteCode（@fwlm/db）を合成した発行。
  // 衝突リトライ（最大 3 回）を使い切ったら投げる契約（本ハンドラが 500 internal に写像）。
  issueCode: (agencyId: string) => Promise<InviteCodeItem>;
}

export interface InviteCodeIssueRequest {
  authorization: string | undefined;
  // ルート層でパースした JSON body（{ agencyId?: string }。agency は省略＝自代理店）。
  body: unknown;
}

export async function handleInviteCodeIssue(
  deps: InviteCodeIssueDeps,
  req: InviteCodeIssueRequest,
): Promise<Response> {
  // 1. 認証（スコープ解決より前に body 形状で 400 を返さない — 認証が常に先）。
  const auth = await requireUser(deps.auth, req.authorization);
  if (!auth.ok) return auth.response;

  // 2. body 形状検証（agencyId は省略可・非空文字列のみ）。
  const parsed = parseOptionalAgencyId(req.body);
  if (!parsed.ok) {
    return jsonError(400, 'validation_failed', '入力内容が正しくありません');
  }

  // 3. 対象代理店の確定。agency は自代理店（他代理店指定は 403）、operator は指定必須（未指定は 400）。
  const scoped = scopeToSingleAgency(auth.user, parsed.agencyId, '招待コードの発行');
  if (!scoped.ok) return scoped.response;

  // 4. 発行。生成リトライ切れ・DB 障害は偽装せず 500 を返す（7.4）。
  let item: InviteCodeItem;
  try {
    item = await deps.issueCode(scoped.agencyId);
  } catch {
    return jsonError(500, 'internal', '招待コードの発行に失敗しました。時間をおいて再試行してください');
  }
  return jsonOk(201, { inviteCode: toJson(item) });
}

// --- POST /invite-codes/:id/disable ---

export interface InviteCodeDisableDeps {
  auth: AuthDeps;
  // disableInviteCode（@fwlm/db）委譲。agency_id をスコープ列に含む UPDATE で、
  // 不在・越権はいずれも null（本ハンドラが 404 に写像・存在の秘匿）。既無効は現状値を返し冪等。
  disableCode: (id: string, agencyId: string) => Promise<InviteCodeItem | null>;
}

export interface InviteCodeDisableRequest {
  authorization: string | undefined;
  // パスパラメータ :id（UUID 形式を事前検証する）。
  id: string;
  // ルート層でパースした JSON body（{ agencyId?: string }。operator は必須・agency は省略＝自代理店）。
  body: unknown;
}

// UUID 形式でない id は DB を叩かず 404 扱い（存在の探り当てを許さない・store-registration と同じ規律）。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleInviteCodeDisable(
  deps: InviteCodeDisableDeps,
  req: InviteCodeDisableRequest,
): Promise<Response> {
  // 1. 認証。
  const auth = await requireUser(deps.auth, req.authorization);
  if (!auth.ok) return auth.response;

  // 2. UUID 事前ガード（DAL に到達させない）。不正形式は不在と同じ 404（存在の秘匿）。
  if (!UUID_RE.test(req.id)) {
    return jsonError(404, 'not_found', '招待コードが見つかりません');
  }

  // 3. body 形状検証 → 対象代理店の確定（agency=自代理店 / operator=指定必須）。
  const parsed = parseOptionalAgencyId(req.body);
  if (!parsed.ok) {
    return jsonError(400, 'validation_failed', '入力内容が正しくありません');
  }
  const scoped = scopeToSingleAgency(auth.user, parsed.agencyId, '招待コードの無効化');
  if (!scoped.ok) return scoped.response;

  // 4. 無効化。null（不在・スコープ不一致）は 404。既無効は現状値が返り 200（冪等・5.3）。
  const item = await deps.disableCode(req.id, scoped.agencyId);
  if (item === null) {
    return jsonError(404, 'not_found', '招待コードが見つかりません');
  }
  return jsonOk(200, { inviteCode: toJson(item) });
}

// --- 共通ヘルパ ---

type UserResult =
  | { ok: true; user: DashboardUserIdentity }
  | { ok: false; response: Response };

// 認証の共通前置。design のコード体系（小文字）に従い、
// 未登録・無効化は同一の 403 封筒（存在有無を漏らさない）。
async function requireUser(
  auth: AuthDeps,
  authorization: string | undefined,
): Promise<UserResult> {
  const outcome = await authenticate(auth, authorization);
  if (outcome.kind === 'unauthenticated') {
    return { ok: false, response: jsonError(401, 'unauthenticated', 'ログインが必要です') };
  }
  if (outcome.kind === 'unregistered' || outcome.kind === 'disabled') {
    return { ok: false, response: jsonError(403, 'forbidden', 'アクセス権がありません') };
  }
  return { ok: true, user: outcome.user };
}

type SingleAgencyResult =
  | { ok: true; agencyId: string }
  | { ok: false; response: Response };

// スコープ解決＋「具体的な 1 代理店」の要求。招待コードは代理店単位のため all は許さず、
// operator の agencyId 未指定は 400 とする（owners-list の GET /owners と同じ判断・5.4）。
function scopeToSingleAgency(
  user: DashboardUserIdentity,
  requestedAgencyId: string | undefined,
  operationLabel: string,
): SingleAgencyResult {
  const scope = resolveAgencyScope(user, requestedAgencyId);
  if (!scope.ok) {
    return {
      ok: false,
      response: jsonError(403, 'forbidden', 'この代理店へのアクセス権がありません'),
    };
  }
  if (scope.scope.kind === 'all') {
    return {
      ok: false,
      response: jsonError(400, 'validation_failed', `${operationLabel}には代理店の指定が必要です`),
    };
  }
  return { ok: true, agencyId: scope.scope.agencyId };
}

// 認証 → スコープ解決 → 1 代理店確定 をまとめた GET 用前置（クエリ agencyId 版）。
async function resolveSingleAgency(
  auth: AuthDeps,
  authorization: string | undefined,
  requestedAgencyId: string | undefined,
): Promise<SingleAgencyResult> {
  const user = await requireUser(auth, authorization);
  if (!user.ok) return user;
  return scopeToSingleAgency(user.user, requestedAgencyId, '招待コード一覧');
}

// body の { agencyId?: string } 形状検証。undefined/null body は「指定なし」として許容する
// （POST /invite-codes/:id/disable は design 上 body 無しが基本形のため）。
type OptionalAgencyIdResult = { ok: true; agencyId: string | undefined } | { ok: false };

function parseOptionalAgencyId(body: unknown): OptionalAgencyIdResult {
  if (body === undefined || body === null) return { ok: true, agencyId: undefined };
  if (typeof body !== 'object' || Array.isArray(body)) return { ok: false };
  const { agencyId } = body as Record<string, unknown>;
  if (agencyId === undefined) return { ok: true, agencyId: undefined };
  if (typeof agencyId !== 'string' || agencyId === '') return { ok: false };
  return { ok: true, agencyId };
}

// InviteCodeItem（DAL 型・Date 含む）→ JSON 形（ISO 文字列）への明示的シリアライズ。
function toJson(item: InviteCodeItem): InviteCodeItemJson {
  return {
    id: item.id,
    agencyId: item.agencyId,
    code: item.code,
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
