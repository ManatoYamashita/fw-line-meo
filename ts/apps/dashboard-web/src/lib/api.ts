import { getFirebaseAuth } from './firebase';

// dashboard-api（Hono）呼び出しの型付き窓口。Bearer 付与・エラー封筒の解釈を一箇所に集約する。
// 設計: dashboard-web「AuthProvider / api client」（requirements 1.1, 1.2, 1.3, 1.4, 7.4）。

// ダッシュボード利用者のロール（@fwlm/db の DashboardRole と同値。dashboard-web は db に依存しないため再定義）。
export type DashboardRole = 'operator' | 'agency';

// GET /me の 200 応答内 user（design の API 契約表: { role, agencyId, agencyName, displayName }）。
export interface Me {
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

// GET /me: 認証済み利用者の自己情報。200 の { user } を value にアンラップする。
export async function getMe(
  options: Pick<ApiFetchOptions, 'getToken' | 'fetchImpl' | 'baseUrl'> = {},
): Promise<ApiResult<Me>> {
  const result = await apiFetch<{ user: Me }>('/me', options);
  if (!result.ok) return result;
  return { ok: true, value: result.value.user };
}
