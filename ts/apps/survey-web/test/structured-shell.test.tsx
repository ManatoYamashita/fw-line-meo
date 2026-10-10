// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { StructuredSurveyDefinition } from '@fwlm/db';

// シェルの structured の流れ（Issue #438）。フォームは差し替え、シェルが送る本文と、応答ごとの画面を確かめる。
//   - structured のフォームを出し、legacy のフォームを出さない
//   - 送信の本文は pageToken・storeId と structured の回答（aspectCodes を混ぜない）
//   - 受付（下書きなし・Stage 2）の後は回答済みの画面（Google の投稿導線・全評価で同一）
//   - STALE_SURVEY は通常の失敗と区別し、再読み込みを案内する（回答済みにしない）

const STRUCTURED_ANSWER = {
  star: 2,
  positiveSelections: [],
  concernSelections: [{ categoryCode: 'service_delivery', facetCodes: ['serving'] }],
};

vi.mock('../src/app/s/[storeId]/structured-survey-form', () => ({
  StructuredSurveyForm: (props: { onSubmit: (a: unknown) => void; submitting: boolean }) => (
    <button data-testid="structured-submit" disabled={props.submitting} onClick={() => props.onSubmit(STRUCTURED_ANSWER)}>
      structured submit
    </button>
  ),
}));
vi.mock('../src/app/s/[storeId]/survey-form', () => ({
  SurveyForm: () => <p data-testid="legacy-form">legacy</p>,
}));
vi.mock('../src/lib/review-link-beacon', () => ({ notifyReviewLinkOpened: vi.fn() }));

import { SurveyShell } from '../src/app/s/[storeId]/survey-shell';
import { notifyReviewLinkOpened } from '../src/lib/review-link-beacon';

const STORE = '44444444-4444-4444-4444-444444444444';
const DEFINITION: StructuredSurveyDefinition = { mode: 'structured', revision: 1, categories: [] };

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn((_url: string, _init: RequestInit) =>
    Promise.resolve({ ok: status >= 200 && status < 300, json: () => Promise.resolve(body) }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderShell() {
  render(
    <SurveyShell
      storeId={STORE}
      storeName="テスト店"
      survey={{ mode: 'structured', definition: DEFINITION }}
      pageToken="PT-v2"
      googleReviewUrl="https://review/ChIJ"
    />,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.mocked(notifyReviewLinkOpened).mockClear();
});

describe('SurveyShell × structured（Issue #438）', () => {
  it('structured のフォームだけを出す', () => {
    renderShell();
    expect(screen.getByTestId('structured-submit')).toBeDefined();
    expect(screen.queryByTestId('legacy-form')).toBeNull();
  });

  it('structured の回答を pageToken・storeId と一緒に送り、受付の後は回答済みの画面（Google の投稿導線）へ進む', async () => {
    const fetchMock = stubFetch(200, { mode: 'structured', generation: 'unavailable', draft: null });
    renderShell();
    fireEvent.click(screen.getByTestId('structured-submit'));
    const link = await screen.findByRole('link', { name: 'Google のクチコミを書く' });
    expect(link.getAttribute('href')).toBe('https://review/ChIJ');
    expect(screen.getByText('テスト店へのご回答ありがとうございました。')).toBeDefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/responses');
    expect(JSON.parse(String(init.body))).toEqual({ pageToken: 'PT-v2', storeId: STORE, ...STRUCTURED_ANSWER });
    // 押下の通知は pageToken を載せる（回答済みの画面と同じ）。
    fireEvent.click(link);
    expect(notifyReviewLinkOpened).toHaveBeenCalledWith(STORE, 'PT-v2');
  });

  it('STALE_SURVEY は「アンケート内容が更新されました」と再読み込みを案内し、回答済みにしない', async () => {
    stubFetch(409, {
      error: {
        code: 'STALE_SURVEY',
        message: 'アンケート内容が更新されました。ページを再読み込みして、もう一度回答してください。',
      },
    });
    renderShell();
    fireEvent.click(screen.getByTestId('structured-submit'));
    expect(
      await screen.findByText(/アンケート内容が更新されました。ページを再読み込みして、もう一度回答してください。/),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'ページを再読み込みする' })).toBeDefined();
    expect(screen.queryByRole('link', { name: 'Google のクチコミを書く' })).toBeNull();
    expect(screen.getByTestId('structured-submit')).toBeDefined();
  });

  it('一般的な失敗は再読み込みの押しボタンを出さない（STALE と区別する）', async () => {
    stubFetch(500, { error: { code: 'INTERNAL', message: 'サーバーエラー' } });
    renderShell();
    fireEvent.click(screen.getByTestId('structured-submit'));
    expect(await screen.findByText('サーバーエラー')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'ページを再読み込みする' })).toBeNull();
  });
});
