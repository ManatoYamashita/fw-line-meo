// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SurveySettingsEditor, type SettingsMutation } from '../app/store/survey-settings/survey-settings-editor';
import type { SurveySettingsResponse } from '../lib/survey-settings-contract';
import { installPointerEventPolyfill } from './pointer-event';

const notices = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@fwlm/ui/components/app-toaster', () => ({ toast: notices }));
const data: SurveySettingsResponse = {
  storeId: 'store', storeName: '店', stores: [], structuredEnabled: true, revision: 1,
  categories: [
    { code: 'food', label: '料理', allowsTargets: true, enabled: true, toggleable: false, ownerTargets: true, targetLimit: 10 },
    { code: 'reservation_visit', label: '予約・来店', allowsTargets: false, enabled: true, toggleable: true, ownerTargets: false, targetLimit: null },
  ],
  targets: [
    { id: 'one', categoryCode: 'food', label: '刺身', active: true, sortOrder: 0 },
    { id: 'two', categoryCode: 'food', label: '焼き鳥', active: true, sortOrder: 1 },
    { id: 'hidden', categoryCode: 'food', label: 'もつ煮', active: false, sortOrder: 2 },
  ],
};
beforeEach(() => { installPointerEventPolyfill(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const add = () => {
  fireEvent.change(screen.getByLabelText('料理名を追加'), { target: { value: '餃子' } });
  fireEvent.click(screen.getByRole('button', { name: '追加する' }));
};
const actions = [
  ['追加', add, '追加中…'],
  ['名前の保存', () => {
    fireEvent.click(screen.getByRole('button', { name: '編集：「刺身」の名前を変更する' }));
    fireEvent.change(screen.getByLabelText('料理名を変更'), { target: { value: '刺身盛り' } });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
  }, '保存中…'],
  ['上へ', () => fireEvent.click(screen.getByRole('button', { name: '「焼き鳥」を上へ移動する' })), '移動中…'],
  ['下へ', () => fireEvent.click(screen.getByRole('button', { name: '「刺身」を下へ移動する' })), '移動中…'],
  ['非表示', () => fireEvent.click(screen.getByRole('button', { name: '「刺身」を非表示にする' })), '非表示にしています…'],
  ['再表示', () => fireEvent.click(screen.getByRole('button', { name: '「もつ煮」を再表示する' })), '再表示中…'],
  ['カテゴリ表示', () => fireEvent.click(screen.getByRole('radio', { name: '表示しない' })), '保存中…'],
] as const;

describe('設定操作のフィードバック（#450）', () => {
  it.each(actions)('%s: 遅延中の表示と成功・失敗の通知', async (_name, start, label) => {
    let finish!: (value: Awaited<ReturnType<SettingsMutation>>) => void;
    const mutate = vi.fn(() => new Promise<Awaited<ReturnType<SettingsMutation>>>((resolve) => { finish = resolve; }));
    render(<SurveySettingsEditor data={data} mutate={mutate} />);
    start();
    expect(screen.getByRole('status').textContent).toBe(label);
    expect(document.querySelector('[data-slot="spinner"]')).not.toBeNull();
    const busyButton = document.querySelector<HTMLButtonElement>('button[aria-busy="true"]');
    if (busyButton) { expect(busyButton.disabled).toBe(true); fireEvent.click(busyButton); }
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(notices.success).not.toHaveBeenCalled();
    await act(async () => { finish({ ok: true }); });
    expect(notices.success).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toBe('');
    expect(notices.error).not.toHaveBeenCalled();
    start();
    await act(async () => { finish({ ok: false, message: '時間をおいて再度お試しください。' }); });
    expect(notices.error).toHaveBeenCalledExactlyOnceWith('時間をおいて再度お試しください。');
    expect(screen.getByRole('status').textContent).toBe('');
    expect(document.querySelector('[data-slot="spinner"]')).toBeNull();
  });

  it.each(['returned error', 'exception'])('%s: 入力を保持して再試行できる', async (kind) => {
    const mutate = vi.fn<SettingsMutation>();
    if (kind === 'exception') mutate.mockRejectedValueOnce(new Error('internal database message'));
    else mutate.mockResolvedValueOnce({ ok: false, message: '追加できませんでした。もう一度お試しください。' });
    mutate.mockResolvedValueOnce({ ok: true });
    render(<SurveySettingsEditor data={data} mutate={mutate} />);
    add();
    await act(async () => {});
    expect(notices.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(notices.error.mock.calls)).not.toContain('internal database message');
    expect((screen.getByLabelText('料理名を追加') as HTMLInputElement).value).toBe('餃子');
    fireEvent.click(screen.getByRole('button', { name: '追加する' }));
    await act(async () => {});
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(notices.success).toHaveBeenCalledTimes(1);
  });

  it('入力エラーは送信せず、Toastと入力欄に示す', () => {
    const mutate = vi.fn();
    render(<SurveySettingsEditor data={data} mutate={mutate} />);
    fireEvent.click(screen.getByRole('button', { name: '追加する' }));
    expect(mutate).not.toHaveBeenCalled();
    expect(notices.error).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('料理名を追加').getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('長時間の保存を案内し、Enterの連打でも重複送信しない', async () => {
    vi.useFakeTimers();
    let finish!: (value: Awaited<ReturnType<SettingsMutation>>) => void;
    const mutate = vi.fn(() => new Promise<Awaited<ReturnType<SettingsMutation>>>((resolve) => { finish = resolve; }));
    render(<SurveySettingsEditor data={data} mutate={mutate} />);
    add();
    fireEvent.submit(screen.getByLabelText('料理名を追加').closest('form')!);
    await act(async () => { vi.advanceTimersByTime(8000); });
    expect(screen.getByRole('status').textContent).toContain('このままお待ちください');
    expect(mutate).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ ok: true }); });
  });
});
