// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { DraftPanel } from '../src/app/s/[storeId]/draft-panel';
import type { DraftPanelProps } from '../src/app/s/[storeId]/types';

const URL = 'https://search.google.com/local/writereview?placeid=ChIJ';

function props(over: Partial<DraftPanelProps> = {}): DraftPanelProps {
  return {
    draft: '良いお店でした。',
    generationFailed: false,
    regenerationsLeft: 3,
    googleReviewUrl: URL,
    onRegenerate: vi.fn(),
    regenerating: false,
    ...over,
  };
}

function stubClipboard(writeText: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('navigator', { clipboard: { writeText } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  stubClipboard(vi.fn().mockResolvedValue(undefined));
});

describe('DraftPanel', () => {
  it('下書きを編集可能な textarea に表示する（3.7）', () => {
    render(<DraftPanel {...props()} />);
    const ta = screen.getByLabelText('口コミ下書き') as HTMLTextAreaElement;
    expect(ta.value).toBe('良いお店でした。');
  });

  it('編集後、コピーは編集済みテキストを writeText に渡す（4.2）', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(<DraftPanel {...props()} />);
    fireEvent.change(screen.getByLabelText('口コミ下書き'), { target: { value: '編集後の文章' } });
    fireEvent.click(screen.getByRole('button', { name: /コピー/ }));
    expect(writeText).toHaveBeenCalledWith('編集後の文章');
    expect(await screen.findByText(/コピーしました/)).toBeDefined();
  });

  it('clipboard 未提供時も手動コピーのフォールバックを表示する（4.6）', () => {
    vi.stubGlobal('navigator', {});
    render(<DraftPanel {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /コピー/ }));
    expect(screen.getByText(/手動でコピー/)).toBeDefined();
  });

  it('writeText 失敗時は手動コピーのフォールバックを表示する（4.6）', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    stubClipboard(writeText);
    render(<DraftPanel {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /コピー/ }));
    expect(await screen.findByText(/手動でコピー/)).toBeDefined();
  });

  it('再生成ボタンで onRegenerate を呼ぶ／残 0 で無効', () => {
    const onRegenerate = vi.fn();
    const { rerender } = render(<DraftPanel {...props({ onRegenerate })} />);
    fireEvent.click(screen.getByRole('button', { name: /別の文章を生成/ }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
    rerender(<DraftPanel {...props({ onRegenerate, regenerationsLeft: 0 })} />);
    expect((screen.getByRole('button', { name: /別の文章を生成/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('生成中は「生成中…」を表示し再生成を無効化（3.6）', () => {
    render(<DraftPanel {...props({ regenerating: true })} />);
    expect(screen.getByText('生成中…')).toBeDefined();
    expect((screen.getByRole('button', { name: /別の文章を生成/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('生成失敗時は失敗メッセージ＋再試行＋投稿導線を表示する（3.9）', () => {
    render(<DraftPanel {...props({ generationFailed: true })} />);
    expect(screen.getByRole('alert').textContent).toContain('失敗');
    expect(screen.getByRole('button', { name: /もう一度生成/ })).toBeDefined();
    expect(screen.getByRole('link', { name: /クチコミを書く/ }).getAttribute('href')).toBe(URL);
  });

  it('投稿導線は全状態で表示され star 分岐が無い（4.4・ゲーティング不在）', () => {
    const { rerender } = render(<DraftPanel {...props()} />);
    expect(screen.getByRole('link', { name: /クチコミを書く/ }).getAttribute('href')).toBe(URL);
    rerender(<DraftPanel {...props({ generationFailed: true })} />);
    expect(screen.getByRole('link', { name: /クチコミを書く/ }).getAttribute('href')).toBe(URL);
  });

  it('draft prop 変更（再生成到着）で textarea が更新される', () => {
    const { rerender } = render(<DraftPanel {...props({ draft: '最初' })} />);
    expect((screen.getByLabelText('口コミ下書き') as HTMLTextAreaElement).value).toBe('最初');
    rerender(<DraftPanel {...props({ draft: '再生成後' })} />);
    expect((screen.getByLabelText('口コミ下書き') as HTMLTextAreaElement).value).toBe('再生成後');
  });
});
