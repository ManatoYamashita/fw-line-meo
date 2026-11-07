import { describe, expect, it, vi } from 'vitest';
import type { GbpLocationRow, Queryable, Result } from '@fwlm/db';
import { createGbpClient, type LocalPostPublishResult } from '../../src/gbp/client.js';
import type { TokenStoreError } from '../../src/gbp/token-store.js';
import { classifyLocalPostResult, classifyStatus, createGoogleAdapter } from '../../src/crosspost/adapters/google.js';

const OWNER = '3f000000-0000-4000-8000-00000000000a';
const STORE = '3f000000-0000-4000-8000-0000000000a1';
const KEY = { ownerId: OWNER, storeId: STORE };

function location(overrides: Partial<GbpLocationRow> = {}): GbpLocationRow {
  return {
    id: '3f000000-0000-4000-8000-0000000000e1',
    store_id: STORE,
    account_name: 'accounts/123',
    location_name: 'locations/456',
    place_id: 'ChIJ',
    can_operate_local_post: true,
    linked_at: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

function fakeDb(rows: GbpLocationRow[]): Queryable {
  return { query: async () => ({ rows, rowCount: rows.length }) } as unknown as Queryable;
}

function client(fetchImpl: unknown, token: Result<string, TokenStoreError> = { ok: true, value: 'ya29.t' }) {
  return createGbpClient({
    tokenStore: { getAccessTokenForStore: async () => token },
    fetch: fetchImpl as typeof fetch,
    backoff: async () => {},
  });
}

const signal = (): AbortSignal => new AbortController().signal;
const input = (photoUrl: string | null = null) => ({ ...KEY, summary: 'お知らせ', photoUrl });

describe('publishLocalPost（gbp/client.ts）', () => {
  it('写真付きの本文を 1 回だけ送り、name と searchUrl を返す', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ name: 'accounts/123/locations/456/localPosts/789', searchUrl: 'https://local.google.com/p' }),
          { status: 200 },
        ),
    );
    const result = await client(fetchMock).publishLocalPost(
      fakeDb([location()]),
      { ...KEY, summary: '新作の抹茶パフェ', photoUrl: 'https://media.example/p.jpg' },
      { signal: signal() },
    );
    expect(result).toEqual({
      kind: 'created',
      postName: 'accounts/123/locations/456/localPosts/789',
      searchUrl: 'https://local.google.com/p',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://mybusiness.googleapis.com/v4/accounts/123/locations/456/localPosts');
    expect(JSON.parse(String(init.body))).toEqual({
      languageCode: 'ja',
      summary: '新作の抹茶パフェ',
      topicType: 'STANDARD',
      media: [{ mediaFormat: 'PHOTO', sourceUrl: 'https://media.example/p.jpg' }],
    });
    expect(init.signal).toBeDefined();
  });

  it('写真なしは media を付けない。5xx でも再送しない', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }));
    const result = await client(fetchMock).publishLocalPost(fakeDb([location()]), input(), { signal: signal() });
    expect(result).toEqual({ kind: 'rejected', status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).not.toHaveProperty('media');
  });

  it('送信前の失敗は not_sent（送らない）', async () => {
    const fetchMock = vi.fn();
    const c = client(fetchMock, { ok: false, error: { kind: 'token_invalid' } });
    expect(await c.publishLocalPost(fakeDb([location()]), input(), { signal: signal() })).toEqual({
      kind: 'not_sent',
      error: { kind: 'token_invalid' },
    });
    expect(await c.publishLocalPost(fakeDb([]), input(), { signal: signal() })).toEqual({
      kind: 'not_sent',
      error: { kind: 'not_linked' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('通信の例外は indeterminate（時間切れかどうかを伝える）。2xx で本文が読めなくても created', async () => {
    const controller = new AbortController();
    const aborting = vi.fn(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    expect(await client(aborting).publishLocalPost(fakeDb([location()]), input(), { signal: controller.signal })).toEqual({
      kind: 'indeterminate',
      aborted: true,
    });
    const broken = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await client(broken).publishLocalPost(fakeDb([location()]), input(), { signal: signal() })).toEqual({
      kind: 'indeterminate',
      aborted: false,
    });
    const html = vi.fn(async () => new Response('<html>', { status: 200 }));
    expect(await client(html).publishLocalPost(fakeDb([location()]), input(), { signal: signal() })).toEqual({
      kind: 'created',
      postName: null,
      searchUrl: null,
    });
  });
});

describe('Google の結果の分類（design.md の表）', () => {
  it.each<[LocalPostPublishResult, unknown]>([
    [{ kind: 'created', postName: 'p', searchUrl: null }, { kind: 'succeeded', externalId: 'p', externalUrl: null }],
    [{ kind: 'not_sent', error: { kind: 'not_linked' } }, { kind: 'failed', reason: 'not_linked', retryable: false }],
    [{ kind: 'not_sent', error: { kind: 'token_invalid' } }, { kind: 'failed', reason: 'token_invalid', retryable: false }],
    [{ kind: 'not_sent', error: { kind: 'crypto_error' } }, { kind: 'failed', reason: 'token_invalid', retryable: false }],
    [
      { kind: 'not_sent', error: { kind: 'permission_denied' } },
      { kind: 'failed', reason: 'permission_denied', retryable: false },
    ],
    [{ kind: 'not_sent', error: { kind: 'rate_limited' } }, { kind: 'failed', reason: 'rate_limited', retryable: true }],
    [
      { kind: 'not_sent', error: { kind: 'upstream_error', status: 0 } },
      { kind: 'failed', reason: 'upstream_unavailable', retryable: true },
    ],
    [{ kind: 'rejected', status: 401 }, { kind: 'failed', reason: 'permission_denied', retryable: false }],
    [{ kind: 'rejected', status: 403 }, { kind: 'failed', reason: 'permission_denied', retryable: false }],
    [{ kind: 'rejected', status: 400 }, { kind: 'failed', reason: 'rejected', retryable: false }],
    [{ kind: 'rejected', status: 404 }, { kind: 'failed', reason: 'rejected', retryable: false }],
    [{ kind: 'rejected', status: 409 }, { kind: 'failed', reason: 'rejected', retryable: false }],
    [{ kind: 'rejected', status: 429 }, { kind: 'failed', reason: 'rate_limited', retryable: true }],
    [{ kind: 'rejected', status: 503 }, { kind: 'failed', reason: 'upstream_unavailable', retryable: true }],
    [{ kind: 'rejected', status: 500 }, { kind: 'unknown', reason: 'upstream_5xx' }],
    [{ kind: 'rejected', status: 502 }, { kind: 'unknown', reason: 'upstream_5xx' }],
    [{ kind: 'rejected', status: 504 }, { kind: 'unknown', reason: 'upstream_5xx' }],
    [{ kind: 'indeterminate', aborted: false }, { kind: 'unknown', reason: 'network' }],
    [{ kind: 'indeterminate', aborted: true }, { kind: 'unknown', reason: 'timeout' }],
  ])('%o → %o', (result, expected) => {
    expect(classifyLocalPostResult(result)).toEqual(expected);
  });

  it('5xx は 503 を除いて結果不明（送ったかもしれない）', () => {
    for (const status of [500, 501, 502, 504, 599]) expect(classifyStatus(status).kind).toBe('unknown');
  });
});

describe('createGoogleAdapter', () => {
  const photo = { width: 1080, height: 1080, byteSize: 200_000 };
  const base = {
    db: fakeDb([]),
    enabled: true,
    isLinked: async () => true,
    getLocation: async () => location(),
    client: {
      publishLocalPost: vi.fn(async (): Promise<LocalPostPublishResult> => ({ kind: 'created', postName: 'p', searchUrl: null })),
    },
  };

  it('有効化・連携・投稿の権限・写真の条件を順に確かめる', async () => {
    expect(await createGoogleAdapter({ ...base, enabled: false }).availability(KEY, { media: null })).toEqual({
      kind: 'not_ready',
    });
    expect(await createGoogleAdapter({ ...base, isLinked: async () => false }).availability(KEY, { media: null })).toEqual({
      kind: 'needs_connection',
    });
    expect(await createGoogleAdapter({ ...base, getLocation: async () => null }).availability(KEY, { media: null })).toEqual({
      kind: 'needs_relink',
    });
    expect(
      await createGoogleAdapter({
        ...base,
        getLocation: async () => location({ can_operate_local_post: false }),
      }).availability(KEY, { media: null }),
    ).toEqual({ kind: 'unsupported_content', issue: 'posting_not_permitted' });
    expect(
      await createGoogleAdapter(base).availability(KEY, { media: { width: 240, height: 1000, byteSize: 50_000 } }),
    ).toEqual({ kind: 'unsupported_content', issue: 'media_size' });
    expect(await createGoogleAdapter(base).availability(KEY, { media: { ...photo, byteSize: 9000 } })).toEqual({
      kind: 'unsupported_content',
      issue: 'media_size',
    });
    expect(await createGoogleAdapter(base).availability(KEY, { media: photo })).toEqual({ kind: 'available' });
  });

  it('承認の本文の写しと写真の取得用 URL を渡す。無効なら送らない', async () => {
    const publishLocalPost = vi.fn(
      async (): Promise<LocalPostPublishResult> => ({ kind: 'created', postName: 'p', searchUrl: 'u' }),
    );
    const adapter = createGoogleAdapter({ ...base, client: { publishLocalPost } });
    const s = signal();
    const outcome = await adapter.publish(
      { ...KEY, deliveryId: 'd', bodyText: '本文', media: { fetchUrl: 'https://m/1.jpg', ...photo }, checkpoint: null, signal: s },
      async () => {},
    );
    expect(outcome).toEqual({ kind: 'succeeded', externalId: 'p', externalUrl: 'u' });
    expect(publishLocalPost).toHaveBeenCalledWith(base.db, { ...KEY, summary: '本文', photoUrl: 'https://m/1.jpg' }, { signal: s });

    const disabled = vi.fn();
    const off = createGoogleAdapter({ ...base, enabled: false, client: { publishLocalPost: disabled } });
    expect(
      await off.publish({ ...KEY, deliveryId: 'd', bodyText: '本文', media: null, checkpoint: null, signal: s }, async () => {}),
    ).toEqual({ kind: 'failed', reason: 'not_ready', retryable: false });
    expect(disabled).not.toHaveBeenCalled();
  });
});
