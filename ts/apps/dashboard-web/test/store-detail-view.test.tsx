// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';

// 店舗の詳細（agency-dashboard Requirement 10.7・11.1–11.5・11.9・11.11–11.14・Issue #526・tasks 9.5）の描画。

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
  getStore: vi.fn(),
  suspendStore: vi.fn(),
  resumeStore: vi.fn(),
}));
vi.mock('../src/lib/api', async () => (await import('./deferred-mocks')).deferResolution(api));

// QR パネルは差し替え、渡された props を観測する（取得・描画そのものは store-qr-panel.test.tsx が試す）。
const qrPanelProps = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
vi.mock('../src/components/store-qr-panel', () => ({
  StoreQrPanel: (props: Record<string, unknown>) => {
    qrPanelProps.calls.push(props);
    return <div data-testid="qr-panel">QR パネル</div>;
  },
}));

import { StoreDetailView } from '../src/app/stores/[storeId]/store-detail-view';

// 英字を含める。数字だけの id は toUpperCase() で値が変わらず、大文字の URL の試験が空振りする。
const STORE_ID = 'abcdef44-4444-4444-4444-444444444444';
const OWNER_ID = 'abcdef55-5555-5555-5555-555555555555';
const AGENCY_ID = 'abcdef11-1111-1111-1111-111111111111';

function store(over: Record<string, unknown> = {}) {
  return {
    id: STORE_ID,
    name: '炭火焼 あいう',
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

function asRole(role: 'operator' | 'agency') {
  useAuthMock.mockReturnValue({
    status: 'ready',
    me: { role, agencyId: role === 'agency' ? AGENCY_ID : null, agencyName: null, displayName: null },
  });
}

function ok(value: unknown) {
  return { ok: true, value };
}
function fail(code: string) {
  return { ok: false, code, message: 'サーバーの文言' };
}

beforeEach(() => {
  asRole('operator');
  qrPanelProps.calls.length = 0;
  for (const fn of Object.values(api)) fn.mockReset();
});
afterEach(cleanup);

describe('StoreDetailView — 取得と状態（11.9・11.11）', () => {
  it('形の不正な id は API を呼ばずに「見つかりません」を出し、概要も操作も描かない', async () => {
    render(<StoreDetailView storeId="new" />);
    expect(await screen.findByText('店舗が見つかりません。店舗一覧から選び直してください。')).toBeTruthy();
    expect(api.getStore).not.toHaveBeenCalled();
    expect(screen.queryByTestId('qr-panel')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('link', { name: '店舗一覧へ戻る' }).getAttribute('href')).toBe('/stores');
  });

  it('API の 404 は「見つかりません」で、概要・操作・QR を描かない', async () => {
    api.getStore.mockResolvedValue(fail('not_found'));
    render(<StoreDetailView storeId={STORE_ID} />);
    expect(await screen.findByText('店舗が見つかりません。店舗一覧から選び直してください。')).toBeTruthy();
    expect(screen.queryByRole('definition')).toBeNull();
    expect(screen.queryByTestId('qr-panel')).toBeNull();
    expect(screen.queryByRole('button', { name: /停止|再開/ })).toBeNull();
  });

  it('404 以外の失敗は「見つかりません」と出さず、失敗と再読み込みを示し、押すと取り直す', async () => {
    api.getStore.mockResolvedValueOnce(fail('internal_error')).mockResolvedValueOnce(ok(store()));
    render(<StoreDetailView storeId={STORE_ID} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('読み込めませんでした');
    expect(screen.queryByText(/見つかりません/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }));
    expect(await screen.findByRole('heading', { level: 1, name: '炭火焼 あいう' })).toBeTruthy();
    expect(api.getStore).toHaveBeenCalledTimes(2);
  });

  it('読み込み中は概要を描かない', () => {
    api.getStore.mockReturnValue(new Promise(() => undefined));
    render(<StoreDetailView storeId={STORE_ID} />);
    expect(screen.getByRole('status').textContent).toContain('読み込み中');
    expect(screen.queryByRole('heading', { level: 1, name: '炭火焼 あいう' })).toBeNull();
  });

  it('大文字の経路の値は、小文字へ正規化した id で取得する', async () => {
    api.getStore.mockResolvedValue(ok(store()));
    render(<StoreDetailView storeId={STORE_ID.toUpperCase()} />);
    await screen.findByRole('heading', { level: 1, name: '炭火焼 あいう' });
    expect(api.getStore).toHaveBeenCalledWith(STORE_ID);
  });
});

describe('StoreDetailView — 概要（11.1・11.12・10.7）', () => {
  it('店名・店舗特定・競合設定・オーナー・登録日・利用状況を出し、運営には担当代理店も出す', async () => {
    api.getStore.mockResolvedValue(ok(store()));
    render(<StoreDetailView storeId={STORE_ID} />);
    expect(await screen.findByRole('heading', { level: 1, name: '炭火焼 あいう' })).toBeTruthy();
    const dl = document.querySelector('dl')!;
    expect(dl.textContent).toContain('確定済み');
    expect(dl.textContent).toContain('競合設定済み');
    expect(dl.textContent).toContain('2026');
    expect(dl.textContent).toContain('利用中');
    const owner = screen.getByRole('link', { name: 'オーナー太郎' });
    expect(owner.getAttribute('href')).toBe(`/owners/${OWNER_ID}`);
    const agency = screen.getByRole('link', { name: '代理店アルファ' });
    expect(agency.getAttribute('href')).toBe(`/admin/agencies/${AGENCY_ID}`);
  });

  it('代理店ロールには担当代理店を出さない（10.4）', async () => {
    asRole('agency');
    api.getStore.mockResolvedValue(ok(store()));
    render(<StoreDetailView storeId={STORE_ID} />);
    await screen.findByRole('heading', { level: 1, name: '炭火焼 あいう' });
    expect(screen.queryByText('代理店アルファ')).toBeNull();
    expect(screen.queryByRole('link', { name: '代理店アルファ' })).toBeNull();
  });

  it('表示名の無いオーナーは「（表示名なし）」のままリンクにする（10.6）', async () => {
    api.getStore.mockResolvedValue(ok(store({ ownerDisplayName: null })));
    render(<StoreDetailView storeId={STORE_ID} />);
    const link = await screen.findByRole('link', { name: '（表示名なし）' });
    expect(link.getAttribute('href')).toBe(`/owners/${OWNER_ID}`);
  });

  it('見出しの店名はリンクにしない。戻るリンクは店舗一覧へ（10.7・11.12）', async () => {
    api.getStore.mockResolvedValue(ok(store()));
    render(<StoreDetailView storeId={STORE_ID} />);
    const h1 = await screen.findByRole('heading', { level: 1, name: '炭火焼 あいう' });
    expect(h1.querySelector('a')).toBeNull();
    expect(screen.getByRole('link', { name: '店舗一覧へ戻る' }).getAttribute('href')).toBe('/stores');
    // リンクは オーナー・代理店（運営）・戻る の 3 つだけ
    expect(screen.getAllByRole('link')).toHaveLength(3);
  });
});

describe('StoreDetailView — QR の区分（11.2・11.3・11.4）', () => {
  it('確定済み・利用中は QR パネルを、閉じる先なし・題なしで置く', async () => {
    api.getStore.mockResolvedValue(ok(store()));
    render(<StoreDetailView storeId={STORE_ID} />);
    await screen.findByTestId('qr-panel');
    const props = qrPanelProps.calls.at(-1)!;
    expect(props['storeId']).toBe(STORE_ID);
    expect(props['storeName']).toBe('炭火焼 あいう');
    expect(props['onClose']).toBeUndefined();
    expect(props['showHeader']).toBe(false);
    expect(screen.getByRole('heading', { level: 2, name: 'QR' })).toBeTruthy();
  });

  it('停止中は QR を出さず、停止中のため発行できない旨を出す', async () => {
    api.getStore.mockResolvedValue(ok(store({ suspendedAt: '2026-09-01T00:00:00.000Z' })));
    render(<StoreDetailView storeId={STORE_ID} />);
    expect(await screen.findByText('停止中のため発行できません')).toBeTruthy();
    expect(screen.queryByTestId('qr-panel')).toBeNull();
  });

  it('停止中かつ場所が未確定なら、停止を先に判定する（「場所の確定が必要です」を出さない）', async () => {
    api.getStore.mockResolvedValue(
      ok(store({ placeStatus: 'pending', suspendedAt: '2026-09-01T00:00:00.000Z' })),
    );
    render(<StoreDetailView storeId={STORE_ID} />);
    expect(await screen.findByText('停止中のため発行できません')).toBeTruthy();
    expect(screen.queryByText('場所の確定が必要です')).toBeNull();
  });

  it('利用中で場所が未確定なら、QR を出さず場所の確定が必要な旨を出す', async () => {
    api.getStore.mockResolvedValue(ok(store({ placeStatus: 'pending' })));
    render(<StoreDetailView storeId={STORE_ID} />);
    expect(await screen.findByText('場所の確定が必要です')).toBeTruthy();
    expect(screen.queryByTestId('qr-panel')).toBeNull();
  });
});

describe('StoreDetailView — 停止・再開（11.5・11.13）', () => {
  it('再開に成功したら 1 件だけ読み直し、読み込み中へ置き換えず、QR パネルを出す', async () => {
    const suspended = store({ suspendedAt: '2026-09-01T00:00:00.000Z' });
    api.getStore.mockResolvedValueOnce(ok(suspended)).mockResolvedValueOnce(ok(store()));
    api.resumeStore.mockResolvedValue(ok({ id: STORE_ID, suspendedAt: null }));
    render(<StoreDetailView storeId={STORE_ID} />);
    const resume = await screen.findByRole('button', { name: '炭火焼 あいう を再開' });
    fireEvent.click(resume);
    await waitFor(() => expect(screen.getByTestId('qr-panel')).toBeTruthy());
    expect(api.resumeStore).toHaveBeenCalledWith({ id: STORE_ID });
    expect(api.getStore).toHaveBeenCalledTimes(2);
    // 一度も読み込み中の表示へ戻っていない（押した操作部品が同じ要素のまま残る）
    expect(screen.queryByText('読み込み中...')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: '炭火焼 あいう' })).toBeTruthy();
  });

  it('読み直しに失敗したら、表示は古いまま残し、失敗だけを上に示す', async () => {
    api.getStore.mockResolvedValueOnce(ok(store())).mockResolvedValueOnce(fail('internal_error'));
    api.suspendStore.mockResolvedValue(ok({ id: STORE_ID, suspendedAt: '2026-09-01T00:00:00.000Z' }));
    render(<StoreDetailView storeId={STORE_ID} />);
    fireEvent.click(await screen.findByRole('button', { name: '炭火焼 あいう を停止' }));
    fireEvent.click(await screen.findByRole('button', { name: '停止する' }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(screen.getByRole('heading', { level: 1, name: '炭火焼 あいう' })).toBeTruthy();
    expect(screen.getByTestId('qr-panel')).toBeTruthy();
  });

  it('読み直しで 404 が返ったら、概要・操作・QR を外して「見つかりません」を出す（11.9）', async () => {
    api.getStore.mockResolvedValueOnce(ok(store())).mockResolvedValueOnce(fail('not_found'));
    api.suspendStore.mockResolvedValue(ok({ id: STORE_ID, suspendedAt: '2026-09-01T00:00:00.000Z' }));
    render(<StoreDetailView storeId={STORE_ID} />);
    fireEvent.click(await screen.findByRole('button', { name: '炭火焼 あいう を停止' }));
    fireEvent.click(await screen.findByRole('button', { name: '停止する' }));
    expect(await screen.findByText('店舗が見つかりません。店舗一覧から選び直してください。')).toBeTruthy();
    expect(screen.queryByTestId('qr-panel')).toBeNull();
    expect(screen.queryByRole('heading', { level: 1, name: '炭火焼 あいう' })).toBeNull();
  });

  it('停止に成功したら、QR パネルを外して停止中のため発行できない旨に切り替える（停止前の QR を残さない）', async () => {
    api.getStore
      .mockResolvedValueOnce(ok(store()))
      .mockResolvedValueOnce(ok(store({ suspendedAt: '2026-09-01T00:00:00.000Z' })));
    api.suspendStore.mockResolvedValue(ok({ id: STORE_ID, suspendedAt: '2026-09-01T00:00:00.000Z' }));
    render(<StoreDetailView storeId={STORE_ID} />);
    expect(await screen.findByTestId('qr-panel')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '炭火焼 あいう を停止' }));
    fireEvent.click(await screen.findByRole('button', { name: '停止する' }));
    expect(await screen.findByText('停止中のため発行できません')).toBeTruthy();
    expect(screen.queryByTestId('qr-panel')).toBeNull();
  });

  it('この画面が api から取り込む関数は getStore だけで、書込は操作部品（停止・再開）に限る（11.13）', () => {
    // 実行時の「呼ばれない」は、取り込んでいない関数に対しては空振りする。書込が増えたときに赤になるよう、
    // 取り込みの宣言そのものを検査する。
    const source = readFileSync(
      resolve(process.cwd(), 'src/app/stores/[storeId]/store-detail-view.tsx'),
      'utf-8',
    );
    const imports = [...source.matchAll(/import \{([^}]*)\} from '[./]*\/lib\/api';/g)].flatMap((m) =>
      (m[1] ?? '').split(',').map((name) => name.trim()).filter((name) => name !== ''),
    );
    expect(imports).toEqual(['getStore']);
  });
});
