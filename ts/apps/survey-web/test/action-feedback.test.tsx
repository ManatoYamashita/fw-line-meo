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
const submit = (star = 3) => {
  fireEvent.click(screen.getByRole('button', { name: `星${star}` }));
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
    if (kind === 'failed') expect(screen.getByRole('link', { name: 'Google のクチコミ欄を開く' })).toBeDefined();
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
    expect(screen.getByRole('link', { name: 'Google のクチコミ欄を開く' })).toBeDefined();
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
    expect((screen.getByRole('button', { name: '文章をコピー' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: /別の文章を生成（残り3回）/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('link', { name: 'Google のクチコミ欄を開く' })).toBeDefined();
    expect(notices.error).toHaveBeenCalledTimes(1);
    expect(notices.success).not.toHaveBeenCalled();
    expect(screen.queryByText(/下書きの生成に失敗しました。再試行するか/)).toBeNull();
    // 再生成の失敗の後も、編集を続けられる
    fireEvent.change(screen.getByLabelText('口コミ下書き'), { target: { value: 'さらに直した文章' } });
    expect((screen.getByLabelText('口コミ下書き') as HTMLTextAreaElement).value).toBe('さらに直した文章');
  });

  it('再生成が成功して前と同じ文面が返っても、編集内容を新しい下書きで置き換える', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response());
    vi.stubGlobal('fetch', fetch);
    renderShell(); submit();
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('口コミ下書き'), { target: { value: '自分で直した文章' } });
    fireEvent.click(screen.getByRole('button', { name: /別の文章を生成/ }));
    await act(async () => {});
    expect(notices.success).toHaveBeenLastCalledWith('別の口コミ文を作成しました。');
    expect((screen.getByLabelText('口コミ下書き') as HTMLTextAreaElement).value).toBe('下書きの文章');
  });

  it('再生成の失敗で返った sessionToken で次の再生成を送り、成功すると下書き・token・残り回数が進む', async () => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const fetch = vi.fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(json({ generation: 'failed', draft: null, sessionToken: 'token2', regenerationsLeft: 3 }))
      .mockResolvedValueOnce(json({ generation: 'ok', draft: '新しい下書き', sessionToken: 'token3', regenerationsLeft: 2 }))
      .mockResolvedValueOnce(json({ generation: 'ok', draft: 'さらに新しい下書き', sessionToken: 'token4', regenerationsLeft: 1 }));
    vi.stubGlobal('fetch', fetch);
    const draftsBody = (call: number) => JSON.parse((fetch.mock.calls[call] as [string, RequestInit])[1].body as string) as unknown;
    renderShell(); submit();
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /別の文章を生成/ }));
    await act(async () => {});
    expect(draftsBody(1)).toEqual({ sessionToken: 'token' });

    fireEvent.click(screen.getByRole('button', { name: /別の文章を生成/ }));
    await act(async () => {});
    expect(fetch.mock.calls[2]![0]).toBe('/api/drafts');
    expect(draftsBody(2)).toEqual({ sessionToken: 'token2' });
    expect((screen.getByLabelText('口コミ下書き') as HTMLTextAreaElement).value).toBe('新しい下書き');
    expect(screen.getByRole('button', { name: '別の文章を生成（残り2回）' })).toBeDefined();
    expect(notices.success).toHaveBeenLastCalledWith('別の口コミ文を作成しました。');

    // 成功で返った新しい token へ進んでいる
    fireEvent.click(screen.getByRole('button', { name: /別の文章を生成/ }));
    await act(async () => {});
    expect(draftsBody(3)).toEqual({ sessionToken: 'token3' });
    expect((screen.getByLabelText('口コミ下書き') as HTMLTextAreaElement).value).toBe('さらに新しい下書き');
  });
});

describe('コピーの通知（#450）', () => {
  it('writeTextをクリック中に呼び、Promise完了後だけ成功通知する', async () => {
    let finish!: () => void;
    const writeText = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '文章をコピー' }));
    expect(writeText).toHaveBeenCalledExactlyOnceWith('編集中の文章');
    const busy = screen.getByRole('button', { name: 'コピー中…' }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true); fireEvent.click(busy);
    expect(notices.success).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    // 成功の通知は、次に押すリンクの名前で投稿までの手順を伝える（コピーだけでは投稿画面は開かない）。
    expect(notices.success).toHaveBeenCalledExactlyOnceWith('コピーしました。「Google のクチコミ欄を開く」から投稿画面を開き、本文欄に貼り付けてください。');
    expect(screen.getByRole('status').textContent).toBe('');
    expect((screen.getByRole('button', { name: '文章をコピー' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(['rejected', 'throws', 'unavailable'])('%s: Toastと手動コピーへ復帰する', async (kind) => {
    const writeText = kind === 'throws' ? vi.fn(() => { throw new Error('internal'); }) : vi.fn().mockRejectedValue(new Error('internal'));
    vi.stubGlobal('navigator', kind === 'unavailable' ? {} : { clipboard: { writeText } });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '文章をコピー' }));
    await act(async () => {});
    expect(notices.error).toHaveBeenCalledTimes(1);
    expect(notices.success).not.toHaveBeenCalled();
    expect(screen.getByText(/上の文章を選択して手動でコピー/)).toBeDefined();
    expect(document.activeElement).toBe(screen.getByLabelText('口コミ下書き'));
    expect((screen.getByRole('button', { name: '文章をコピー' }) as HTMLButtonElement).disabled).toBe(false);
    // コピーに失敗しても投稿画面を開く導線は消さない（手動でコピーしたあとに開ける）。
    expect(screen.getByRole('link', { name: 'Google のクチコミ欄を開く' }).getAttribute('href')).toBe('https://example.com/review');
  });
});

// Requirement 4.4: 星の値で導線を出し分けない（レビューゲーティングをしない）。
describe('星の値によらず同じ導線（4.4）', () => {
  async function actionsAfterSubmit(star: number) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));
    renderShell(); submit(star);
    await act(async () => {});
    const actions = [...document.querySelectorAll('section button, section a')].map((el) => ({
      tag: el.tagName,
      name: (el.textContent ?? '').trim(),
      href: el.getAttribute('href'),
      target: el.getAttribute('target'),
      className: el.getAttribute('class'),
    }));
    cleanup();
    localStorage.clear();
    return actions;
  }

  it('星1と星5で、コピー・投稿画面を開くリンク・再生成の並びと見た目が一致する', async () => {
    const low = await actionsAfterSubmit(1);
    const high = await actionsAfterSubmit(5);
    expect(low.map((a) => a.name), '星1の操作の並び').toEqual([
      '文章をコピー',
      'Google のクチコミ欄を開く',
      '別の文章を生成（残り3回）',
    ]);
    expect(high, '星1と星5で導線が食い違っています').toEqual(low);
  });
});
