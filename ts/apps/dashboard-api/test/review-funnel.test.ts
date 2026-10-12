import { describe, it, expect, vi } from 'vitest';
import type { DashboardUserIdentity, StoreReviewFunnelMonth, StoreWithAgency } from '@fwlm/db';
import { handleReviewFunnel, type ReviewFunnelDeps } from '../src/review-funnel.js';
import { readJson, type ErrorEnvelope } from './support/json.js';

// QR パネルの実績（Issue #401・store-qr-issuance-ui Requirement 8）。
// 評価の順序は QR と同じ「認証 → 店舗取得 → RBAC」で、拒否した要求では実績を読まない。

const STORE = '44444444-4444-4444-4444-444444444444';
const OP: DashboardUserIdentity = { id: 'u1', role: 'operator', operatorId: 'op1', agencyId: null };
const AG_OWN: DashboardUserIdentity = { id: 'u2', role: 'agency', operatorId: 'op1', agencyId: 'ag1' };
const AG_OTHER: DashboardUserIdentity = { id: 'u3', role: 'agency', operatorId: 'op1', agencyId: 'ag2' };

const MONTHS: StoreReviewFunnelMonth[] = [
  { month: '2026-09', responses: 12, reviewLinkOpens: 7 },
  { month: '2026-08', responses: 0, reviewLinkOpens: 0 },
];

function store(over: Partial<StoreWithAgency> = {}): StoreWithAgency {
  return {
    id: STORE,
    name: 'テスト店',
    placeId: 'ChIJ',
    placeStatus: 'confirmed',
    suspendedAt: null,
    ownerId: 'ow1',
    agencyId: 'ag1',
    ...over,
  };
}

function deps(over: Partial<ReviewFunnelDeps> = {}, user: DashboardUserIdentity | null = OP) {
  const readFunnel = vi.fn((_storeId: string) => Promise.resolve(MONTHS));
  const all: ReviewFunnelDeps = {
    auth: {
      verifier: {
        verifyIdToken: (t) =>
          Promise.resolve({ uid: `uid-${t}`, email: null, emailVerified: false, signInProvider: null }),
      },
      findUser: () => Promise.resolve(user === null ? null : { ...user, disabled: false }),
      linkByEmail: () => Promise.resolve(null),
    },
    findStore: () => Promise.resolve(store()),
    readFunnel,
    ...over,
  };
  return { deps: all, readFunnel };
}

function req(over: Partial<{ storeId: string; authorization: string | undefined }> = {}) {
  const log = vi.fn();
  return { request: { storeId: STORE, authorization: 'Bearer tok', log, ...over }, log };
}

describe('handleReviewFunnel', () => {
  it('運営は当月・前月の実績を月・回答件数・押下回数の形で受け取る', async () => {
    const { deps: d, readFunnel } = deps();
    const res = await handleReviewFunnel(d, req().request);

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ months: MONTHS });
    expect(readFunnel).toHaveBeenCalledWith(STORE);
  });

  it('担当の代理店は受け取れる', async () => {
    const { deps: d } = deps({}, AG_OWN);
    expect((await handleReviewFunnel(d, req().request)).status).toBe(200);
  });

  it('DAL が項目を足しても、返すのは月・回答件数・押下回数の 3 つだけ（Requirement 8.2）', async () => {
    const leaky = [{ ...MONTHS[0]!, byStar: { 1: 3, 5: 9 } }] as unknown as StoreReviewFunnelMonth[];
    const { deps: d } = deps({ readFunnel: () => Promise.resolve(leaky) });

    const body = (await (await handleReviewFunnel(d, req().request)).json()) as {
      months: Record<string, unknown>[];
    };

    expect(Object.keys(body.months[0] ?? {}).sort()).toEqual(['month', 'responses', 'reviewLinkOpens']);
  });

  it('認証なしは 401 で実績を読まない', async () => {
    const { deps: d, readFunnel } = deps();
    const res = await handleReviewFunnel(d, req({ authorization: undefined }).request);

    expect(res.status).toBe(401);
    expect((await readJson<ErrorEnvelope>(res)).error.code).toBe('unauthenticated');
    expect(readFunnel).not.toHaveBeenCalled();
  });

  it('未登録・無効化の利用者は 403 で実績を読まない', async () => {
    const unregistered = deps({}, null);
    expect((await handleReviewFunnel(unregistered.deps, req().request)).status).toBe(403);

    const disabled = deps();
    disabled.deps.auth.findUser = () => Promise.resolve({ ...AG_OWN, disabled: true });
    expect((await handleReviewFunnel(disabled.deps, req().request)).status).toBe(403);

    expect(unregistered.readFunnel).not.toHaveBeenCalled();
    expect(disabled.readFunnel).not.toHaveBeenCalled();
  });

  it('担当外の代理店は 403 で実績を読まない（Requirement 8.6）', async () => {
    const { deps: d, readFunnel } = deps({}, AG_OTHER);
    const res = await handleReviewFunnel(d, req().request);

    expect(res.status).toBe(403);
    expect((await readJson<ErrorEnvelope>(res)).error.code).toBe('forbidden');
    expect(readFunnel).not.toHaveBeenCalled();
  });

  it('不在の店舗は 404 で実績を読まない', async () => {
    const { deps: d, readFunnel } = deps({ findStore: () => Promise.resolve(null) });
    const res = await handleReviewFunnel(d, req().request);

    expect(res.status).toBe(404);
    expect((await readJson<ErrorEnvelope>(res)).error.code).toBe('not_found');
    expect(readFunnel).not.toHaveBeenCalled();
  });

  it('停止中・場所が未確定の店舗でも実績は読める（利用可否を決める判定ではない）', async () => {
    for (const over of [{ suspendedAt: new Date('2026-09-23T09:00:00Z') }, { placeStatus: 'pending' as const }]) {
      const { deps: d } = deps({ findStore: () => Promise.resolve(store(over)) });
      expect((await handleReviewFunnel(d, req().request)).status).toBe(200);
    }
  });

  it('読み出しの失敗は 500 にし、店舗の識別子だけを記録する（例外の文言を載せない）', async () => {
    const { deps: d } = deps({ readFunnel: () => Promise.reject(new Error('connection refused')) });
    const { request, log } = req();

    const res = await handleReviewFunnel(d, request);

    expect(res.status).toBe(500);
    expect((await readJson<ErrorEnvelope>(res)).error.code).toBe('internal');
    expect(log.mock.calls).toEqual([['error', 'dashboard-api.review_funnel_read_failed', { storeId: STORE }]]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('connection refused');
  });
});
