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
    expect(toaster?.style.getPropertyValue('--error-text')).toBe('var(--destructive)');
  });
});
