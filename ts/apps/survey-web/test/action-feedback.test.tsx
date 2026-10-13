// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SurveyShell } from '../src/app/s/[storeId]/survey-shell';
import { DraftPanel } from '../src/app/s/[storeId]/draft-panel';

const notices = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@fwlm/ui/components/app-toaster', () => ({ toast: notices }));
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const response = (generation = 'ok') => new Response(JSON.stringify({ generation, draft: generation === 'ok' ? '下書きの文章' : null, sessionToken: 'token', regenerationsLeft: 3 }));
const renderShell = () => render(<SurveyShell storeId="store" storeName="店" survey={{ mode: 'legacy', aspects: [] }} pageToken="page" googleReviewUrl="https://example.com/review" />);
const submit = () => {
  fireEvent.click(screen.getByRole('button', { name: '星3' }));
  fireEvent.click(screen.getByRole('button', { name: '送信する' }));
};
const renderPanel = () => render(<DraftPanel draft="編集中の文章" generationFailed={false} regenerationsLeft={3} googleReviewUrl="https://example.com/review" onRegenerate={() => {}} onReviewLinkOpen={() => {}} regenerating={false} />);

describe('回答・再生成の通知（#450）', () => {
  it.each(['ok', 'failed', 'HTTP error', 'network error'])('%s: 待機中と結果を正しく通知する', async (kind) => {
    let resolve!: (r: Response) => void;
    let reject!: (e: Error) => void;
    const fetch = vi.fn(() => new Promise<Response>((yes, no) => { resolve = yes; reject = no; }));
    vi.stubGlobal('fetch', fetch);
    renderShell();
    submit();
    expect(screen.getByRole('button', { name: '口コミ文を作成しています…' }).getAttribute('aria-busy')).toBe('true');
    fireEvent.submit(document.querySelector('form')!);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(notices.success).not.toHaveBeenCalled();
    await act(async () => {
      if (kind === 'network error') reject(new Error('internal message'));
      else resolve(kind === 'HTTP error' ? new Response(JSON.stringify({ error: { message: '時間をおいて再度お試しください。' } }), { status: 429 }) : response(kind));
    });
    if (kind === 'ok') expect(notices.success).toHaveBeenCalledExactlyOnceWith('口コミ文を作成しました。');
    else {
      expect(notices.error).toHaveBeenCalledTimes(1);
      expect(notices.success).not.toHaveBeenCalled();
      expect(JSON.stringify(notices.error.mock.calls)).not.toContain('internal message');
    }
    if (kind === 'failed') expect(screen.getByRole('link', { name: 'Google のクチコミを書く' })).toBeDefined();
    if (kind.includes('error')) expect((screen.getByRole('button', { name: '送信する' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(['failed', 'network error', 'ok'])('再生成 %s: 元の投稿導線を保ち、結果を1回通知する', async (kind) => {
    let resolve!: (r: Response) => void;
    let reject!: (e: Error) => void;
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockImplementationOnce(() => new Promise<Response>((yes, no) => { resolve = yes; reject = no; }));
    vi.stubGlobal('fetch', fetch);
    renderShell(); submit();
    await act(async () => {});
    vi.clearAllMocks();
    fireEvent.click(screen.getByRole('button', { name: /別の文章を生成/ }));
    const busy = screen.getByRole('button', { name: '別の文章を作成しています…' }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true); fireEvent.click(busy);
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => { if (kind === 'network error') reject(new Error('internal message')); else resolve(response(kind)); });
    expect(screen.getByRole('link', { name: 'Google のクチコミを書く' })).toBeDefined();
    if (kind === 'ok') expect(notices.success).toHaveBeenCalledExactlyOnceWith('別の口コミ文を作成しました。');
    else { expect(notices.error).toHaveBeenCalledTimes(1); expect(notices.success).not.toHaveBeenCalled(); }
    if (kind === 'network error') expect((screen.getByLabelText('口コミ下書き') as HTMLTextAreaElement).value).toBe('下書きの文章');
  });

  it('既存の下書きがある状態の再生成が HTTP 200 / generation:failed でも、編集済みの文章と操作を保つ', async () => {
    const failed = new Response(JSON.stringify({ generation: 'failed', draft: null, sessionToken: 'token2', regenerationsLeft: 3 }), { status: 200 });
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(failed);
    vi.stubGlobal('fetch', fetch);
    renderShell(); submit();
    await act(async () => {});
    const textarea = screen.getByLabelText('口コミ下書き') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '自分で直した文章' } });
    vi.clearAllMocks();
    fireEvent.click(screen.getByRole('button', { name: /別の文章を生成/ }));
    await act(async () => {});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('口コミ下書き') as HTMLTextAreaElement).value).toBe('自分で直した文章');
    expect((screen.getByRole('button', { name: 'コピーして投稿する' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: /別の文章を生成（残り3回）/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('link', { name: 'Google のクチコミを書く' })).toBeDefined();
    expect(notices.error).toHaveBeenCalledTimes(1);
    expect(notices.success).not.toHaveBeenCalled();
    expect(screen.queryByText(/下書きの生成に失敗しました。再試行するか/)).toBeNull();
    // 再生成の失敗の後も、編集を続けられる
    fireEvent.change(screen.getByLabelText('口コミ下書き'), { target: { value: 'さらに直した文章' } });
    expect((screen.getByLabelText('口コミ下書き') as HTMLTextAreaElement).value).toBe('さらに直した文章');
  });
});

describe('コピーの通知（#450）', () => {
  it('writeTextをクリック中に呼び、Promise完了後だけ成功通知する', async () => {
    let finish!: () => void;
    const writeText = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'コピーして投稿する' }));
    expect(writeText).toHaveBeenCalledExactlyOnceWith('編集中の文章');
    const busy = screen.getByRole('button', { name: 'コピー中…' }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true); fireEvent.click(busy);
    expect(notices.success).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    expect(notices.success).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toBe('');
    expect((screen.getByRole('button', { name: 'コピーして投稿する' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(['rejected', 'throws', 'unavailable'])('%s: Toastと手動コピーへ復帰する', async (kind) => {
    const writeText = kind === 'throws' ? vi.fn(() => { throw new Error('internal'); }) : vi.fn().mockRejectedValue(new Error('internal'));
    vi.stubGlobal('navigator', kind === 'unavailable' ? {} : { clipboard: { writeText } });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'コピーして投稿する' }));
    await act(async () => {});
    expect(notices.error).toHaveBeenCalledTimes(1);
    expect(notices.success).not.toHaveBeenCalled();
    expect(screen.getByText(/上の文章を選択して手動でコピー/)).toBeDefined();
    expect(document.activeElement).toBe(screen.getByLabelText('口コミ下書き'));
    expect((screen.getByRole('button', { name: 'コピーして投稿する' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
