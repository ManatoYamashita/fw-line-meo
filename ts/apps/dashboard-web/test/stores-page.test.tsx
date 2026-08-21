// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';
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
  // QR パネルが使う窓口。差し替えを忘れると undefined が呼ばれて既存テストごと落ちる。
  getStoreQr: vi.fn(),
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
const storeConfirmedNoCompetitor = {
  id: 's3',
  name: '競合未設定の確定店',
  placeStatus: 'confirmed' as const,
  competitorConfigured: false,
  ownerId: 'o3',
  ownerDisplayName: null,
  agencyId: 'a1',
  agencyName: '代理店アルファ',
  createdAt: '2026-01-03T00:00:00Z',
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

// jsdom には object URL を作る手段が無いため差し込む（store-qr-panel.test.tsx と同規約）。
const createObjectURL = vi.fn(() => 'blob:mock-url');
const revokeObjectURL = vi.fn();

function qrOk() {
  return { ok: true as const, value: { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' } };
}

// 対象店舗の行を返す（行内の発行操作とパネルの挿入位置を検査するため）。
function rowOf(storeName: string): HTMLTableRowElement {
  const cell = screen.getByText(storeName);
  const row = cell.closest('tr');
  if (row === null) throw new Error(`row not found for ${storeName}`);
  return row;
}

beforeEach(() => {
  useAuthMock.mockReset();
  Object.values(api).forEach((m) => m.mockReset());
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
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

describe('店舗一覧ページ: QR 発行導線', () => {
  it('場所が確定済みの行に店名を含む名前の発行操作を出す（1.1, 6.3）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({ ok: true, value: [storeConfirmed] });
    render(<StoresPage />);
    const scope = within(await screen.findByRole('main'));

    await scope.findByText('鳥貴族 渋谷店');
    const button = scope.getByRole('button', { name: /鳥貴族 渋谷店/ });
    expect(button.textContent).toContain('QR');
  });

  it('場所が未確定の行には発行操作を出さず理由を示す（3.1, 3.2）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({ ok: true, value: [storeConfirmed, storePending] });
    render(<StoresPage />);
    await screen.findByText('未確定の店');

    const pendingRow = within(rowOf('未確定の店'));
    expect(pendingRow.queryByRole('button')).toBeNull();
    // 「未確定」という店舗特定列の既存表示に当たらない語で照合する（テストの感度を保つ）。
    expect(pendingRow.getByText(/場所の確定/)).toBeTruthy();
  });

  it('競合設定の状態にかかわらず発行操作を出す（1.5）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({ ok: true, value: [storeConfirmedNoCompetitor] });
    render(<StoresPage />);
    await screen.findByText('競合未設定の確定店');

    expect(
      within(rowOf('競合未設定の確定店')).getByRole('button', { name: /競合未設定の確定店/ }),
    ).toBeTruthy();
  });

  it('既存の列を欠落させず QR 列を加える（1.4）', async () => {
    ready('operator');
    api.getStores.mockResolvedValue({ ok: true, value: [storeConfirmed] });
    render(<StoresPage />);
    const scope = within(await screen.findByRole('main'));
    await scope.findByText('鳥貴族 渋谷店');

    const headers = scope.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['店名', '店舗特定', '競合設定', '担当代理店', 'QR']);
  });

  it('agency では担当代理店列を除いた 4 列になる（1.4）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({ ok: true, value: [storeConfirmed] });
    render(<StoresPage />);
    const scope = within(await screen.findByRole('main'));
    await scope.findByText('鳥貴族 渋谷店');

    const headers = scope.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['店名', '店舗特定', '競合設定', 'QR']);
  });

  it('発行操作でパネルが対象行の直下に現れる（1.3）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({
      ok: true,
      value: [storeConfirmed, storeConfirmedNoCompetitor],
    });
    api.getStoreQr.mockResolvedValue(qrOk());
    render(<StoresPage />);
    await screen.findByText('鳥貴族 渋谷店');

    const targetRow = rowOf('鳥貴族 渋谷店');
    fireEvent.click(within(targetRow).getByRole('button', { name: /鳥貴族 渋谷店/ }));

    const heading = await screen.findByRole('heading', { name: /鳥貴族 渋谷店/ });
    expect(targetRow.nextElementSibling?.contains(heading)).toBe(true);
  });

  it('挿入したパネルの行が表の全列にまたがる（1.4）', async () => {
    ready('operator');
    api.getStores.mockResolvedValue({ ok: true, value: [storeConfirmed] });
    api.getStoreQr.mockResolvedValue(qrOk());
    render(<StoresPage />);
    await screen.findByText('鳥貴族 渋谷店');

    const targetRow = rowOf('鳥貴族 渋谷店');
    fireEvent.click(within(targetRow).getByRole('button', { name: /鳥貴族 渋谷店/ }));
    await screen.findByRole('heading', { name: /鳥貴族 渋谷店/ });

    const panelCell = targetRow.nextElementSibling?.querySelector('td');
    expect(panelCell?.getAttribute('colspan')).toBe('5');
  });

  it('別店舗の発行でパネルを差し替え、前の資源を引き継がせない（2.8）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({
      ok: true,
      value: [storeConfirmed, storeConfirmedNoCompetitor],
    });
    api.getStoreQr.mockResolvedValue(qrOk());
    render(<StoresPage />);
    await screen.findByText('鳥貴族 渋谷店');

    fireEvent.click(within(rowOf('鳥貴族 渋谷店')).getByRole('button', { name: /鳥貴族 渋谷店/ }));
    await screen.findByRole('heading', { name: /鳥貴族 渋谷店/ });

    fireEvent.click(
      within(rowOf('競合未設定の確定店')).getByRole('button', { name: /競合未設定の確定店/ }),
    );
    await screen.findByRole('heading', { name: /競合未設定の確定店/ });

    expect(screen.queryByRole('heading', { name: /鳥貴族 渋谷店/ })).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('同じ店舗の発行操作を再度押しても取得を再発行しない（2.2）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({ ok: true, value: [storeConfirmed] });
    api.getStoreQr.mockResolvedValue(qrOk());
    render(<StoresPage />);
    await screen.findByText('鳥貴族 渋谷店');

    const button = within(rowOf('鳥貴族 渋谷店')).getByRole('button', { name: /鳥貴族 渋谷店/ });
    fireEvent.click(button);
    await screen.findByRole('heading', { name: /鳥貴族 渋谷店/ });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(api.getStoreQr).toHaveBeenCalledTimes(1);
  });

  it('発行に失敗しても一覧の表示を維持する（4.4）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({ ok: true, value: [storeConfirmed, storePending] });
    api.getStoreQr.mockResolvedValue({ ok: false, code: 'network', message: 'x' });
    render(<StoresPage />);
    await screen.findByText('鳥貴族 渋谷店');

    fireEvent.click(within(rowOf('鳥貴族 渋谷店')).getByRole('button', { name: /鳥貴族 渋谷店/ }));
    await screen.findByRole('alert');

    expect(screen.getByText('鳥貴族 渋谷店')).toBeTruthy();
    expect(screen.getByText('未確定の店')).toBeTruthy();
    expect(api.getStores).toHaveBeenCalledTimes(1);
  });

  it('パネルを閉じると表示を残さない（2.8）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({ ok: true, value: [storeConfirmed] });
    api.getStoreQr.mockResolvedValue(qrOk());
    render(<StoresPage />);
    await screen.findByText('鳥貴族 渋谷店');

    fireEvent.click(within(rowOf('鳥貴族 渋谷店')).getByRole('button', { name: /鳥貴族 渋谷店/ }));
    await screen.findByRole('heading', { name: /鳥貴族 渋谷店/ });

    fireEvent.click(screen.getByRole('button', { name: /閉じる/ }));
    expect(screen.queryByRole('heading', { name: /鳥貴族 渋谷店/ })).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });
});

describe('店舗一覧ページ: 行と取得対象の対応', () => {
  it('押した行の店舗 ID で取得する（1.3・取り違えの防止）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({
      ok: true,
      value: [storeConfirmed, storeConfirmedNoCompetitor],
    });
    api.getStoreQr.mockResolvedValue(qrOk());
    render(<StoresPage />);
    await screen.findByText('競合未設定の確定店');

    // 一覧の 2 行目を押す。1 行目の ID を渡す実装ではここが赤になる。
    fireEvent.click(
      within(rowOf('競合未設定の確定店')).getByRole('button', { name: /競合未設定の確定店/ }),
    );
    await screen.findByRole('heading', { name: /競合未設定の確定店/ });

    expect(api.getStoreQr).toHaveBeenCalledWith('s3');
    expect(api.getStoreQr).not.toHaveBeenCalledWith('s1');
  });

  it('別店舗へ切り替えると切り替え先の店舗 ID で取得し直す（2.8）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({
      ok: true,
      value: [storeConfirmed, storeConfirmedNoCompetitor],
    });
    api.getStoreQr.mockResolvedValue(qrOk());
    render(<StoresPage />);
    await screen.findByText('鳥貴族 渋谷店');

    fireEvent.click(within(rowOf('鳥貴族 渋谷店')).getByRole('button', { name: /鳥貴族 渋谷店/ }));
    await screen.findByRole('heading', { name: /鳥貴族 渋谷店/ });
    fireEvent.click(
      within(rowOf('競合未設定の確定店')).getByRole('button', { name: /競合未設定の確定店/ }),
    );
    await screen.findByRole('heading', { name: /競合未設定の確定店/ });

    expect(api.getStoreQr.mock.calls.map(([id]) => id)).toEqual(['s1', 's3']);
  });

  it('保存名にも押した行の店舗が反映される（2.4, 2.6）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({
      ok: true,
      value: [storeConfirmed, storeConfirmedNoCompetitor],
    });
    api.getStoreQr.mockResolvedValue(qrOk());
    render(<StoresPage />);
    await screen.findByText('競合未設定の確定店');

    fireEvent.click(
      within(rowOf('競合未設定の確定店')).getByRole('button', { name: /競合未設定の確定店/ }),
    );
    const link = await screen.findByRole('link', { name: /競合未設定の確定店/ });
    expect(link.getAttribute('download')).toBe('qr-競合未設定の確定店-s3.png');
  });
});

describe('店舗一覧ページ: 発行導線の操作性', () => {
  it('見える文言が読み上げ名に含まれる（WCAG 2.5.3 Label in Name）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({ ok: true, value: [storeConfirmed] });
    render(<StoresPage />);
    await screen.findByText('鳥貴族 渋谷店');

    const button = within(rowOf('鳥貴族 渋谷店')).getByRole('button', { name: /鳥貴族 渋谷店/ });
    const visible = button.textContent ?? '';
    expect(visible.length).toBeGreaterThan(0);
    expect(button.getAttribute('aria-label')).toContain(visible);
  });

  it('発行導線が開閉状態を支援技術へ伝える（6.1）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({ ok: true, value: [storeConfirmed] });
    api.getStoreQr.mockResolvedValue(qrOk());
    render(<StoresPage />);
    await screen.findByText('鳥貴族 渋谷店');

    const button = within(rowOf('鳥貴族 渋谷店')).getByRole('button', { name: /鳥貴族 渋谷店/ });
    expect(button.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(button);
    await screen.findByRole('heading', { name: /鳥貴族 渋谷店/ });
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('パネルを閉じたとき焦点を発行操作へ戻す（6.1）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({ ok: true, value: [storeConfirmed] });
    api.getStoreQr.mockResolvedValue(qrOk());
    render(<StoresPage />);
    await screen.findByText('鳥貴族 渋谷店');

    const button = within(rowOf('鳥貴族 渋谷店')).getByRole('button', { name: /鳥貴族 渋谷店/ });
    fireEvent.click(button);
    await screen.findByRole('heading', { name: /鳥貴族 渋谷店/ });

    fireEvent.click(screen.getByRole('button', { name: /閉じる/ }));
    expect(document.activeElement).toBe(button);
  });

  it('agency でもパネル行が全列にまたがる（1.4）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({ ok: true, value: [storeConfirmed] });
    api.getStoreQr.mockResolvedValue(qrOk());
    render(<StoresPage />);
    await screen.findByText('鳥貴族 渋谷店');

    const targetRow = rowOf('鳥貴族 渋谷店');
    fireEvent.click(within(targetRow).getByRole('button', { name: /鳥貴族 渋谷店/ }));
    await screen.findByRole('heading', { name: /鳥貴族 渋谷店/ });

    expect(targetRow.nextElementSibling?.querySelector('td')?.getAttribute('colspan')).toBe('4');
  });

  it('発行に失敗しても他店舗の発行を妨げない（4.4）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({
      ok: true,
      value: [storeConfirmed, storeConfirmedNoCompetitor],
    });
    api.getStoreQr.mockResolvedValueOnce({ ok: false, code: 'network', message: 'x' });
    render(<StoresPage />);
    await screen.findByText('鳥貴族 渋谷店');

    fireEvent.click(within(rowOf('鳥貴族 渋谷店')).getByRole('button', { name: /鳥貴族 渋谷店/ }));
    await screen.findByRole('alert');

    api.getStoreQr.mockResolvedValue(qrOk());
    fireEvent.click(
      within(rowOf('競合未設定の確定店')).getByRole('button', { name: /競合未設定の確定店/ }),
    );

    await screen.findByRole('img');
    expect(api.getStoreQr.mock.calls.map(([id]) => id)).toEqual(['s1', 's3']);
  });
});
