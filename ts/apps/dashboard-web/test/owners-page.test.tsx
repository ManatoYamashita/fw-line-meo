// @vitest-environment jsdom
//
// オーナー一覧の画面（owner-line-unlink tasks 5.2 / Requirements 1.4, 1.7, 2.1, 2.2, 2.3, 2.4, 2.6,
// 3.2, 3.3 / design.md「OwnersPage・OwnerLineUnlinkControl」）。
//
// 本テストが守る契約:
//  1. オーナー名・担当代理店（運営のみ）・店舗・LINE の連携・操作の列を出す（2.1）
//  2. 連携状態の表示 4 通り（連携中／解除済み／メニュー未解除／引継ぎ先）を出し、解除済みも一覧に残す（2.1, 2.3, 2.6, 3.3）
//  3. 連携中には解除、メニュー未解除には外し直しの操作を出し、それ以外の解除済みには出さない（2.2, 2.3, 3.3）
//  4. 解除に成功すると、画面を再読み込みせずに一覧を取り直し、行を解除済みへ変える（2.4）
//  5. 要求の失敗では行を変えず、失敗を示す（1.7）。メニューの失敗では外し直しの操作が出る（3.2, 3.3）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import type { OwnerListItem } from '../src/lib/types';

const useAuthMock = vi.fn();
vi.mock('../src/lib/auth-context', () => ({ useAuth: () => useAuthMock() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  // 帯（TopNav）が現在地の判定に使う。このページの実経路を返す。
  usePathname: () => '/owners',
}));
vi.mock('next/link', () => ({
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

const api = vi.hoisted(() => ({
  getOwners: vi.fn(),
  unlinkOwnerLine: vi.fn(),
}));
vi.mock('../src/lib/api', async () => (await import('./deferred-mocks')).deferResolution(api));

import OwnersPage from '../src/app/owners/page';
import { expectListSkeleton } from './list-skeleton';

// jsdom 25 は PointerEvent を実装していない（確認ダイアログの Base UI が参照する）。
if (!('PointerEvent' in window)) {
  class PointerEventPolyfill extends MouseEvent {}
  Object.defineProperty(window, 'PointerEvent', {
    value: PointerEventPolyfill,
    configurable: true,
    writable: true,
  });
}

function ready(role: 'operator' | 'agency') {
  useAuthMock.mockReturnValue({
    status: 'ready',
    me: {
      id: 'u1',
      role,
      agencyId: role === 'agency' ? 'a1' : null,
      agencyName: role === 'agency' ? '代理店アルファ' : null,
      displayName: 'テスト',
    },
    signIn: vi.fn(),
    signOut: vi.fn(),
  });
}

function owner(overrides: Partial<OwnerListItem> & Pick<OwnerListItem, 'id'>): OwnerListItem {
  return {
    displayName: null,
    onboardingStatus: 'store_identified',
    createdAt: '2026-09-01T00:00:00Z',
    inviteCode: null,
    agencyName: '代理店アルファ',
    lineLink: 'linked',
    menuUnlinkPending: false,
    storeNames: [],
    takenOverBy: null,
    ...overrides,
  };
}

const linked = owner({
  id: 'o1',
  displayName: '連携中のオーナー',
  storeNames: ['鳥貴族 渋谷店', '鳥貴族 新宿店'],
});
const unlinked = owner({ id: 'o2', displayName: '解除済みのオーナー', lineLink: 'unlinked' });
const pending = owner({
  id: 'o3',
  displayName: 'メニュー未解除のオーナー',
  lineLink: 'unlinked',
  menuUnlinkPending: true,
  agencyName: '代理店ベータ',
});
const takenOver = owner({
  id: 'o4',
  displayName: '引き継がれたオーナー',
  lineLink: 'unlinked',
  takenOverBy: { ownerId: 'o5', displayName: '新しい担当者' },
});
const takenOverNoName = owner({
  id: 'o6',
  displayName: '名無しへ引き継いだオーナー',
  lineLink: 'unlinked',
  takenOverBy: { ownerId: 'o7', displayName: null },
});

const ALL = [linked, unlinked, pending, takenOver];

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function rowOf(name: string): HTMLTableRowElement {
  const row = screen.getByText(name).closest('tr');
  if (row === null) throw new Error(`row not found for ${name}`);
  return row;
}

// 見出しの位置から列のセルを引く（列の並びを変えても対象を取り違えない）。
function cellOf(name: string, header: string): HTMLElement {
  const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
  const index = headers.indexOf(header);
  if (index < 0) throw new Error(`${header} の列がありません`);
  const cell = rowOf(name).children[index];
  if (!(cell instanceof HTMLElement)) throw new Error(`cell not found for ${name}`);
  return cell;
}

function headers(): (string | null)[] {
  return screen.getAllByRole('columnheader').map((h) => h.textContent);
}

beforeEach(() => {
  useAuthMock.mockReset();
  Object.values(api).forEach((m) => m.mockReset());
});
afterEach(cleanup);

describe('オーナー一覧: 列と取得', () => {
  it('運営にはオーナー名・担当代理店・店舗・LINE の連携・操作の列を出し、代理店を指定せずに全件を取る', async () => {
    ready('operator');
    api.getOwners.mockResolvedValue({ ok: true, value: ALL });
    render(<OwnersPage />);
    await screen.findByText('連携中のオーナー');

    expect(screen.getByRole('heading', { level: 1, name: 'オーナー一覧' })).toBeTruthy();
    expect(headers()).toEqual(['オーナー名', '担当代理店', '店舗', 'LINE の連携', '操作']);
    expect(within(cellOf('メニュー未解除のオーナー', '担当代理店')).getByText('代理店ベータ')).toBeTruthy();
    expect(api.getOwners).toHaveBeenCalledTimes(1);
    expect(api.getOwners).toHaveBeenCalledWith({});
  });

  it('代理店には担当代理店の列を出さない', async () => {
    ready('agency');
    api.getOwners.mockResolvedValue({ ok: true, value: ALL });
    render(<OwnersPage />);
    await screen.findByText('連携中のオーナー');

    expect(headers()).toEqual(['オーナー名', '店舗', 'LINE の連携', '操作']);
    expect(screen.queryByText('代理店ベータ')).toBeNull();
    expect(api.getOwners).toHaveBeenCalledWith({});
  });

  it('店舗の列に確定済みの店舗名を並べ、店舗の無いオーナーにはその旨を示す', async () => {
    ready('agency');
    api.getOwners.mockResolvedValue({ ok: true, value: [linked, unlinked] });
    render(<OwnersPage />);
    await screen.findByText('連携中のオーナー');

    const stores = within(cellOf('連携中のオーナー', '店舗')).getAllByRole('listitem');
    expect(stores.map((item) => item.textContent)).toEqual(['鳥貴族 渋谷店', '鳥貴族 新宿店']);
    expect(within(cellOf('解除済みのオーナー', '店舗')).getByText('確定済みの店舗はありません')).toBeTruthy();
  });

  it('表示名の無いオーナーは作成日を添えて区別する', async () => {
    ready('agency');
    api.getOwners.mockResolvedValue({ ok: true, value: [owner({ id: 'o9' })] });
    render(<OwnersPage />);

    expect(await screen.findByText('（表示名なし・2026-09-01 作成）')).toBeTruthy();
  });

  it('取得中は読み込み中を示し、行の操作 1 つ分の形を添える', () => {
    ready('agency');
    api.getOwners.mockReturnValue(new Promise(() => {}));
    render(<OwnersPage />);
    const main = screen.getByRole('main');
    const region = within(main).getByRole('status');
    expect(region.textContent).toBe('読み込み中...');
    expectListSkeleton(main, region, { actions: 1 });
  });

  it('取得に失敗したら理由を示し、表を描かない', async () => {
    ready('agency');
    api.getOwners.mockResolvedValue({ ok: false, code: 'network', message: '通信エラー' });
    render(<OwnersPage />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'オーナー一覧を読み込めませんでした。通信状況を確認して、画面を再読み込みしてください。',
    );
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('0 件のときは空の案内と招待コードへの導線を出す', async () => {
    ready('agency');
    api.getOwners.mockResolvedValue({ ok: true, value: [] });
    render(<OwnersPage />);

    expect(await screen.findByText('オーナーはまだいません。')).toBeTruthy();
    const main = within(screen.getByRole('main'));
    expect(main.getByRole('link', { name: '招待コードを確認する' }).getAttribute('href')).toBe(
      '/invite-codes',
    );
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('オーナー一覧: 連携状態の表示（2.1, 2.3, 2.6, 3.3）', () => {
  it('連携中・解除済み・メニュー未解除・引継ぎ先の 4 通りを表示し、解除済みも一覧に残す', async () => {
    ready('operator');
    api.getOwners.mockResolvedValue({ ok: true, value: ALL });
    render(<OwnersPage />);
    await screen.findByText('連携中のオーナー');

    // 見出し行 + 4 人。解除済みの 3 人も除かない。
    expect(screen.getAllByRole('row')).toHaveLength(ALL.length + 1);
    expect(cellOf('連携中のオーナー', 'LINE の連携').textContent).toBe('連携中');
    expect(cellOf('解除済みのオーナー', 'LINE の連携').textContent).toBe('解除済み');
    expect(cellOf('メニュー未解除のオーナー', 'LINE の連携').textContent).toBe(
      '解除済み（メニュー未解除）',
    );
    expect(cellOf('引き継がれたオーナー', 'LINE の連携').textContent).toBe(
      '解除済み（引継ぎ先: 新しい担当者）',
    );
  });

  it('引継ぎ先に表示名が無ければ「表示名なし」と示す', async () => {
    ready('agency');
    api.getOwners.mockResolvedValue({ ok: true, value: [takenOverNoName] });
    render(<OwnersPage />);
    await screen.findByText('名無しへ引き継いだオーナー');

    expect(cellOf('名無しへ引き継いだオーナー', 'LINE の連携').textContent).toBe(
      '解除済み（引継ぎ先: （表示名なし））',
    );
  });

  it('メニュー未解除で引き継がれてもいるときは、両方を示す', async () => {
    ready('agency');
    api.getOwners.mockResolvedValue({
      ok: true,
      value: [{ ...takenOver, menuUnlinkPending: true }],
    });
    render(<OwnersPage />);
    await screen.findByText('引き継がれたオーナー');

    expect(cellOf('引き継がれたオーナー', 'LINE の連携').textContent).toBe(
      '解除済み（メニュー未解除・引継ぎ先: 新しい担当者）',
    );
  });

  it('連携中には解除、メニュー未解除には外し直しの操作を出し、それ以外の解除済みには操作を出さない（2.2, 2.3, 3.3）', async () => {
    ready('operator');
    api.getOwners.mockResolvedValue({ ok: true, value: ALL });
    render(<OwnersPage />);
    await screen.findByText('連携中のオーナー');

    const linkedActions = within(cellOf('連携中のオーナー', '操作'));
    expect(
      linkedActions.getByRole('button', { name: '連携中のオーナー の LINE の連携を解除' }),
    ).toBeTruthy();
    expect(linkedActions.queryByRole('button', { name: /外し直す/ })).toBeNull();

    const pendingActions = within(cellOf('メニュー未解除のオーナー', '操作'));
    expect(
      pendingActions.getByRole('button', { name: 'メニュー未解除のオーナー のメニューを外し直す' }),
    ).toBeTruthy();
    expect(pendingActions.queryByRole('button', { name: /連携を解除/ })).toBeNull();

    expect(within(rowOf('解除済みのオーナー')).queryByRole('button')).toBeNull();
    expect(within(rowOf('引き継がれたオーナー')).queryByRole('button')).toBeNull();
  });
});

describe('オーナー一覧: 解除の操作（1.4, 1.7, 2.4, 3.2）', () => {
  it('確認ダイアログでキャンセルすると要求を送らず、行も変えない', async () => {
    ready('agency');
    api.getOwners.mockResolvedValue({ ok: true, value: [linked] });
    render(<OwnersPage />);
    await screen.findByText('連携中のオーナー');

    fireEvent.click(screen.getByRole('button', { name: '連携中のオーナー の LINE の連携を解除' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(3);
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(api.unlinkOwnerLine).not.toHaveBeenCalled();
    expect(api.getOwners).toHaveBeenCalledTimes(1);
    expect(cellOf('連携中のオーナー', 'LINE の連携').textContent).toBe('連携中');
  });

  it('解除に成功すると、再読み込みせずに一覧を取り直して行を解除済みへ変える（2.4）', async () => {
    ready('agency');
    const refreshed = deferred<unknown>();
    api.getOwners
      .mockResolvedValueOnce({ ok: true, value: [linked, unlinked] })
      .mockReturnValueOnce(refreshed.promise);
    api.unlinkOwnerLine.mockResolvedValue({
      ok: true,
      value: { owner: { id: 'o1', lineLink: 'unlinked', menuUnlinkPending: false }, menu: 'removed' },
    });
    render(<OwnersPage />);
    await screen.findByText('連携中のオーナー');
    const table = screen.getByRole('table');

    fireEvent.click(screen.getByRole('button', { name: '連携中のオーナー の LINE の連携を解除' }));
    fireEvent.click(await screen.findByRole('button', { name: '解除する' }));

    // 取り直しの最中も表は描いたままにする（読み込み中の表示で置き換えない）。
    await waitFor(() => expect(api.getOwners).toHaveBeenCalledTimes(2));
    expect(api.unlinkOwnerLine).toHaveBeenCalledWith({ id: 'o1' });
    expect(screen.getByRole('table')).toBe(table);
    expect(screen.queryByText('読み込み中...')).toBeNull();

    refreshed.resolve({ ok: true, value: [{ ...linked, lineLink: 'unlinked' }, unlinked] });

    await waitFor(() =>
      expect(cellOf('連携中のオーナー', 'LINE の連携').textContent).toBe('解除済み'),
    );
    expect(screen.getByRole('table')).toBe(table);
    expect(within(rowOf('連携中のオーナー')).queryByRole('button')).toBeNull();
    await waitFor(() =>
      expect(within(cellOf('連携中のオーナー', '操作')).getByRole('status').textContent).toBe(
        '連携中のオーナー の LINE の連携を解除しました。',
      ),
    );
  });

  it('要求が失敗したときは行を連携中のまま保ち、失敗を示す（1.7）', async () => {
    ready('agency');
    api.getOwners.mockResolvedValue({ ok: true, value: [linked] });
    api.unlinkOwnerLine.mockResolvedValue({ ok: false, code: 'internal_error', message: 'x' });
    render(<OwnersPage />);
    await screen.findByText('連携中のオーナー');

    fireEvent.click(screen.getByRole('button', { name: '連携中のオーナー の LINE の連携を解除' }));
    fireEvent.click(await screen.findByRole('button', { name: '解除する' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('LINE の連携を解除できませんでした');
    expect(cellOf('連携中のオーナー', 'LINE の連携').textContent).toBe('連携中');
    expect(
      within(cellOf('連携中のオーナー', '操作')).getByRole('button', {
        name: '連携中のオーナー の LINE の連携を解除',
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/解除しました/)).toBeNull();
  });

  it('メニューを外せなかったときは、外せなかった旨を示し、行に外し直しの操作を出す（3.2, 3.3）', async () => {
    ready('agency');
    api.getOwners
      .mockResolvedValueOnce({ ok: true, value: [linked] })
      .mockResolvedValueOnce({
        ok: true,
        value: [{ ...linked, lineLink: 'unlinked', menuUnlinkPending: true }],
      });
    api.unlinkOwnerLine.mockResolvedValue({
      ok: true,
      value: { owner: { id: 'o1', lineLink: 'unlinked', menuUnlinkPending: true }, menu: 'failed' },
    });
    render(<OwnersPage />);
    await screen.findByText('連携中のオーナー');

    fireEvent.click(screen.getByRole('button', { name: '連携中のオーナー の LINE の連携を解除' }));
    fireEvent.click(await screen.findByRole('button', { name: '解除する' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('LINE のメニューは外せませんでした');
    await waitFor(() =>
      expect(cellOf('連携中のオーナー', 'LINE の連携').textContent).toBe('解除済み（メニュー未解除）'),
    );
    expect(
      within(cellOf('連携中のオーナー', '操作')).getByRole('button', {
        name: '連携中のオーナー のメニューを外し直す',
      }),
    ).toBeTruthy();
  });

  it('外し直しに成功すると、取り直した一覧で未解除の表示が消える', async () => {
    ready('operator');
    api.getOwners
      .mockResolvedValueOnce({ ok: true, value: [pending] })
      .mockResolvedValueOnce({ ok: true, value: [{ ...pending, menuUnlinkPending: false }] });
    api.unlinkOwnerLine.mockResolvedValue({
      ok: true,
      value: { owner: { id: 'o3', lineLink: 'unlinked', menuUnlinkPending: false }, menu: 'removed' },
    });
    render(<OwnersPage />);
    await screen.findByText('メニュー未解除のオーナー');

    fireEvent.click(
      screen.getByRole('button', { name: 'メニュー未解除のオーナー のメニューを外し直す' }),
    );

    await waitFor(() =>
      expect(cellOf('メニュー未解除のオーナー', 'LINE の連携').textContent).toBe('解除済み'),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.unlinkOwnerLine).toHaveBeenCalledTimes(1);
    expect(api.getOwners).toHaveBeenCalledTimes(2);
  });

  it('取り直しに失敗しても表を残し、失敗を別の通知で示す', async () => {
    ready('agency');
    api.getOwners
      .mockResolvedValueOnce({ ok: true, value: [linked] })
      .mockResolvedValueOnce({ ok: false, code: 'network', message: '取得に失敗しました' });
    api.unlinkOwnerLine.mockResolvedValue({
      ok: true,
      value: { owner: { id: 'o1', lineLink: 'unlinked', menuUnlinkPending: false }, menu: 'removed' },
    });
    render(<OwnersPage />);
    await screen.findByText('連携中のオーナー');

    fireEvent.click(screen.getByRole('button', { name: '連携中のオーナー の LINE の連携を解除' }));
    fireEvent.click(await screen.findByRole('button', { name: '解除する' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('オーナー一覧を読み込めませんでした');
    expect(screen.getByRole('table')).toBeTruthy();
  });
});
