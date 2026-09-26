// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { toast } from 'sonner';

import { AppToaster } from '../src/components/app-toaster';
import {
  notifyActionError,
  notifyActionInfo,
  notifyActionSuccess,
} from '../src/lib/action-feedback';

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(() => {
  toast.dismiss();
  cleanup();
});

describe('AppToaster / action feedback', () => {
  it('成功・失敗・案内を共通 Toaster に積み、利用者が閉じられる', async () => {
    render(<AppToaster />);

    act(() => {
      notifyActionSuccess({ title: '保存しました。' });
      notifyActionError({
        title: '保存できませんでした',
        description: '通信状況を確認して、もう一度お試しください。',
      });
      notifyActionInfo({ title: '変更はありません。' });
    });

    expect(await screen.findByText('保存しました。')).toBeTruthy();
    expect(await screen.findByText('保存できませんでした')).toBeTruthy();
    expect(screen.getByText('通信状況を確認して、もう一度お試しください。')).toBeTruthy();
    expect(screen.getByText('変更はありません。')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '通知を閉じる' })).toHaveLength(3);
    const notificationRegion = screen.getByLabelText(/操作結果の通知/);
    const toaster = notificationRegion.querySelector<HTMLElement>('[data-sonner-toaster]');
    expect(toaster?.classList.contains('app-toaster')).toBe(true);
    // 右側に出す（design-language 7.5。上下は画面の幅で決まり、test/app-toaster.test.tsx が固定する）。
    expect(toaster?.getAttribute('data-x-position')).toBe('right');
    // 面は白・枠は中立の罫線・文字は本文色で、状態を問わず同じ。状態は右上のにじみと
    // アイコンの意味色（globals.css）と文言で示す。文字を意味色で塗らないのは、にじみの上に
    // 文字が重なっても対比が変わらないようにするため。
    for (const type of ['success', 'info', 'warning', 'error'] as const) {
      expect(toaster?.style.getPropertyValue(`--${type}-bg`), type).toBe('var(--card)');
      expect(toaster?.style.getPropertyValue(`--${type}-border`), type).toBe('var(--border)');
      expect(toaster?.style.getPropertyValue(`--${type}-text`), type).toBe('var(--foreground)');
    }
  });
});
