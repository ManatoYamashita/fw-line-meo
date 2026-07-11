// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SurveyForm } from '../src/app/s/[storeId]/survey-form';

const ASPECTS = [
  { code: 'taste', label: '味' },
  { code: 'service', label: '接客' },
];

afterEach(cleanup);

function setup(submitting = false) {
  const onSubmit = vi.fn();
  render(<SurveyForm aspects={ASPECTS} onSubmit={onSubmit} submitting={submitting} />);
  return { onSubmit };
}

describe('SurveyForm', () => {
  it('星のみで送信できる（aspectCodes 空）', () => {
    const { onSubmit } = setup();
    fireEvent.click(screen.getByRole('button', { name: '星5' }));
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    expect(onSubmit).toHaveBeenCalledWith({ star: 5, aspectCodes: [] });
  });

  it('星なしでは送信できず必須エラーを表示する', () => {
    const { onSubmit } = setup();
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('満足度');
  });

  it('星＋良かった点＋一言を送信する', () => {
    const { onSubmit } = setup();
    fireEvent.click(screen.getByRole('button', { name: '星4' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '味' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'おいしい' } });
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    expect(onSubmit).toHaveBeenCalledWith({ star: 4, aspectCodes: ['taste'], comment: 'おいしい' });
  });

  it('良かった点は選択・解除できる', () => {
    const { onSubmit } = setup();
    fireEvent.click(screen.getByRole('button', { name: '星3' }));
    const taste = screen.getByRole('checkbox', { name: '味' });
    fireEvent.click(taste); // 選択
    fireEvent.click(taste); // 解除
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    expect(onSubmit).toHaveBeenCalledWith({ star: 3, aspectCodes: [] });
  });

  it('一言は 200 字上限（maxLength 属性）', () => {
    setup();
    const textarea = screen.getByRole('textbox');
    expect(textarea.getAttribute('maxLength')).toBe('200');
  });

  it('送信中は送信ボタンが無効', () => {
    setup(true);
    expect((screen.getByRole('button', { name: '送信する' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('空白のみの一言は comment を含めない', () => {
    const { onSubmit } = setup();
    fireEvent.click(screen.getByRole('button', { name: '星5' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    expect(onSubmit).toHaveBeenCalledWith({ star: 5, aspectCodes: [] });
  });
});
