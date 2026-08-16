// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';

const useAuthMock = vi.fn();
vi.mock('../src/lib/auth-context', () => ({ useAuth: () => useAuthMock() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

const api = vi.hoisted(() => ({
  getStores: vi.fn(),
  getOwners: vi.fn(),
  getAgencies: vi.fn(),
  getCategories: vi.fn(),
  searchStores: vi.fn(),
  registerStore: vi.fn(),
}));
vi.mock('../src/lib/api', () => api);

import StoreRegisterPage from '../src/app/stores/new/page';

function readyAgency() {
  useAuthMock.mockReturnValue({
    status: 'ready',
    me: { role: 'agency', agencyId: 'a1', agencyName: '代理店A', displayName: 'テスト' },
    signIn: vi.fn(),
    signOut: vi.fn(),
  });
}

const owner = { id: 'o1', displayName: '山田オーナー', onboardingStatus: 'pending', createdAt: '2026-01-01T00:00:00Z' };
const candidate = {
  placeId: 'p1',
  name: '鳥貴族 渋谷店',
  address: '東京都渋谷区1-1',
  latitude: 35.6,
  longitude: 139.7,
  types: ['restaurant'],
};

beforeEach(() => {
  useAuthMock.mockReset();
  Object.values(api).forEach((m) => m.mockReset());
  readyAgency();
});
afterEach(cleanup);

async function selectOwnerAndSearchTo(scope: ReturnType<typeof within>, query: string) {
  fireEvent.change(await scope.findByLabelText('オーナー'), { target: { value: 'o1' } });
  fireEvent.click(scope.getByRole('button', { name: /次へ/ }));
  fireEvent.change(await scope.findByLabelText('店名'), { target: { value: query } });
  fireEvent.click(scope.getByRole('button', { name: '検索' }));
}

describe('店舗登録ウィザード', () => {
  it('選択可能オーナーが 0 件のとき案内を表示し先へ進めない（Req 3.3）', async () => {
    api.getOwners.mockResolvedValue({ ok: true, value: [] });
    render(<StoreRegisterPage />);
    const scope = within(await screen.findByRole('main'));
    expect(await scope.findByText(/対象オーナーがいません/)).toBeTruthy();
    expect(scope.queryByRole('button', { name: /次へ/ })).toBeNull();
  });

  it('検索結果が見つかると候補を一覧表示する（Req 3.4）', async () => {
    api.getOwners.mockResolvedValue({ ok: true, value: [owner] });
    api.searchStores.mockResolvedValue({ ok: true, value: [candidate] });
    render(<StoreRegisterPage />);
    const scope = within(await screen.findByRole('main'));
    await selectOwnerAndSearchTo(scope, '鳥貴族');
    expect(await scope.findByRole('button', { name: /鳥貴族 渋谷店/ })).toBeTruthy();
  });

  it('検索結果 0 件のとき再検索案内を表示する（Req 3.5）', async () => {
    api.getOwners.mockResolvedValue({ ok: true, value: [owner] });
    api.searchStores.mockResolvedValue({ ok: true, value: [] });
    render(<StoreRegisterPage />);
    const scope = within(await screen.findByRole('main'));
    await selectOwnerAndSearchTo(scope, 'zzz');
    expect(await scope.findByText(/見つかりませんでした/)).toBeTruthy();
  });

  it('検索が失敗(502)したときエラー案内を表示する（Req 3.6）', async () => {
    api.getOwners.mockResolvedValue({ ok: true, value: [owner] });
    api.searchStores.mockResolvedValue({ ok: false, code: 'places_error', message: 'x' });
    render(<StoreRegisterPage />);
    const scope = within(await screen.findByRole('main'));
    await selectOwnerAndSearchTo(scope, 'x');
    expect(await scope.findByText(/検索に失敗しました/)).toBeTruthy();
  });

  it('ハッピーパス: オーナー選択→検索→候補選択→カテゴリ→確定で成功案内、候補は verbatim 送信（Req 3.7, 3.8）', async () => {
    api.getOwners.mockResolvedValue({ ok: true, value: [owner] });
    api.searchStores.mockResolvedValue({ ok: true, value: [candidate] });
    api.getCategories.mockResolvedValue({ ok: true, value: [{ code: 'izakaya', label: '居酒屋' }] });
    api.registerStore.mockResolvedValue({ ok: true, value: { storeId: 'store-1' } });
    render(<StoreRegisterPage />);
    const scope = within(await screen.findByRole('main'));
    await selectOwnerAndSearchTo(scope, '鳥貴族');
    fireEvent.click(await scope.findByRole('button', { name: /鳥貴族 渋谷店/ }));
    fireEvent.click(await scope.findByRole('button', { name: /この店舗で進む/ }));
    fireEvent.change(await scope.findByLabelText(/カテゴリ/), { target: { value: 'izakaya' } });
    fireEvent.click(scope.getByRole('button', { name: /登録を確定/ }));
    expect(await scope.findByText('登録が完了しました')).toBeTruthy();
    expect(api.registerStore).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'o1', candidate, categoryCode: 'izakaya' }),
    );
  });

  it('確定時に 409 が返ると既に登録済み案内を表示する（Req 3.9）', async () => {
    api.getOwners.mockResolvedValue({ ok: true, value: [owner] });
    api.searchStores.mockResolvedValue({ ok: true, value: [candidate] });
    api.getCategories.mockResolvedValue({ ok: true, value: [] });
    api.registerStore.mockResolvedValue({ ok: false, code: 'place_already_registered', message: 'x' });
    render(<StoreRegisterPage />);
    const scope = within(await screen.findByRole('main'));
    await selectOwnerAndSearchTo(scope, '鳥貴族');
    fireEvent.click(await scope.findByRole('button', { name: /鳥貴族 渋谷店/ }));
    fireEvent.click(await scope.findByRole('button', { name: /この店舗で進む/ }));
    fireEvent.click(await scope.findByRole('button', { name: /登録を確定/ }));
    expect(await scope.findByText(/既に登録済み/)).toBeTruthy();
  });
});
