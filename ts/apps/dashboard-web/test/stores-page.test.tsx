// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

// 認証コンテキストはモックし、ready な operator/agency を注入する（login-page.test と同規約）。
const useAuthMock = vi.fn();
vi.mock('../src/lib/auth-context', () => ({ useAuth: () => useAuthMock() }));

// next/navigation・next/link はブラウザランタイム依存のためモックする。
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  // 帯（TopNav）が現在地の判定に使う。このページの実経路を返し、偽装が嘘をつかないようにする。
  usePathname: () => '/stores',
}));
vi.mock('next/link', () => ({
  // href / children 以外の props（TopNav が現在地へ付ける aria-current と className）も素の a へ透過する。
  // 捨てると帯の現在地表現が DOM に現れず、検証が構造を掴めない。
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: ReactNode } & import('react').ComponentProps<'a'>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
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
import { settleEffects } from './focus-observation';
import { announcedText, ownText } from './live-region';

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

// 着手前（task 2.3 の開始時点）に照合が 1 件も無かった契約を、実装へ触れる**前**に固定する。
// task 2.1 の「ログアウトの押しボタンに照合が 0 件」・task 2.2 の「無検証の契約 6 つ」と同型で、
// 「壊れない」のではなく「壊れても誰も気づかない」状態だった箇所である。
// 以下はいずれも着手前の素の実装に対しても緑であり、部品化がこれらを保つことを測る基準になる。
describe('店舗一覧ページ: 着手前に無検証だった契約', () => {
  it('取得中は ASCII 三点の「読み込み中...」を提示する（Req 3.2）', () => {
    ready('agency');
    // 解決しない約束を返して取得中の分岐に留める（この分岐を描く照合は着手前に 0 件だった）。
    api.getStores.mockReturnValue(new Promise(() => {}));
    render(<StoresPage />);
    const scope = within(screen.getByRole('main'));
    // 三点リーダは 2 種類ある（振り分けは U+2026・この面と認可ガードは ASCII 3 点）。
    // 見た目がほぼ同じなので、一括置換で揃えると誰も気づかないまま文言が変わる。
    expect(scope.getByText('読み込み中...')).toBeTruthy();
    expect(scope.queryByText('読み込み中…')).toBeNull();
  });

  it('取得に失敗したら理由を読み上げ領域で提示し、一覧を描かない（Req 3.2）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({ ok: false, code: 'network', message: '取得に失敗しました' });
    render(<StoresPage />);
    const scope = within(await screen.findByRole('main'));
    const alert = await scope.findByRole('alert');
    expect(announcedText(alert)).toBe('取得に失敗しました');
    expect(scope.queryByRole('table')).toBeNull();
  });

  it('0 件案内の文言は「担当店舗は 0件 です。」の完全一致である（Req 2.3）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({ ok: true, value: [] });
    render(<StoresPage />);
    const scope = within(await screen.findByRole('main'));
    // 既存の照合は /0件/ の部分一致だけで、前後の文言も助詞も固定していなかった。
    expect(await scope.findByText('担当店舗は 0件 です。')).toBeTruthy();
  });

  it('主要領域は 1 つで、0 件分岐が版面に持つリンクは登録導線 1 つだけである（Req 3.3）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({ ok: true, value: [] });
    const { container } = render(<StoresPage />);
    const main = await screen.findByRole('main');
    // 外枠の到達は取得の完了ではない。0 件の案内が出るまで待たないと、読み込み中の画面で
    // リンクを数えることになる。
    await within(main).findByText('担当店舗は 0件 です。');
    expect(container.querySelectorAll('main')).toHaveLength(1);
    // 帯のリンクを数に入れないため版面の内側へ限る。**個数の完全一致**で見るのは、
    // 「追加」型の改変（導線をもう 1 つ増やす）を包含判定が捕まえないためである。
    expect(within(main).getAllByRole('link')).toHaveLength(1);
  });

  it('一覧は表として読め、行数は見出し行と店舗数の和である（Req 2.1）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({ ok: true, value: [storeConfirmed, storePending] });
    render(<StoresPage />);
    const scope = within(await screen.findByRole('main'));
    await scope.findByText('鳥貴族 渋谷店');
    // 表そのものの役割は既存の照合が 1 つも掴んでいなかった（列見出しの役割だけを見ていた）。
    // カード化すればこの 3 本が同時に赤くなる。
    expect(scope.getAllByRole('table')).toHaveLength(1);
    expect(scope.getAllByRole('row')).toHaveLength(3);
    expect(scope.getAllByRole('cell')).toHaveLength(8);
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

describe('店舗一覧ページ: 発行導線の焦点', () => {
  it('初回取得が成功しても焦点を発行操作から奪わない（6.1）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({ ok: true, value: [storeConfirmed] });
    api.getStoreQr.mockResolvedValue(qrOk());
    render(<StoresPage />);
    await screen.findByText('鳥貴族 渋谷店');

    const button = within(rowOf('鳥貴族 渋谷店')).getByRole('button', { name: /鳥貴族 渋谷店/ });
    button.focus();
    fireEvent.click(button);
    await screen.findByRole('img');

    // 初回はパネルが焦点を壊していないため、引き取ってはならない（横取りになる）。
    // 否定の比較なので待たずに観測点を確定させる（Issue #166）。
    await settleEffects();
    expect(document.activeElement).toBe(button);
  });

  it('失敗から再試行して成功するまで焦点が body へ落ちない（6.1）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({ ok: true, value: [storeConfirmed] });
    api.getStoreQr
      .mockResolvedValueOnce({ ok: false, code: 'network', message: 'x' })
      .mockResolvedValueOnce(qrOk());
    render(<StoresPage />);
    await screen.findByText('鳥貴族 渋谷店');

    const button = within(rowOf('鳥貴族 渋谷店')).getByRole('button', { name: /鳥貴族 渋谷店/ });
    button.focus();
    fireEvent.click(button);
    await screen.findByRole('alert');

    const retry = screen.getByRole('button', { name: /再試行/ });
    retry.focus();
    fireEvent.click(retry);
    expect(document.activeElement).not.toBe(document.body);

    const link = await screen.findByRole('link', { name: /鳥貴族 渋谷店/ });
    // 収束を待つ（Issue #166。store-qr-panel.test.tsx と同じ理由で、ここも偽の赤になりうる）。
    await waitFor(() => expect(document.activeElement).toBe(link));
  });
});

// 意匠の適用そのものを固定する。版面・表・空状態・通知・処理中はいずれも
// docs/design/design-language.md（§7.2 / §3 / §6）と .kiro/specs/ui-airbnb-surfaces/design.md
// （Architecture Pattern・面の側に置く色）が正典であり、ここでは結論も数値も転記せず参照する。
//
// **分岐ごとに走査する。** この面は 取得中 / 失敗 / 0 件 / 1 件以上 の 4 分岐を持ち、
// 最後の分岐はさらにロールで 2 通りに割れる。片方だけを見る照合は「もう片方の版面だけを
// 狭い側へ変える」注入を緑のまま通す（task 2.2 で実測済みの空振り）。
interface SurfaceBranch {
  readonly name: string;
  readonly role: 'operator' | 'agency';
  /** 取得結果の偽装。 */
  readonly arrange: () => void;
  /** その分岐が実際に描かれたことの確認（描かれない状態を緑と読まないための前置き）。 */
  readonly settle: () => Promise<unknown>;
}

const SURFACE_BRANCHES: readonly SurfaceBranch[] = [
  {
    name: '取得中',
    role: 'agency',
    arrange: () => {
      // 解決しない約束を返して取得中の分岐に留める。
      api.getStores.mockReturnValue(new Promise(() => {}));
    },
    settle: () => screen.findByText('読み込み中...'),
  },
  {
    name: '失敗',
    role: 'agency',
    arrange: () => {
      api.getStores.mockResolvedValue({ ok: false, code: 'network', message: '取得に失敗しました' });
    },
    settle: () => screen.findByRole('alert'),
  },
  {
    name: '0 件',
    role: 'agency',
    arrange: () => {
      api.getStores.mockResolvedValue({ ok: true, value: [] });
    },
    settle: () => screen.findByText('担当店舗は 0件 です。'),
  },
  {
    name: '1 件以上/agency',
    role: 'agency',
    arrange: () => {
      api.getStores.mockResolvedValue({ ok: true, value: [storeConfirmed, storePending] });
    },
    settle: () => screen.findByText('鳥貴族 渋谷店'),
  },
  {
    name: '1 件以上/operator',
    role: 'operator',
    arrange: () => {
      api.getStores.mockResolvedValue({ ok: true, value: [storeConfirmed, storePending] });
    },
    settle: () => screen.findByText('鳥貴族 渋谷店'),
  },
];

describe('店舗一覧ページ: 意匠の適用', () => {
  it('どの分岐でも一覧系の広い版面へ置換し、主要領域を 1 つに保つ（Req 1.5, 2.5, 3.3）', async () => {
    let visited = 0;
    for (const branch of SURFACE_BRANCHES) {
      ready(branch.role);
      branch.arrange();
      const { container } = render(<StoresPage />);
      await branch.settle();

      const shell = container.querySelector('[data-slot="page-shell"]');
      expect(shell, branch.name).not.toBeNull();
      // 版面は 2 段しかない。一覧が主なので広い側を使う。
      expect(shell!.getAttribute('data-width'), branch.name).toBe('lg');
      // 既存の main を **置換** する（入れ子にしない）。
      expect(shell!.tagName, branch.name).toBe('MAIN');
      expect(container.querySelectorAll('main'), branch.name).toHaveLength(1);
      // **包含では足りない**（task 2.1 で差し戻された「追加」型の穴）。max-w-* を後ろへ足せば
      // data-width は lg のまま実効の版面だけが縮む。幅を与えるクラスの集合を完全一致で固定する。
      const tokens = shell!.className.split(/\s+/).filter((token) => token.length > 0);
      const widthTokens = tokens.filter((token) => /(^|:)(?:max-|min-)?w-/.test(token));
      expect(widthTokens, branch.name).toEqual(['w-full', 'max-w-7xl']);
      visited += 1;
      cleanup();
    }
    // 走査対象が 1 件も無い状態で緑にならないようにする（要件 7.4）。
    expect(visited).toBe(SURFACE_BRANCHES.length);
  });

  it('主見出しを見出しの部品で描き、読み上げ名と階層を変えない（Req 1.1, 3.2）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({ ok: true, value: [storeConfirmed] });
    render(<StoresPage />);
    const heading = await screen.findByRole('heading', { level: 1, name: '店舗一覧' });
    expect(heading.getAttribute('data-slot')).toBe('heading');
    expect(heading.getAttribute('data-level')).toBe('1');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('一覧を表の部品で描き、行・列・セルの役割を保つ（Req 2.1, 2.2）', async () => {
    ready('operator');
    api.getStores.mockResolvedValue({ ok: true, value: [storeConfirmed, storePending] });
    render(<StoresPage />);
    const scope = within(await screen.findByRole('main'));
    await scope.findByText('鳥貴族 渋谷店');

    const table = scope.getByRole('table');
    expect(table.getAttribute('data-slot')).toBe('table');
    expect(table.querySelector('thead')?.getAttribute('data-slot')).toBe('table-head');
    expect(table.querySelector('tbody')?.getAttribute('data-slot')).toBe('table-body');

    // 見出し行・データ行のいずれも行の部品を通る。**集合の完全一致**で見るのは、
    // 素の <tr> を 1 行だけ混ぜる改変を包含判定が捕まえないためである。
    expect(scope.getAllByRole('row').map((row) => row.getAttribute('data-slot'))).toEqual([
      'table-row',
      'table-row',
      'table-row',
    ]);
    // 列見出しは全件が部品を通り、列見出しとしての scope を持つ（素の <th> は scope を欠いていた）。
    const headers = scope.getAllByRole('columnheader');
    expect(headers.map((header) => header.getAttribute('data-slot'))).toEqual(
      Array.from({ length: 5 }, () => 'table-header-cell'),
    );
    expect(headers.map((header) => header.getAttribute('scope'))).toEqual(
      Array.from({ length: 5 }, () => 'col'),
    );
    // データセルも同様。1 つでも素の <td> が混ざれば余白と行の高さが揃わない。
    expect(scope.getAllByRole('cell').map((cell) => cell.getAttribute('data-slot'))).toEqual(
      Array.from({ length: 10 }, () => 'table-cell'),
    );
  });

  it('横方向の捲りは表の外側の容器が担い、キーボードで到達できる（Req 2.5, 4.1）', async () => {
    ready('operator');
    api.getStores.mockResolvedValue({ ok: true, value: [storeConfirmed] });
    render(<StoresPage />);
    const main = await screen.findByRole('main');
    const scope = within(main);
    await scope.findByText('鳥貴族 渋谷店');

    const table = scope.getByRole('table');
    // 捲りを tbody の内側へ挟むと行の隣接が壊れて発行パネルの挿入が成立しなくなる。
    // 容器は表の**直接の親**でなければならない。
    const container = table.parentElement;
    expect(container?.getAttribute('data-slot')).toBe('table-container');
    // 捲る領域が焦点を得られないと、溢れて隠れた列へ到達する手段が無くなる（WCAG 2.1.1）。
    // e2e（dashboard-surfaces.spec.ts）が宣言する表の捲れる領域 1 件はこの容器のことである。
    expect(container?.getAttribute('tabindex')).toBe('0');
    // 面の側で捲れる領域を増やさない（増やすと e2e の件数宣言と食い違う）。
    expect(main.querySelectorAll('[data-slot="table-container"]')).toHaveLength(1);
  });

  it('0 件の案内を空状態の部品へ移し、登録導線を子として渡す（Req 2.3）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({ ok: true, value: [] });
    render(<StoresPage />);
    const main = await screen.findByRole('main');
    await within(main).findByText('担当店舗は 0件 です。');

    const empty = main.querySelector('[data-slot="empty-state"]');
    expect(empty).not.toBeNull();
    const inside = within(empty as HTMLElement);
    // 文言は 1 文字も変えない。
    expect(inside.getByText('担当店舗は 0件 です。')).toBeTruthy();
    // 部品は押しボタンを内包しない。導線は呼び出し側が children として渡す。
    const link = inside.getByRole('link', { name: '店舗を登録する' });
    expect(link.getAttribute('href')).toBe('/stores/new');
    // 要素はリンクのまま（役割を押しボタンへ変えない）。
    expect(link.tagName).toBe('A');
    expect(within(main).queryAllByRole('button')).toHaveLength(0);
  });

  it('処理中は文言を可視のまま残し、回転する図形を装飾として添える（Req 1.1, 4.5）', () => {
    ready('agency');
    api.getStores.mockReturnValue(new Promise(() => {}));
    render(<StoresPage />);
    const main = screen.getByRole('main');

    const regions = within(main).getAllByRole('status');
    expect(regions).toHaveLength(1);
    const region = regions[0]!;
    // 文言が sr-only の子（Spinner の aria-label 経由）へ落ちていないことを構造で確かめる。
    // <Spinner aria-label="読み込み中..." /> へ置き換えると、ここが空になる。
    expect(ownText(region)).toBe('読み込み中...');
    // 図形側に aria-hidden が付いていないと読み上げ領域が二重になり、この値も二重になる。
    expect(announcedText(region)).toBe('読み込み中...');
    const spinner = region.querySelector('[data-slot="spinner"]');
    expect(spinner).not.toBeNull();
    expect(spinner!.getAttribute('aria-hidden')).toBe('true');
  });

  it('取得の失敗は危険の通知の部品として読み上げ領域 1 つに載る（Req 1.1, 3.5）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({ ok: false, code: 'network', message: '取得に失敗しました' });
    render(<StoresPage />);
    const main = await screen.findByRole('main');
    // 外枠の到達は取得の完了ではない（invite-codes-page.test.tsx の同じ箇所に理由がある）。
    await within(main).findByText('取得に失敗しました');

    const alerts = within(main).getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    const alert = alerts[0]!;
    expect(alert.getAttribute('data-slot')).toBe('alert');
    // 危険の変種は自ら role="alert" を持つ。文言の側へ役割を重ねると領域が二重になる。
    expect(alert.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(alert.querySelector('[data-slot="alert-description"]')?.textContent).toBe(
      '取得に失敗しました',
    );
    expect(announcedText(alert)).toBe('取得に失敗しました');
    // 失敗のとき処理中の表示は残さない（読み上げ領域を 1 つに保つ）。
    expect(within(main).queryAllByRole('status')).toHaveLength(0);
  });

  it('発行パネルの行も表の部品を通り、対象行の直後へ 1 段だけ挿さる（Req 2.1）', async () => {
    ready('operator');
    api.getStores.mockResolvedValue({
      ok: true,
      value: [storeConfirmed, storeConfirmedNoCompetitor],
    });
    api.getStoreQr.mockResolvedValue(qrOk());
    render(<StoresPage />);
    const main = await screen.findByRole('main');
    await within(main).findByText('鳥貴族 渋谷店');

    const targetRow = rowOf('鳥貴族 渋谷店');
    fireEvent.click(within(targetRow).getByRole('button', { name: /鳥貴族 渋谷店/ }));
    await screen.findByRole('heading', { name: /鳥貴族 渋谷店/ });

    const panelRow = targetRow.nextElementSibling;
    expect(panelRow?.tagName).toBe('TR');
    expect(panelRow?.getAttribute('data-slot')).toBe('table-row');
    // 本体は子をそのまま tbody へ流す（間に要素を挟むと隣接関係が壊れる）。
    expect(panelRow?.parentElement).toBe(targetRow.parentElement);
    expect(targetRow.parentElement?.getAttribute('data-slot')).toBe('table-body');

    const panelCell = panelRow?.querySelector('td');
    expect(panelCell?.getAttribute('data-slot')).toBe('table-cell');
    // 桁数は列見出しの実数と一致する（operator は担当代理店列を含む 5 列）。列数の起点は
    // <th> の並びとは別に持たれているため、両者が一致することをここで結び付ける。
    expect(panelCell?.getAttribute('colspan')).toBe('5');
    expect(panelCell?.getAttribute('colspan')).toBe(
      String(within(main).getAllByRole('columnheader').length),
    );
    // 発行操作から開閉先を指す id は行ごとに一意である。
    expect(panelCell?.getAttribute('id')).toBe('qr-panel-s1');
  });

  it('発行できない理由の文言に色を増やさず、補足の色 1 つだけを与える（Req 1.3, 1.4）', async () => {
    ready('agency');
    api.getStores.mockResolvedValue({ ok: true, value: [storePending] });
    render(<StoresPage />);
    const scope = within(await screen.findByRole('main'));
    await scope.findByText('未確定の店');

    const reason = scope.getByText('場所の確定が必要です');
    const tokens = reason.className.split(/\s+/).filter((token) => token.length > 0);
    // **包含では足りない**。別の文字色を後ろへ足せば補足の色は宣言に残ったまま実描画で負ける。
    // 面の側に置く色は閉じた集合であり、この 1 つ（補足色 × ページ背景）を増やさない。
    expect(tokens.filter((token) => /(^|:)text-/.test(token))).toEqual(['text-muted-foreground']);
  });
});
