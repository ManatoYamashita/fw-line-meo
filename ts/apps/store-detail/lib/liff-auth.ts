// LIFF 認可ライブラリ（Task 5.1）。
//
// 責務は「ID トークンのサーバーサイド検証（sub の取得）」と「検証済み sub からの自店解決」のみ。
// 詳細データの読取・API ルートの 401/404 マッピングは task 5.2 の責務（本モジュールは
// 呼出元がルーティング判断に使える型付き結果を返すのみで、HTTP レスポンスは組み立てない）。
//
// 契約の根拠（記憶に頼らず、事前に確定済みの調査結果のみを用いる — CLAUDE.md「LINE API を記憶で
// 答えない」規律）:
//   design.md「TS / store-detail」Responsibilities & Constraints:
//     認可: liff.getIDToken() → サーバーで POST /oauth2/v2.1/verify → sub（=userId）→
//     owners.line_user_id 突合 → 自店のみ返却。**getProfile の userId を認可に使わない**。
//   design.md「Security Considerations」:
//     LIFF 認可は ID トークンのサーバーサイド検証のみを信頼。storeId を URL・リクエストボディから
//     受けない。
//   research.md「LINE Messaging API — Push・Flex・LIFF」:
//     `POST https://api.line.me/oauth2/v2.1/verify` に id_token・client_id を渡す。レスポンスの
//     sub が userId。**Messaging API チャネルと同一プロバイダー配下が前提**（userId 突合の運用上の
//     必須制約）。本モジュールはプロバイダーの一致自体を検証する手段を持たない（LINE 側が
//     プロバイダー不一致を検知した場合は verify 自体が失敗する契約に依拠する）。運用上は
//     LIFF 用 LINE Login チャネルを Messaging API チャネルと同一プロバイダー配下に作成することが
//     前提条件であり、これはコード側では担保できないインフラ/運用上の制約である
//     （research.md Open Questions 参照）。
//
// Security-critical な設計上の制約:
//   resolveOwnerStore / authorizeStoreDetailRequest は、クライアントが制御しうる識別子
//   （storeId・ownerId 等）をパラメータとして一切受け取らない。店舗解決の唯一の入力は
//   verifyLiffIdToken が返す検証済み sub のみである。これは型システムで構造的に強制されており
//   （test/liff-auth.test.ts の型レベル検証を参照）、実装者が誤って `resolveOwnerStore(pool, sub,
//   storeId)` のような抜け道を追加すればコンパイルが失敗する。

import type { Queryable, Result, StoreRow } from '@fwlm/db';

const DEFAULT_VERIFY_ENDPOINT = 'https://api.line.me/oauth2/v2.1/verify';

// --- Step 1: ID トークンのサーバーサイド検証 -------------------------------------------

/** verifyLiffIdToken が失敗として返しうる理由。 */
export type LiffTokenVerificationError =
  /** LINE が無効・期限切れ・プロバイダー不一致等でトークンを拒否した（HTTP 400 相当）。 */
  | 'INVALID_TOKEN'
  /** LINE 側の障害・ネットワークエラー・想定外のレスポンス形式など、トークンの真偽を判定できなかった。 */
  | 'VERIFY_REQUEST_FAILED';

export interface LiffAuthOptions {
  /** テスト用に検証エンドポイントを差し替える。 */
  readonly verifyEndpoint?: string;
  /** テスト用に fetch 実装を差し替える。 */
  readonly fetchImpl?: typeof fetch;
}

interface LineVerifyResponseBody {
  readonly sub?: unknown;
}

/**
 * LIFF から渡された ID トークンを LINE の `/oauth2/v2.1/verify` でサーバーサイド検証し、
 * 検証済み `sub`（=userId）を返す。`liff.getProfile()` の userId は信頼しない
 * （design.md で明示的に禁止されている）。
 *
 * 入力はトークン自体と呼出元（サーバー環境）が保持する client_id のみで、それ以外の
 * クライアント由来の値は一切参照しない。
 */
export async function verifyLiffIdToken(
  idToken: string,
  clientId: string,
  options: LiffAuthOptions = {},
): Promise<Result<string, LiffTokenVerificationError>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.verifyEndpoint ?? DEFAULT_VERIFY_ENDPOINT;

  const body = new URLSearchParams({ id_token: idToken, client_id: clientId });

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch {
    // ネットワーク例外の文言に idToken/clientId は含まれないが、念のため固定文言のみを使う
    // （セキュリティ制約: 生の ID トークンをログ/エラーに露出させない）。
    return { ok: false, error: 'VERIFY_REQUEST_FAILED' };
  }

  const rawBody = await response.text();

  if (!response.ok) {
    // LINE は無効/期限切れ/プロバイダー不一致のトークンを 400 で拒否する契約（research.md）。
    // 400 以外（5xx 等）は「トークンの真偽を判定できなかった」＝サービス障害として区別する。
    return { ok: false, error: response.status === 400 ? 'INVALID_TOKEN' : 'VERIFY_REQUEST_FAILED' };
  }

  let parsed: LineVerifyResponseBody;
  try {
    parsed = JSON.parse(rawBody) as LineVerifyResponseBody;
  } catch {
    return { ok: false, error: 'VERIFY_REQUEST_FAILED' };
  }

  if (typeof parsed.sub !== 'string' || parsed.sub.length === 0) {
    // 200 かつ sub 欠落は契約外の応答。真偽を判定できない安全側の分類ではなく、
    // 「認可主体を特定できないトークン」として INVALID_TOKEN に倒す（自店解決の唯一の鍵が無いため）。
    return { ok: false, error: 'INVALID_TOKEN' };
  }

  return { ok: true, value: parsed.sub };
}

// --- Step 2: 検証済み sub からの自店解決 -----------------------------------------------

/**
 * resolveOwnerStore が失敗として返しうる理由。
 *
 * four-tier-data-model の確定仕様により 1 オーナーは複数店舗を持ちうる（1:N。
 * db/migrations/0001_four_tier_baseline.sql の stores に owner_id 側の UNIQUE 制約は無い）。
 * sub のみを入力とする本関数は複数の confirmed 店舗を一意に絞り込む手段を持たないため、
 * 2 件以上の confirmed 店舗が見つかった場合は誤った店舗を推測で返さず AMBIGUOUS_STORE とする
 * （安全側の失敗。task 5.2 はこれを 404 相当として扱う想定）。
 */
export type StoreResolutionError =
  /** sub に一致する owner が存在しない。 */
  | 'OWNER_NOT_FOUND'
  /** owner は存在するが、place_status='confirmed' の店舗が 1 件も無い（オンボーディング未完了）。 */
  | 'STORE_NOT_IDENTIFIED'
  /** owner に confirmed 店舗が複数あり、sub のみでは自店を一意に決定できない（1:N の実例）。 */
  | 'AMBIGUOUS_STORE';

/**
 * 検証済み `sub` から自店（`stores` 行）を解決する。
 *
 * Security-critical: この関数のシグネチャは `(pool, sub: string)` の 2 引数のみを受け付ける。
 * `storeId`・`ownerId` 等、クライアント制御可能な識別子を受け取るパラメータは存在しない
 * （design.md「storeId を URL・リクエストボディから受けない」の構造的担保）。
 */
export async function resolveOwnerStore(
  pool: Queryable,
  sub: string,
): Promise<Result<StoreRow, StoreResolutionError>> {
  const ownerRes = await pool.query<{ id: string }>('SELECT id FROM owners WHERE line_user_id = $1', [
    sub,
  ]);
  const ownerRow = ownerRes.rows[0];
  if (!ownerRow) {
    return { ok: false, error: 'OWNER_NOT_FOUND' };
  }

  const storeRes = await pool.query<StoreRow>(
    `SELECT id, owner_id, category_code, name, latitude, longitude, place_id, place_status, created_at
       FROM stores
      WHERE owner_id = $1 AND place_status = 'confirmed'
      ORDER BY created_at ASC`,
    [ownerRow.id],
  );

  if (storeRes.rows.length === 0) {
    return { ok: false, error: 'STORE_NOT_IDENTIFIED' };
  }
  if (storeRes.rows.length > 1) {
    return { ok: false, error: 'AMBIGUOUS_STORE' };
  }

  return { ok: true, value: storeRes.rows[0]! };
}

// --- 合成: token 検証 → 自店解決 の単一エントリポイント ---------------------------------

/** authorizeStoreDetailRequest が返しうる失敗理由（検証エラー・解決エラーの和集合）。 */
export type StoreDetailAuthorizationError = LiffTokenVerificationError | StoreResolutionError;

/**
 * task 5.2（読取 API ルート）が使う単一のエントリポイント。
 * 「ID トークン検証 → sub → 自店解決」を一気通貫で行い、クライアントから受け取るのは
 * `idToken`（Authorization ヘッダ由来）のみとする。`clientId` はサーバー環境設定
 * （LIFF チャネル ID）であり、`pool` は DB 接続。ここでも storeId 等は一切受け取らない。
 *
 * 検証が失敗した場合は DB へ問い合わせない（無効トークンで owner 解決に進まないことを保証する
 * ショートサーキット）。
 */
export async function authorizeStoreDetailRequest(
  idToken: string,
  clientId: string,
  pool: Queryable,
  options: LiffAuthOptions = {},
): Promise<Result<StoreRow, StoreDetailAuthorizationError>> {
  const verifyResult = await verifyLiffIdToken(idToken, clientId, options);
  if (!verifyResult.ok) {
    return verifyResult;
  }
  return resolveOwnerStore(pool, verifyResult.value);
}
