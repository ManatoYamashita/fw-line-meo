// Google ビジネスプロフィール（GBP）REST API の薄いクライアント（gbp-post-review-reply spec task 2.2）。
// Requirements: 3.5（承認済み下書きの投稿実行）, 4.1（返信対象クチコミの一覧取得）,
// 4.4（公式返信の投稿）, 5.3（新着クチコミの返信候補提示のためのオンデマンド取得）。
//
// 設計上の責務と不変条件:
// - v4（mybusiness.googleapis.com）と v1（Account Management / Business Information）の
//   **name 形式差の吸収を単一所有する**。v1 の location は `locations/{l}`、v4 は
//   `accounts/{a}/locations/{l}` を要求するため、`gbp_locations` に保持した
//   account_name・location_name の結合をこのモジュール以外で行ってはならない。
// - 認可トークンは TokenStore 経由でのみ取得する。refresh grant には一切触れない
//   （google-auth-library の GaxiosError はリクエストボディに平文 refresh token を保持するため、
//   本モジュールが原エラーへ触れる経路自体を作らない・Req 2.1）。
// - 429/5xx は指数バックオフで 1 回だけ再試行し、それでも失敗した場合は型付きエラーで返す
//   （上位の GbpFlows が LINE 向けメッセージへ一元変換する・Req 3.7, 4.7）。
// - HTTP には Node 標準 fetch のみを使用し、新規 HTTP ライブラリを導入しない。
//   テストで実ネットワークを叩かないよう fetch と backoff を注入可能にする。

import { getGbpLocation, type Queryable, type Result } from '@fwlm/db';
import type { StoreKey, TokenStoreError, TokenStoreService } from './token-store.js';

const V4_BASE = 'https://mybusiness.googleapis.com/v4';
const ACCOUNT_MANAGEMENT_BASE = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const BUSINESS_INFORMATION_BASE = 'https://mybusinessbusinessinformation.googleapis.com/v1';

/** Business Information の locations.list は readMask 必須。突合に必要な最小フィールドのみ要求する。 */
const LOCATIONS_READ_MASK = 'name,title,metadata';
/** 投稿はテキスト主体の標準投稿のみ（本 spec のスコープ。イベント・特典は扱わない）。 */
const LOCAL_POST_TOPIC_TYPE = 'STANDARD';
const LOCAL_POST_LANGUAGE_CODE = 'ja';
/** v4 reviews.list の pageSize 上限。 */
const REVIEWS_PAGE_SIZE_MAX = 50;
/** ページ送りの安全上限（無限ループ・クォータ浪費の防止）。 */
const MAX_PAGES = 10;
/** 429/5xx の再試行は 1 回（= 合計 2 試行）。 */
const MAX_ATTEMPTS = 2;

/** GBP のリソース ID として許容する形（パス区切り・空白・クエリ混入を排除する）。 */
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_.~-]+$/;
/**
 * ドットのみで構成された ID（`.` / `..`）。URL 正規化で親階層へ抜けるため個別に排除する
 * （例: `.../reviews/../reply` は `.../locations/{l}/reply` に化ける）。
 */
const DOT_ONLY_ID_PATTERN = /^\.+$/;

/** 外部 URL のパスセグメントとして安全に埋め込める ID かを判定する。 */
function isSafeResourceId(id: string): boolean {
  return RESOURCE_ID_PATTERN.test(id) && !DOT_ONLY_ID_PATTERN.test(id);
}

/** 返信対象クチコミ（GbpFlows がセッションへスナップショットする形）。 */
export interface GbpReview {
  /** accounts/{a}/locations/{l}/reviews/{r}（返信の宛先）。 */
  reviewName: string;
  /** 1..5。GBP の enum が未知値の場合は 0。 */
  rating: number;
  authorName: string;
  /** 評価のみのクチコミでは空文字。 */
  comment: string;
  createTime: string;
  hasReply: boolean;
  replyComment: string | null;
}

/** v1 列挙の結果 1 件（placeId で stores.place_id と突合する）。 */
export interface GbpAccountLocation {
  accountName: string;
  locationName: string;
  title: string;
  placeId: string | null;
  canOperateLocalPost: boolean;
}

/**
 * GBP 呼び出しの失敗分類。
 * - `not_linked`: 店舗が未連携（`gbp_locations` 行なし・トークン行なし・保存 name が不正）。
 *   design の GbpApiError には無いが、`token_invalid`（再連携誘導）と区別が必要なため追加した。
 * - `token_invalid`: TokenStore 由来の失効を透過（Req 2.3）。**オーナー側の再連携で回復する**。
 * - `crypto_error`: token_ref を復号できない（暗号鍵の不一致・改竄）。**オーナーには回復手段がなく、
 *   運用側の対応が必要**なため `token_invalid` に畳まない。畳むと鍵の誤投入（不良デプロイ）で
 *   全オーナーに再連携を促し、誤鍵下で保存された新トークンがロールバック後に壊れる連鎖破損を招く。
 * - `permission_denied`: 401/403、および自店以外の location を指す reviewName（fail-closed）。
 * - `rate_limited`: 1 回の再試行後も 429。
 * - `incomplete_listing`: ページ送りが安全上限に達し列挙が不完全（部分結果を成功として返さない）。
 * - `upstream_error`: 上記以外の HTTP 失敗・ネットワーク断・レスポンス解釈不能・
 *   TokenStore の一過性障害（status=0）。いずれも再試行で回復しうる。
 */
export type GbpApiError =
  | { kind: 'not_linked' }
  | { kind: 'token_invalid' }
  | { kind: 'crypto_error' }
  | { kind: 'permission_denied' }
  | { kind: 'rate_limited' }
  | { kind: 'incomplete_listing' }
  | { kind: 'upstream_error'; status: number };

export interface CreateLocalPostInput extends StoreKey {
  /** 1500 文字以内であることは呼び出し側（GbpPrompts の検証）で保証済み。 */
  summary: string;
}

export interface ListReviewsInput extends StoreKey {
  /** 1..50 にクランプされる。 */
  limit: number;
}

export interface UpsertReviewReplyInput extends StoreKey {
  /** accounts/{a}/locations/{l}/reviews/{r}。自店の location と一致しない場合は拒否する。 */
  reviewName: string;
  /** 4096 バイト以内であることは呼び出し側（GbpPrompts の検証）で保証済み。 */
  comment: string;
}

export interface GbpClientService {
  /** OAuth callback 時点の一時アクセストークンで v1 の accounts / locations を全列挙する。 */
  listAccountsAndLocations(accessToken: string): Promise<Result<GbpAccountLocation[], GbpApiError>>;
  createLocalPost(
    db: Queryable,
    input: CreateLocalPostInput,
  ): Promise<Result<{ postName: string }, GbpApiError>>;
  /** GBP の返却順のまま返す。新着順・未返信優先などの整列は呼び出し側の責務（Req 4.1, 5.3）。 */
  listReviews(db: Queryable, input: ListReviewsInput): Promise<Result<GbpReview[], GbpApiError>>;
  /** 既存返信があれば上書きする（upsert）。上書き確認は GbpFlows が事前に取る（Req 4.6）。 */
  upsertReviewReply(db: Queryable, input: UpsertReviewReplyInput): Promise<Result<void, GbpApiError>>;
}

export interface GbpClientDeps {
  /** アクセストークンの唯一の供給元。refresh grant はこの内側に閉じる（Req 2.1）。 */
  tokenStore: Pick<TokenStoreService, 'getAccessTokenForStore'>;
  /** Node 標準 fetch を渡す。テストではスタブを注入する。 */
  fetch: typeof fetch;
  /** 再試行前の待機（省略時は 500ms * 2^attempt）。テストで注入可能。 */
  backoff?: ((attempt: number) => Promise<void>) | undefined;
}

// =====================================================================
// name 形式変換（本モジュールの単一所有）
// =====================================================================

/** `accounts/123` / `123` / `accounts/123/locations/9` 等から末尾の ID を取り出す。 */
function extractResourceId(value: string, collection: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed === '') return null;

  const segments = trimmed.split('/');
  const index = segments.lastIndexOf(collection);
  // コレクション名を含む場合は「その直後の 1 セグメント」だけを ID とみなす。
  const id = index === -1 ? (segments.length === 1 ? segments[0] : null) : segments[index + 1];
  if (id === undefined || id === null || id === '') return null;
  // コレクション名の直後にさらにセグメントが続く（= 別階層）場合は、
  // その先が既知の下位コレクションでない限り不正として扱う。
  if (index !== -1 && segments.length > index + 2) {
    const next = segments[index + 2];
    if (next !== 'locations' && next !== 'reviews' && next !== 'localPosts') return null;
  }
  return isSafeResourceId(id) ? id : null;
}

/**
 * v1 の `locations/{l}` と保管済み `accounts/{a}` から v4 のロケーションパスを組む。
 * 形式が解釈できない場合は null（不正な URL を組んで外部へ送らないため）。
 */
export function buildV4LocationPath(accountName: string, locationName: string): string | null {
  const accountId = extractResourceId(accountName, 'accounts');
  const locationId = extractResourceId(locationName, 'locations');
  if (accountId === null || locationId === null) return null;
  return `accounts/${accountId}/locations/${locationId}`;
}

/**
 * クチコミ返信の v4 パス（`{v4LocationPath}/reviews/{r}/reply`）を組む。
 * reviewName に含まれる location 部分が自店と一致しない場合は null を返す
 * （postback 由来の name を信用せず、他店舗のクチコミへ返信できない構造にする・Req 2.6）。
 */
export function buildV4ReviewReplyPath(
  v4LocationPath: string,
  reviewName: string,
): string | null {
  const trimmed = reviewName.trim().replace(/\/+$/, '');
  const marker = '/reviews/';
  const at = trimmed.indexOf(marker);
  if (at === -1) return null;

  const locationPart = trimmed.slice(0, at);
  const reviewId = trimmed.slice(at + marker.length);
  if (locationPart !== v4LocationPath) return null;
  if (!isSafeResourceId(reviewId)) return null;
  return `${v4LocationPath}/reviews/${reviewId}/reply`;
}

// =====================================================================
// レスポンス解釈（unknown からの安全な取り出し）
// =====================================================================

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown, key: string): string | null {
  const record = asRecord(value);
  const field = record?.[key];
  return typeof field === 'string' ? field : null;
}

function readArray(value: unknown, key: string): unknown[] {
  const record = asRecord(value);
  const field = record?.[key];
  return Array.isArray(field) ? field : [];
}

const STAR_RATING_TO_NUMBER: Readonly<Record<string, number>> = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

function toGbpReview(raw: unknown): GbpReview | null {
  const name = readString(raw, 'name');
  if (name === null) return null;
  const record = asRecord(raw);
  const starRating = readString(raw, 'starRating') ?? '';
  const reply = record?.['reviewReply'];
  const replyComment = readString(reply, 'comment');

  return {
    reviewName: name,
    rating: STAR_RATING_TO_NUMBER[starRating] ?? 0,
    authorName: readString(record?.['reviewer'], 'displayName') ?? '',
    comment: readString(raw, 'comment') ?? '',
    createTime: readString(raw, 'createTime') ?? '',
    hasReply: replyComment !== null,
    replyComment,
  };
}

function toAccountLocation(accountName: string, raw: unknown): GbpAccountLocation | null {
  const locationName = readString(raw, 'name');
  if (locationName === null) return null;
  const metadata = asRecord(raw)?.['metadata'];
  const canOperate = asRecord(metadata)?.['canOperateLocalPost'];

  return {
    accountName,
    locationName,
    title: readString(raw, 'title') ?? '',
    placeId: readString(metadata, 'placeId'),
    canOperateLocalPost: canOperate === true,
  };
}

// =====================================================================
// HTTP（分類・再試行）
// =====================================================================

function classifyStatus(status: number): GbpApiError {
  if (status === 401 || status === 403) return { kind: 'permission_denied' };
  if (status === 429) return { kind: 'rate_limited' };
  return { kind: 'upstream_error', status };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  accessToken: string;
  body?: unknown;
  /** false のときレスポンスボディを解釈しない（更新系で本文を必要としない場合）。 */
  expectJson: boolean;
}

function defaultBackoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
}

function createRequester(deps: GbpClientDeps) {
  const backoff = deps.backoff ?? defaultBackoff;

  return async function send(options: RequestOptions): Promise<Result<unknown, GbpApiError>> {
    const init: RequestInit = {
      method: options.method,
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        Accept: 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    };

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await backoff(attempt - 1);

      let response: Response;
      try {
        response = await deps.fetch(options.url, init);
      } catch {
        // ネットワーク断・タイムアウト。原因の詳細（URL・トークン）は伝播させない。
        return { ok: false, error: { kind: 'upstream_error', status: 0 } };
      }

      if (!response.ok) {
        const isLastAttempt = attempt === MAX_ATTEMPTS - 1;
        if (!isLastAttempt && isRetryableStatus(response.status)) continue;
        return { ok: false, error: classifyStatus(response.status) };
      }

      if (!options.expectJson) return { ok: true, value: null };
      try {
        return { ok: true, value: await response.json() };
      } catch {
        // 2xx なのに解釈不能（HTML のエラーページ等）。
        return { ok: false, error: { kind: 'upstream_error', status: 0 } };
      }
    }
    // MAX_ATTEMPTS >= 1 のため到達しないが、noImplicitReturns のため明示する。
    return { ok: false, error: { kind: 'upstream_error', status: 0 } };
  };
}

// =====================================================================
// クライアント本体
// =====================================================================

/**
 * TokenStore のエラーを GBP 呼び出しの分類へ写像する。
 *
 * TokenStore は invalid_grant「以外」の refresh 失敗（ネットワーク断・Google トークン
 * エンドポイントの 5xx）を throw するため、ここで必ず捕捉して Result に閉じる。
 * 例外が外へ漏れると GbpFlows が失敗を型として受け取れず、Req 3.7 / 4.7 の
 * 「失敗通知＋再試行手段の提示・承認済み下書きの温存」が成立しない。
 */
async function resolveAccessToken(
  deps: GbpClientDeps,
  db: Queryable,
  key: StoreKey,
): Promise<Result<string, GbpApiError>> {
  let res: Result<string, TokenStoreError>;
  try {
    res = await deps.tokenStore.getAccessTokenForStore(db, key);
  } catch {
    // 一過性障害として扱う（失効ではないので再連携誘導へ倒さない）。
    // 原エラーは保持しない: サニタイズ済みでも露出面を増やさない方針（Req 2.1）。
    return { ok: false, error: { kind: 'upstream_error', status: 0 } };
  }

  if (res.ok) return res;
  switch (res.error.kind) {
    case 'not_linked':
      return { ok: false, error: { kind: 'not_linked' } };
    case 'token_invalid':
      return { ok: false, error: { kind: 'token_invalid' } };
    case 'crypto_error':
      // 復号不能は運用側の障害。オーナーの再連携では直らないため区別して伝える。
      return { ok: false, error: { kind: 'crypto_error' } };
  }
}

/** `gbp_locations` の保管値から v4 ロケーションパスを解決する（未連携・不正保存は not_linked）。 */
async function resolveV4LocationPath(
  db: Queryable,
  key: StoreKey,
): Promise<Result<string, GbpApiError>> {
  const row = await getGbpLocation(db, { ownerId: key.ownerId, storeId: key.storeId });
  if (row === null) return { ok: false, error: { kind: 'not_linked' } };
  const path = buildV4LocationPath(row.account_name, row.location_name);
  if (path === null) return { ok: false, error: { kind: 'not_linked' } };
  return { ok: true, value: path };
}

export function createGbpClient(deps: GbpClientDeps): GbpClientService {
  const send = createRequester(deps);

  /**
   * ページトークンを辿って items を集約する。`MAX_PAGES` に達してもなお続きがある場合は、
   * 部分結果を成功として返さず `incomplete_listing` で失敗させる（fail-closed）。
   * 欠けた結果を返すと、placeId 突合でロケーションを見落とし
   * Req 1.6「管理権限なし」の誤判定につながるため。
   */
  async function collectPages(
    baseUrl: string,
    accessToken: string,
    itemsKey: string,
    params: Record<string, string>,
  ): Promise<Result<unknown[], GbpApiError>> {
    const items: unknown[] = [];
    let pageToken: string | null = null;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const search = new URLSearchParams(params);
      if (pageToken !== null) search.set('pageToken', pageToken);
      const query = search.toString();
      const res: Result<unknown, GbpApiError> = await send({
        method: 'GET',
        url: query === '' ? baseUrl : `${baseUrl}?${query}`,
        accessToken,
        expectJson: true,
      });
      if (!res.ok) return res;

      items.push(...readArray(res.value, itemsKey));
      pageToken = readString(res.value, 'nextPageToken');
      if (pageToken === null || pageToken === '') return { ok: true, value: items };
    }
    // 上限到達時点で続きが残っている = 列挙が不完全。
    return { ok: false, error: { kind: 'incomplete_listing' } };
  }

  return {
    async listAccountsAndLocations(accessToken) {
      const accountsRes = await collectPages(
        `${ACCOUNT_MANAGEMENT_BASE}/accounts`,
        accessToken,
        'accounts',
        {},
      );
      if (!accountsRes.ok) return accountsRes;

      const result: GbpAccountLocation[] = [];
      for (const account of accountsRes.value) {
        const accountName = readString(account, 'name');
        if (accountName === null) continue;
        const accountId = extractResourceId(accountName, 'accounts');
        if (accountId === null) continue;

        const locationsRes = await collectPages(
          `${BUSINESS_INFORMATION_BASE}/accounts/${accountId}/locations`,
          accessToken,
          'locations',
          { readMask: LOCATIONS_READ_MASK },
        );
        if (!locationsRes.ok) return locationsRes;

        for (const location of locationsRes.value) {
          const mapped = toAccountLocation(accountName, location);
          if (mapped !== null) result.push(mapped);
        }
      }
      return { ok: true, value: result };
    },

    async createLocalPost(db, input) {
      const pathRes = await resolveV4LocationPath(db, input);
      if (!pathRes.ok) return pathRes;
      const tokenRes = await resolveAccessToken(deps, db, input);
      if (!tokenRes.ok) return tokenRes;

      const res = await send({
        method: 'POST',
        url: `${V4_BASE}/${pathRes.value}/localPosts`,
        accessToken: tokenRes.value,
        body: {
          languageCode: LOCAL_POST_LANGUAGE_CODE,
          summary: input.summary,
          topicType: LOCAL_POST_TOPIC_TYPE,
        },
        expectJson: true,
      });
      if (!res.ok) return res;

      const postName = readString(res.value, 'name');
      // 作成は成功しているが name を読めない = 応答形式の想定外。
      if (postName === null) return { ok: false, error: { kind: 'upstream_error', status: 0 } };
      return { ok: true, value: { postName } };
    },

    async listReviews(db, input) {
      const pathRes = await resolveV4LocationPath(db, input);
      if (!pathRes.ok) return pathRes;
      const tokenRes = await resolveAccessToken(deps, db, input);
      if (!tokenRes.ok) return tokenRes;

      const pageSize = Math.min(Math.max(Math.trunc(input.limit) || 1, 1), REVIEWS_PAGE_SIZE_MAX);
      // orderBy は送らない: v4 reviews.list が対応するという一次情報が無く、非対応パラメータを
      // 付けると全リクエストが 400 になる。整列は design どおり呼び出し側の責務（Req 4.1, 5.3）。
      const query = new URLSearchParams({ pageSize: String(pageSize) });
      const res = await send({
        method: 'GET',
        url: `${V4_BASE}/${pathRes.value}/reviews?${query.toString()}`,
        accessToken: tokenRes.value,
        expectJson: true,
      });
      if (!res.ok) return res;

      const reviews: GbpReview[] = [];
      for (const raw of readArray(res.value, 'reviews')) {
        const review = toGbpReview(raw);
        if (review !== null) reviews.push(review);
      }
      return { ok: true, value: reviews };
    },

    async upsertReviewReply(db, input) {
      const pathRes = await resolveV4LocationPath(db, input);
      if (!pathRes.ok) return pathRes;

      const replyPath = buildV4ReviewReplyPath(pathRes.value, input.reviewName);
      // 自店以外を指す name は送信せずに拒否する（fail-closed・Req 2.6）。
      if (replyPath === null) return { ok: false, error: { kind: 'permission_denied' } };

      const tokenRes = await resolveAccessToken(deps, db, input);
      if (!tokenRes.ok) return tokenRes;

      const res = await send({
        method: 'PUT',
        url: `${V4_BASE}/${replyPath}`,
        accessToken: tokenRes.value,
        body: { comment: input.comment },
        expectJson: false,
      });
      if (!res.ok) return res;
      return { ok: true, value: undefined };
    },
  };
}
