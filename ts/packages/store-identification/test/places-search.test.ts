import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPlacesSearchAdapter } from '../src/places-search.js';

const FIXED_FIELD_MASK =
  'places.id,places.displayName,places.formattedAddress,places.location,places.types';

// Places API (New) searchText の実レスポンス形状（必要フィールドのみ）。
function rawPlace(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'ChIJ-place-1',
    displayName: { text: 'テスト食堂' },
    formattedAddress: '東京都渋谷区1-1-1',
    location: { latitude: 35.1, longitude: 139.1 },
    types: ['restaurant', 'food'],
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('createPlacesSearchAdapter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('リクエストの FieldMask ヘッダを固定文字列で送信する', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { places: [rawPlace()] }));
    const adapter = createPlacesSearchAdapter({ apiKey: 'test-api-key', fetch: fetchMock });

    await adapter.searchCandidates('テスト食堂');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://places.googleapis.com/v1/places:searchText');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Goog-FieldMask']).toBe(FIXED_FIELD_MASK);
    expect(headers['X-Goog-Api-Key']).toBe('test-api-key');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      textQuery: 'テスト食堂',
      languageCode: 'ja',
      regionCode: 'JP',
      pageSize: 10,
    });
  });

  it('1件のとき found として StoreCandidate に正しくマッピングする', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { places: [rawPlace()] }));
    const adapter = createPlacesSearchAdapter({ apiKey: 'k', fetch: fetchMock });

    const outcome = await adapter.searchCandidates('テスト食堂');

    expect(outcome).toEqual({
      kind: 'found',
      candidates: [
        {
          placeId: 'ChIJ-place-1',
          name: 'テスト食堂',
          address: '東京都渋谷区1-1-1',
          latitude: 35.1,
          longitude: 139.1,
          types: ['restaurant', 'food'],
        },
      ],
    });
  });

  it('10件のとき found として10件すべてマッピングする', async () => {
    const places = Array.from({ length: 10 }, (_, i) =>
      rawPlace({ id: `ChIJ-place-${i}`, displayName: { text: `店舗${i}` } }),
    );
    const fetchMock = vi.fn(async () => jsonResponse(200, { places }));
    const adapter = createPlacesSearchAdapter({ apiKey: 'k', fetch: fetchMock });

    const outcome = await adapter.searchCandidates('テスト');

    expect(outcome.kind).toBe('found');
    if (outcome.kind === 'found') {
      expect(outcome.candidates).toHaveLength(10);
      expect(outcome.candidates[0]?.placeId).toBe('ChIJ-place-0');
      expect(outcome.candidates[9]?.placeId).toBe('ChIJ-place-9');
    }
  });

  it('places が空配列のとき empty を返す', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { places: [] }));
    const adapter = createPlacesSearchAdapter({ apiKey: 'k', fetch: fetchMock });

    const outcome = await adapter.searchCandidates('存在しない店');

    expect(outcome).toEqual({ kind: 'empty' });
  });

  it('places フィールド自体が欠落しているとき empty を返す', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    const adapter = createPlacesSearchAdapter({ apiKey: 'k', fetch: fetchMock });

    const outcome = await adapter.searchCandidates('存在しない店');

    expect(outcome).toEqual({ kind: 'empty' });
  });

  it('非2xxレスポンスのとき error を返す', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(500, { error: 'boom' }));
    const adapter = createPlacesSearchAdapter({ apiKey: 'k', fetch: fetchMock });

    const outcome = await adapter.searchCandidates('テスト食堂');

    expect(outcome).toEqual({ kind: 'error' });
  });

  it('JSON パース不能なレスポンスのとき例外を投げず error を返す', async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      } as Response;
    });
    const adapter = createPlacesSearchAdapter({ apiKey: 'k', fetch: fetchMock });

    await expect(adapter.searchCandidates('テスト食堂')).resolves.toEqual({ kind: 'error' });
  });

  it('1.5秒以内にレスポンスが無いとき AbortController でタイムアウトし error を返す', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    });
    const adapter = createPlacesSearchAdapter({ apiKey: 'k', fetch: fetchMock });

    const pending = adapter.searchCandidates('テスト食堂');
    await vi.advanceTimersByTimeAsync(1500);

    await expect(pending).resolves.toEqual({ kind: 'error' });
  });

  it('fetch 自体が失敗（ネットワークエラー）したとき error を返す', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('network error');
    });
    const adapter = createPlacesSearchAdapter({ apiKey: 'k', fetch: fetchMock });

    await expect(adapter.searchCandidates('テスト食堂')).resolves.toEqual({ kind: 'error' });
  });

  it('検索クエリ（店名）をログに出力しない', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const secretStoreName = '極秘店名テスト12345';

    const fetchMock = vi.fn(async () => jsonResponse(500, {}));
    const adapter = createPlacesSearchAdapter({ apiKey: 'k', fetch: fetchMock });
    await adapter.searchCandidates(secretStoreName);

    for (const spy of [consoleLogSpy, consoleErrorSpy, consoleWarnSpy]) {
      for (const call of spy.mock.calls) {
        for (const arg of call) {
          expect(String(arg)).not.toContain(secretStoreName);
        }
      }
    }

    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });
});
