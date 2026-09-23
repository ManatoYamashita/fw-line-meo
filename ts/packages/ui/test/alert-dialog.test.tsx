// @vitest-environment jsdom
//
// 確認ダイアログの共通部品（store-suspension tasks 5.1 / Requirements 1.6 / design.md「AlertDialog（`@fwlm/ui`）」）。
//
// 本テストが守る契約:
//  1. 開くまでは何も描かず、起点を押すと alertdialog の役割で題名と説明を名前・説明として公開する
//  2. 焦点はダイアログの中へ移り、Tab / Shift+Tab で外へ出ない（閉じ込め）
//  3. キャンセル・Esc では確定の処理を呼ばずに閉じ、確定では 1 回だけ呼んで閉じる
//  4. どの閉じ方でも焦点が起点のボタンへ戻る
//  5. 背景の押下では閉じない（応答を求めるダイアログは、外を押しただけで答えたことにしない）
//  6. 直書きの色も、フォーカス指標の打ち消しも持たない
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../src/components/alert-dialog';

// jsdom 25 は PointerEvent を実装していない（components.test.tsx と同じ理由の最小互換）。
if (!('PointerEvent' in window)) {
  class PointerEventPolyfill extends MouseEvent {}
  Object.defineProperty(window, 'PointerEvent', {
    value: PointerEventPolyfill,
    configurable: true,
    writable: true,
  });
}

afterEach(cleanup);

const RAW_HEX = /#[0-9a-fA-F]{3,8}/;
const RAW_PALETTE_COLOR =
  /\b(?:bg|text|border|ring|outline|fill|stroke)-(?:black|white|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?\b/;

function renderDialog(onConfirm: () => void = vi.fn()): ReactElement {
  return (
    <>
      <button type="button">ダイアログの外の操作</button>
      <AlertDialog>
        <AlertDialogTrigger variant="destructive">停止</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>この店舗を停止しますか</AlertDialogTitle>
            <AlertDialogDescription>
              停止すると日次の取得と変化通知が止まります。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onConfirm}>
              停止する
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

async function openDialog() {
  const user = userEvent.setup();
  const trigger = screen.getByRole('button', { name: '停止' });
  await user.click(trigger);
  const dialog = await screen.findByRole('alertdialog');
  return { user, trigger, dialog };
}

describe('AlertDialog — 開閉と名前の公開（Requirements 1.6）', () => {
  it('開くまではダイアログを描かない', () => {
    render(renderDialog());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('起点を押すと alertdialog として開き、題名と説明を名前・説明として公開する', async () => {
    render(renderDialog());
    const { dialog } = await openDialog();

    // 背景の内容は支援技術から隠れる（モーダルであることの実体。Base UI は aria-modal ではなく
    // 外側の要素へ aria-hidden を付けてこれを実現する）。
    const outside = screen.getByRole('button', { name: 'ダイアログの外の操作', hidden: true });
    expect(outside.closest('[aria-hidden="true"]'), '背景の内容が支援技術から隠れていません').not.toBeNull();
    expect(screen.queryByRole('button', { name: 'ダイアログの外の操作' })).toBeNull();
    const labelledBy = dialog.getAttribute('aria-labelledby');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(labelledBy).toBeTruthy();
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe('この店舗を停止しますか');
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      '停止すると日次の取得と変化通知が止まります。',
    );
  });
});

describe('AlertDialog — 焦点の閉じ込め', () => {
  it('開くと焦点がダイアログの中へ移り、最初の操作はキャンセルである', async () => {
    render(renderDialog());
    const { dialog } = await openDialog();

    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    // 取り消せない操作の確認では、Enter の一押しで確定しないよう既定の焦点を安全側に置く。
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'キャンセル' }));
  });

  it('Tab と Shift+Tab を繰り返しても焦点がダイアログの外へ出ない', async () => {
    render(renderDialog());
    const { user, dialog } = await openDialog();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    // 閉じ込めは、ダイアログの前後に置いた番兵（focus guard）へ焦点が入ったときに反対端の操作へ
    // 焦点を送り直す仕組みで、送り直しは次の描画の機会まで遅れる。人が次の Tab を押すより十分に
    // 早いが、テストの連続した Tab はその間に割り込めてしまうので、番兵から出るまで待ってから
    // 次の Tab を押す。
    const settle = () =>
      waitFor(() =>
        expect(document.activeElement?.hasAttribute('data-base-ui-focus-guard')).toBe(false),
      );
    const visited: Element[] = [];
    for (let i = 0; i < 4; i += 1) {
      await user.tab();
      await settle();
      visited.push(document.activeElement!);
    }
    for (let i = 0; i < 4; i += 1) {
      await user.tab({ shift: true });
      await settle();
      visited.push(document.activeElement!);
    }

    const outside = screen.getByRole('button', { name: 'ダイアログの外の操作', hidden: true });
    const trigger = screen.getByRole('button', { name: '停止', hidden: true });
    expect(visited).not.toContain(outside);
    expect(visited).not.toContain(trigger);
    // 閉じ込めが空振りしていないこと（2 つのボタンの間を実際に行き来したこと）も確かめる。
    expect(visited).toContain(screen.getByRole('button', { name: '停止する' }));
    expect(visited).toContain(screen.getByRole('button', { name: 'キャンセル' }));
  });
});

describe('AlertDialog — 確定・キャンセルと焦点の戻り（Requirements 1.6）', () => {
  it('キャンセルでは確定の処理を呼ばずに閉じ、焦点が起点へ戻る', async () => {
    const onConfirm = vi.fn();
    render(renderDialog(onConfirm));
    const { user, trigger } = await openDialog();

    await user.click(screen.getByRole('button', { name: 'キャンセル' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('Esc では確定の処理を呼ばずに閉じ、焦点が起点へ戻る', async () => {
    const onConfirm = vi.fn();
    render(renderDialog(onConfirm));
    const { user, trigger, dialog } = await openDialog();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('確定では処理を 1 回だけ呼んで閉じ、焦点が起点へ戻る', async () => {
    const onConfirm = vi.fn();
    render(renderDialog(onConfirm));
    const { user, trigger } = await openDialog();

    await user.click(screen.getByRole('button', { name: '停止する' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('背景を押しても閉じない（外を押しただけで答えたことにしない）', async () => {
    const onConfirm = vi.fn();
    render(renderDialog(onConfirm));
    const { user } = await openDialog();

    const backdrop = document.querySelector('[data-slot="alert-dialog-backdrop"]');
    expect(backdrop, '背景の要素を描いていません').not.toBeNull();
    await user.click(backdrop!);

    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('AlertDialog — design tokens とフォーカス指標', () => {
  it('開いた状態のどの要素も直書きの色とフォーカス指標の打ち消しを持たない', async () => {
    render(renderDialog());
    await openDialog();

    const classes = [...document.body.querySelectorAll('*')]
      .map((node) => node.getAttribute('class') ?? '')
      .join(' ');
    // 部品の面そのものがクラスを持っていること（空振りで緑にならないこと）を先に確かめる。
    expect(document.querySelector('[data-slot="alert-dialog-content"]')?.getAttribute('class')).toMatch(
      /\bbg-/,
    );
    expect(classes).not.toMatch(RAW_HEX);
    expect(classes).not.toMatch(RAW_PALETTE_COLOR);
    expect(classes).not.toMatch(/\boutline-none\b/);
    expect(classes).not.toMatch(/focus-visible:(?:ring|border|outline)-/);
  });

  it('確定とキャンセルは押しボタンの寸法区分を持つ（操作領域の拡張を引き継ぐ）', async () => {
    render(renderDialog());
    await openDialog();

    for (const name of ['キャンセル', '停止する']) {
      const button = screen.getByRole('button', { name });
      expect(button.getAttribute('data-size'), `${name} に寸法区分がありません`).toBe('default');
      expect(button.getAttribute('class')).toContain('after:-inset-2');
    }
  });
});
