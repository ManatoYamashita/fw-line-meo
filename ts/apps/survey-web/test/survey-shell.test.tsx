// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { markAnswered } from '../src/app/s/[storeId]/answered-flag';

// 葉コンポーネントはモックし、シェルの状態遷移と API 呼出を独立に検証する。
vi.mock('../src/app/s/[storeId]/survey-form', () => ({
  SurveyForm: (props: {
    onSubmit: (a: { star: number; aspectCodes: string[] }) => void;
    submitting: boolean;
  }) => (
    <button
      data-testid="submit"
      disabled={props.submitting}
      onClick={() => props.onSubmit({ star: 5, aspectCodes: ['taste'] })}
    >
      submit
    </button>
  ),
}));
vi.mock('../src/app/s/[storeId]/draft-panel', () => ({
  DraftPanel: (props: {
    draft: string;
    regenerationsLeft: number;
    generationFailed: boolean;
    googleReviewUrl: string;
    onRegenerate: () => void;
  }) => (
    <div>
      <span data-testid="draft">{props.draft}</span>
      <span data-testid="left">{props.regenerationsLeft}</span>
      <span data-testid="failed">{String(props.generationFailed)}</span>
      <a data-testid="review-link" href={props.googleReviewUrl}>
        Google のクチコミを書く
      </a>
      <button data-testid="regen" onClick={() => props.onRegenerate()}>
        regen
      </button>
    </div>
  ),
}));

import { SurveyShell } from '../src/app/s/[storeId]/survey-shell';

const STORE = '44444444-4444-4444-4444-444444444444';

interface RouteResp {
  ok?: boolean;
  body: unknown;
}

function stubFetch(routes: Record<string, RouteResp>): ReturnType<typeof vi.fn> {
  const fn = vi.fn((url: string) => {
    const r = routes[url];
    return Promise.resolve({ ok: r?.ok ?? true, json: () => Promise.resolve(r?.body ?? {}) });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderShell() {
  return render(
    <SurveyShell
      storeId={STORE}
      storeName="テスト店"
      aspects={[{ code: 'taste', label: '味' }]}
      pageToken="PT"
      googleReviewUrl="https://review/ChIJ"
    />,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SurveyShell', () => {
  it('回答フェーズでフォームを表示する', () => {
    stubFetch({});
    renderShell();
    expect(screen.getByTestId('submit')).toBeDefined();
  });

  it('送信後に /api/responses を呼び下書きフェーズへ遷移する', async () => {
    const fetchFn = stubFetch({
      '/api/responses': { body: { generation: 'ok', draft: 'D1', sessionToken: 'T1', regenerationsLeft: 3 } },
    });
    renderShell();
    fireEvent.click(screen.getByTestId('submit'));
    const draft = await screen.findByTestId('draft');
    expect(draft.textContent).toBe('D1');
    expect(fetchFn).toHaveBeenCalledWith('/api/responses', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse((fetchFn.mock.calls[0]?.[1] as { body: string }).body);
    expect(body).toMatchObject({ pageToken: 'PT', storeId: STORE, star: 5, aspectCodes: ['taste'] });
  });

  it('再生成で /api/drafts を呼び下書きと残数を更新する', async () => {
    stubFetch({
      '/api/responses': { body: { generation: 'ok', draft: 'D1', sessionToken: 'T1', regenerationsLeft: 3 } },
      '/api/drafts': { body: { generation: 'ok', draft: 'D2', sessionToken: 'T2', regenerationsLeft: 2 } },
    });
    renderShell();
    fireEvent.click(screen.getByTestId('submit'));
    await screen.findByTestId('draft');
    fireEvent.click(screen.getByTestId('regen'));
    const draft = await screen.findByText('D2');
    expect(draft.textContent).toBe('D2');
    expect(screen.getByTestId('left').textContent).toBe('2');
  });

  it('回答済み(24h以内)は回答済み画面＋投稿導線を表示する', async () => {
    markAnswered(STORE);
    stubFetch({});
    renderShell();
    expect(await screen.findByText(/ご回答ありがとうございました/)).toBeDefined();
    const link = screen.getByRole('link', { name: /クチコミを書く/ });
    expect(link.getAttribute('href')).toBe('https://review/ChIJ');
    // フォームは表示しない
    expect(screen.queryByTestId('submit')).toBeNull();
  });

  it('生成失敗(200 failed)でも下書きフェーズへ遷移し投稿導線を維持する（3.9）', async () => {
    stubFetch({
      '/api/responses': { body: { generation: 'failed', draft: null, sessionToken: 'T1', regenerationsLeft: 3 } },
    });
    renderShell();
    fireEvent.click(screen.getByTestId('submit'));
    expect((await screen.findByTestId('failed')).textContent).toBe('true');
    // 投稿導線は失敗時も維持される
    expect(screen.getByTestId('review-link').getAttribute('href')).toBe('https://review/ChIJ');
  });

  it('送信が非 200 なら回答フェーズに留まりエラーを表示する', async () => {
    stubFetch({ '/api/responses': { ok: false, body: { error: { code: 'RATE_LIMITED' } } } });
    renderShell();
    fireEvent.click(screen.getByTestId('submit'));
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByTestId('submit')).toBeDefined(); // フォーム維持
    expect(screen.queryByTestId('draft')).toBeNull();
  });
});
