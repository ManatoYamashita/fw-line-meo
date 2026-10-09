import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleResponses, type ResponsesDeps } from '../src/app/api/responses/handler';
import { createSessionTokenService } from '../src/lib/session-token';
import { ok } from '../src/lib/result';
import * as validate from '../src/lib/validate';

// legacy の回答受付は structured survey の pageToken（v: 2）を受理しない（Issue #436）。
//
// 署名の正しい v2 の token を実際に signStructuredPage で作り、handleResponses へ通す。拒否するだけで
// なく、legacy の検証・集計・下書きの生成へ一歩も進まないことを、依存を spy して制御フローとして
// 固定する（ローリングデプロイで v2 を発行するインスタンスと混在しても、legacy の意味で数えない）。
// structured の受付を接続する Issue #438 で、この拒否は structured の分岐に置き換わる。

vi.mock('../src/lib/validate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/validate')>();
  return { ...actual, validateSurveyAnswer: vi.fn(actual.validateSurveyAnswer) };
});

const KEY = 'test-signing-key';
const STORE = '44444444-4444-4444-4444-444444444444';
const tokens = createSessionTokenService(KEY);

function spiedDeps() {
  const deps = {
    tokens,
    generator: { generate: vi.fn(() => Promise.resolve(ok('良いお店でした'))) },
    rateLimiter: { check: vi.fn(() => true) },
    findStore: vi.fn(() =>
      Promise.resolve({
        id: STORE,
        name: 'テスト店',
        placeId: 'ChIJ',
        placeStatus: 'confirmed' as const,
        suspendedAt: null,
      }),
    ),
    listAspects: vi.fn(() => Promise.resolve([{ code: 'taste', label: '味' }])),
    incrementTallies: vi.fn(() => Promise.resolve()),
    clientKey: () => 'ip1',
    log: vi.fn(),
  };
  return deps satisfies ResponsesDeps;
}

function req(pageToken: string): Request {
  return new Request('http://x/api/responses', {
    method: 'POST',
    body: JSON.stringify({ pageToken, storeId: STORE, star: 5, aspectCodes: ['taste'] }),
  });
}

describe('handleResponses × structured pageToken（v: 2）', () => {
  beforeEach(() => {
    vi.mocked(validate.validateSurveyAnswer).mockClear();
  });

  it('署名の正しい v2 の token は PAGE_TOKEN_INVALID（400）で拒否する', async () => {
    const token = tokens.signStructuredPage(STORE, 3);
    // 前提: token 自体は verifyPage を通る（拒否は handler の分岐による）。
    expect(tokens.verifyPage(token, STORE).ok).toBe(true);

    const res = await handleResponses(req(token), spiedDeps());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('PAGE_TOKEN_INVALID');
  });

  it('v2 では legacy の検証・集計・生成・店舗と観点の読み取りへ進まない', async () => {
    const deps = spiedDeps();
    await handleResponses(req(tokens.signStructuredPage(STORE, 3)), deps);

    expect(validate.validateSurveyAnswer).not.toHaveBeenCalled();
    expect(deps.incrementTallies).not.toHaveBeenCalled();
    expect(deps.generator.generate).not.toHaveBeenCalled();
    expect(deps.findStore).not.toHaveBeenCalled();
    expect(deps.listAspects).not.toHaveBeenCalled();
    expect(deps.rateLimiter.check).not.toHaveBeenCalled();
  });

  it('legacy の token は従来どおり受理し、検証・集計・生成へ進む', async () => {
    const deps = spiedDeps();
    const res = await handleResponses(req(tokens.signPage(STORE)), deps);

    expect(res.status).toBe(200);
    expect((await res.json()).generation).toBe('ok');
    expect(validate.validateSurveyAnswer).toHaveBeenCalledTimes(1);
    expect(deps.incrementTallies).toHaveBeenCalledTimes(1);
    expect(deps.generator.generate).toHaveBeenCalledTimes(1);
  });
});
