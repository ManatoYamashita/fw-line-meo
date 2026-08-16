// 詳細データの読取 API（Task 5.2 / 多店舗対応は task 5.4・Issue #61）。
//
// design.md「TS / store-detail」API Contract:
//   GET /api/detail[?storeId={storeId}]
//   Request:  Authorization: Bearer {LIFF ID token}
//             ?storeId — 任意。認可済み集合内でのみ有効な「ヒント」
//   Response: 200 = 自店＋競合の詳細 JSON（30日推移含む）＋ storeName ＋ stores[]
//   Errors:   401（検証失敗）, 409（認可済み集合が2件以上で表示対象を決められない）,
//             404（owner 不在・confirmed 店舗0件）, 500
//
// 認可（idToken → sub → 認可済み集合）は lib/liff-auth.ts の authorizeStoreDetailRequest に
// 一任する。本ファイルは「ルートの所有」（HTTP ステータスマッピング・入出力の組立）のみを
// 担当する。
//
// design.md「クライアント入力の不変条件」の遵守:
//   `?storeId` はクライアント由来だが、認可主体を決めない。表示対象の決定は必ず
//   「認可済み集合を作る（authorizeStoreDetailRequest）→ その集合の中から選ぶ
//   （selectAuthorizedStore）」の順で行い、ヒントが集合の境界に影響する経路は存在しない。
//   集合外・不正・空のヒントは一律無視し、**未指定時と完全に同一の応答**を返す（非オラクル。
//   404 等で区別すると「その storeId が実在するか」を観測させてしまうため）。
//   selectAuthorizedStore は Queryable を受け取らない純関数なので、ヒントが SQL に到達せず、
//   不正 UUID による pg 22P02（→500）も構造的に起きない。
//
// エラー分類の設計判断（design.md の 401/404 の二分法をそのまま反映）:
//   StoreDetailAuthorizationError = LiffTokenVerificationError | StoreResolutionError
//     - LiffTokenVerificationError（'INVALID_TOKEN' | 'VERIFY_REQUEST_FAILED'）
//       = トークン自体の検証失敗 → 401
//     - StoreResolutionError（'OWNER_NOT_FOUND' | 'STORE_NOT_IDENTIFIED'）
//       = 検証済みトークンだが認可済み集合が空 → 404
//   OWNER_NOT_FOUND（sub に一致する owner が存在しない）も同じ「表示できる店舗が無い」という
//   性質のエラーであり、401（トークン自体は正当）と混同すべきではない。加えて
//   OWNER_NOT_FOUND のみ 401 に倒すと「この sub は owner として未登録である」という情報を
//   クライアントに区別可能な形で漏らすことになる。よって 2 値とも 404 として扱う（区別しない）。
//
// 構造的な no-write 保証（4.2）: 本モジュールは GET のみを export する。Next.js App Router の
// 規約上、POST/PUT/DELETE/PATCH を export すればそのメソッドが定義されてしまうため、
// 「export しない」こと自体が書込 API 不在の構造的な担保となる（test/route.db.test.ts で検証）。

import { getPool } from '@fwlm/db';
import type { Queryable, StoreRow } from '@fwlm/db';

import {
  authorizeStoreDetailRequest,
  selectAuthorizedStore,
  type LiffAuthOptions,
} from '../../../lib/liff-auth';
import { queryStoreDetail } from '../../../lib/data';
import { STORE_SELECTION_REQUIRED, type StoreRef } from '../../../lib/contract';

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

/** 認可済み集合をクライアントへ開示する最小形へ落とす（place_id・座標・owner_id は出さない）。 */
function toStoreRefs(stores: readonly StoreRow[]): StoreRef[] {
  return stores.map((store) => ({ storeId: store.id, name: store.name }));
}

function selectionRequired(stores: readonly StoreRow[]): Response {
  return new Response(
    JSON.stringify({
      error: { code: STORE_SELECTION_REQUIRED, message: '表示する店舗を選んでください' },
      stores: toStoreRefs(stores),
    }),
    { status: 409, headers: { 'Content-Type': 'application/json' } },
  );
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
    // STORE_NOT_IDENTIFIED | OWNER_NOT_FOUND — 上部コメント参照。
    return jsonError(404, 'STORE_NOT_FOUND', '店舗情報が見つかりません');
  }

  const stores = authResult.value;

  // ヒントの解釈。URLSearchParams#get は重複指定でも最初の値を返すため決定的。
  const hint = new URL(req.url).searchParams.get('storeId');
  const hinted = selectAuthorizedStore(stores, hint);

  if (hint && !hinted) {
    // 無視した事実は残す（silent drop を作らない）。ただし storeId そのものはログに書かない
    // ——集合外の値は攻撃者由来でありうるため、ログを通じた反射・汚染の経路を作らない。
    console.warn(
      JSON.stringify({
        event: 'store-detail.store_hint_ignored',
        reason: 'not_in_authorized_set',
        authorizedCount: stores.length,
      }),
    );
  }

  // 集合が1件のときのみヒント無しでも表示対象が決まる。2件以上でヒントが解決しなければ、
  // 推測せず候補一覧を返す。この分岐の入力は「集合」と「集合内で解決したか」だけであり、
  // ヒントの中身は結果に一切現れない（＝未指定時と同一応答＝非オラクル）。
  const chosen = hinted ?? (stores.length === 1 ? stores[0]! : null);
  if (chosen === null) {
    return selectionRequired(stores);
  }

  try {
    const detail = await queryStoreDetail(pool, chosen.id);
    return jsonOk({ ...detail, storeName: chosen.name, stores: toStoreRefs(stores) });
  } catch (err) {
    console.error(JSON.stringify({ event: 'store-detail.query_error', error: errorMessageOf(err) }));
    return jsonError(500, 'INTERNAL', 'サーバーエラー');
  }
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
