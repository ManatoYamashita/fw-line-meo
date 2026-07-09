import { describe, it, expect, vi } from 'vitest';
import { handleResponses, type ResponsesDeps } from '../src/app/api/responses/handler';
import { createSessionTokenService } from '../src/lib/session-token';
import { ok, err } from '../src/lib/result';
import type { DraftGenerator } from '../src/lib/draft/generator';

const KEY = 'test-signing-key';
const STORE = '44444444-4444-4444-4444-444444444444';
const tokens = createSessionTokenService(KEY);

function okGenerator(draft = '良いお店でした'): DraftGenerator {
  return { generate: () => Promise.resolve(ok(draft)) };
}
function failGenerator(): DraftGenerator {
  return { generate: () => Promise.resolve(err({ kind: 'API_ERROR' as const })) };
}

function baseDeps(over: Partial<ResponsesDeps> = {}): ResponsesDeps {
  return {
    tokens,
    generator: okGenerator(),
    rateLimiter: { check: () => true },
    findStore: () =>
      Promise.resolve({ id: STORE, name: 'テスト店', placeId: 'ChIJ', placeStatus: 'confirmed' }),
    listAspects: () =>
      Promise.resolve([
        { code: 'taste', label: '味' },
        { code: 'service', label: '接客' },
      ]),
    incrementTallies: () => Promise.resolve(),
    clientKey: () => 'ip1',
    log: () => {},
    ...over,
  };
}

function req(body: unknown): Request {
  return new Request('http://x/api/responses', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function validBody(over: Record<string, unknown> = {}) {
  return { pageToken: tokens.signPage(STORE), storeId: STORE, star: 5, aspectCodes: ['taste'], ...over };
}

describe('handleResponses', () => {
  it('正常: 集計加算＋下書き＋sessionToken を 200 で返す', async () => {
    const incrementTallies = vi.fn(() => Promise.resolve());
    const res = await handleResponses(req(validBody()), baseDeps({ incrementTallies }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.generation).toBe('ok');
    expect(json.draft).toBe('良いお店でした');
    expect(json.sessionToken).toBeTypeOf('string');
    expect(json.regenerationsLeft).toBe(3);
    expect(incrementTallies).toHaveBeenCalledWith({ storeId: STORE, star: 5, aspectCodes: ['taste'] });
  });

  it('pageToken 不正は 400 PAGE_TOKEN_INVALID（store 取得も生成もしない）', async () => {
    const findStore = vi.fn();
    const generator = { generate: vi.fn() };
    const res = await handleResponses(
      req(validBody({ pageToken: 'bogus' })),
      baseDeps({ findStore, generator: generator as unknown as DraftGenerator }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('PAGE_TOKEN_INVALID');
    expect(findStore).not.toHaveBeenCalled();
    expect(generator.generate).not.toHaveBeenCalled();
  });

  it('別 store 向け pageToken は 400（storeId 束縛）', async () => {
    const otherToken = tokens.signPage('00000000-0000-0000-0000-000000000000');
    const res = await handleResponses(req(validBody({ pageToken: otherToken })), baseDeps());
    expect(res.status).toBe(400);
  });

  it('レート制限超過は 429', async () => {
    const res = await handleResponses(req(validBody()), baseDeps({ rateLimiter: { check: () => false } }));
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe('RATE_LIMITED');
  });

  it('店舗不在は 404', async () => {
    const res = await handleResponses(req(validBody()), baseDeps({ findStore: () => Promise.resolve(null) }));
    expect(res.status).toBe(404);
  });

  it('place 未確定は 404', async () => {
    const res = await handleResponses(
      req(validBody()),
      baseDeps({
        findStore: () => Promise.resolve({ id: STORE, name: '店', placeId: null, placeStatus: 'pending' }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it('星欠落は 400 VALIDATION（生成しない）', async () => {
    const generator = { generate: vi.fn() };
    const res = await handleResponses(
      req(validBody({ star: undefined })),
      baseDeps({ generator: generator as unknown as DraftGenerator }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION');
    expect(generator.generate).not.toHaveBeenCalled();
  });

  it('不正 JSON ボディは 400 VALIDATION', async () => {
    const res = await handleResponses(req('{ not json'), baseDeps());
    expect(res.status).toBe(400);
  });

  it('生成失敗でも 200 generation:failed＋sessionToken（draft は null）', async () => {
    const res = await handleResponses(req(validBody()), baseDeps({ generator: failGenerator() }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.generation).toBe('failed');
    expect(json.draft).toBeNull();
    expect(json.sessionToken).toBeTypeOf('string');
  });

  it('安全ブロックは 200 failed かつ INFO ログ（件数把握）', async () => {
    const log = vi.fn();
    const generator: DraftGenerator = {
      generate: () => Promise.resolve(err({ kind: 'SAFETY_BLOCKED' as const })),
    };
    const res = await handleResponses(req(validBody()), baseDeps({ generator, log }));
    expect(res.status).toBe(200);
    expect((await res.json()).generation).toBe('failed');
    expect(log).toHaveBeenCalledWith('info', 'generation_safety_blocked');
  });

  it('集計失敗でも 200 で下書きを返し WARN ログのみ', async () => {
    const log = vi.fn();
    const res = await handleResponses(
      req(validBody()),
      baseDeps({ incrementTallies: () => Promise.reject(new Error('db down')), log }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).generation).toBe('ok');
    expect(log).toHaveBeenCalledWith('warn', 'tally_failed');
  });
});
