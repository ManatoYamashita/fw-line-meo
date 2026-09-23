// @vitest-environment jsdom
//
// 1 店舗分の停止・再開の操作部品（store-suspension tasks 5.2 / Requirements 1.6, 1.8, 2.2, 2.3 /
// design.md「StoreSuspensionControl」）。
//
// 本テストが守る契約:
//  1. 利用中は「利用中」と停止の操作、停止中は「停止中」と再開の操作を出す（2.2, 2.3）
//  2. 停止は確認ダイアログを経たときだけ要求を送り、止まるものを示す。キャンセルでは送らない（1.6）
//  3. 再開は確認なしで送る（Req 1.6 は停止だけを確認の対象にしている）
//  4. 成功・失敗のどちらでも一覧の読み直し（onChanged）を呼ぶ
//  5. 失敗は alert の役割を持つ文言で示し、成功の通知を出さない（1.8）
//  6. 成功はダイアログの外のライブリージョンで告げる
//  7. 実行中は二重に送らない
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import type { ApiResult } from '../src/lib/api';

// api.ts は './firebase' を取り込むため、モジュールごと差し替えて実 SDK を発火させない
// （store-qr-panel.test.tsx と同規約）。
vi.mock('../src/lib/api', () => ({ suspendStore: vi.fn(), resumeStore: vi.fn() }));

import { resumeStore, suspendStore } from '../src/lib/api';
import { StoreSuspensionControl } from '../src/app/stores/store-suspension-control';

// jsdom 25 は PointerEvent を実装していない（ui の alert-dialog.test.tsx と同じ理由の最小互換）。
if (!('PointerEvent' in window)) {
  class PointerEventPolyfill extends MouseEvent {}
  Object.defineProperty(window, 'PointerEvent', {
    value: PointerEventPolyfill,
    configurable: true,
    writable: true,
  });
}

const STORE_ID = '11111111-2222-3333-4444-555555555555';
const STORE_NAME = '炭火焼肉 やました';
const SUSPENDED_AT = '2026-09-23T01:00:00.000Z';

type SuspensionValue = { id: string; suspendedAt: string | null };

const suspendMock = vi.mocked(suspendStore);
const resumeMock = vi.mocked(resumeStore);

function ok(suspendedAt: string | null): ApiResult<SuspensionValue> {
  return { ok: true, value: { id: STORE_ID, suspendedAt } };
}

function failure(code: string, message = 'サーバーのエラー'): ApiResult<SuspensionValue> {
  return { ok: false, code, message };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function renderControl(suspendedAt: string | null, onChanged = vi.fn().mockResolvedValue(undefined)) {
  const view = render(
    <StoreSuspensionControl
      store={{ id: STORE_ID, name: STORE_NAME, suspendedAt }}
      onChanged={onChanged}
    />,
  );
  return { ...view, onChanged };
}

function suspendButton(): HTMLElement {
  return screen.getByRole('button', { name: `${STORE_NAME} を停止` });
}

function resumeButton(): HTMLElement {
  return screen.getByRole('button', { name: `${STORE_NAME} を再開` });
}

async function openConfirm(): Promise<HTMLElement> {
  fireEvent.click(suspendButton());
  return await screen.findByRole('alertdialog');
}

// 成功の通知を持つライブリージョン。成功時に 1 つだけ文言を持つ。
function statusText(): string {
  return screen
    .getAllByRole('status')
    .map((node) => node.textContent ?? '')
    .join('');
}

beforeEach(() => {
  suspendMock.mockReset();
  resumeMock.mockReset();
});

afterEach(cleanup);

describe('StoreSuspensionControl — 状態に応じた操作（2.2, 2.3）', () => {
  it('利用中は「利用中」と停止の操作を出し、再開の操作を出さない', () => {
    renderControl(null);
    expect(screen.getByText('利用中')).toBeTruthy();
    // 見えている文言を読み上げ名へ含める（WCAG 2.5.3 Label in Name）。
    expect(suspendButton().textContent).toContain('停止');
    expect(screen.queryByRole('button', { name: /再開/ })).toBeNull();
  });

  it('停止中は「停止中」と再開の操作を出し、停止の操作を出さない', () => {
    renderControl(SUSPENDED_AT);
    expect(screen.getByText('停止中')).toBeTruthy();
    expect(resumeButton().textContent).toContain('再開');
    expect(screen.queryByRole('button', { name: `${STORE_NAME} を停止` })).toBeNull();
  });
});

describe('StoreSuspensionControl — 停止の確認（1.6）', () => {
  it('停止を押すと確認ダイアログが開き、止まるものを示し、まだ要求を送らない', async () => {
    renderControl(null);
    const dialog = await openConfirm();

    const description = within(dialog).getByText(/日次の取得/);
    for (const stopped of ['日次の取得', '変化通知', 'アンケート', 'QR の発行', '詳細画面']) {
      expect(description.textContent, `止まるものに「${stopped}」が示されていない`).toContain(
        stopped,
      );
    }
    expect(dialog.textContent).toContain(STORE_NAME);
    expect(suspendMock).not.toHaveBeenCalled();
  });

  it('開いた直後の焦点はキャンセルにある（Enter の一押しで停止しない）', async () => {
    renderControl(null);
    const dialog = await openConfirm();
    const cancel = within(dialog).getByRole('button', { name: 'キャンセル' });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
  });

  it('キャンセルでは要求を送らず、読み直しも呼ばない', async () => {
    const { onChanged } = renderControl(null);
    const dialog = await openConfirm();

    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(suspendMock).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('「停止する」で確定したときだけ要求を 1 回送り、読み直しを呼ぶ', async () => {
    suspendMock.mockResolvedValue(ok(SUSPENDED_AT));
    const { onChanged } = renderControl(null);
    const dialog = await openConfirm();

    fireEvent.click(within(dialog).getByRole('button', { name: '停止する' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(suspendMock).toHaveBeenCalledTimes(1);
    expect(suspendMock).toHaveBeenCalledWith({ id: STORE_ID });
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it('成功はダイアログの外のライブリージョンで告げ、失敗の文言を出さない', async () => {
    suspendMock.mockResolvedValue(ok(SUSPENDED_AT));
    const { onChanged } = renderControl(null);
    const dialog = await openConfirm();

    fireEvent.click(within(dialog).getByRole('button', { name: '停止する' }));

    await waitFor(() => expect(statusText()).toContain(`${STORE_NAME} を停止しました`));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // 閉じたダイアログの中ではなく、起点の近くに残る領域で告げる。
    for (const region of screen.getAllByRole('status')) {
      expect(region.closest('[role="alertdialog"]')).toBeNull();
    }
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('ライブリージョンは結果の前から置かれている（文言と同時に挿入すると読み上げられないことがある）', () => {
    renderControl(null);
    const regions = screen.getAllByRole('status');
    expect(regions.length).toBeGreaterThan(0);
    expect(statusText()).toBe('');
  });

  it('ダイアログを閉じた後、焦点は操作の押しボタンへ戻る', async () => {
    suspendMock.mockResolvedValue(ok(SUSPENDED_AT));
    renderControl(null);
    const trigger = suspendButton();
    const dialog = await openConfirm();

    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));

    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

describe('StoreSuspensionControl — 再開（確認なし）', () => {
  it('再開は確認ダイアログを出さずに要求を 1 回送り、読み直しを呼んで成功を告げる', async () => {
    resumeMock.mockResolvedValue(ok(null));
    const { onChanged } = renderControl(SUSPENDED_AT);

    fireEvent.click(resumeButton());

    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(resumeMock).toHaveBeenCalledWith({ id: STORE_ID });
    expect(suspendMock).not.toHaveBeenCalled();
    await waitFor(() => expect(statusText()).toContain(`${STORE_NAME} を再開しました`));
  });
});

describe('StoreSuspensionControl — 失敗の表示（1.8）', () => {
  it('停止の失敗（500）は確認できなかった旨を alert で示し、読み直しを呼び、成功を告げない', async () => {
    suspendMock.mockResolvedValue(failure('internal_error'));
    const { onChanged } = renderControl(null);
    const dialog = await openConfirm();

    fireEvent.click(within(dialog).getByRole('button', { name: '停止する' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      '停止できたか確認できませんでした。一覧の表示を確認してください',
    );
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(statusText()).not.toContain('停止しました');
  });

  it('再開の失敗（通信不能）も確認できなかった旨を alert で示し、読み直しを呼ぶ', async () => {
    resumeMock.mockResolvedValue(failure('network', 'ネットワークエラー'));
    const { onChanged } = renderControl(SUSPENDED_AT);

    fireEvent.click(resumeButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      '再開できたか確認できませんでした。一覧の表示を確認してください',
    );
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(statusText()).not.toContain('再開しました');
  });

  it('見つからない（404）は店舗が見つからない旨を alert で示し、読み直しを呼ぶ', async () => {
    resumeMock.mockResolvedValue(failure('not_found', '店舗が見つかりません'));
    const { onChanged } = renderControl(SUSPENDED_AT);

    fireEvent.click(resumeButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('店舗が見つかりません。一覧を更新しました');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('失敗の後に成功すると、前の失敗の文言を残さない', async () => {
    resumeMock.mockResolvedValueOnce(failure('internal_error')).mockResolvedValueOnce(ok(null));
    renderControl(SUSPENDED_AT);

    fireEvent.click(resumeButton());
    await screen.findByRole('alert');

    fireEvent.click(resumeButton());
    await waitFor(() => expect(statusText()).toContain('再開しました'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('StoreSuspensionControl — 二重送信の防止', () => {
  it('再開の実行中にもう一度押しても要求は 1 回だけで、押しボタンは無効を示す', async () => {
    const pending = deferred<ApiResult<SuspensionValue>>();
    resumeMock.mockReturnValue(pending.promise);
    const { onChanged } = renderControl(SUSPENDED_AT);

    fireEvent.click(resumeButton());
    await waitFor(() => expect(resumeButton().getAttribute('aria-disabled')).toBe('true'));
    fireEvent.click(resumeButton());
    fireEvent.click(resumeButton());

    expect(resumeMock).toHaveBeenCalledTimes(1);

    pending.resolve(ok(null));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(resumeButton().getAttribute('aria-disabled')).not.toBe('true'));
  });

  it('停止の実行中は確認ダイアログを開き直せず、要求は 1 回だけ', async () => {
    const pending = deferred<ApiResult<SuspensionValue>>();
    suspendMock.mockReturnValue(pending.promise);
    const { onChanged } = renderControl(null);
    const dialog = await openConfirm();

    fireEvent.click(within(dialog).getByRole('button', { name: '停止する' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(suspendButton().getAttribute('aria-disabled')).toBe('true'));

    fireEvent.click(suspendButton());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(suspendMock).toHaveBeenCalledTimes(1);

    pending.resolve(ok(SUSPENDED_AT));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('読み直しが終わるまで実行中として扱う', async () => {
    resumeMock.mockResolvedValue(ok(null));
    const reload = deferred<void>();
    const onChanged = vi.fn().mockReturnValue(reload.promise);
    renderControl(SUSPENDED_AT, onChanged);

    fireEvent.click(resumeButton());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(resumeButton().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(resumeButton());
    expect(resumeMock).toHaveBeenCalledTimes(1);

    reload.resolve(undefined);
    await waitFor(() => expect(statusText()).toContain('再開しました'));
  });

  it('読み直しが失敗しても落ちず、要求の結果を告げて再び押せるようになる', async () => {
    resumeMock.mockResolvedValue(ok(null));
    const onChanged = vi.fn().mockRejectedValue(new Error('reload failed'));
    renderControl(SUSPENDED_AT, onChanged);

    fireEvent.click(resumeButton());

    // 読み直しの失敗は一覧の側が示す。この部品は要求の結果だけを告げる。
    await waitFor(() => expect(statusText()).toContain('再開しました'));
    expect(resumeButton().getAttribute('aria-disabled')).not.toBe('true');
  });
});
