import { describe, it, expect } from 'vitest';
import { handleDrafts, type DraftsDeps } from '../src/app/api/drafts/handler';
import { createSessionTokenService } from '../src/lib/session-token';
import { ok, err } from '../src/lib/result';
import type { DraftGenerator } from '../src/lib/draft/generator';
import type { DraftMaterial } from '../src/lib/domain';

const KEY = 'test-signing-key';
const STORE = '44444444-4444-4444-4444-444444444444';
const MATERIAL: DraftMaterial = { storeName: '店', star: 5, aspectLabels: ['味'], comment: 'よい' };

function okGenerator(draft = '再生成した下書き'): DraftGenerator {
  return { generate: () => Promise.resolve(ok(draft)) };
}

function baseDeps(tokens: ReturnType<typeof createSessionTokenService>, over: Partial<DraftsDeps> = {}): DraftsDeps {
  return {
    tokens,
    generator: okGenerator(),
    rateLimiter: { check: () => true },
    clientKey: () => 'ip1',
    log: () => {},
    ...over,
  };
}

function req(body: unknown): Request {
  return new Request('http://x/api/drafts', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('handleDrafts', () => {
  it('再生成成功: attempt を +1 し regenerationsLeft を減らす', async () => {
    const tokens = createSessionTokenService(KEY);
    const sessionToken = tokens.sign({ storeId: STORE, material: MATERIAL, attempt: 0 });
    const res = await handleDrafts(req({ sessionToken }), baseDeps(tokens));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.generation).toBe('ok');
    expect(json.draft).toBe('再生成した下書き');
    expect(json.regenerationsLeft).toBe(2);
    // 返却トークンの attempt が 1 に進んでいる
    const v = tokens.verify(json.sessionToken);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.attempt).toBe(1);
  });

  it('不正トークンは 400 TOKEN_INVALID（生成しない）', async () => {
    const tokens = createSessionTokenService(KEY);
    const generator = { generate: () => Promise.reject(new Error('should not call')) };
    const res = await handleDrafts(req({ sessionToken: 'bogus' }), baseDeps(tokens, { generator: generator as unknown as DraftGenerator }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('TOKEN_INVALID');
  });

  it('期限切れトークンは 400 TOKEN_EXPIRED', async () => {
    let clock = 1_000_000;
    const tokens = createSessionTokenService(KEY, () => clock);
    const sessionToken = tokens.sign({ storeId: STORE, material: MATERIAL, attempt: 0 });
    clock += 30 * 60 * 1000 + 1;
    const res = await handleDrafts(req({ sessionToken }), baseDeps(tokens));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('TOKEN_EXPIRED');
  });

  it('レート制限超過は 429', async () => {
    const tokens = createSessionTokenService(KEY);
    const sessionToken = tokens.sign({ storeId: STORE, material: MATERIAL, attempt: 0 });
    const res = await handleDrafts(req({ sessionToken }), baseDeps(tokens, { rateLimiter: { check: () => false } }));
    expect(res.status).toBe(429);
  });

  it('attempt が上限(3)なら 409 REGEN_LIMIT（生成しない）', async () => {
    const tokens = createSessionTokenService(KEY);
    const sessionToken = tokens.sign({ storeId: STORE, material: MATERIAL, attempt: 3 });
    const generator = { generate: () => Promise.reject(new Error('should not call')) };
    const res = await handleDrafts(req({ sessionToken }), baseDeps(tokens, { generator: generator as unknown as DraftGenerator }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('REGEN_LIMIT');
  });

  it('3 回目まで許可し 4 回目で 409（連続再生成）', async () => {
    const tokens = createSessionTokenService(KEY);
    let token = tokens.sign({ storeId: STORE, material: MATERIAL, attempt: 0 });
    for (let i = 0; i < 3; i++) {
      const res = await handleDrafts(req({ sessionToken: token }), baseDeps(tokens));
      expect(res.status).toBe(200);
      token = (await res.json()).sessionToken;
    }
    // 4 回目
    const res4 = await handleDrafts(req({ sessionToken: token }), baseDeps(tokens));
    expect(res4.status).toBe(409);
  });

  it('生成失敗は attempt を消費せず 200 failed（回数据え置き）', async () => {
    const tokens = createSessionTokenService(KEY);
    const sessionToken = tokens.sign({ storeId: STORE, material: MATERIAL, attempt: 1 });
    const failGen: DraftGenerator = { generate: () => Promise.resolve(err({ kind: 'API_ERROR' as const })) };
    const res = await handleDrafts(req({ sessionToken }), baseDeps(tokens, { generator: failGen }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.generation).toBe('failed');
    expect(json.draft).toBeNull();
    expect(json.regenerationsLeft).toBe(2); // 3 - 1（据え置き）
    const v = tokens.verify(json.sessionToken);
    if (v.ok) expect(v.value.attempt).toBe(1); // 消費していない
  });
});
