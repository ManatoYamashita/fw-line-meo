// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';

// オーナーの詳細（agency-dashboard Requirement 10.7・11.6–11.9・11.11–11.13・Issue #526・tasks 9.6）の描画。

const useAuthMock = vi.fn();
vi.mock('../src/lib/auth-context', () => ({ useAuth: () => useAuthMock() }));
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
  getOwner: vi.fn(),
  unlinkOwnerLine: vi.fn(),
}));
vi.mock('../src/lib/api', async () => (await import('./deferred-mocks')).deferResolution(api));

import { OwnerDetailView } from '../src/app/owners/[ownerId]/owner-detail-view';

// 英字を含める。数字だけの id は toUpperCase() で値が変わらず、大文字の URL の試験が空振りする。
const OWNER_ID = 'abcdef55-5555-5555-5555-555555555555';
const AGENCY_ID = 'abcdef11-1111-1111-1111-111111111111';
const S1 = 'abcdef44-4444-4444-4444-444444444441';
const S2 = 'abcdef44-4444-4444-4444-444444444442';

function owner(over: Record<string, unknown> = {}) {
  return {
    id: OWNER_ID,
    displayName: 'オーナー太郎',
    onboardingStatus: 'store_identified',
    createdAt: '2026-08-12T09:00:00.000Z',
    inviteCode: { id: 'c1', code: 'ABCD2345', disabled: false },
    agencyId: AGENCY_ID,
    agencyName: '代理店アルファ',
    lineLink: 'linked',
    menuUnlinkPending: false,
    stores: [],
    takenOverBy: null,
    ...over,
  };
}

function storeRow(id: string, name: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name,
    placeStatus: 'confirmed',
    suspendedAt: null,
    competitorConfigured: true,
    ownerId: OWNER_ID,
    ownerDisplayName: 'オーナー太郎',
    agencyId: AGENCY_ID,
    agencyName: '代理店アルファ',
    createdAt: '2026-08-12T09:00:00.000Z',
    ...over,
  };
}

function detail(ownerOver: Record<string, unknown> = {}, stores = [storeRow(S1, '炭火焼 あいう')]) {
  return { owner: owner(ownerOver), stores };
}

function asRole(role: 'operator' | 'agency') {
  useAuthMock.mockReturnValue({
    status: 'ready',
    me: { role, agencyId: role === 'agency' ? AGENCY_ID : null, agencyName: null, displayName: null },
  });
}
const ok = (value: unknown) => ({ ok: true, value });
const fail = (code: string) => ({ ok: false, code, message: 'サーバーの文言' });

beforeEach(() => {
  asRole('operator');
  for (const fn of Object.values(api)) fn.mockReset();
});
afterEach(cleanup);

const NOT_FOUND_TEXT = 'オーナーが見つかりません。オーナー一覧から選び直してください。';

describe('OwnerDetailView — 取得と状態（11.9・11.11）', () => {
  it('形の不正な id は API を呼ばずに「見つかりません」を出し、概要も操作も描かない', async () => {
    render(<OwnerDetailView ownerId="x" />);
    expect(await screen.findByText(NOT_FOUND_TEXT)).toBeTruthy();
    expect(api.getOwner).not.toHaveBeenCalled();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('link', { name: 'オーナー一覧へ戻る' }).getAttribute('href')).toBe('/owners');
  });

  it('API の 404 は「見つかりません」で、概要・店舗の表・操作を描かない', async () => {
    api.getOwner.mockResolvedValue(fail('not_found'));
    render(<OwnerDetailView ownerId={OWNER_ID} />);
    expect(await screen.findByText(NOT_FOUND_TEXT)).toBeTruthy();
    expect(document.querySelector('dl')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('404 以外の失敗は「見つかりません」と出さず、失敗と再読み込みを示し、押すと取り直す', async () => {
    api.getOwner.mockResolvedValueOnce(fail('internal_error')).mockResolvedValueOnce(ok(detail()));
    render(<OwnerDetailView ownerId={OWNER_ID} />);
    expect((await screen.findByRole('alert')).textContent).toContain('読み込めませんでした');
    expect(screen.queryByText(/見つかりません/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'オーナー太郎' })).toBeTruthy();
    expect(api.getOwner).toHaveBeenCalledTimes(2);
  });

  it('大文字の経路の値は、小文字へ正規化した id で取得する', async () => {
    api.getOwner.mockResolvedValue(ok(detail()));
    render(<OwnerDetailView ownerId={OWNER_ID.toUpperCase()} />);
    await screen.findByRole('heading', { level: 1, name: 'オーナー太郎' });
    expect(api.getOwner).toHaveBeenCalledWith(OWNER_ID);
  });
});

describe('OwnerDetailView — 概要（11.6・11.12・10.7）', () => {
  it('状態・登録日・招待コード・LINE の連携を出し、運営には担当代理店をリンクで出す', async () => {
    api.getOwner.mockResolvedValue(ok(detail()));
    render(<OwnerDetailView ownerId={OWNER_ID} />);
    await screen.findByRole('heading', { level: 1, name: 'オーナー太郎' });
    const dl = document.querySelector('dl')!;
    expect(dl.textContent).toContain('店舗特定済み');
    expect(dl.textContent).toContain('2026');
    expect(dl.textContent).toContain('ABCD2345');
    expect(dl.textContent).toContain('連携中');
    expect(screen.getByRole('link', { name: '代理店アルファ' }).getAttribute('href')).toBe(
      `/admin/agencies/${AGENCY_ID}`,
    );
  });

  it('招待コードの記録が無いオーナーは「記録なし」を出す。無効のコードには「無効」を添える（8.5）', async () => {
    api.getOwner.mockResolvedValueOnce(ok(detail({ inviteCode: null })));
    const first = render(<OwnerDetailView ownerId={OWNER_ID} />);
    expect(await screen.findByText('記録なし（この機能より前の登録）')).toBeTruthy();
    first.unmount();
    api.getOwner.mockResolvedValueOnce(
      ok(detail({ inviteCode: { id: 'c1', code: 'ABCD2345', disabled: true } })),
    );
    render(<OwnerDetailView ownerId={OWNER_ID} />);
    await screen.findByText('ABCD2345');
    expect(within(document.querySelector('dl')!).getByText('無効')).toBeTruthy();
  });

  it('代理店ロールには担当代理店を出さない（10.4）', async () => {
    asRole('agency');
    api.getOwner.mockResolvedValue(ok(detail()));
    render(<OwnerDetailView ownerId={OWNER_ID} />);
    await screen.findByRole('heading', { level: 1, name: 'オーナー太郎' });
    expect(screen.queryByText('代理店アルファ')).toBeNull();
  });

  it('表示名の無いオーナーは h1 を「（表示名なし）」とし、リンクにしない', async () => {
    api.getOwner.mockResolvedValue(ok(detail({ displayName: null })));
    render(<OwnerDetailView ownerId={OWNER_ID} />);
    const h1 = await screen.findByRole('heading', { level: 1, name: '（表示名なし）' });
    expect(h1.querySelector('a')).toBeNull();
  });

  it('引き継ぎ先は文のままで、リンクにしない（10.7）', async () => {
    api.getOwner.mockResolvedValue(
      ok(
        detail({
          lineLink: 'unlinked',
          takenOverBy: { ownerId: 'abcdef66-6666-6666-6666-666666666666', displayName: '新しい担当者' },
        }),
      ),
    );
    render(<OwnerDetailView ownerId={OWNER_ID} />);
    await screen.findByRole('heading', { level: 1, name: 'オーナー太郎' });
    const dl = document.querySelector('dl')!;
    expect(dl.textContent).toContain('引継ぎ先: 新しい担当者');
    expect(screen.queryByRole('link', { name: '新しい担当者' })).toBeNull();
  });
});

describe('OwnerDetailView — 店舗の表（11.7・10.1・10.6）', () => {
  it('列は店名・店舗特定・競合設定・利用状況の 4 つで、操作の列も押しボタンも置かない', async () => {
    api.getOwner.mockResolvedValue(
      ok(
        detail({}, [
          storeRow(S1, '炭火焼 あいう'),
          storeRow(S2, '停止中の店', { placeStatus: 'pending', suspendedAt: '2026-09-01T00:00:00.000Z', competitorConfigured: false }),
        ]),
      ),
    );
    render(<OwnerDetailView ownerId={OWNER_ID} />);
    await screen.findByRole('table');
    expect(screen.getAllByRole('columnheader').map((c) => c.textContent)).toEqual([
      '店名',
      '店舗特定',
      '競合設定',
      '利用状況',
    ]);
    // 捲れる領域は「店舗」の名前を持ち、その中に表が 1 つある
    const region = screen.getByRole('region', { name: '店舗' });
    const table = within(region).getByRole('table');
    expect(within(table).queryByRole('button')).toBeNull();
    // 停止・再開と QR の操作は、この表に置かない（店舗名から店舗の詳細へ進めば操作できる）
    expect(screen.queryByRole('button', { name: /停止|再開|QR/ })).toBeNull();
  });

  it('店名は店舗の詳細へのリンクで、停止中・未確定の店舗もリンクにし、状態を語で示す', async () => {
    api.getOwner.mockResolvedValue(
      ok(
        detail({}, [
          storeRow(S1, '炭火焼 あいう'),
          storeRow(S2, '停止中の店', { placeStatus: 'pending', suspendedAt: '2026-09-01T00:00:00.000Z', competitorConfigured: false }),
        ]),
      ),
    );
    render(<OwnerDetailView ownerId={OWNER_ID} />);
    const link = await screen.findByRole('link', { name: '炭火焼 あいう' });
    expect(link.getAttribute('href')).toBe(`/stores/${S1}`);
    const suspendedRow = screen.getByRole('link', { name: '停止中の店' }).closest('tr')!;
    expect(suspendedRow.getAttribute('href')).toBeNull();
    expect(suspendedRow.textContent).toContain('未確定');
    expect(suspendedRow.textContent).toContain('競合未設定');
    expect(suspendedRow.textContent).toContain('停止中');
    expect(screen.getByRole('link', { name: '停止中の店' }).getAttribute('href')).toBe(`/stores/${S2}`);
  });

  it('店舗が 0 件なら、表を描かず 0 件である旨を出す', async () => {
    api.getOwner.mockResolvedValue(ok(detail({}, [])));
    render(<OwnerDetailView ownerId={OWNER_ID} />);
    expect(await screen.findByText('このオーナーの店舗はありません。')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('OwnerDetailView — 連携の解除（11.8・11.13）', () => {
  it('連携中のオーナーには解除の操作を置き、成功したら 1 件だけ読み直して解除済みへ更新する', async () => {
    api.getOwner
      .mockResolvedValueOnce(ok(detail()))
      .mockResolvedValueOnce(ok(detail({ lineLink: 'unlinked' })));
    api.unlinkOwnerLine.mockResolvedValue(
      ok({ owner: { id: OWNER_ID, lineLink: 'unlinked', menuUnlinkPending: false }, menu: 'removed' }),
    );
    render(<OwnerDetailView ownerId={OWNER_ID} />);
    fireEvent.click(await screen.findByRole('button', { name: 'オーナー太郎 の LINE の連携を解除' }));
    fireEvent.click(await screen.findByRole('button', { name: '解除する' }));
    await waitFor(() => expect(screen.getByText('解除済み')).toBeTruthy());
    expect(api.unlinkOwnerLine).toHaveBeenCalledWith({ id: OWNER_ID });
    expect(api.getOwner).toHaveBeenCalledTimes(2);
    // 読み込み中の表示へ戻っていない
    expect(screen.queryByText('読み込み中...')).toBeNull();
    // 解除済みになったら、解除の操作は出さない
    expect(screen.queryByRole('button', { name: /LINE の連携を解除/ })).toBeNull();
  });

  it('読み直しに失敗したら、表示は古いまま残し、失敗だけを上に示す', async () => {
    api.getOwner.mockResolvedValueOnce(ok(detail())).mockResolvedValueOnce(fail('internal_error'));
    api.unlinkOwnerLine.mockResolvedValue(
      ok({ owner: { id: OWNER_ID, lineLink: 'unlinked', menuUnlinkPending: false }, menu: 'removed' }),
    );
    render(<OwnerDetailView ownerId={OWNER_ID} />);
    fireEvent.click(await screen.findByRole('button', { name: 'オーナー太郎 の LINE の連携を解除' }));
    fireEvent.click(await screen.findByRole('button', { name: '解除する' }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(screen.getByRole('heading', { level: 1, name: 'オーナー太郎' })).toBeTruthy();
  });

  it('読み直しで 404 が返ったら、概要・表・操作を外して「見つかりません」を出す（11.9）', async () => {
    api.getOwner.mockResolvedValueOnce(ok(detail())).mockResolvedValueOnce(fail('not_found'));
    api.unlinkOwnerLine.mockResolvedValue(
      ok({ owner: { id: OWNER_ID, lineLink: 'unlinked', menuUnlinkPending: false }, menu: 'removed' }),
    );
    render(<OwnerDetailView ownerId={OWNER_ID} />);
    fireEvent.click(await screen.findByRole('button', { name: 'オーナー太郎 の LINE の連携を解除' }));
    fireEvent.click(await screen.findByRole('button', { name: '解除する' }));
    expect(await screen.findByText(NOT_FOUND_TEXT)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('この画面が api から取り込む関数は getOwner だけで、書込は操作部品（連携の解除）に限る（11.13）', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/app/owners/[ownerId]/owner-detail-view.tsx'),
      'utf-8',
    );
    const imports = [...source.matchAll(/import \{([^}]*)\} from '[./]*\/lib\/api';/g)].flatMap((m) =>
      (m[1] ?? '').split(',').map((name) => name.trim()).filter((name) => name !== ''),
    );
    expect(imports).toEqual(['getOwner']);
  });

  it('この画面のソースに、確定の比較を書かない（停止の述語ガードの数えに加えない）', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/app/owners/[ownerId]/owner-detail-view.tsx'),
      'utf-8',
    );
    expect(source).not.toMatch(/placeStatus\s*[!=]==?\s*'confirmed'/);
  });
});
