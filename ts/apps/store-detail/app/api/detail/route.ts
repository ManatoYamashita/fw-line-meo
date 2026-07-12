// 詳細データの読取 API（Task 5.2）。
//
// design.md「TS / store-detail」API Contract:
//   GET /api/detail
//   Request:  Authorization: Bearer {LIFF ID token}
//   Response: 自店＋競合の詳細 JSON（30日推移含む）
//   Errors:   401（検証失敗）, 404（店舗未特定・または sub に紐づく confirmed 店舗が複数で
//             一意に解決不能＝AMBIGUOUS_STORE）, 500
//
// 認可（idToken → sub → storeId）は lib/liff-auth.ts（task 5.1・触れない）の
// authorizeStoreDetailRequest に一任する。本ファイルは「ルートの所有」（HTTP ステータス
// マッピング・入出力の組立）のみを担当し、storeId 等クライアント制御可能な識別子を
// authorizeStoreDetailRequest の成功結果以外から一切受け取らない
// （design.md「Security Considerations」storeId を URL・リクエストボディから受けない）。
//
// エラー分類の設計判断（design.md の 401/404 の二分法をそのまま反映）:
//   StoreDetailAuthorizationError = LiffTokenVerificationError | StoreResolutionError
//     - LiffTokenVerificationError（'INVALID_TOKEN' | 'VERIFY_REQUEST_FAILED'）
//       = トークン自体の検証失敗 → 401
//     - StoreResolutionError（'OWNER_NOT_FOUND' | 'STORE_NOT_IDENTIFIED' | 'AMBIGUOUS_STORE'）
//       = 検証済みトークンだが自店を一意に解決できない → 404
//   design.md の API Contract は 404 の理由として「店舗未特定・または AMBIGUOUS_STORE」の
//   2 種類のみを明記するが、OWNER_NOT_FOUND（sub に一致する owner が存在しない）も同じ
//   「storeId を一意に解決できない」という性質のエラーであり、401（トークン自体は正当）と
//   混同すべきではない。加えて OWNER_NOT_FOUND のみ 401 に倒すと「この sub は owner として
//   未登録である」という情報をクライアントに区別可能な形で漏らすことになり、design.md
//   「誤った店舗の情報を返さないことを優先する」の安全側方針に反する。よって
//   StoreResolutionError の 3 値はすべて 404 として扱う（区別しない）。
//
// 構造的な no-write 保証（4.2）: 本モジュールは GET のみを export する。Next.js App Router の
// 規約上、POST/PUT/DELETE/PATCH を export すればそのメソッドが定義されてしまうため、
// 「export しない」こと自体が書込 API 不在の構造的な担保となる（test/route.db.test.ts で検証）。

import { getPool } from '@fwlm/db';
import type { Queryable } from '@fwlm/db';

import { authorizeStoreDetailRequest, type LiffAuthOptions } from '../../../lib/liff-auth';
import { queryStoreDetail } from '../../../lib/data';

// pg / cloud-sql-connector を使うため Node ランタイムが必須（Edge 不可）。
export const runtime = 'nodejs';
// 認可（Bearer トークン）によって応答が変わるため、静的キャッシュ・ISR の対象にしない。
export const dynamic = 'force-dynamic';

// --- レスポンス封筒（survey-web/src/lib/http.ts の { error: { code, message } } 規約に合わせる） ---

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// --- Authorization ヘッダからの ID トークン抽出 ----------------------------------------

const BEARER_PREFIX_RE = /^Bearer\s+(.+)$/i;

function extractBearerToken(req: Request): string | null {
  // Web 標準 Headers は大文字小文字を区別せず取得できる（Fetch 仕様）。
  const header = req.headers.get('Authorization');
  if (!header) {
    return null;
  }
  const match = BEARER_PREFIX_RE.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

// --- 認可エラー → HTTP ステータスの分類 -------------------------------------------------

const TOKEN_VERIFICATION_ERRORS = new Set(['INVALID_TOKEN', 'VERIFY_REQUEST_FAILED']);

function isTokenVerificationFailure(error: string): boolean {
  return TOKEN_VERIFICATION_ERRORS.has(error);
}

// --- 実行時設定（LIFF チャネル ID）。dashboard-api の loadConfig 規約と同様、必須 env の欠落は
// 明示エラーとする。ただしこれはクライアント起因ではなくサーバー設定不備のため 500 として扱う。
// LIFF_VERIFY_ENDPOINT は本番では未設定（LINE 本番エンドポイントを既定使用）で、DB テストのみが
// フェイクサーバーへ差し替えるためのテスト用の任意 env（lib/liff-auth.ts の LiffAuthOptions が
// 既に提供する verifyEndpoint 差替え口を、route.ts 単体でテスト可能にするために利用する）。

function readLiffAuthConfig(env: NodeJS.ProcessEnv): { clientId: string; options: LiffAuthOptions } {
  const clientId = env.LIFF_CHANNEL_ID;
  if (!clientId) {
    throw new Error('LIFF_CHANNEL_ID is required');
  }
  const verifyEndpoint = env.LIFF_VERIFY_ENDPOINT;
  return { clientId, options: verifyEndpoint ? { verifyEndpoint } : {} };
}

export async function GET(req: Request): Promise<Response> {
  let clientId: string;
  let liffAuthOptions: LiffAuthOptions;
  try {
    ({ clientId, options: liffAuthOptions } = readLiffAuthConfig(process.env));
  } catch (err) {
    console.error(JSON.stringify({ event: 'store-detail.config_error', error: errorMessageOf(err) }));
    return jsonError(500, 'INTERNAL', 'サーバーエラー');
  }

  const idToken = extractBearerToken(req);
  if (!idToken) {
    return jsonError(401, 'UNAUTHORIZED', '認証情報が見つかりません');
  }

  let pool: Queryable;
  try {
    pool = await getPool();
  } catch (err) {
    console.error(JSON.stringify({ event: 'store-detail.pool_error', error: errorMessageOf(err) }));
    return jsonError(500, 'INTERNAL', 'サーバーエラー');
  }

  const authResult = await authorizeStoreDetailRequest(idToken, clientId, pool, liffAuthOptions);
  if (!authResult.ok) {
    if (isTokenVerificationFailure(authResult.error)) {
      return jsonError(401, 'UNAUTHORIZED', '認証に失敗しました');
    }
    // STORE_NOT_IDENTIFIED | AMBIGUOUS_STORE | OWNER_NOT_FOUND — 上部コメント参照。
    return jsonError(404, 'STORE_NOT_FOUND', '店舗情報が見つかりません');
  }

  try {
    const detail = await queryStoreDetail(pool, authResult.value.id);
    return jsonOk(detail);
  } catch (err) {
    console.error(JSON.stringify({ event: 'store-detail.query_error', error: errorMessageOf(err) }));
    return jsonError(500, 'INTERNAL', 'サーバーエラー');
  }
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
