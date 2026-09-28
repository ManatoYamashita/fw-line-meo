// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';

import type { ApiResult, StoreReviewFunnelMonth } from '../src/lib/api';

// api.ts は './firebase' を取り込むため、モジュールごと差し替えて実 SDK を発火させない。
// 取得手続きは props で注入する。
vi.mock('../src/lib/api', () => ({ getStoreReviewFunnel: vi.fn() }));

import { REVIEW_LINK_OPENS_NOTE, StoreReviewFunnel } from '../src/components/store-review-funnel';

// QR パネルの実績（Issue #401・store-qr-issuance-ui Requirement 8）。

const STORE_ID = '11111111-2222-3333-4444-555555555555';
const STORE_NAME = '炭火焼肉 やました';

const MONTHS: StoreReviewFunnelMonth[] = [
  { month: '2026-09', responses: 12, reviewLinkOpens: 7 },
  { month: '2026-08', responses: 0, reviewLinkOpens: 0 },
];

function ok(months = MONTHS): ApiResult<StoreReviewFunnelMonth[]> {
  return { ok: true, value: months };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(cleanup);

/** 行見出しの名前で行を引き、その行のデータセルの文字を並べる。 */
function rowValues(name: string): string[] {
  const table = screen.getByRole('table', { name: `${STORE_NAME} のアンケートの実績` });
  const header = within(table).getByRole('rowheader', { name });
  const row = header.closest('tr');
  if (row === null) throw new Error(`行が見つからない: ${name}`);
  return within(row).getAllByRole('cell').map((cell) => cell.textContent ?? '');
}

describe('StoreReviewFunnel', () => {
  it('当月・前月の回答件数と投稿画面へ進んだ回数を、月の見出しつきで表示する（Requirement 8.1）', async () => {
    const fetchFunnel = vi.fn().mockResolvedValue(ok());
    render(<StoreReviewFunnel storeId={STORE_ID} storeName={STORE_NAME} fetchFunnel={fetchFunnel} />);

    const table = await screen.findByRole('table', { name: `${STORE_NAME} のアンケートの実績` });
    expect(fetchFunnel).toHaveBeenCalledWith(STORE_ID);
    const columns = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(columns).toEqual(['項目', '今月9月', '先月8月']);
    expect(rowValues('アンケートの回答')).toEqual(['12 件', '0 件']);
    expect(rowValues('Google の投稿画面へ進んだ回数')).toEqual(['7 回', '0 回']);
  });

  it('0 件の月も空欄にせず 0 と表示する（Requirement 8.7）', async () => {
    const zero = [
      { month: '2026-09', responses: 0, reviewLinkOpens: 0 },
      { month: '2026-08', responses: 0, reviewLinkOpens: 0 },
    ];
    render(
      <StoreReviewFunnel
        storeId={STORE_ID}
        storeName={STORE_NAME}
        fetchFunnel={vi.fn().mockResolvedValue(ok(zero))}
      />,
    );

    await screen.findByRole('table');
    expect(rowValues('アンケートの回答')).toEqual(['0 件', '0 件']);
    expect(rowValues('Google の投稿画面へ進んだ回数')).toEqual(['0 回', '0 回']);
  });

  it('年をまたぐ前月も月の数字で出す（1 月の前月は 12 月）', async () => {
    const newYear = [
      { month: '2027-01', responses: 1, reviewLinkOpens: 1 },
      { month: '2026-12', responses: 2, reviewLinkOpens: 0 },
    ];
    render(
      <StoreReviewFunnel
        storeId={STORE_ID}
        storeName={STORE_NAME}
        fetchFunnel={vi.fn().mockResolvedValue(ok(newYear))}
      />,
    );

    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      '項目',
      '今月1月',
      '先月12月',
    ]);
  });

  it('投稿画面へ進んだ回数が投稿数ではないことを、同じ領域に示す（Requirement 8.3）', async () => {
    render(
      <StoreReviewFunnel storeId={STORE_ID} storeName={STORE_NAME} fetchFunnel={vi.fn().mockResolvedValue(ok())} />,
    );

    const section = await screen.findByRole('region', { name: 'アンケートの実績' });
    expect(within(section).getByText(REVIEW_LINK_OPENS_NOTE)).toBeTruthy();
    expect(REVIEW_LINK_OPENS_NOTE).toContain('実際に投稿されたかどうかは Google 側で決まる');
  });

  it('件数を星評価で分けて表示しない（Requirement 8.2）', async () => {
    render(
      <StoreReviewFunnel storeId={STORE_ID} storeName={STORE_NAME} fetchFunnel={vi.fn().mockResolvedValue(ok())} />,
    );

    const section = await screen.findByRole('region', { name: 'アンケートの実績' });
    expect(within(section).getAllByRole('row')).toHaveLength(3); // 見出し行＋2 指標
    expect(section.textContent).not.toMatch(/星|★/);
  });

  it('取得中は読み込み中であることを示し、表を出さない', () => {
    const pending = deferred<ApiResult<StoreReviewFunnelMonth[]>>();
    render(
      <StoreReviewFunnel storeId={STORE_ID} storeName={STORE_NAME} fetchFunnel={vi.fn().mockReturnValue(pending.promise)} />,
    );

    expect(screen.getByText('実績を読み込んでいます')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('どの失敗でも同じ文言を出し、403 と 404 を区別しない（Requirement 8.4 / 8.6）', async () => {
    const texts: string[] = [];
    for (const code of ['forbidden', 'not_found', 'unauthenticated', 'internal', 'network', 'invalid_response']) {
      const { unmount, container } = render(
        <StoreReviewFunnel
          storeId={STORE_ID}
          storeName={STORE_NAME}
          fetchFunnel={vi.fn().mockResolvedValue({ ok: false, code, message: `server message ${code}` })}
        />,
      );
      await screen.findByText(/実績を読み込めませんでした/);
      expect(screen.queryByRole('table')).toBeNull();
      // サーバの message を描画しない
      expect(container.textContent).not.toContain('server message');
      texts.push(container.textContent ?? '');
      unmount();
    }
    expect(new Set(texts).size).toBe(1);
  });

  it('失敗を割り込みの読み上げ（role="alert"）にしない（主操作の結果の通知を上書きしない）', async () => {
    render(
      <StoreReviewFunnel
        storeId={STORE_ID}
        storeName={STORE_NAME}
        fetchFunnel={vi.fn().mockResolvedValue({ ok: false, code: 'internal', message: 'x' })}
      />,
    );

    await screen.findByText(/実績を読み込めませんでした/);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('取得完了前にアンマウントされたら結果を反映しない', async () => {
    const pending = deferred<ApiResult<StoreReviewFunnelMonth[]>>();
    const { unmount } = render(
      <StoreReviewFunnel storeId={STORE_ID} storeName={STORE_NAME} fetchFunnel={vi.fn().mockReturnValue(pending.promise)} />,
    );
    unmount();
    pending.resolve(ok());
    await Promise.resolve();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('印刷の対象から外す指定を領域そのものに持つ（Requirement 8.5）', async () => {
    render(
      <StoreReviewFunnel storeId={STORE_ID} storeName={STORE_NAME} fetchFunnel={vi.fn().mockResolvedValue(ok())} />,
    );

    const section = await screen.findByRole('region', { name: 'アンケートの実績' });
    expect(section.className.split(/\s+/)).toContain('print:hidden');
  });
});
