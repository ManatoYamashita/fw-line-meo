// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import type { SurveySettingsResponse } from '../lib/survey-settings-contract';
import { installPointerEventPolyfill } from './pointer-event';

// アンケート設定画面（Issue #437）。LIFF はモックし、API は fetch の差し替えで返す。
// 画面が送る要求（メソッド・パス・本文・Authorization・?storeId のヒント）と、応答に応じた描画を確かめる。
// 予約・来店の 2 択は Base UI の Radio で、クリックを PointerEvent で転送するので、jsdom に互換実装を入れる。

const liffMocks = vi.hoisted(() => ({
  init: vi.fn(),
  isLoggedIn: vi.fn(),
  getIDToken: vi.fn(),
  login: vi.fn(),
}));
vi.mock('@line/liff', () => ({ default: liffMocks }));

import SurveySettingsPage from '../app/store/survey-settings/page';

const CATEGORIES: SurveySettingsResponse['categories'] = [
  { code: 'food', label: '料理', allowsTargets: true, enabled: true, toggleable: false, ownerTargets: true, targetLimit: 10 },
  { code: 'drink', label: 'ドリンク', allowsTargets: true, enabled: true, toggleable: false, ownerTargets: true, targetLimit: 10 },
  { code: 'service_delivery', label: '接客・提供', allowsTargets: false, enabled: true, toggleable: false, ownerTargets: false, targetLimit: null },
  { code: 'reservation_visit', label: '予約・来店', allowsTargets: false, enabled: true, toggleable: true, ownerTargets: false, targetLimit: null },
];

function settings(overrides: Partial<SurveySettingsResponse> = {}): SurveySettingsResponse {
  return {
    storeId: 'store-1',
    storeName: 'テスト自由が丘店',
    stores: [{ storeId: 'store-1', name: 'テスト自由が丘店' }],
    structuredEnabled: false,
    revision: 3,
    categories: CATEGORIES,
    targets: [
      { id: 't-sashimi', categoryCode: 'food', label: '刺身盛り合わせ', active: true, sortOrder: 0 },
      { id: 't-yakitori', categoryCode: 'food', label: '焼き鳥5種盛り', active: true, sortOrder: 1 },
      { id: 't-motsu', categoryCode: 'food', label: '名物もつ煮', active: false, sortOrder: 2 },
      { id: 't-lemon', categoryCode: 'drink', label: '自家製レモンサワー', active: true, sortOrder: 0 },
    ],
    ...overrides,
  };
}

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** 応答を順に返す fetch。呼び出しを記録する。 */
function stubFetch(...responses: { status: number; body: unknown }[]): Call[] {
  const calls: Call[] = [];
  const queue = [...responses];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        headers: init.headers as Record<string, string>,
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      const next = queue.shift() ?? { status: 500, body: { error: { code: 'INTERNAL', message: 'x' } } };
      return Promise.resolve({
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        json: () => Promise.resolve(next.body),
      });
    }),
  );
  return calls;
}

function setUrl(search: string): void {
  window.history.replaceState({}, '', `/store/survey-settings${search}`);
}

async function renderReady(...more: { status: number; body: unknown }[]): Promise<Call[]> {
  const calls = stubFetch({ status: 200, body: settings() }, ...more);
  render(<SurveySettingsPage />);
  await screen.findByRole('heading', { level: 2, name: '料理' });
  return calls;
}

function section(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

describe('アンケート設定画面', () => {
  beforeEach(() => {
    installPointerEventPolyfill();
    vi.stubEnv('NEXT_PUBLIC_LIFF_ID', 'test-liff-id');
    liffMocks.init.mockReset().mockResolvedValue(undefined);
    liffMocks.isLoggedIn.mockReset().mockReturnValue(true);
    liffMocks.getIDToken.mockReset().mockReturnValue('id-token-1');
    liffMocks.login.mockReset();
    setUrl('');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('料理・ドリンクの表示中の一覧を並び順に、非表示の一覧と予約・来店の切り替えとともに描く', async () => {
    const calls = await renderReady();
    expect(calls[0]).toMatchObject({ url: '/api/survey-settings', method: 'GET' });
    expect(calls[0]!.headers.Authorization).toBe('Bearer id-token-1');

    const food = section('料理');
    expect(within(food).getByText('表示中 2 / 10 件')).toBeDefined();
    const rows = within(food).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('刺身盛り合わせ'), expect.stringContaining('焼き鳥5種盛り')]),
    );
    expect(within(food).getByRole('heading', { name: '非表示にした料理名' })).toBeDefined();
    expect(within(food).getByRole('button', { name: '「名物もつ煮」を再表示する' })).toBeDefined();
    expect(within(section('ドリンク')).getByText('表示中 1 / 10 件')).toBeDefined();
    // 料理名・ドリンク名を持たないカテゴリ（接客など）は、この画面に出さない。
    expect(screen.queryByRole('region', { name: '接客・提供' })).toBeNull();
    const visit = section('予約・来店');
    expect(within(visit).getByRole('radio', { name: '表示する' }).getAttribute('aria-checked')).toBe('true');
    // 客向けの structured の画面が未接続の間は、今のアンケートが変わらないことを伝える。
    expect(screen.getByText(/今お客様が使っているアンケートは変わりません/)).toBeDefined();
    expect(screen.getByRole('link', { name: '店舗詳細へ戻る' }).getAttribute('href')).toBe('/store?storeId=store-1');
  });

  it('料理名を追加する: 本文に storeId を入れず、応答の設定で一覧を描き直す', async () => {
    const added = settings({
      targets: [
        ...settings().targets,
        { id: 't-new', categoryCode: 'food', label: '海鮮丼', active: true, sortOrder: 2 },
      ],
    });
    const calls = await renderReady({ status: 200, body: added });
    const food = section('料理');
    fireEvent.change(within(food).getByLabelText('料理名を追加'), { target: { value: '  海鮮丼 ' } });
    fireEvent.click(within(food).getByRole('button', { name: '追加する' }));

    await screen.findByText('「海鮮丼」を追加しました。');
    expect(calls[1]).toMatchObject({
      url: '/api/survey-settings/targets',
      method: 'POST',
      body: { categoryCode: 'food', label: '  海鮮丼 ' },
    });
    expect(JSON.stringify(calls[1]!.body)).not.toContain('storeId');
    expect(within(section('料理')).getByText('表示中 3 / 10 件')).toBeDefined();
    expect((within(section('料理')).getByLabelText('料理名を追加') as HTMLInputElement).value).toBe('');
  });

  it('空欄・41 文字・改行は送らずに、何を直せばよいかを出す', async () => {
    const calls = await renderReady();
    const food = section('料理');
    const input = within(food).getByLabelText('料理名を追加');
    const submit = within(food).getByRole('button', { name: '追加する' });

    fireEvent.click(submit);
    expect(await within(food).findByText('名前を入力してください。')).toBeDefined();
    fireEvent.change(input, { target: { value: 'あ'.repeat(41) } });
    expect(within(food).getByText(/41 \/ 40 文字/)).toBeDefined();
    fireEvent.click(submit);
    expect(await within(food).findByText('名前は40文字以内で入力してください。')).toBeDefined();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(calls).toHaveLength(1);
  });

  it('サーバーが拒否した理由（同名など）を、追加の欄の下に出す', async () => {
    await renderReady({
      status: 409,
      body: { error: { code: 'DUPLICATE_LABEL', message: '同じ名前がすでに表示されています。別の名前にしてください。' } },
    });
    const food = section('料理');
    fireEvent.change(within(food).getByLabelText('料理名を追加'), { target: { value: '刺身盛り合わせ' } });
    fireEvent.click(within(food).getByRole('button', { name: '追加する' }));
    expect(await within(food).findByText('同じ名前がすでに表示されています。別の名前にしてください。')).toBeDefined();
  });

  it('非表示にした同名を追加するときは、再表示したと案内する', async () => {
    await renderReady({ status: 200, body: settings() });
    const food = section('料理');
    fireEvent.change(within(food).getByLabelText('料理名を追加'), { target: { value: '名物もつ煮' } });
    fireEvent.click(within(food).getByRole('button', { name: '追加する' }));
    expect(await screen.findByText('非表示にしていた「名物もつ煮」を再表示しました。')).toBeDefined();
  });

  it('上限（10 件）に達したら追加と再表示を押せず、理由を出す。名前の変更・並び替え・非表示は押せる', async () => {
    const full = settings({
      targets: [
        ...Array.from({ length: 10 }, (_, i) => ({
          id: `t-${i}`,
          categoryCode: 'food',
          label: `料理 ${i}`,
          active: true,
          sortOrder: i,
        })),
        { id: 't-hidden', categoryCode: 'food', label: '非表示の料理', active: false, sortOrder: 0 },
      ],
    });
    stubFetch({ status: 200, body: full });
    render(<SurveySettingsPage />);
    await screen.findByRole('heading', { level: 2, name: '料理' });
    const food = section('料理');
    expect((within(food).getByRole('button', { name: '追加する' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(food).getByText('料理は10件まで登録できます。追加するには、どれかを非表示にしてください。')).toBeDefined();
    expect((within(food).getByRole('button', { name: '「非表示の料理」を再表示する' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(food).getByRole('button', { name: '「料理 3」の名前を変更する' }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(food).getByRole('button', { name: '「料理 3」を下へ移動する' }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(food).getByRole('button', { name: '「料理 3」を非表示にする' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('「下へ」はカテゴリの全件の並びを PUT で送る。先頭の「上へ」と末尾の「下へ」は押せない', async () => {
    const calls = await renderReady({ status: 200, body: settings() });
    const food = section('料理');
    expect((within(food).getByRole('button', { name: '「刺身盛り合わせ」を上へ移動する' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(food).getByRole('button', { name: '「焼き鳥5種盛り」を下へ移動する' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(food).getByRole('button', { name: '「刺身盛り合わせ」を下へ移動する' }));
    await screen.findByText('並び順を保存しました。');
    expect(calls[1]).toMatchObject({
      url: '/api/survey-settings/targets/order',
      method: 'PUT',
      body: { categoryCode: 'food', targetIds: ['t-yakitori', 't-sashimi'] },
    });
  });

  it('非表示・再表示・名前の変更は、その Target の ID のパスへ送る', async () => {
    const calls = await renderReady(
      { status: 200, body: settings() },
      { status: 200, body: settings() },
      { status: 200, body: settings() },
    );
    const food = section('料理');
    fireEvent.click(within(food).getByRole('button', { name: '「焼き鳥5種盛り」を非表示にする' }));
    await screen.findByText('「焼き鳥5種盛り」を非表示にしました。');
    fireEvent.click(within(section('料理')).getByRole('button', { name: '「名物もつ煮」を再表示する' }));
    await screen.findByText('「名物もつ煮」を再表示しました。');
    fireEvent.click(within(section('料理')).getByRole('button', { name: '「刺身盛り合わせ」の名前を変更する' }));
    const edit = within(section('料理')).getByLabelText('料理名を変更');
    fireEvent.change(edit, { target: { value: 'お刺身盛り合わせ' } });
    fireEvent.click(within(section('料理')).getByRole('button', { name: '保存する' }));
    await screen.findByText('名前を変更しました。');
    expect(calls.slice(1).map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', '/api/survey-settings/targets/t-yakitori/disable', undefined],
      ['PATCH', '/api/survey-settings/targets/t-motsu', { active: true }],
      ['PATCH', '/api/survey-settings/targets/t-sashimi', { label: 'お刺身盛り合わせ' }],
    ]);
  });

  it('予約・来店を「表示しない」にすると PATCH で送る', async () => {
    const calls = await renderReady({
      status: 200,
      body: settings({
        categories: CATEGORIES.map((c) => (c.code === 'reservation_visit' ? { ...c, enabled: false } : c)),
      }),
    });
    fireEvent.click(within(section('予約・来店')).getByRole('radio', { name: '表示しない' }));
    await screen.findByText('予約・来店をアンケートに表示しません。');
    expect(calls[1]).toMatchObject({
      url: '/api/survey-settings/categories/reservation_visit',
      method: 'PATCH',
      body: { enabled: false },
    });
    expect(within(section('予約・来店')).getByRole('radio', { name: '表示しない' }).getAttribute('aria-checked')).toBe('true');
  });

  it('?storeId のヒントを、どの要求にもクエリとして付ける（本文には入れない）', async () => {
    setUrl('?storeId=store-2');
    const calls = stubFetch({ status: 200, body: settings({ storeId: 'store-2' }) }, { status: 200, body: settings() });
    render(<SurveySettingsPage />);
    await screen.findByRole('heading', { level: 2, name: '料理' });
    fireEvent.click(within(section('料理')).getByRole('button', { name: '「焼き鳥5種盛り」を非表示にする' }));
    await screen.findByText('「焼き鳥5種盛り」を非表示にしました。');
    expect(calls.map((c) => c.url)).toEqual([
      '/api/survey-settings?storeId=store-2',
      '/api/survey-settings/targets/t-yakitori/disable?storeId=store-2',
    ]);
  });

  it('名前は HTML として解釈せず、そのまま文字として描く', async () => {
    stubFetch({
      status: 200,
      body: settings({
        targets: [{ id: 't-x', categoryCode: 'food', label: '<img src=x onerror=alert(1)>', active: true, sortOrder: 0 }],
      }),
    });
    const { container } = render(<SurveySettingsPage />);
    await screen.findByText('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
  });

  it('複数店舗で店が決まらないときは、設定画面へのリンクで店を選ばせる', async () => {
    stubFetch({
      status: 409,
      body: {
        error: { code: 'STORE_SELECTION_REQUIRED', message: '設定する店舗を選んでください' },
        stores: [
          { storeId: 'store-1', name: 'A 店' },
          { storeId: 'store-2', name: 'B 店' },
        ],
      },
    });
    render(<SurveySettingsPage />);
    const link = await screen.findByRole('link', { name: 'B 店' });
    expect(link.getAttribute('href')).toBe('/store/survey-settings?storeId=store-2');
  });

  it('認証の失敗・LIFF の失敗は、開き直しを促す', async () => {
    stubFetch({ status: 401, body: { error: { code: 'UNAUTHORIZED', message: '認証に失敗しました' } } });
    render(<SurveySettingsPage />);
    expect(await screen.findByText('認証に失敗しました。LINE アプリからこの画面を開き直してください。')).toBeDefined();
    cleanup();

    liffMocks.getIDToken.mockReturnValue(null);
    render(<SurveySettingsPage />);
    expect(await screen.findByText(/LINE 連携でエラーが発生しました/)).toBeDefined();
  });
});
