// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '../src/components/dialog';

if (!('PointerEvent' in window)) {
  class PointerEventPolyfill extends MouseEvent {}
  Object.defineProperty(window, 'PointerEvent', {
    value: PointerEventPolyfill,
    configurable: true,
    writable: true,
  });
}

afterEach(cleanup);

function renderDialog() {
  return render(
    <>
      <button type="button">背景の操作</button>
      <Dialog>
        <DialogTrigger>QR を発行</DialogTrigger>
        <DialogContent>
          <DialogTitle>店舗の QR</DialogTitle>
          <DialogDescription>QR とアンケート URL を確認できます。</DialogDescription>
          <DialogClose>閉じる</DialogClose>
        </DialogContent>
      </Dialog>
    </>,
  );
}

describe('Dialog', () => {
  it('dialog として名前・説明を公開し、閉じた後に Trigger へ焦点を戻す', async () => {
    const user = userEvent.setup();
    renderDialog();

    const trigger = screen.getByRole('button', { name: 'QR を発行' });
    await user.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: '店舗の QR' });
    expect(dialog.getAttribute('aria-describedby')).not.toBeNull();
    expect(screen.queryByRole('button', { name: '背景の操作' })).toBeNull();
    expect(screen.getByRole('button', { name: '背景の操作', hidden: true })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '閉じる' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('Escape で閉じる', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'QR を発行' }));
    await screen.findByRole('dialog', { name: '店舗の QR' });

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('backdrop を押すと閉じる', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'QR を発行' }));
    await screen.findByRole('dialog', { name: '店舗の QR' });

    const backdrop = document.querySelector<HTMLElement>('[data-slot="dialog-backdrop"]');
    expect(backdrop).not.toBeNull();
    await user.click(backdrop!);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Drawer は reduced motion と印刷時の掲示面表示に対応する class を持つ', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'QR を発行' }));

    const dialog = await screen.findByRole('dialog', { name: '店舗の QR' });
    expect(dialog.className).toContain('data-starting-style:translate-x-full');
    expect(dialog.className).toContain('data-ending-style:translate-x-full');
    expect(dialog.className).toContain('transition-transform');
    expect(dialog.className).toContain('print:translate-x-0');
    expect(dialog.className).toContain('print:static');
  });
});
