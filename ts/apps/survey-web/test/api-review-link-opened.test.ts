import { describe, it, expect, vi } from 'vitest';
import { handleReviewLinkOpened, type ReviewLinkDeps } from '../src/app/api/review-link-opened/handler';
import { createSessionTokenService, type SessionTokenService } from '../src/lib/session-token';
import type { DraftMaterial } from '../src/lib/domain';

// 投稿導線の押下の通知（Issue #137・Requirement 5.7）。
// 数えるのは token を検証できた押下だけで、記録するのは storeId だけ。

const KEY = 'test-signing-key';
const STORE = '44444444-4444-4444-4444-444444444444';
const OTHER = '55555555-5555-5555-5555-555555555555';
// sessionToken は素材（客の回答の中身）を封入している。記録へ漏れないことを確かめるため中身を持たせる。
const MATERIAL: DraftMaterial = {
  storeName: '店',
  star: 2,
  aspectLabels: ['味'],
  concernLabels: ['接客'],
  comment: '客の自由記述',
};

function deps(tokens: SessionTokenService, over: Partial<ReviewLinkDeps> = {}) {
  const log = vi.fn();
  const all: ReviewLinkDeps = {
    tokens,
    rateLimiter: { check: () => true },
    clientKey: () => 'ip1',
    log,
    ...over,
  };
  return { deps: all, log };
}

// sendBeacon は文字列の本文を text/plain で送る。既定をそれに合わせる。
function req(body: unknown, contentType = 'text/plain;charset=UTF-8'): Request {
  return new Request('http://x/api/review-link-opened', {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('handleReviewLinkOpened', () => {
  it('下書き画面の sessionToken（同じ店舗）なら 204 で押下を記録する', async () => {
    const tokens = createSessionTokenService(KEY);
    const token = tokens.sign({ storeId: STORE, material: MATERIAL, attempt: 0 });
    const { deps: d, log } = deps(tokens);

    const res = await handleReviewLinkOpened(req({ storeId: STORE, token }), d);

    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('info', 'survey_review_link_opened', { storeId: STORE });
  });

  it('回答済み画面の pageToken（同じ店舗）なら 204 で押下を記録する', async () => {
    const tokens = createSessionTokenService(KEY);
    const { deps: d, log } = deps(tokens);

    const res = await handleReviewLinkOpened(req({ storeId: STORE, token: tokens.signPage(STORE) }), d);

    expect(res.status).toBe(204);
    expect(log).toHaveBeenCalledWith('info', 'survey_review_link_opened', { storeId: STORE });
  });

  it('記録するのは storeId だけ（素材を封入した sessionToken から回答の中身を載せない）', async () => {
    const tokens = createSessionTokenService(KEY);
    const token = tokens.sign({ storeId: STORE, material: MATERIAL, attempt: 2 });
    const { deps: d, log } = deps(tokens);

    await handleReviewLinkOpened(req({ storeId: STORE, token, extra: '客の自由記述' }), d);

    const fields = log.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(Object.keys(fields)).toEqual(['storeId']);
    expect(JSON.stringify(log.mock.calls)).not.toContain('客の自由記述');
  });

  it('JSON の Content-Type で送られても受け付ける（keepalive の fetch へ落ちた経路）', async () => {
    const tokens = createSessionTokenService(KEY);
    const { deps: d, log } = deps(tokens);

    const res = await handleReviewLinkOpened(
      req({ storeId: STORE, token: tokens.signPage(STORE) }, 'application/json'),
      d,
    );

    expect(res.status).toBe(204);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('他店舗向けの sessionToken は 400 で記録しない', async () => {
    const tokens = createSessionTokenService(KEY);
    const token = tokens.sign({ storeId: OTHER, material: MATERIAL, attempt: 0 });
    const { deps: d, log } = deps(tokens);

    const res = await handleReviewLinkOpened(req({ storeId: STORE, token }), d);

    expect(res.status).toBe(400);
    expect(log).not.toHaveBeenCalled();
  });

  it('他店舗向けの pageToken は 400 で記録しない', async () => {
    const tokens = createSessionTokenService(KEY);
    const { deps: d, log } = deps(tokens);

    const res = await handleReviewLinkOpened(req({ storeId: STORE, token: tokens.signPage(OTHER) }), d);

    expect(res.status).toBe(400);
    expect(log).not.toHaveBeenCalled();
  });

  it('別の鍵で署名された token は 400 で記録しない（改ざん）', async () => {
    const forged = createSessionTokenService('attacker-key');
    const { deps: d, log } = deps(createSessionTokenService(KEY));

    for (const token of [forged.signPage(STORE), forged.sign({ storeId: STORE, material: MATERIAL, attempt: 0 })]) {
      const res = await handleReviewLinkOpened(req({ storeId: STORE, token }), d);
      expect(res.status).toBe(400);
    }
    expect(log).not.toHaveBeenCalled();
  });

  it('期限切れの token は 400 で記録しない（pageToken 5 分・sessionToken 30 分）', async () => {
    let now = 1_000_000;
    const tokens = createSessionTokenService(KEY, () => now);
    const pageToken = tokens.signPage(STORE);
    const sessionToken = tokens.sign({ storeId: STORE, material: MATERIAL, attempt: 0 });
    const { deps: d, log } = deps(tokens);

    now += 5 * 60 * 1000 + 1;
    expect((await handleReviewLinkOpened(req({ storeId: STORE, token: pageToken }), d)).status).toBe(400);
    now += 30 * 60 * 1000;
    expect((await handleReviewLinkOpened(req({ storeId: STORE, token: sessionToken }), d)).status).toBe(400);
    expect(log).not.toHaveBeenCalled();
  });

  it('storeId か token が欠けた本文・JSON でない本文は 400 で記録しない', async () => {
    const tokens = createSessionTokenService(KEY);
    const { deps: d, log } = deps(tokens);
    const token = tokens.signPage(STORE);

    for (const body of ['not json', 'null', '[]', { storeId: STORE }, { token }, { storeId: 1, token }, { storeId: STORE, token: 1 }]) {
      const res = await handleReviewLinkOpened(req(body), d);
      expect(res.status).toBe(400);
    }
    expect(log).not.toHaveBeenCalled();
  });

  it('レート制限を超えたら 429 で記録しない', async () => {
    const tokens = createSessionTokenService(KEY);
    const { deps: d, log } = deps(tokens, { rateLimiter: { check: () => false } });

    const res = await handleReviewLinkOpened(req({ storeId: STORE, token: tokens.signPage(STORE) }), d);

    expect(res.status).toBe(429);
    expect(log).not.toHaveBeenCalled();
  });

  it('レート制限の鍵は clientKey から取る', async () => {
    const tokens = createSessionTokenService(KEY);
    const check = vi.fn(() => true);
    const { deps: d } = deps(tokens, { rateLimiter: { check }, clientKey: () => '203.0.113.7' });

    await handleReviewLinkOpened(req({ storeId: STORE, token: tokens.signPage(STORE) }), d);

    expect(check).toHaveBeenCalledWith('203.0.113.7');
  });
});
