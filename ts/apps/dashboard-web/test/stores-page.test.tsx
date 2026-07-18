// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';

// 認証コンテキストはモックし、ready な operator/agency を注入する（login-page.test と同規約）。
const useAuthMock = vi.fn();
vi.mock('../src/lib/auth-context', () => ({ useAuth: () => useAuthMock() }));

// next/navigation・next/link はブラウザランタイム依存のためモックする。
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

// api クライアントは全メソッドをモックし、ネットワーク・firebase を発火させない。
const api = vi.hoisted(() => ({
  getStores: vi.fn(),
  getOwners: vi.fn(),
  getAgencies: vi.fn(),
  getCategories: vi.fn(),
  searchStores: vi.fn(),
  registerStore: vi.fn(),
}));
vi.mock('../src/lib/api', () => api);

import StoresPage from '../src/app/stores/page';

function ready(role: 'operator' | 'agency') {
  useAuthMock.mockReturnValue({
    status: 'ready',
    me: {
      role,
      agencyId: role === 'agency' ? 'a1' : null,
      agencyName: role === 'agency' ? '代理店A' : null,
      displayName: 'テスト',
    },
    signIn: vi.fn(),
    signOut: vi.fn(),
  });
}

const storeConfirmed = {
  id: 's1',
  name: '鳥貴族 渋谷店',
  placeStatus: 'confirmed' as const,
  competitorConfigured: true,
  ownerId: 'o1',
  ownerDisplayName: 'オーナー1',
  agencyId: 'a1',
  agencyName: '代理店アルファ',
  createdAt: '2026-01-01T00:00:00Z',
};
const storePending = {
  id: 's2',
  name: '未確定の店',
  placeStatus: 'pending' as const,
  competitorConfigured: false,
  ownerId: 'o2',
  ownerDisplayName: null,
  agencyId: 'a1',
  agencyName: '代理店アルファ',
  createdAt: '2026-01-02T00:00:00Z',
};

beforeEach(() => {
  useAuthMock.mockReset();
  Object.values(api).forEach((m) => m.mockReset());
});
afterEach(cleanup);

describe('店舗一覧ページ', () => {
  it('店舗特定・競合設定のステータスをバッジで表示する（Req 4.3）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({ ok: true, value: [storeConfirmed, storePending] });
    render(<StoresPage />);
    const scope = within(await screen.findByRole('main'));
    expect(await scope.findByText('鳥貴族 渋谷店')).toBeTruthy();
    expect(scope.getByText('確定済み')).toBeTruthy();
    expect(scope.getByText('未確定')).toBeTruthy();
    expect(scope.getByText('競合設定済み')).toBeTruthy();
    expect(scope.getByText('競合未設定')).toBeTruthy();
  });

  it('operator は担当代理店列（agencyName）を表示する（Req 4.2）', async () => {
    ready('operator');
    api.getStores.mockResolvedValue({ ok: true, value: [storeConfirmed] });
    render(<StoresPage />);
    const scope = within(await screen.findByRole('main'));
    expect(await scope.findByText('担当代理店')).toBeTruthy();
    expect(scope.getByText('代理店アルファ')).toBeTruthy();
  });

  it('agency には担当代理店列を表示しない（Req 4.1）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({ ok: true, value: [storeConfirmed] });
    render(<StoresPage />);
    const scope = within(await screen.findByRole('main'));
    await scope.findByText('鳥貴族 渋谷店');
    expect(scope.queryByText('担当代理店')).toBeNull();
  });

  it('0 件のとき 0 件案内と店舗登録導線を表示する（Req 4.4）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({ ok: true, value: [] });
    render(<StoresPage />);
    const scope = within(await screen.findByRole('main'));
    expect(await scope.findByText(/0件/)).toBeTruthy();
    const link = scope.getByRole('link', { name: /店舗を登録/ });
    expect(link.getAttribute('href')).toBe('/stores/new');
  });
});
