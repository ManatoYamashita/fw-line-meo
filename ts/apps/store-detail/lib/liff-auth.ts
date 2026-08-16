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
// Security-critical な設計上の制約（design.md「クライアント入力の不変条件」・Issue #61 で再定義）:
//   認可主体（誰か）は検証済み sub のみが決める。クライアント由来の識別子は、sub から導いた
//   「認可済み集合」の内部での絞り込みにのみ使用でき、集合の境界を広げる入力としては使えない。
//   集合外の値は無視し、未指定時と完全に同一の応答を返す（非オラクル）。
//
//   これを構造で担保するため、責務を 2 つに分離している:
//     listOwnerConfirmedStores(pool, sub)  — 集合の生成。入力は検証済み sub のみ
//     selectAuthorizedStore(stores, hint)  — 集合内の選択。pool を受け取らない純関数
//   後者が DB に触れないため、クライアント由来のヒントは SQL に一切到達しない。これは
//   IDOR の構造的排除に加え、不正 UUID による pg 22P02（→ 500）も同時に不可能にする。
//
//   検証の所在（Issue #70 / PR #76・Issue #66 で是正済み）:
//     test/liff-auth.test.ts の型レベル検証は、tsconfig.json の exclude から "test" が外れた
//     ため typecheck（tsc -p tsconfig.json --noEmit）と next build の双方で実行される。
//     scripts/check-test-code-coverage.sh が tsc --listFiles で「実際にプログラムへ含まれて
//     いるか」を機械検証しているため、再び除外されれば CI が赤くなる。
//   実効ガードは 4 つ:
//     (a) test/liff-auth.test.ts の型ブロック — 引数タプル形状、options の鍵集合
//         （Exclude<keyof …> による表明。左辺は LiffAuthOptions だけでなく
//         authorizeStoreDetailRequest / verifyLiffIdToken の**実引数位置の型**も含む。
//         名前付き型だけに固定すると、引数位置の型を派生型・交差型へ差し替える経路が
//         素通りすることを PR #79 のレビューで実測した）、および許可鍵の型
//     (b) 同ファイルの arity チェック（実行時。既定値付き引数は .length に数えられないため
//         (a) の二重化にとどまり、単独では options への密輸を検出できない）
//     (c) selectAuthorizedStore の振る舞いテスト（戻り値が必ず入力配列の要素であること）
//     (d) test/route.db.test.ts の非オラクル deep-equal

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

// --- Step 2: 検証済み sub からの「認可済み集合」の生成 -----------------------------------

/**
 * listOwnerConfirmedStores が失敗として返しうる理由。
 *
 * four-tier-data-model の確定仕様により 1 オーナーは複数店舗を持ちうる（1:N。
 * db/migrations/0001_four_tier_baseline.sql の stores に owner_id 側の UNIQUE 制約は無い）。
 * 本関数は集合をそのまま返すため、複数店舗は失敗ではない（Issue #61 以前に存在した
 * AMBIGUOUS_STORE は廃止。表示対象が決まらない場合の扱いは呼出元＝ルートの責務）。
 */
export type StoreResolutionError =
  /** sub に一致する owner が存在しない。 */
  | 'OWNER_NOT_FOUND'
  /** owner は存在するが、place_status='confirmed' の店舗が 1 件も無い（オンボーディング未完了）。 */
  | 'STORE_NOT_IDENTIFIED';

/**
 * 検証済み `sub` が所有する confirmed 店舗の集合（＝認可済み集合）を返す。
 *
 * Security-critical: この関数のシグネチャは `(pool, sub: string)` の 2 引数のみを受け付ける。
 * `storeId`・`ownerId` 等、クライアント制御可能な識別子を受け取るパラメータは存在しない。
 * 集合の境界は常に sub のみが決め、クライアント入力が境界を広げることはできない。
 *
 * 並び順は `created_at ASC, id ASC`。`created_at` の既定値 `now()` は**トランザクション開始
 * 時刻**であり、複数店舗を 1 トランザクションで登録すると同値になりうるため、`id` を
 * tiebreaker に置いて呼出ごとの順序揺れ（＝選択リストの並び替わり）を防ぐ。
 */
export async function listOwnerConfirmedStores(
  pool: Queryable,
  sub: string,
): Promise<Result<readonly StoreRow[], StoreResolutionError>> {
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
      ORDER BY created_at ASC, id ASC`,
    [ownerRow.id],
  );

  if (storeRes.rows.length === 0) {
    return { ok: false, error: 'STORE_NOT_IDENTIFIED' };
  }

  return { ok: true, value: storeRes.rows };
}

// --- Step 2b: 認可済み集合の「内部での」絞り込み（純関数・DB に触れない） ------------------

/**
 * 認可済み集合 `stores` の中から、クライアント由来のヒント `requestedStoreId` に一致する
 * 店舗を返す。一致しなければ `null`。
 *
 * Security-critical: 本関数は `Queryable` を受け取らない純関数であり、ヒントは SQL に一切
 * 到達しない（引数タプルに Queryable が現れないことは test/liff-auth.test.ts の型ブロックが
 * 機械検証する）。副次的に、UUID として不正な文字列を渡されても pg の 22P02
 * （invalid_text_representation）が発生しえず、500 に化けることもない。
 *
 * ⚠️ 型が担保するのはここまでである。戻り値の型は `StoreRow | null` であり、「戻り値が必ず
 *    入力配列の要素であること」は型では表現できない（新しい StoreRow を組み立てて返す実装も
 *    型検査を通る）。この不変条件＝ IDOR の構造的排除は、test/liff-auth.test.ts の
 *    「戻り値は必ず入力配列の要素である」振る舞いテストだけが担保している。当該テストを
 *    削除すると根拠が失われるため、削除してはならない。
 *
 * ヒントが `null`・空文字・集合外のいずれであっても一律 `null` を返す。呼出元はこれを
 * 「未指定」と区別してはならない（design.md の非オラクル要件。集合外の値の存在有無を
 * クライアントに観測させないため）。
 */
export function selectAuthorizedStore(
  stores: readonly StoreRow[],
  requestedStoreId: string | null,
): StoreRow | null {
  if (!requestedStoreId) {
    return null;
  }
  return stores.find((store) => store.id === requestedStoreId) ?? null;
}

// --- 合成: token 検証 → 認可済み集合の生成 の単一エントリポイント -------------------------

/** authorizeStoreDetailRequest が返しうる失敗理由（検証エラー・解決エラーの和集合）。 */
export type StoreDetailAuthorizationError = LiffTokenVerificationError | StoreResolutionError;

/**
 * 読取 API ルートが使う単一のエントリポイント。
 * 「ID トークン検証 → sub → 認可済み集合の生成」を一気通貫で行い、クライアントから受け取るのは
 * `idToken`（Authorization ヘッダ由来）のみとする。`clientId` はサーバー環境設定
 * （LIFF チャネル ID）であり、`pool` は DB 接続。ここでも storeId 等は一切受け取らない。
 *
 * 表示対象の絞り込み（クライアント由来のヒントの適用）は意図的に本関数の外に置き、
 * `selectAuthorizedStore` に分離している。「認可（集合の決定）」と「選択（集合内の絞り込み）」を
 * 混ぜないことが不変条件の担保そのものであり、`options` にクライアント制御可能な識別子を
 * 追加することは禁止する。arity チェックは既定値付き引数を数えないためこの経路を検出できないが、
 * test/liff-auth.test.ts の型ブロックが鍵集合を `Exclude<keyof LiffAuthOptions | keyof
 * ActualAuthorizeOptions | keyof ActualVerifyOptions, keyof ExpectedLiffAuthOptions>` で表明して
 * おり、許可外の鍵が生えれば違反鍵名つきでコンパイルが失敗する（Issue #66・PR #79）。
 * `ActualAuthorizeOptions` / `ActualVerifyOptions` は本関数と verifyLiffIdToken の実引数位置から
 * 導いてある。`LiffAuthOptions` を変えずに引数位置の型だけを派生型・交差型へ差し替える迂回を
 * 塞ぐためであり、この 2 つを外すとその経路が素通りする（実測済み）。
 *
 * 検証が失敗した場合は DB へ問い合わせない（無効トークンで owner 解決に進まないことを保証する
 * ショートサーキット）。
 */
export async function authorizeStoreDetailRequest(
  idToken: string,
  clientId: string,
  pool: Queryable,
  options: LiffAuthOptions = {},
): Promise<Result<readonly StoreRow[], StoreDetailAuthorizationError>> {
  const verifyResult = await verifyLiffIdToken(idToken, clientId, options);
  if (!verifyResult.ok) {
    return verifyResult;
  }
  return listOwnerConfirmedStores(pool, verifyResult.value);
}
