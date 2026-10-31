// @vitest-environment jsdom
//
// 1 オーナー分の LINE の解除・メニューの外し直しの操作部品（owner-line-unlink tasks 5.2 /
// Requirements 1.4, 1.7, 2.2, 2.3, 3.2, 3.3 / design.md「OwnersPage・OwnerLineUnlinkControl」）。
//
// 本テストが守る契約:
//  1. 連携中は解除の操作、メニュー未解除は外し直しの操作を出し、どちらでもない解除済みには操作を出さない（2.2, 2.3, 3.3）
//  2. 解除は確認ダイアログを経たときだけ送り、ダイアログは 3 点を示す。キャンセルでは送らない（1.4）
//  3. 外し直しは確認なしで送る（紐づけの状態を変えないため）
//  4. メニューを外せなかったときは、解除は完了したが外せなかったことと外し直しの導線を示す（3.2）
//  5. 要求の失敗は alert で示し、成功の通知を出さない（1.7）
//  6. 成功・失敗のどちらでも一覧の読み直し（onChanged）を呼ぶ
//  7. 実行中は二重に送らない。操作が消えたときは焦点を結果の文言へ移す
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';

import type { ApiResult } from '../src/lib/api';
import type { OwnerLineUnlinkResult, OwnerListItem } from '../src/lib/types';

// api.ts は './firebase' を取り込むため、モジュールごと差し替えて実 SDK を発火させない。
const api = vi.hoisted(() => ({ unlinkOwnerLine: vi.fn() }));
vi.mock('../src/lib/api', async () => (await import('./deferred-mocks')).deferResolution(api));

import { OwnerLineUnlinkControl } from '../src/app/owners/owner-line-unlink-control';

// jsdom 25 は PointerEvent を実装していない（store-suspension-control.test.tsx と同じ理由の最小互換）。
if (!('PointerEvent' in window)) {
  class PointerEventPolyfill extends MouseEvent {}
  Object.defineProperty(window, 'PointerEvent', {
    value: PointerEventPolyfill,
    configurable: true,
    writable: true,
  });
}

const OWNER_ID = '11111111-2222-3333-4444-555555555555';
const OWNER_NAME = '山下 太郎';

const unlinkMock = api.unlinkOwnerLine;

function owner(overrides: Partial<OwnerListItem> = {}): OwnerListItem {
  return {
    id: OWNER_ID,
    displayName: OWNER_NAME,
    onboardingStatus: 'store_identified',
    createdAt: '2026-09-01T00:00:00Z',
    inviteCode: null,
    agencyName: '代理店アルファ',
    lineLink: 'linked',
    menuUnlinkPending: false,
    storeNames: ['炭火焼肉 やました'],
    takenOverBy: null,
    ...overrides,
  };
}

const LINKED = owner();
const PENDING = owner({ lineLink: 'unlinked', menuUnlinkPending: true });
const UNLINKED = owner({ lineLink: 'unlinked' });

function ok(
  menu: OwnerLineUnlinkResult['menu'],
  menuUnlinkPending = menu === 'failed',
): ApiResult<OwnerLineUnlinkResult> {
  return { ok: true, value: { owner: { id: OWNER_ID, lineLink: 'unlinked', menuUnlinkPending }, menu } };
}

function failure(code: string, message = 'サーバーのエラー'): ApiResult<OwnerLineUnlinkResult> {
  return { ok: false, code, message };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function renderControl(target: OwnerListItem, onChanged = vi.fn().mockResolvedValue(undefined)) {
  const view = render(<OwnerLineUnlinkControl owner={target} onChanged={onChanged} />);
  return { ...view, onChanged };
}

function unlinkButton(): HTMLElement {
  return screen.getByRole('button', { name: `${OWNER_NAME} の LINE の連携を解除` });
}

function retryButton(): HTMLElement {
  return screen.getByRole('button', { name: `${OWNER_NAME} のメニューを外し直す` });
}

async function openConfirm(): Promise<HTMLElement> {
  fireEvent.click(unlinkButton());
  return await screen.findByRole('alertdialog');
}

function statusText(): string {
  return screen
    .getAllByRole('status')
    .map((node) => node.textContent ?? '')
    .join('');
}

beforeEach(() => {
  unlinkMock.mockReset();
});

afterEach(cleanup);

describe('OwnerLineUnlinkControl — 状態に応じた操作（2.2, 2.3, 3.3）', () => {
  it('連携中は解除の操作を出し、外し直しの操作を出さない', () => {
    renderControl(LINKED);
    // 見えている文言を読み上げ名へ含める（WCAG 2.5.3 Label in Name）。
    expect(unlinkButton().textContent).toContain('LINE の連携を解除');
    expect(screen.queryByRole('button', { name: /外し直す/ })).toBeNull();
  });

  it('メニュー未解除の解除済みは外し直しの操作を出し、解除の操作を出さない', () => {
    renderControl(PENDING);
    expect(retryButton().textContent).toContain('メニューを外し直す');
    expect(screen.queryByRole('button', { name: /連携を解除/ })).toBeNull();
  });

  it('メニューも外し終えた解除済みには操作を出さない', () => {
    renderControl(UNLINKED);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('OwnerLineUnlinkControl — 解除の確認（1.4）', () => {
  it('解除を押すと確認ダイアログが開いて 3 点を示し、まだ要求を送らない', async () => {
    renderControl(LINKED);
    const dialog = await openConfirm();

    expect(dialog.textContent).toContain(OWNER_NAME);
    const points = within(dialog).getAllByRole('listitem').map((item) => item.textContent ?? '');
    expect(points).toHaveLength(3);
    // 1 点目: 元の LINE に通知が届かず、店舗も見られなくなる。
    expect(points[0]).toContain('日次の変化通知が届かなくなり');
    expect(points[0]).toContain('店舗の情報も見られなくなります');
    // 2 点目: 店舗と履歴は残る。
    expect(points[1]).toContain('店舗とその履歴は消えずに残ります');
    // 3 点目: 同じ店舗を LINE で確定し直すと引き継げる。
    expect(points[2]).toContain('同じ店舗を LINE で確定し直すと');
    expect(points[2]).toContain('引き継げます');
    // 3 点はダイアログの説明として支援技術へ結び付ける。
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const description = document.getElementById(describedBy!);
    expect(description?.textContent).toContain('店舗とその履歴は消えずに残ります');
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it('開いた直後の焦点はキャンセルにある（Enter の一押しで解除しない）', async () => {
    renderControl(LINKED);
    const dialog = await openConfirm();
    const cancel = within(dialog).getByRole('button', { name: 'キャンセル' });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
  });

  it('キャンセルでは要求を送らず、読み直しも呼ばず、焦点を解除の押しボタンへ戻す', async () => {
    const { onChanged } = renderControl(LINKED);
    const trigger = unlinkButton();
    const dialog = await openConfirm();

    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(unlinkMock).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('「解除する」で確定したときだけ要求を 1 回送り、読み直しを呼んで成功を告げる', async () => {
    unlinkMock.mockResolvedValue(ok('removed'));
    const { onChanged } = renderControl(LINKED);
    const dialog = await openConfirm();

    fireEvent.click(within(dialog).getByRole('button', { name: '解除する' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(unlinkMock).toHaveBeenCalledTimes(1);
    expect(unlinkMock).toHaveBeenCalledWith({ id: OWNER_ID });
    await waitFor(() => expect(statusText()).toBe(`${OWNER_NAME} の LINE の連携を解除しました。`));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('成功の文言には読み上げない成功の印が添えられ、結果の前の空の領域には印を置かない', async () => {
    unlinkMock.mockResolvedValue(ok('removed'));
    renderControl(LINKED);
    const region = () => screen.getAllByRole('status').find((node) => node.tagName === 'P')!;
    expect(region().querySelector('[data-slot="success-icon"]')).toBeNull();
    // 空の領域は余白を持たない（:empty が効く）ことの前提。印だけが残ると行の高さが変わる。
    expect(region().childNodes).toHaveLength(0);

    fireEvent.click(within(await openConfirm()).getByRole('button', { name: '解除する' }));

    await waitFor(() => expect(region().textContent).toBe(`${OWNER_NAME} の LINE の連携を解除しました。`));
    const icon = region().querySelector('[data-slot="success-icon"]');
    expect(icon, '成功の文言に印が添えられていません').not.toBeNull();
    expect(icon!.tagName.toLowerCase()).toBe('svg');
    expect(icon!.getAttribute('aria-hidden')).toBe('true');
    // 印は文言の前に置く（文言だけが先に目に入ると、色でしか成功を区別できない）。
    expect(region().firstElementChild).toBe(icon);
  });

  it('外すメニューが無かったとき（not_needed）も解除の成功として告げる', async () => {
    unlinkMock.mockResolvedValue(ok('not_needed'));
    renderControl(LINKED);
    fireEvent.click(within(await openConfirm()).getByRole('button', { name: '解除する' }));

    await waitFor(() => expect(statusText()).toBe(`${OWNER_NAME} の LINE の連携を解除しました。`));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ライブリージョンは結果の前から置かれ、空である', () => {
    renderControl(LINKED);
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    expect(statusText()).toBe('');
  });
});

describe('OwnerLineUnlinkControl — メニューを外せなかったとき（3.2）', () => {
  it('解除は完了したがメニューを外せなかったことと、外し直しの導線を示す', async () => {
    unlinkMock.mockResolvedValue(ok('failed'));
    const { onChanged } = renderControl(LINKED);
    fireEvent.click(within(await openConfirm()).getByRole('button', { name: '解除する' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      '連携は解除しました。LINE のメニューは外せませんでした。「メニューを外し直す」から再試行してください。',
    );
    expect(onChanged).toHaveBeenCalledTimes(1);
    // 解除の成功だけを告げる文言は出さない（メニューの失敗を見落とさせない）。
    expect(statusText()).not.toContain('解除しました');
  });
});

describe('OwnerLineUnlinkControl — 外し直し（3.3, 3.4）', () => {
  it('外し直しは確認ダイアログを出さずに要求を 1 回送り、外せたことを告げる', async () => {
    unlinkMock.mockResolvedValue(ok('removed', false));
    const { onChanged } = renderControl(PENDING);

    fireEvent.click(retryButton());

    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(unlinkMock).toHaveBeenCalledTimes(1);
    expect(unlinkMock).toHaveBeenCalledWith({ id: OWNER_ID });
    await waitFor(() => expect(statusText()).toBe(`${OWNER_NAME} の LINE のメニューを外しました。`));
  });

  it('外し直しでも外せなかったときは、再試行を促す alert を示す', async () => {
    unlinkMock.mockResolvedValue(ok('failed'));
    renderControl(PENDING);

    fireEvent.click(retryButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'LINE のメニューを外せませんでした。時間をおいて「メニューを外し直す」から再試行してください。',
    );
    expect(statusText()).toBe('');
  });
});

describe('OwnerLineUnlinkControl — 要求の失敗（1.7）', () => {
  it('解除の失敗（500）は解除できなかった旨を alert で示し、読み直しを呼び、成功を告げない', async () => {
    unlinkMock.mockResolvedValue(failure('internal_error'));
    const { onChanged } = renderControl(LINKED);
    fireEvent.click(within(await openConfirm()).getByRole('button', { name: '解除する' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'LINE の連携を解除できませんでした。時間をおいてもう一度お試しください。',
    );
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(statusText()).toBe('');
    // 操作は解除のまま残り、もう一度押せる。
    expect(unlinkButton().getAttribute('aria-disabled')).not.toBe('true');
  });

  it('通信できなかったときは、成否を言い切らずに一覧を確かめるよう促す', async () => {
    unlinkMock.mockResolvedValue(failure('network', 'ネットワークエラー'));
    renderControl(LINKED);
    fireEvent.click(within(await openConfirm()).getByRole('button', { name: '解除する' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      '解除できたか確認できませんでした。一覧の表示を確認してください。',
    );
    expect(statusText()).toBe('');
  });

  it('見つからない（404）はオーナーが見つからない旨を示す', async () => {
    unlinkMock.mockResolvedValue(failure('not_found', 'not found'));
    renderControl(LINKED);
    fireEvent.click(within(await openConfirm()).getByRole('button', { name: '解除する' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('オーナーが見つかりません。一覧を更新しました。');
  });

  it('権限の失敗は固定の文言へ写し、サーバーの文言を出さない', async () => {
    unlinkMock.mockResolvedValue(failure('forbidden', 'サーバー内部の文言'));
    renderControl(LINKED);
    fireEvent.click(within(await openConfirm()).getByRole('button', { name: '解除する' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('このオーナーを変更する権限がありません。');
    expect(alert.textContent).not.toContain('サーバー内部の文言');
  });

  it('外し直しの失敗（500）は外し直せなかった旨を示す', async () => {
    unlinkMock.mockResolvedValue(failure('internal_error'));
    renderControl(PENDING);
    fireEvent.click(retryButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'LINE のメニューを外し直せませんでした。時間をおいてもう一度お試しください。',
    );
  });

  it('失敗の後に成功すると、前の失敗の文言を残さない', async () => {
    unlinkMock.mockResolvedValueOnce(failure('internal_error')).mockResolvedValueOnce(ok('removed', false));
    renderControl(PENDING);

    fireEvent.click(retryButton());
    await screen.findByRole('alert');

    fireEvent.click(retryButton());
    await waitFor(() => expect(statusText()).toContain('メニューを外しました'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('OwnerLineUnlinkControl — 二重送信と焦点', () => {
  it('外し直しの実行中にもう一度押しても要求は 1 回だけで、押しボタンは無効を示す', async () => {
    const pending = deferred<ApiResult<OwnerLineUnlinkResult>>();
    unlinkMock.mockReturnValue(pending.promise);
    const { onChanged } = renderControl(PENDING);

    fireEvent.click(retryButton());
    await waitFor(() => expect(retryButton().getAttribute('aria-disabled')).toBe('true'));
    fireEvent.click(retryButton());
    fireEvent.click(retryButton());

    expect(unlinkMock).toHaveBeenCalledTimes(1);

    pending.resolve(ok('removed', false));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(retryButton().getAttribute('aria-disabled')).not.toBe('true'));
  });

  it('解除の実行中は確認ダイアログを開き直せず、要求は 1 回だけ', async () => {
    const pending = deferred<ApiResult<OwnerLineUnlinkResult>>();
    unlinkMock.mockReturnValue(pending.promise);
    const { onChanged } = renderControl(LINKED);

    fireEvent.click(within(await openConfirm()).getByRole('button', { name: '解除する' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(unlinkButton().getAttribute('aria-disabled')).toBe('true'));

    fireEvent.click(unlinkButton());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(unlinkMock).toHaveBeenCalledTimes(1);

    pending.resolve(ok('removed'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('読み直しが失敗しても落ちず、要求の結果を告げる', async () => {
    unlinkMock.mockResolvedValue(ok('removed', false));
    const onChanged = vi.fn().mockRejectedValue(new Error('reload failed'));
    renderControl(PENDING, onChanged);

    fireEvent.click(retryButton());

    await waitFor(() => expect(statusText()).toContain('メニューを外しました'));
    expect(retryButton().getAttribute('aria-disabled')).not.toBe('true');
  });

  // 解除に成功して読み直すと、操作の押しボタンは消える（解除済みには操作を出さない・2.3）。
  // 押した要素が消えると焦点は文書の先頭へ落ちるので、結果の文言へ移す。
  it('解除の後に操作が消えたら、焦点を結果の文言へ移す', async () => {
    unlinkMock.mockResolvedValue(ok('removed'));

    function Harness() {
      const [current, setCurrent] = useState<OwnerListItem>(LINKED);
      return (
        <OwnerLineUnlinkControl
          owner={current}
          onChanged={async () => {
            setCurrent(UNLINKED);
          }}
        />
      );
    }
    render(<Harness />);

    fireEvent.click(within(await openConfirm()).getByRole('button', { name: '解除する' }));

    await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
    const message = await screen.findByText(`${OWNER_NAME} の LINE の連携を解除しました。`);
    await waitFor(() => expect(document.activeElement).toBe(message.closest('[role="status"]')));
  });

  it('メニューの失敗で操作が外し直しへ変わるときは、同じ押しボタンに焦点を留める', async () => {
    unlinkMock.mockResolvedValue(ok('failed'));

    function Harness() {
      const [current, setCurrent] = useState<OwnerListItem>(LINKED);
      return (
        <OwnerLineUnlinkControl
          owner={current}
          onChanged={async () => {
            setCurrent(PENDING);
          }}
        />
      );
    }
    render(<Harness />);
    const trigger = unlinkButton();

    fireEvent.click(within(await openConfirm()).getByRole('button', { name: '解除する' }));

    await screen.findByRole('alert');
    expect(retryButton()).toBe(trigger);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
