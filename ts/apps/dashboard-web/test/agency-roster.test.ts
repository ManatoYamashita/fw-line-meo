import { describe, it, expect, vi } from 'vitest';

// api.ts は './firebase'（初期化＋Auth）を取り込むため、firebase 実 SDK を発火させないよう
// firebase/app・firebase/auth をモックする。実 fetch はテスト毎に注入する（store-api.test.ts と同規約）。
vi.mock('firebase/app', () => ({
  initializeApp: vi.fn(() => ({ name: 'test-app' })),
  getApps: vi.fn(() => []),
  getApp: vi.fn(() => ({ name: 'test-app' })),
}));
vi.mock('firebase/auth', () => ({
  getAuth: vi.fn(() => ({ currentUser: null })),
}));

import { groupStoresByOwner, loadAgencyRoster, storesOfOwner } from '../src/lib/agency-roster';
import { formatJstDate } from '../src/lib/jst-date';
import {
  ONBOARDING_STATUS_LABEL,
  PLACE_STATUS_LABEL,
  storeSuspensionLabel,
} from '../src/lib/status-labels';
import type { StoreListItem } from '../src/lib/types';

// 1 代理店ぶんの「オーナー＋店舗」の共用部品（Issue #485・代理店詳細 #486 と共用）。

function store(id: string, ownerId: string, suspendedAt: string | null = null): StoreListItem {
  return {
    id,
    name: `店${id}`,
    placeStatus: 'confirmed',
    competitorConfigured: false,
    ownerId,
    ownerDisplayName: null,
    agencyId: 'a1',
    agencyName: '代理店A',
    createdAt: '2026-01-01T00:00:00Z',
    suspendedAt,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const OWNER = { id: 'o1', displayName: '山田', onboardingStatus: 'pending', createdAt: '2026-01-01T00:00:00Z' };

describe('groupStoresByOwner', () => {
  it('店舗をオーナーごとに振り分け、1 オーナーの複数店舗を API の並び順のまま持つ', () => {
    const byOwner = groupStoresByOwner([store('1', 'o1'), store('2', 'o2'), store('3', 'o1')]);
    expect(storesOfOwner(byOwner, 'o1').map((s) => s.id)).toEqual(['1', '3']);
    expect(storesOfOwner(byOwner, 'o2').map((s) => s.id)).toEqual(['2']);
  });

  it('店舗の無いオーナーは空配列。停止中の店舗も除かない', () => {
    const byOwner = groupStoresByOwner([store('1', 'o1', '2026-05-01T00:00:00Z')]);
    expect(storesOfOwner(byOwner, 'o1').map((s) => s.id)).toEqual(['1']);
    expect(storesOfOwner(byOwner, 'o9')).toEqual([]);
    expect(storesOfOwner(groupStoresByOwner([]), 'o1')).toEqual([]);
  });

  it('入力の配列を書き換えない（純粋関数）', () => {
    const input = [store('1', 'o1'), store('2', 'o1')];
    const snapshot = JSON.stringify(input);
    groupStoresByOwner(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('loadAgencyRoster', () => {
  /** パスごとに応答を返す fetch。応答の解決は外から操作できる。 */
  function routedFetch(routes: Record<string, () => Promise<Response>>) {
    return vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://api.test').pathname;
      const route = routes[path];
      if (route === undefined) throw new Error(`unexpected ${path}`);
      return route();
    });
  }

  it('オーナーと店舗を並行に要求し、運営は agencyId を両方へ渡す', async () => {
    let releaseOwners!: () => void;
    const ownersGate = new Promise<void>((resolve) => {
      releaseOwners = resolve;
    });
    const fetchImpl = routedFetch({
      '/owners': async () => {
        await ownersGate;
        return jsonResponse(200, { owners: [OWNER] });
      },
      '/stores': async () => jsonResponse(200, { stores: [store('1', 'o1')] }),
    });
    const pending = loadAgencyRoster(
      { agencyId: 'a1' },
      { getToken: async () => 't', fetchImpl, baseUrl: 'http://api.test' },
    );
    // オーナーの応答を待たずに、店舗も要求している（直列にしない）。
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    releaseOwners();
    const result = await pending;
    expect(fetchImpl.mock.calls.map(([url]) => String(url)).sort()).toEqual([
      'http://api.test/owners?agencyId=a1',
      'http://api.test/stores?agencyId=a1',
    ]);
    expect(result.kind).toBe('loaded');
    if (result.kind !== 'loaded' || result.stores.kind !== 'loaded') throw new Error('unreachable');
    expect(result.owners.map((o) => o.id)).toEqual(['o1']);
    expect(storesOfOwner(result.stores.byOwner, 'o1').map((s) => s.id)).toEqual(['1']);
  });

  it('代理店ロール（agencyId なし）はクエリを付けない', async () => {
    const fetchImpl = routedFetch({
      '/owners': async () => jsonResponse(200, { owners: [] }),
      '/stores': async () => jsonResponse(200, { stores: [] }),
    });
    await loadAgencyRoster({}, { getToken: async () => 't', fetchImpl, baseUrl: 'http://api.test' });
    expect(fetchImpl.mock.calls.map(([url]) => String(url)).sort()).toEqual([
      'http://api.test/owners',
      'http://api.test/stores',
    ]);
  });

  it('オーナーの失敗は全体の失敗にする（0 件に化けさせない）', async () => {
    const fetchImpl = routedFetch({
      '/owners': async () => jsonResponse(500, { error: { code: 'internal', message: 'x' } }),
      '/stores': async () => jsonResponse(200, { stores: [] }),
    });
    const result = await loadAgencyRoster({}, { getToken: async () => 't', fetchImpl, baseUrl: 'http://api.test' });
    expect(result).toEqual({ kind: 'error' });
  });

  it('店舗だけの失敗はオーナーを保ったまま店舗を失敗として返す（店舗なしに化けさせない）', async () => {
    const fetchImpl = routedFetch({
      '/owners': async () => jsonResponse(200, { owners: [OWNER] }),
      '/stores': async () => jsonResponse(500, { error: { code: 'internal', message: 'x' } }),
    });
    const result = await loadAgencyRoster({}, { getToken: async () => 't', fetchImpl, baseUrl: 'http://api.test' });
    expect(result.kind).toBe('loaded');
    if (result.kind !== 'loaded') throw new Error('unreachable');
    expect(result.owners).toHaveLength(1);
    expect(result.stores).toEqual({ kind: 'error' });
  });
});

describe('状態の表示語（status-labels）', () => {
  it('オーナー・場所・利用状況の語を 1 つの対応表から引く', () => {
    expect(ONBOARDING_STATUS_LABEL).toEqual({
      pending: '店舗特定前',
      store_identified: '店舗特定済み',
      active: '利用中',
    });
    expect(PLACE_STATUS_LABEL).toEqual({ pending: '未確定', confirmed: '確定済み' });
    expect(storeSuspensionLabel(null)).toBe('利用中');
    expect(storeSuspensionLabel('2026-05-01T00:00:00Z')).toBe('停止中');
  });
});

describe('formatJstDate', () => {
  it('日本時間の暦日で出す（UTC の 15:00 以降は翌日）', () => {
    expect(formatJstDate('2026-02-28T14:59:59Z')).toBe('2026-02-28');
    expect(formatJstDate('2026-02-28T15:00:00Z')).toBe('2026-03-01');
    expect(formatJstDate('2026-03-01T09:00:00+09:00')).toBe('2026-03-01');
  });

  it('解釈できない値は null', () => {
    expect(formatJstDate('not-a-date')).toBeNull();
  });
});
