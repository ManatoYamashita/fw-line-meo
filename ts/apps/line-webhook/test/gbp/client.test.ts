import { describe, it, expect, vi } from 'vitest';
import type { GbpLocationRow, Queryable } from '@fwlm/db';
import {
  buildV4LocationPath,
  buildV4ReviewReplyPath,
  createGbpClient,
  type GbpApiError,
  type GbpClientService,
} from '../../src/gbp/client.js';
import type { StoreKey, TokenStoreError } from '../../src/gbp/token-store.js';
import type { Result } from '@fwlm/db';

// --- fixtures（unit テスト・実ネットワーク／実 DB には触れない）---
const OWNER = 'fcd00000-0000-0000-0000-00000000000a';
const STORE = 'fcd00000-0000-0000-0000-0000000000a1';
const KEY: StoreKey = { ownerId: OWNER, storeId: STORE };
const ACCESS_TOKEN = 'ya29.test-access-token';
const ACCOUNT_NAME = 'accounts/1234567890';
const LOCATION_NAME = 'locations/9876543210';
const V4_PATH = 'accounts/1234567890/locations/9876543210';

function locationRow(overrides: Partial<GbpLocationRow> = {}): GbpLocationRow {
  return {
    id: 'fcd00000-0000-0000-0000-0000000000e1',
    store_id: STORE,
    account_name: ACCOUNT_NAME,
    location_name: LOCATION_NAME,
    place_id: 'ChIJtest',
    can_operate_local_post: true,
    linked_at: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

/** getGbpLocation の SQL に固定応答を返す最小の偽 Queryable。 */
function fakeDb(rows: GbpLocationRow[]): Queryable {
  return {
    query: async () => ({ rows, rowCount: rows.length }),
  } as unknown as Queryable;
}

function stubTokenStore(
  result: Result<string, TokenStoreError> = { ok: true, value: ACCESS_TOKEN },
  rejection?: Error,
): { getAccessTokenForStore: () => Promise<Result<string, TokenStoreError>> } {
  return {
    getAccessTokenForStore: async () => {
      // TokenStore は invalid_grant 以外の refresh 失敗（ネットワーク断・Google の 5xx）で
      // サニタイズ済み Error を throw する（token-store.ts の sanitizeRefreshError）。
      if (rejection !== undefined) throw rejection;
      return result;
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** backoff を no-op に差し替えたクライアント（テストで実待機しない）。 */
function makeClient(opts: {
  fetch: typeof fetch;
  token?: Result<string, TokenStoreError>;
  tokenRejection?: Error;
  rows?: GbpLocationRow[];
}): { client: GbpClientService; db: Queryable; backoffCalls: number[] } {
  const backoffCalls: number[] = [];
  const client = createGbpClient({
    tokenStore: stubTokenStore(opts.token, opts.tokenRejection),
    fetch: opts.fetch,
    backoff: async (attempt: number) => {
      backoffCalls.push(attempt);
    },
  });
  return { client, db: fakeDb(opts.rows ?? [locationRow()]), backoffCalls };
}

// =====================================================================
// name 形式変換（v1 `locations/{l}` → v4 `accounts/{a}/locations/{l}`）
// =====================================================================
describe('buildV4LocationPath', () => {
  it('accounts/{a} と locations/{l} を v4 パスへ結合する', () => {
    expect(buildV4LocationPath(ACCOUNT_NAME, LOCATION_NAME)).toBe(V4_PATH);
  });

  it('location 側が v4 形式で保存されていても account は保管値を優先する', () => {
    expect(buildV4LocationPath(ACCOUNT_NAME, 'accounts/999/locations/9876543210')).toBe(V4_PATH);
  });

  it('裸の ID（プレフィックスなし）も受け付ける', () => {
    expect(buildV4LocationPath('1234567890', '9876543210')).toBe(V4_PATH);
  });

  it('末尾スラッシュ・前後空白を許容する', () => {
    expect(buildV4LocationPath(' accounts/1234567890/ ', ' locations/9876543210 ')).toBe(V4_PATH);
  });

  it('空・不正な ID は null を返す', () => {
    expect(buildV4LocationPath('', LOCATION_NAME)).toBeNull();
    expect(buildV4LocationPath(ACCOUNT_NAME, '')).toBeNull();
    expect(buildV4LocationPath(ACCOUNT_NAME, 'locations/')).toBeNull();
    expect(buildV4LocationPath('accounts/bad id', LOCATION_NAME)).toBeNull();
    expect(buildV4LocationPath(ACCOUNT_NAME, 'locations/a/b')).toBeNull();
  });

  it('ドットのみの ID（. / ..）はパス正規化で階層を抜けるため null', () => {
    expect(buildV4LocationPath(ACCOUNT_NAME, 'locations/..')).toBeNull();
    expect(buildV4LocationPath(ACCOUNT_NAME, 'locations/.')).toBeNull();
    expect(buildV4LocationPath('accounts/..', LOCATION_NAME)).toBeNull();
  });
});

describe('buildV4ReviewReplyPath', () => {
  it('reviewName の review ID を店舗の v4 パスへ再結合する', () => {
    expect(buildV4ReviewReplyPath(V4_PATH, `${V4_PATH}/reviews/abc-123`)).toBe(
      `${V4_PATH}/reviews/abc-123/reply`,
    );
  });

  it('他店舗の location を指す reviewName は null（テナント隔離・Req 2.6）', () => {
    expect(
      buildV4ReviewReplyPath(V4_PATH, 'accounts/1234567890/locations/1111111111/reviews/abc-123'),
    ).toBeNull();
  });

  it('reviews セグメントを欠く name は null', () => {
    expect(buildV4ReviewReplyPath(V4_PATH, V4_PATH)).toBeNull();
    expect(buildV4ReviewReplyPath(V4_PATH, '')).toBeNull();
  });

  // `.../reviews/../reply` は URL 正規化で `.../locations/{l}/reply` へ化ける。
  // locationPart 一致検証が先に効くため越境はしないが、明示的に排除しておく。
  it('ドットのみの review ID（. / ..）は null', () => {
    expect(buildV4ReviewReplyPath(V4_PATH, `${V4_PATH}/reviews/..`)).toBeNull();
    expect(buildV4ReviewReplyPath(V4_PATH, `${V4_PATH}/reviews/.`)).toBeNull();
  });
});

// =====================================================================
// listAccountsAndLocations（v1・accounts + locations 列挙）
// =====================================================================
describe('listAccountsAndLocations', () => {
  it('v1 の accounts / locations を列挙し placeId 付きで返す', async () => {
    // 第 2 引数（RequestInit）まで受ける。省略すると呼び出し記録が 1 要素タプルになり、
    // 下の Authorization ヘッダ検証が `calls[n][1]` へ到達できない。
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://mybusinessaccountmanagement.googleapis.com/v1/accounts')) {
        return jsonResponse(200, { accounts: [{ name: ACCOUNT_NAME }] });
      }
      return jsonResponse(200, {
        locations: [
          {
            name: LOCATION_NAME,
            title: 'テスト食堂',
            metadata: { placeId: 'ChIJtest', canOperateLocalPost: true },
          },
          { name: 'locations/222', title: '二号店', metadata: {} },
        ],
      });
    });
    const { client } = makeClient({ fetch: fetchMock as unknown as typeof fetch });

    const res = await client.listAccountsAndLocations(ACCESS_TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual([
      {
        accountName: ACCOUNT_NAME,
        locationName: LOCATION_NAME,
        title: 'テスト食堂',
        placeId: 'ChIJtest',
        canOperateLocalPost: true,
      },
      {
        accountName: ACCOUNT_NAME,
        locationName: 'locations/222',
        title: '二号店',
        placeId: null,
        canOperateLocalPost: false,
      },
    ]);

    // locations 呼び出しは readMask 必須・parent は account name
    const locationsCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('mybusinessbusinessinformation'),
    );
    expect(locationsCall).toBeDefined();
    const locationsUrl = new URL(String(locationsCall?.[0]));
    expect(locationsUrl.pathname).toBe(`/v1/${ACCOUNT_NAME}/locations`);
    expect(locationsUrl.searchParams.get('readMask')).toBe('name,title,metadata');
    const init = locationsCall?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('nextPageToken を辿って全ページを集約する', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const token = url.searchParams.get('pageToken');
      if (url.host.startsWith('mybusinessaccountmanagement')) {
        return token === null
          ? jsonResponse(200, { accounts: [{ name: ACCOUNT_NAME }], nextPageToken: 'a2' })
          : jsonResponse(200, { accounts: [{ name: 'accounts/second' }] });
      }
      return token === null
        ? jsonResponse(200, {
            locations: [{ name: LOCATION_NAME, title: 'A', metadata: {} }],
            nextPageToken: 'l2',
          })
        : jsonResponse(200, { locations: [{ name: 'locations/333', title: 'B', metadata: {} }] });
    });
    const { client } = makeClient({ fetch: fetchMock as unknown as typeof fetch });

    const res = await client.listAccountsAndLocations(ACCESS_TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 2 アカウント × 2 ロケーション
    expect(res.value).toHaveLength(4);
    expect(res.value.map((v) => v.accountName)).toEqual([
      ACCOUNT_NAME,
      ACCOUNT_NAME,
      'accounts/second',
      'accounts/second',
    ]);
  });

  // 部分結果を成功として返すと、task 3.x の placeId 突合でロケーションが欠け、
  // Req 1.6「管理権限なし」の誤判定を生む。打ち切りは fail-closed で明示する。
  it('ページ送りが安全上限に達したら incomplete_listing（部分結果を成功にしない）', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { accounts: [{ name: ACCOUNT_NAME }], nextPageToken: 'next' }),
    );
    const { client } = makeClient({ fetch: fetchMock as unknown as typeof fetch });

    const res = await client.listAccountsAndLocations(ACCESS_TOKEN);
    expect(res).toEqual({ ok: false, error: { kind: 'incomplete_listing' } satisfies GbpApiError });
    // 上限（MAX_PAGES）で確実に打ち切る。
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });
});

// =====================================================================
// createLocalPost（v4 localPosts.create）
// =====================================================================
describe('createLocalPost', () => {
  it('v4 localPosts へ languageCode/summary/topicType を POST する', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { name: `${V4_PATH}/localPosts/p1` }));
    const { client, db } = makeClient({ fetch: fetchMock as unknown as typeof fetch });

    const res = await client.createLocalPost(db, { ...KEY, summary: 'お知らせです' });
    expect(res).toEqual({ ok: true, value: { postName: `${V4_PATH}/localPosts/p1` } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://mybusiness.googleapis.com/v4/${V4_PATH}/localPosts`);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(JSON.parse(String(init.body))).toEqual({
      languageCode: 'ja',
      summary: 'お知らせです',
      topicType: 'STANDARD',
    });
  });

  it('gbp_locations に行が無い店舗は not_linked（ネットワークを叩かない）', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    const { client, db } = makeClient({ fetch: fetchMock as unknown as typeof fetch, rows: [] });

    const res = await client.createLocalPost(db, { ...KEY, summary: 'x' });
    expect(res).toEqual({ ok: false, error: { kind: 'not_linked' } satisfies GbpApiError });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// =====================================================================
// listReviews（v4 reviews.list）
// =====================================================================
describe('listReviews', () => {
  it('pageSize 付きで取得し GbpReview へ写像する', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        reviews: [
          {
            name: `${V4_PATH}/reviews/r1`,
            starRating: 'FIVE',
            comment: 'おいしかった',
            createTime: '2026-07-01T10:00:00Z',
            reviewer: { displayName: '山田' },
          },
          {
            name: `${V4_PATH}/reviews/r2`,
            starRating: 'TWO',
            createTime: '2026-06-30T10:00:00Z',
            reviewer: {},
            reviewReply: { comment: '申し訳ありません' },
          },
        ],
      }),
    );
    const { client, db } = makeClient({ fetch: fetchMock as unknown as typeof fetch });

    const res = await client.listReviews(db, { ...KEY, limit: 5 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual([
      {
        reviewName: `${V4_PATH}/reviews/r1`,
        rating: 5,
        authorName: '山田',
        comment: 'おいしかった',
        createTime: '2026-07-01T10:00:00Z',
        hasReply: false,
        replyComment: null,
      },
      {
        reviewName: `${V4_PATH}/reviews/r2`,
        rating: 2,
        authorName: '',
        comment: '',
        createTime: '2026-06-30T10:00:00Z',
        hasReply: true,
        replyComment: '申し訳ありません',
      },
    ]);

    const url = new URL(String((fetchMock.mock.calls[0] as unknown as [string])[0]));
    expect(url.pathname).toBe(`/v4/${V4_PATH}/reviews`);
    expect(url.searchParams.get('pageSize')).toBe('5');
    // v4 reviews.list の orderBy サポートは未確認のため送らない（非対応なら全件 400）。
    // 整列は design どおり呼び出し側の責務。
    expect(url.searchParams.get('orderBy')).toBeNull();
  });

  it('limit は 1..50 にクランプされる', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { reviews: [] }));
    const { client, db } = makeClient({ fetch: fetchMock as unknown as typeof fetch });

    await client.listReviews(db, { ...KEY, limit: 999 });
    await client.listReviews(db, { ...KEY, limit: 0 });
    const first = new URL(String((fetchMock.mock.calls[0] as unknown as [string])[0]));
    const second = new URL(String((fetchMock.mock.calls[1] as unknown as [string])[0]));
    expect(first.searchParams.get('pageSize')).toBe('50');
    expect(second.searchParams.get('pageSize')).toBe('1');
  });

  it('reviews 欠落レスポンスは空配列', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    const { client, db } = makeClient({ fetch: fetchMock as unknown as typeof fetch });
    const res = await client.listReviews(db, { ...KEY, limit: 5 });
    expect(res).toEqual({ ok: true, value: [] });
  });
});

// =====================================================================
// upsertReviewReply（v4 reviews.updateReply）
// =====================================================================
describe('upsertReviewReply', () => {
  it('PUT {review}/reply に comment を送る', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { comment: 'ありがとうございます' }));
    const { client, db } = makeClient({ fetch: fetchMock as unknown as typeof fetch });

    const res = await client.upsertReviewReply(db, {
      ...KEY,
      reviewName: `${V4_PATH}/reviews/r1`,
      comment: 'ありがとうございます',
    });
    expect(res).toEqual({ ok: true, value: undefined });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://mybusiness.googleapis.com/v4/${V4_PATH}/reviews/r1/reply`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ comment: 'ありがとうございます' });
  });

  it('自店以外の location を指す reviewName は permission_denied（送信しない）', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    const { client, db } = makeClient({ fetch: fetchMock as unknown as typeof fetch });

    const res = await client.upsertReviewReply(db, {
      ...KEY,
      reviewName: 'accounts/1234567890/locations/1111111111/reviews/r1',
      comment: 'x',
    });
    expect(res).toEqual({ ok: false, error: { kind: 'permission_denied' } satisfies GbpApiError });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// =====================================================================
// エラー分類・リトライ
// =====================================================================
describe('エラー分類とリトライ', () => {
  it.each([
    [401, { kind: 'permission_denied' } as GbpApiError],
    [403, { kind: 'permission_denied' } as GbpApiError],
    [400, { kind: 'upstream_error', status: 400 } as GbpApiError],
    [404, { kind: 'upstream_error', status: 404 } as GbpApiError],
  ])('HTTP %i はリトライせず分類する', async (status, expected) => {
    const fetchMock = vi.fn(async () => jsonResponse(status, { error: { message: 'x' } }));
    const { client, db, backoffCalls } = makeClient({ fetch: fetchMock as unknown as typeof fetch });

    const res = await client.createLocalPost(db, { ...KEY, summary: 'x' });
    expect(res).toEqual({ ok: false, error: expected });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(backoffCalls).toEqual([]);
  });

  it('429 は 1 回だけリトライし、なお 429 なら rate_limited', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(429, {}));
    const { client, db, backoffCalls } = makeClient({ fetch: fetchMock as unknown as typeof fetch });

    const res = await client.createLocalPost(db, { ...KEY, summary: 'x' });
    expect(res).toEqual({ ok: false, error: { kind: 'rate_limited' } satisfies GbpApiError });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(backoffCalls).toEqual([0]);
  });

  it('5xx は 1 回だけリトライし、なお失敗なら upstream_error(status)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(503, {}));
    const { client, db } = makeClient({ fetch: fetchMock as unknown as typeof fetch });

    const res = await client.listReviews(db, { ...KEY, limit: 5 });
    expect(res).toEqual({
      ok: false,
      error: { kind: 'upstream_error', status: 503 } satisfies GbpApiError,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('リトライで成功すれば正常系として返す', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return call === 1 ? jsonResponse(500, {}) : jsonResponse(200, { reviews: [] });
    });
    const { client, db } = makeClient({ fetch: fetchMock as unknown as typeof fetch });

    const res = await client.listReviews(db, { ...KEY, limit: 5 });
    expect(res).toEqual({ ok: true, value: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ネットワーク例外は upstream_error(status=0)（リトライしない）', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const { client, db } = makeClient({ fetch: fetchMock as unknown as typeof fetch });

    const res = await client.createLocalPost(db, { ...KEY, summary: 'x' });
    expect(res).toEqual({
      ok: false,
      error: { kind: 'upstream_error', status: 0 } satisfies GbpApiError,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('JSON でない 2xx 応答は upstream_error(status=0)', async () => {
    const fetchMock = vi.fn(async () => new Response('<html>', { status: 200 }));
    const { client, db } = makeClient({ fetch: fetchMock as unknown as typeof fetch });

    const res = await client.listReviews(db, { ...KEY, limit: 5 });
    expect(res).toEqual({
      ok: false,
      error: { kind: 'upstream_error', status: 0 } satisfies GbpApiError,
    });
  });

  it('TokenStore の token_invalid をそのまま透過する（Req 2.3）', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    const { client, db } = makeClient({
      fetch: fetchMock as unknown as typeof fetch,
      token: { ok: false, error: { kind: 'token_invalid' } },
    });

    const res = await client.createLocalPost(db, { ...KEY, summary: 'x' });
    expect(res).toEqual({ ok: false, error: { kind: 'token_invalid' } satisfies GbpApiError });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('TokenStore の not_linked を透過する', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    const { client, db } = makeClient({
      fetch: fetchMock as unknown as typeof fetch,
      token: { ok: false, error: { kind: 'not_linked' } },
    });

    const res = await client.listReviews(db, { ...KEY, limit: 5 });
    expect(res).toEqual({ ok: false, error: { kind: 'not_linked' } satisfies GbpApiError });
  });

  // crypto_error（鍵不一致・改竄）は「オーナー側の失効」ではなく運用側の障害であり、
  // token_invalid（= 再連携誘導）に畳むと不良デプロイ時に全オーナーへ再連携を促してしまう。
  it('TokenStore の crypto_error は token_invalid に畳まず独立分類で透過する', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    const { client, db } = makeClient({
      fetch: fetchMock as unknown as typeof fetch,
      token: { ok: false, error: { kind: 'crypto_error' } },
    });

    const res = await client.upsertReviewReply(db, {
      ...KEY,
      reviewName: `${V4_PATH}/reviews/r1`,
      comment: 'x',
    });
    expect(res).toEqual({ ok: false, error: { kind: 'crypto_error' } satisfies GbpApiError });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // token-store.ts は invalid_grant 以外の refresh 失敗（ネットワーク断・Google の 5xx）で
  // throw する。ここで捕捉しないと Result 契約が破れ、Req 3.7/4.7 の
  // 「失敗通知＋再試行手段の提示・承認済み下書きの温存」が成立しない。
  it('TokenStore が reject しても例外を漏らさず upstream_error(status=0) を返す（Req 3.7）', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    const { client, db } = makeClient({
      fetch: fetchMock as unknown as typeof fetch,
      tokenRejection: new Error('google refresh grant failed (status=503, error=unknown)'),
    });

    const res = await client.createLocalPost(db, { ...KEY, summary: 'x' });
    expect(res).toEqual({
      ok: false,
      error: { kind: 'upstream_error', status: 0 } satisfies GbpApiError,
    });
    // トークン未取得のまま外部へ送信しない。
    expect(fetchMock).not.toHaveBeenCalled();
    // 原エラーは保持しない（平文露出面を作らない・Req 2.1）。
    expect(JSON.stringify(res)).not.toContain('refresh grant');
  });

  it('返信投稿でも TokenStore の reject を Result へ写像する（Req 4.7）', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    const { client, db } = makeClient({
      fetch: fetchMock as unknown as typeof fetch,
      tokenRejection: new Error('google refresh grant failed (status=unknown, error=unknown)'),
    });

    const res = await client.upsertReviewReply(db, {
      ...KEY,
      reviewName: `${V4_PATH}/reviews/r1`,
      comment: 'x',
    });
    expect(res).toEqual({
      ok: false,
      error: { kind: 'upstream_error', status: 0 } satisfies GbpApiError,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('クチコミ取得でも TokenStore の reject を Result へ写像する（Req 5.3）', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { reviews: [] }));
    const { client, db } = makeClient({
      fetch: fetchMock as unknown as typeof fetch,
      tokenRejection: new Error('google refresh grant failed (status=500, error=unknown)'),
    });

    const res = await client.listReviews(db, { ...KEY, limit: 5 });
    expect(res).toEqual({
      ok: false,
      error: { kind: 'upstream_error', status: 0 } satisfies GbpApiError,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gbp_locations の name が壊れている場合は not_linked（不正な URL を組まない）', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    const { client, db } = makeClient({
      fetch: fetchMock as unknown as typeof fetch,
      rows: [locationRow({ location_name: 'locations/' })],
    });

    const res = await client.createLocalPost(db, { ...KEY, summary: 'x' });
    expect(res).toEqual({ ok: false, error: { kind: 'not_linked' } satisfies GbpApiError });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
