import { getFirebaseAuth } from './firebase';
import type {
  AgencyItem,
  Category,
  DashboardUserItem,
  InviteCodeItem,
  OwnerListItem,
  StoreCandidate,
  StoreListItem,
} from './types';

// dashboard-api（Hono）呼び出しの型付き窓口。Bearer 付与・エラー封筒の解釈を一箇所に集約する。
// 設計: dashboard-web「AuthProvider / api client」（requirements 1.1, 1.2, 1.3, 1.4, 7.4）。

// ダッシュボード利用者のロール（@fwlm/db の DashboardRole と同値。dashboard-web は db に依存しないため再定義）。
export type DashboardRole = 'operator' | 'agency';

// GET /me の 200 応答内 user（design の API 契約表: { role, agencyId, agencyName, displayName }）。
export interface Me {
  // 利用者 ID（UI が「自分の行」を識別し自己無効化ボタンを非表示にするために使う）。
  id: string;
  role: DashboardRole;
  agencyId: string | null;
  agencyName: string | null;
  displayName: string | null;
}

// エラー封筒を判別共用体で返す（design: dashboard-web api client の Contracts）。
export type ApiResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface ApiFetchOptions {
  method?: HttpMethod;
  body?: unknown;
  // Firebase ID トークン取得を注入可能にする（既定は現在のログインユーザーの getIdToken()）。
  getToken?: () => Promise<string | null>;
  // fetch を注入可能にする（テスト用。既定はグローバル fetch）。
  fetchImpl?: typeof fetch;
  // ベース URL を注入可能にする（既定は NEXT_PUBLIC_API_BASE_URL）。
  baseUrl?: string;
}

// NEXT_PUBLIC_API_BASE_URL は next build 時にインライン化される（build-arg 経由・上記 firebase.ts 参照）。
const DEFAULT_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';

const NETWORK_MESSAGE = 'ネットワークエラーが発生しました。通信状況を確認して再試行してください。';

// 既定のトークン取得: Firebase SDK 管理の現在ユーザーから ID トークンを取り出す。
async function defaultGetToken(): Promise<string | null> {
  const user = getFirebaseAuth().currentUser;
  return user ? await user.getIdToken() : null;
}

// 応答ボディを安全に JSON として読む。空・非 JSON は undefined を返す（例外を投げない）。
async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// 非 2xx 応答からエラー封筒 { error: { code, message } } を取り出す。解釈不能ならフォールバック。
async function parseErrorEnvelope(res: Response): Promise<{ code: string; message: string }> {
  const fallback = {
    code: `http_${res.status}`,
    message: `リクエストに失敗しました（HTTP ${res.status}）。しばらくして再試行してください。`,
  };
  const parsed = await readJson(res);
  if (parsed !== null && typeof parsed === 'object' && 'error' in parsed) {
    const err = (parsed as { error: unknown }).error;
    if (err !== null && typeof err === 'object') {
      const record = err as Record<string, unknown>;
      const code = typeof record.code === 'string' ? record.code : fallback.code;
      const message = typeof record.message === 'string' ? record.message : fallback.message;
      return { code, message };
    }
  }
  return fallback;
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<ApiResult<T>> {
  const {
    method = 'GET',
    body,
    getToken = defaultGetToken,
    fetchImpl = fetch,
    baseUrl = DEFAULT_BASE_URL,
  } = options;

  try {
    const token = await getToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.ok) {
      const value = (await readJson(res)) as T;
      return { ok: true, value };
    }
    const { code, message } = await parseErrorEnvelope(res);
    return { ok: false, code, message };
  } catch {
    // fetch 拒否・トークン取得失敗など通信不能はネットワークエラーに写す。
    return { ok: false, code: 'network', message: NETWORK_MESSAGE };
  }
}

// 型付きクライアントメソッド共通のオプション（method/body は各メソッドが固定するため受けない）。
export type ApiClientOptions = Pick<ApiFetchOptions, 'getToken' | 'fetchImpl' | 'baseUrl'>;

// undefined/空文字を除いたクエリ文字列を組み立てる（付与すべき値が無ければ空文字を返す）。
function buildQuery(params: Record<string, string | undefined>): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') usp.set(key, value);
  }
  const query = usp.toString();
  return query.length > 0 ? `?${query}` : '';
}

// GET /me: 認証済み利用者の自己情報。200 の { user } を value にアンラップする。
export async function getMe(options: ApiClientOptions = {}): Promise<ApiResult<Me>> {
  const result = await apiFetch<{ user: Me }>('/me', options);
  if (!result.ok) return result;
  return { ok: true, value: result.value.user };
}

// GET /stores: スコープ付き店舗一覧。agency は自代理店分（引数不要）、operator は agencyId 未指定で全件・指定で絞り込み。
export async function getStores(
  params: { agencyId?: string } = {},
  options: ApiClientOptions = {},
): Promise<ApiResult<StoreListItem[]>> {
  const result = await apiFetch<{ stores: StoreListItem[] }>(
    `/stores${buildQuery({ agencyId: params.agencyId })}`,
    options,
  );
  if (!result.ok) return result;
  return { ok: true, value: result.value.stores };
}

// GET /owners: 登録対象オーナー一覧。agency は無指定で自代理店、operator は agencyId 指定が必須（未指定は API が 400）。
export async function getOwners(
  params: { agencyId?: string } = {},
  options: ApiClientOptions = {},
): Promise<ApiResult<OwnerListItem[]>> {
  const result = await apiFetch<{ owners: OwnerListItem[] }>(
    `/owners${buildQuery({ agencyId: params.agencyId })}`,
    options,
  );
  if (!result.ok) return result;
  return { ok: true, value: result.value.owners };
}

// GET /agencies: 代理店一覧（operator 専用。agency ロールは API が 403）。
export async function getAgencies(options: ApiClientOptions = {}): Promise<ApiResult<AgencyItem[]>> {
  const result = await apiFetch<{ agencies: AgencyItem[] }>('/agencies', options);
  if (!result.ok) return result;
  return { ok: true, value: result.value.agencies };
}

// POST /agencies: 代理店を作成（operator 専用。agency ロールは API が 403）。201 で { agency }。
// operatorId はサーバー側が認証ユーザーから設定するため送らない。空名は API が 400(validation_failed)。
export async function createAgency(
  input: { name: string },
  options: ApiClientOptions = {},
): Promise<ApiResult<AgencyItem>> {
  const result = await apiFetch<{ agency: AgencyItem }>('/agencies', {
    ...options,
    method: 'POST',
    body: { name: input.name },
  });
  if (!result.ok) return result;
  return { ok: true, value: result.value.agency };
}

// GET /dashboard-users: ダッシュボード利用者一覧（operator 専用。agency ロールは API が 403）。
export async function getDashboardUsers(
  options: ApiClientOptions = {},
): Promise<ApiResult<DashboardUserItem[]>> {
  const result = await apiFetch<{ users: DashboardUserItem[] }>('/dashboard-users', options);
  if (!result.ok) return result;
  return { ok: true, value: result.value.users };
}

// POST /dashboard-users: 利用者を登録（operator 専用）。201 で { user }。
// role='agency' は agencyId 必須・role='operator' は agencyId を送らない（ck_dashboard_role_scope・Req 6.3）。
// email 重複は 409(email_conflict)、role/agencyId 不整合や email 形式不正は 400(validation_failed)。
export async function createDashboardUser(
  input: { role: DashboardRole; agencyId?: string; email: string; displayName?: string },
  options: ApiClientOptions = {},
): Promise<ApiResult<DashboardUserItem>> {
  // agencyId/displayName は指定時のみ載せる（operator 登録では agencyId を送らないことが契約上の要件）。
  const body: Record<string, unknown> = { role: input.role, email: input.email };
  if (input.agencyId !== undefined) body.agencyId = input.agencyId;
  if (input.displayName !== undefined) body.displayName = input.displayName;
  const result = await apiFetch<{ user: DashboardUserItem }>('/dashboard-users', {
    ...options,
    method: 'POST',
    body,
  });
  if (!result.ok) return result;
  return { ok: true, value: result.value.user };
}

// POST /dashboard-users/:id/disable: 利用者を無効化（operator 専用）。200 で { user }。
// operatorId はサーバー側が認証ユーザーから解決する。不在・スコープ外 id は 404(not_found)。
// 既無効への再実行も現状値を返し冪等。
export async function disableDashboardUser(
  input: { id: string },
  options: ApiClientOptions = {},
): Promise<ApiResult<DashboardUserItem>> {
  const result = await apiFetch<{ user: DashboardUserItem }>(
    `/dashboard-users/${encodeURIComponent(input.id)}/disable`,
    { ...options, method: 'POST' },
  );
  if (!result.ok) return result;
  return { ok: true, value: result.value.user };
}

// POST /dashboard-users/:id/enable: 無効化済み利用者を再有効化（operator 専用）。200 で { user }。
// operatorId はサーバー側が認証ユーザーから解決する。不在・スコープ外 id は 404(not_found)。
// 既に有効な利用者への再実行も現状値を返し冪等。
export async function enableDashboardUser(
  input: { id: string },
  options: ApiClientOptions = {},
): Promise<ApiResult<DashboardUserItem>> {
  const result = await apiFetch<{ user: DashboardUserItem }>(
    `/dashboard-users/${encodeURIComponent(input.id)}/enable`,
    { ...options, method: 'POST' },
  );
  if (!result.ok) return result;
  return { ok: true, value: result.value.user };
}

// GET /categories: 業態カテゴリ一覧（seed が単一情報源）。
export async function getCategories(options: ApiClientOptions = {}): Promise<ApiResult<Category[]>> {
  const result = await apiFetch<{ categories: Category[] }>('/categories', options);
  if (!result.ok) return result;
  return { ok: true, value: result.value.categories };
}

// POST /stores/search: 店名から店舗候補（最大10件）を検索。0 件は空配列で 200、外部要因失敗は 502(places_error)。
export async function searchStores(
  query: string,
  options: ApiClientOptions = {},
): Promise<ApiResult<StoreCandidate[]>> {
  const result = await apiFetch<{ candidates: StoreCandidate[] }>('/stores/search', {
    ...options,
    method: 'POST',
    body: { query },
  });
  if (!result.ok) return result;
  return { ok: true, value: result.value.candidates };
}

// POST /stores: 選択候補を確定登録。候補はサーバー側で再検証されるため、検索応答をそのまま verbatim で送る。
// 201 で { storeId }、既登録 Place は 409(place_already_registered)、権限外は 403。
export async function registerStore(
  input: { ownerId: string; candidate: StoreCandidate; categoryCode?: string },
  options: ApiClientOptions = {},
): Promise<ApiResult<{ storeId: string }>> {
  return apiFetch<{ storeId: string }>('/stores', { ...options, method: 'POST', body: input });
}

// GET /invite-codes: 招待コード一覧。agency は自代理店分（引数不要）、operator は agencyId 指定が必須（未指定は API が 400）。
export async function getInviteCodes(
  params: { agencyId?: string } = {},
  options: ApiClientOptions = {},
): Promise<ApiResult<InviteCodeItem[]>> {
  const result = await apiFetch<{ inviteCodes: InviteCodeItem[] }>(
    `/invite-codes${buildQuery({ agencyId: params.agencyId })}`,
    options,
  );
  if (!result.ok) return result;
  return { ok: true, value: result.value.inviteCodes };
}

// POST /invite-codes: 新しい招待コードを発行。agency は agencyId 省略（自代理店）、operator は agencyId 指定。
// 201 で { inviteCode }。生成衝突が続くと 500。
export async function issueInviteCode(
  params: { agencyId?: string } = {},
  options: ApiClientOptions = {},
): Promise<ApiResult<InviteCodeItem>> {
  const result = await apiFetch<{ inviteCode: InviteCodeItem }>('/invite-codes', {
    ...options,
    method: 'POST',
    body: params.agencyId === undefined ? {} : { agencyId: params.agencyId },
  });
  if (!result.ok) return result;
  return { ok: true, value: result.value.inviteCode };
}

// POST /invite-codes/:id/disable: 招待コードを無効化。operator は対象代理店を agencyId で指定、agency は自代理店スコープ。
// 200 で { inviteCode }（既無効への再実行も現状値を返し冪等）。スコープ外/不明 id は 404(not_found)。
export async function disableInviteCode(
  params: { id: string; agencyId?: string },
  options: ApiClientOptions = {},
): Promise<ApiResult<InviteCodeItem>> {
  const result = await apiFetch<{ inviteCode: InviteCodeItem }>(
    `/invite-codes/${encodeURIComponent(params.id)}/disable`,
    {
      ...options,
      method: 'POST',
      body: params.agencyId === undefined ? {} : { agencyId: params.agencyId },
    },
  );
  if (!result.ok) return result;
  return { ok: true, value: result.value.inviteCode };
}
