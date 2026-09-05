// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { announcedText, ownText } from './live-region';

const useAuthMock = vi.fn();
vi.mock('../src/lib/auth-context', () => ({ useAuth: () => useAuthMock() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  // 帯（TopNav）が現在地の判定に使う。このページの実経路を返し、偽装が嘘をつかないようにする。
  usePathname: () => '/stores/new',
}));
vi.mock('next/link', () => ({
  // href / children 以外の props（TopNav が現在地へ付ける aria-current と className）も素の a へ透過する。
  // 捨てると帯の現在地表現が DOM に現れず、検証が構造を掴めない。
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: ReactNode } & import('react').ComponentProps<'a'>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const api = vi.hoisted(() => ({
  getStores: vi.fn(),
  getOwners: vi.fn(),
  getAgencies: vi.fn(),
  getCategories: vi.fn(),
  searchStores: vi.fn(),
  registerStore: vi.fn(),
}));
vi.mock('../src/lib/api', () => api);

import StoreRegisterPage from '../src/app/stores/new/page';

function readyAgency() {
  useAuthMock.mockReturnValue({
    status: 'ready',
    me: { role: 'agency', agencyId: 'a1', agencyName: '代理店A', displayName: 'テスト' },
    signIn: vi.fn(),
    signOut: vi.fn(),
  });
}

const owner = { id: 'o1', displayName: '山田オーナー', onboardingStatus: 'pending', createdAt: '2026-01-01T00:00:00Z' };
const candidate = {
  placeId: 'p1',
  name: '鳥貴族 渋谷店',
  address: '東京都渋谷区1-1',
  latitude: 35.6,
  longitude: 139.7,
  types: ['restaurant'],
};

beforeEach(() => {
  useAuthMock.mockReset();
  Object.values(api).forEach((m) => m.mockReset());
  readyAgency();
});
afterEach(cleanup);

async function selectOwnerAndSearchTo(scope: ReturnType<typeof within>, query: string) {
  fireEvent.change(await scope.findByLabelText('オーナー'), { target: { value: 'o1' } });
  fireEvent.click(scope.getByRole('button', { name: /次へ/ }));
  fireEvent.change(await scope.findByLabelText('店名'), { target: { value: query } });
  fireEvent.click(scope.getByRole('button', { name: '検索' }));
}

describe('店舗登録ウィザード', () => {
  it('選択可能オーナーが 0 件のとき案内を表示し先へ進めない（Req 3.3）', async () => {
    api.getOwners.mockResolvedValue({ ok: true, value: [] });
    render(<StoreRegisterPage />);
    const scope = within(await screen.findByRole('main'));
    expect(await scope.findByText(/対象オーナーがいません/)).toBeTruthy();
    expect(scope.queryByRole('button', { name: /次へ/ })).toBeNull();
  });

  it('検索結果が見つかると候補を一覧表示する（Req 3.4）', async () => {
    api.getOwners.mockResolvedValue({ ok: true, value: [owner] });
    api.searchStores.mockResolvedValue({ ok: true, value: [candidate] });
    render(<StoreRegisterPage />);
    const scope = within(await screen.findByRole('main'));
    await selectOwnerAndSearchTo(scope, '鳥貴族');
    expect(await scope.findByRole('button', { name: /鳥貴族 渋谷店/ })).toBeTruthy();
  });

  it('検索結果 0 件のとき再検索案内を表示する（Req 3.5）', async () => {
    api.getOwners.mockResolvedValue({ ok: true, value: [owner] });
    api.searchStores.mockResolvedValue({ ok: true, value: [] });
    render(<StoreRegisterPage />);
    const scope = within(await screen.findByRole('main'));
    await selectOwnerAndSearchTo(scope, 'zzz');
    expect(await scope.findByText(/見つかりませんでした/)).toBeTruthy();
  });

  it('検索が失敗(502)したときエラー案内を表示する（Req 3.6）', async () => {
    api.getOwners.mockResolvedValue({ ok: true, value: [owner] });
    api.searchStores.mockResolvedValue({ ok: false, code: 'places_error', message: 'x' });
    render(<StoreRegisterPage />);
    const scope = within(await screen.findByRole('main'));
    await selectOwnerAndSearchTo(scope, 'x');
    expect(await scope.findByText(/検索に失敗しました/)).toBeTruthy();
  });

  it('ハッピーパス: オーナー選択→検索→候補選択→カテゴリ→確定で成功案内、候補は verbatim 送信（Req 3.7, 3.8）', async () => {
    api.getOwners.mockResolvedValue({ ok: true, value: [owner] });
    api.searchStores.mockResolvedValue({ ok: true, value: [candidate] });
    api.getCategories.mockResolvedValue({ ok: true, value: [{ code: 'izakaya', label: '居酒屋' }] });
    api.registerStore.mockResolvedValue({ ok: true, value: { storeId: 'store-1' } });
    render(<StoreRegisterPage />);
    const scope = within(await screen.findByRole('main'));
    await selectOwnerAndSearchTo(scope, '鳥貴族');
    fireEvent.click(await scope.findByRole('button', { name: /鳥貴族 渋谷店/ }));
    fireEvent.click(await scope.findByRole('button', { name: /この店舗で進む/ }));
    fireEvent.change(await scope.findByLabelText(/カテゴリ/), { target: { value: 'izakaya' } });
    fireEvent.click(scope.getByRole('button', { name: /登録を確定/ }));
    expect(await scope.findByText('登録が完了しました')).toBeTruthy();
    expect(api.registerStore).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'o1', candidate, categoryCode: 'izakaya' }),
    );
  });

  it('確定時に 409 が返ると既に登録済み案内を表示する（Req 3.9）', async () => {
    api.getOwners.mockResolvedValue({ ok: true, value: [owner] });
    api.searchStores.mockResolvedValue({ ok: true, value: [candidate] });
    api.getCategories.mockResolvedValue({ ok: true, value: [] });
    api.registerStore.mockResolvedValue({ ok: false, code: 'place_already_registered', message: 'x' });
    render(<StoreRegisterPage />);
    const scope = within(await screen.findByRole('main'));
    await selectOwnerAndSearchTo(scope, '鳥貴族');
    fireEvent.click(await scope.findByRole('button', { name: /鳥貴族 渋谷店/ }));
    fireEvent.click(await scope.findByRole('button', { name: /この店舗で進む/ }));
    fireEvent.click(await scope.findByRole('button', { name: /登録を確定/ }));
    expect(await scope.findByText(/既に登録済み/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 着手前から在った契約（ui-airbnb-surfaces task 5.1 / 5.2 の段 1）
//
// 上の 6 件は「どの段で何が出るか」だけを掴んでおり、意匠の適用で壊しうるものの大半を
// 固定していない。実装へ触れる前にここで固定し、素の実装に対して緑であることを確かめてから
// 部品化へ進む（2.1〜2.5 と同じ手順。5 タスク連続で無検証の契約が見つかっている）。
// ---------------------------------------------------------------------------

/** 要素の直下テキストだけを集める（文言が sr-only の子へ落ちていないことを構造で見る）。 */
function ownTextsIn(scope: HTMLElement): string[] {
  return Array.from(scope.querySelectorAll('*')).map((element) => ownText(element));
}

function readyOperator() {
  useAuthMock.mockReturnValue({
    status: 'ready',
    me: { role: 'operator', displayName: '運営太郎' },
    signIn: vi.fn(),
    signOut: vi.fn(),
  });
}

/**
 * 描画をやり直す。
 *
 * ウィザードは段を進めると前の段へ戻れない（戻る操作は候補確認にしか無い）。段を横断する
 * 照合は 1 度の描画を使い回せないので、段ごとに描き直してから先頭の段から進める。
 */
function restart() {
  cleanup();
  render(<StoreRegisterPage />);
}

/** 5 段すべてを通し、各段で `main` を返す。段ごとの見出し・押しボタンを横断で見るための足場。 */
async function advanceToStep(step: 'owner' | 'search' | 'confirm' | 'basic' | 'done') {
  const main = await screen.findByRole('main');
  const scope = within(main);
  if (step === 'owner') return main;
  fireEvent.change(await scope.findByLabelText('オーナー'), { target: { value: 'o1' } });
  fireEvent.click(scope.getByRole('button', { name: '次へ（店名検索）' }));
  if (step === 'search') return main;
  fireEvent.change(await scope.findByLabelText('店名'), { target: { value: '鳥貴族' } });
  fireEvent.click(scope.getByRole('button', { name: '検索' }));
  fireEvent.click(await scope.findByRole('button', { name: /鳥貴族 渋谷店/ }));
  if (step === 'confirm') return main;
  fireEvent.click(await scope.findByRole('button', { name: 'この店舗で進む' }));
  if (step === 'basic') return main;
  fireEvent.click(await scope.findByRole('button', { name: '登録を確定' }));
  await scope.findByText('登録が完了しました');
  return main;
}

/** ハッピーパスを最後まで通せる偽装一式。 */
function stubHappyPath() {
  api.getOwners.mockResolvedValue({ ok: true, value: [owner] });
  api.searchStores.mockResolvedValue({ ok: true, value: [candidate] });
  api.getCategories.mockResolvedValue({ ok: true, value: [{ code: 'izakaya', label: '居酒屋' }] });
  api.registerStore.mockResolvedValue({ ok: true, value: { storeId: 'store-1' } });
}

describe('店舗登録ウィザード: 着手前から在った契約（意匠の適用で壊しうる）', () => {
  // --- 見出し ---------------------------------------------------------------

  it('主見出しと 5 段の見出しの読み上げ名と階層を変更しない（Req 3.2）', async () => {
    stubHappyPath();
    render(<StoreRegisterPage />);

    // 段ごとに h2 の完全一致を要求する。**5 段すべて**を通る（片方の段だけの照合は
    // 「同じ軸だけを見る」空振りを招く。2.2 / 2.3 の教訓）。
    const expected = [
      ['owner', 'オーナー選択'],
      ['search', '店名検索'],
      ['confirm', '店舗の確認'],
      ['basic', '基本情報'],
      ['done', '登録が完了しました'],
    ] as const;

    let visited = 0;
    for (const [step, heading] of expected) {
      restart();
      const main = await advanceToStep(step);
      const scope = within(main);
      // 主見出しは全段で不変。
      expect(scope.getByRole('heading', { level: 1, name: '店舗登録' }), step).toBeTruthy();
      expect(scope.getByRole('heading', { level: 2, name: heading }), step).toBeTruthy();
      // 段の見出しはその段に 1 つだけ。
      expect(scope.getAllByRole('heading', { level: 2 }), step).toHaveLength(1);
      visited += 1;
    }
    // 走査対象が 0 件で緑にならないようにする（Req 7.4）。
    expect(visited).toBe(expected.length);
  });

  // --- 領域とリンクの個数（Req 3.3）------------------------------------------

  it('主要領域とナビゲーション領域はそれぞれ 1 つである（Req 3.3）', async () => {
    stubHappyPath();
    render(<StoreRegisterPage />);
    await screen.findByRole('main');
    expect(screen.getAllByRole('main')).toHaveLength(1);
    // 帯（TopNav）が唯一のナビゲーション領域である。段階表示を nav にするとここが赤くなる。
    expect(screen.getAllByRole('navigation')).toHaveLength(1);
  });

  it('完了の段のリンクは店舗一覧への 1 件だけ増える（Req 3.3）', async () => {
    stubHappyPath();
    render(<StoreRegisterPage />);
    const before = within(await screen.findByRole('main')).queryAllByRole('link').length;
    const main = await advanceToStep('done');
    const links = within(main).getAllByRole('link');
    expect(links).toHaveLength(before + 1);
    const back = within(main).getByRole('link', { name: '店舗一覧へ戻る' });
    expect(back.getAttribute('href')).toBe('/stores');
  });

  // --- 押しボタンの読み上げ名と個数（Req 3.2, 3.3）----------------------------

  it('各段の押しボタンの読み上げ名と個数を変更しない（Req 3.2, 3.3）', async () => {
    stubHappyPath();
    render(<StoreRegisterPage />);

    // **集合の完全一致**で見る。包含では押しボタンを 1 つ足す改変を捕まえられない
    // （2.1 で差し戻された「追加」型の穴）。帯のログアウトは主要領域の外なのでここには出ない
    // （帯側の個数は top-nav.test.tsx が固定している）。
    const expected = [
      ['owner', ['次へ（店名検索）']],
      ['search', ['検索']],
      ['confirm', ['店名検索へ戻る', 'この店舗で進む']],
      ['basic', ['登録を確定']],
      ['done', []],
    ] as const;

    let visited = 0;
    for (const [step, names] of expected) {
      restart();
      const main = await advanceToStep(step);
      // 完了の段は押しボタンを 1 つも持たない。0 件を例外ではなく空配列として受ける
      // （getAllByRole は 0 件で throw するため、押しボタンが消えた改変を
      // 「見つからない」という別の失敗にすり替えてしまう）。
      const actual = within(main)
        .queryAllByRole('button')
        .map((button) => button.textContent?.replace(/\s+/g, ' ').trim() ?? '');
      expect(actual.slice().sort(), step).toEqual([...names].sort());
      visited += 1;
    }
    expect(visited).toBe(expected.length);
  });

  it('候補の押しボタンの読み上げ名は店名と住所の連結のままである（Req 3.2）', async () => {
    stubHappyPath();
    render(<StoreRegisterPage />);
    const scope = within(await screen.findByRole('main'));
    await selectOwnerAndSearchTo(scope, '鳥貴族');
    // **完全一致**。写真前提の意匠を採らない代わりに題名と補足を積むとき、
    // 読み上げ名が分解されて変わらないことを固定する（正典 §7.6）。
    expect(
      await scope.findByRole('button', { name: '鳥貴族 渋谷店（東京都渋谷区1-1）' }),
    ).toBeTruthy();
  });

  // --- 文言（Req 3.2）--------------------------------------------------------

  it('処理中の文言は ASCII 3 点である（三点リーダへ揃えない・Req 3.2）', () => {
    // agency は自代理店のオーナーを読み込む。解決しない約束で取得中の分岐に留める。
    api.getOwners.mockReturnValue(new Promise(() => {}));
    render(<StoreRegisterPage />);
    const main = screen.getByRole('main');
    const texts = ownTextsIn(main);
    expect(texts).toContain('読み込み中...');
    expect(texts).not.toContain('読み込み中…');
  });

  it('案内・失敗の文言を 1 文字も変更しない（Req 3.2）', async () => {
    // 文言ごとに到達経路が異なるので、経路つきの表で横断する。
    const cases = [
      {
        name: '対象オーナー 0 件',
        text: '対象オーナーがいません。オーナーが先に LINE で招待コード入力を済ませる必要があります。',
        arrange: () => {
          api.getOwners.mockResolvedValue({ ok: true, value: [] });
        },
        reach: async () => {},
      },
      {
        name: '検索 0 件',
        text: '見つかりませんでした。表記を変えて再検索してください。',
        arrange: () => {
          api.getOwners.mockResolvedValue({ ok: true, value: [owner] });
          api.searchStores.mockResolvedValue({ ok: true, value: [] });
        },
        reach: async () => {
          await selectOwnerAndSearchTo(within(await screen.findByRole('main')), 'zzz');
        },
      },
      {
        name: '検索失敗',
        text: '検索に失敗しました。時間をおいて再試行してください。',
        arrange: () => {
          api.getOwners.mockResolvedValue({ ok: true, value: [owner] });
          api.searchStores.mockResolvedValue({ ok: false, code: 'places_error', message: 'x' });
        },
        reach: async () => {
          await selectOwnerAndSearchTo(within(await screen.findByRole('main')), 'x');
        },
      },
      {
        name: '既登録',
        text: '既に登録済みの店舗です。',
        arrange: () => {
          stubHappyPath();
          api.registerStore.mockResolvedValue({
            ok: false,
            code: 'place_already_registered',
            message: 'x',
          });
        },
        reach: async () => {
          const main = await advanceToStep('basic');
          fireEvent.click(within(main).getByRole('button', { name: '登録を確定' }));
        },
      },
      {
        name: '権限外',
        text: 'この操作を行う権限がありません。運営までお問い合わせください。',
        arrange: () => {
          stubHappyPath();
          api.registerStore.mockResolvedValue({ ok: false, code: 'forbidden', message: 'x' });
        },
        reach: async () => {
          const main = await advanceToStep('basic');
          fireEvent.click(within(main).getByRole('button', { name: '登録を確定' }));
        },
      },
      {
        name: '登録完了',
        text: '店舗を登録しました。',
        arrange: () => {
          stubHappyPath();
        },
        reach: async () => {
          await advanceToStep('done');
        },
      },
    ];

    let visited = 0;
    for (const testCase of cases) {
      cleanup();
      Object.values(api).forEach((m) => m.mockReset());
      readyAgency();
      testCase.arrange();
      render(<StoreRegisterPage />);
      await testCase.reach();
      const main = await screen.findByRole('main');
      // 直下テキストで見る（Alert の説明の受け口へ移っても、装飾の子へ落ちれば赤くなる）。
      await within(main).findByText(testCase.text);
      expect(ownTextsIn(main), testCase.name).toContain(testCase.text);
      visited += 1;
    }
    expect(visited).toBe(cases.length);
  });

  it('確定の失敗はサーバの文言をそのまま提示する（Req 3.2）', async () => {
    stubHappyPath();
    api.registerStore.mockResolvedValue({
      ok: false,
      code: 'internal',
      message: '一時的な障害です。',
    });
    render(<StoreRegisterPage />);
    const main = await advanceToStep('basic');
    fireEvent.click(within(main).getByRole('button', { name: '登録を確定' }));
    expect(await within(main).findByText('一時的な障害です。')).toBeTruthy();
  });

  it('オーナー取得に失敗すると取得側の文言をそのまま提示する（Req 3.2）', async () => {
    api.getOwners.mockResolvedValue({
      ok: false,
      code: 'internal',
      message: 'オーナー取得に失敗しました。',
    });
    render(<StoreRegisterPage />);
    const scope = within(await screen.findByRole('main'));
    expect(await scope.findByText('オーナー取得に失敗しました。')).toBeTruthy();
    // 失敗時は処理中の文言を出さない（両方が同時に出ると状態が読めない）。
    expect(scope.queryByText('読み込み中...')).toBeNull();
  });

  // --- 候補確認と基本情報の提示（Req 3.2）------------------------------------

  it('候補確認と基本情報の両方の段で店名と住所を提示する（Req 3.2）', async () => {
    stubHappyPath();
    render(<StoreRegisterPage />);
    let visited = 0;
    for (const step of ['confirm', 'basic'] as const) {
      restart();
      const main = await advanceToStep(step);
      const texts = ownTextsIn(main);
      expect(texts, step).toContain('店名: 鳥貴族 渋谷店');
      expect(texts, step).toContain('住所: 東京都渋谷区1-1');
      visited += 1;
    }
    expect(visited).toBe(2);
  });

  // --- 無効状態の配線（Req 3.5）----------------------------------------------

  it('オーナー未選択の間は次への押しボタンを無効属性で止める（Req 3.5）', async () => {
    api.getOwners.mockResolvedValue({ ok: true, value: [owner] });
    render(<StoreRegisterPage />);
    const scope = within(await screen.findByRole('main'));
    const next = await scope.findByRole('button', { name: '次へ（店名検索）' });
    // 無効の通知手段は素の無効属性のままにする（焦点の到達を要求する箇所とは別枠・Req 3.5）。
    expect(next.hasAttribute('disabled')).toBe(true);
    fireEvent.change(await scope.findByLabelText('オーナー'), { target: { value: 'o1' } });
    expect(
      scope.getByRole('button', { name: '次へ（店名検索）' }).hasAttribute('disabled'),
    ).toBe(false);
  });

  it('店名が空の間と検索中は検索の押しボタンを無効属性で止める（Req 3.5）', async () => {
    api.getOwners.mockResolvedValue({ ok: true, value: [owner] });
    // 解決しない約束で検索中の分岐に留める。
    api.searchStores.mockReturnValue(new Promise(() => {}));
    render(<StoreRegisterPage />);
    const scope = within(await screen.findByRole('main'));
    fireEvent.change(await scope.findByLabelText('オーナー'), { target: { value: 'o1' } });
    fireEvent.click(scope.getByRole('button', { name: '次へ（店名検索）' }));

    expect(scope.getByRole('button', { name: '検索' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(await scope.findByLabelText('店名'), { target: { value: '鳥貴族' } });
    expect(scope.getByRole('button', { name: '検索' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(scope.getByRole('button', { name: '検索' }));
    expect(scope.getByRole('button', { name: '検索' }).hasAttribute('disabled')).toBe(true);
  });

  it('確定の送信中は登録の押しボタンを無効属性で止める（Req 3.5）', async () => {
    stubHappyPath();
    api.registerStore.mockReturnValue(new Promise(() => {}));
    render(<StoreRegisterPage />);
    const main = await advanceToStep('basic');
    const scope = within(main);
    expect(scope.getByRole('button', { name: '登録を確定' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(scope.getByRole('button', { name: '登録を確定' }));
    expect(scope.getByRole('button', { name: '登録を確定' }).hasAttribute('disabled')).toBe(true);
  });

  // --- 選択と記入欄（Req 3.4）------------------------------------------------

  it('選択 3 つはラベルから選択要素として掴め、値の直接変更が届く（Req 3.4）', async () => {
    // 代理店の選択は operator にしか出ない。**分岐を変えて 3 つとも通る**。
    readyOperator();
    api.getAgencies.mockResolvedValue({ ok: true, value: [{ id: 'a1', name: '代理店A' }] });
    api.getOwners.mockResolvedValue({ ok: true, value: [owner] });
    api.getCategories.mockResolvedValue({ ok: true, value: [{ code: 'izakaya', label: '居酒屋' }] });
    api.searchStores.mockResolvedValue({ ok: true, value: [candidate] });
    render(<StoreRegisterPage />);
    const scope = within(await screen.findByRole('main'));

    const agency = await scope.findByLabelText('代理店');
    // id・値の変更はいずれも **選択要素そのもの** から読めること
    // （包む要素へ移ると支援技術もプログラムによる操作も届かない）。
    expect(agency.tagName).toBe('SELECT');
    expect(agency.getAttribute('id')).toBe('agency-select');
    fireEvent.change(agency, { target: { value: 'a1' } });
    expect((agency as HTMLSelectElement).value).toBe('a1');
    expect(api.getOwners).toHaveBeenCalledWith({ agencyId: 'a1' });

    const ownerSelect = await scope.findByLabelText('オーナー');
    expect(ownerSelect.tagName).toBe('SELECT');
    expect(ownerSelect.getAttribute('id')).toBe('owner-select');
    fireEvent.change(ownerSelect, { target: { value: 'o1' } });
    expect((ownerSelect as HTMLSelectElement).value).toBe('o1');

    fireEvent.click(scope.getByRole('button', { name: '次へ（店名検索）' }));
    fireEvent.change(await scope.findByLabelText('店名'), { target: { value: '鳥貴族' } });
    fireEvent.click(scope.getByRole('button', { name: '検索' }));
    fireEvent.click(await scope.findByRole('button', { name: /鳥貴族 渋谷店/ }));
    fireEvent.click(await scope.findByRole('button', { name: 'この店舗で進む' }));

    const category = await scope.findByLabelText('カテゴリ（任意）');
    expect(category.tagName).toBe('SELECT');
    expect(category.getAttribute('id')).toBe('category-select');
    fireEvent.change(category, { target: { value: 'izakaya' } });
    expect((category as HTMLSelectElement).value).toBe('izakaya');
  });

  it('店名の記入欄はラベルから掴め、値の直接変更が届く（Req 3.4）', async () => {
    api.getOwners.mockResolvedValue({ ok: true, value: [owner] });
    render(<StoreRegisterPage />);
    const scope = within(await screen.findByRole('main'));
    fireEvent.change(await scope.findByLabelText('オーナー'), { target: { value: 'o1' } });
    fireEvent.click(scope.getByRole('button', { name: '次へ（店名検索）' }));
    const input = await scope.findByLabelText('店名');
    expect(input.tagName).toBe('INPUT');
    expect(input.getAttribute('id')).toBe('store-name-input');
    fireEvent.change(input, { target: { value: '鳥貴族' } });
    expect((input as HTMLInputElement).value).toBe('鳥貴族');
  });

  it('operator は代理店を選ぶまでオーナー選択も処理中も出さない（Req 3.2）', async () => {
    readyOperator();
    api.getAgencies.mockResolvedValue({ ok: true, value: [{ id: 'a1', name: '代理店A' }] });
    render(<StoreRegisterPage />);
    const scope = within(await screen.findByRole('main'));
    await scope.findByLabelText('代理店');
    expect(scope.queryByLabelText('オーナー')).toBeNull();
    // 処理中の文言は agency 側だけの分岐である（operator では代理店選択が先行する）。
    expect(scope.queryByText('読み込み中...')).toBeNull();
    expect(api.getOwners).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 意匠の適用そのもの（task 5.1 = 検索の帯と候補一覧 / task 5.2 = 段階表示とフォーム）
// ---------------------------------------------------------------------------

/** 面のソース。className の literal を実物から読むための単一の経路。 */
const SURFACE_PATH = resolve(process.cwd(), 'src/app/stores/new/page.tsx');

/** ソース中の className リテラルを全て取り出し、空白区切りの語へ割る。 */
function classTokensInSource(): string[] {
  expect(existsSync(SURFACE_PATH), SURFACE_PATH).toBe(true);
  const source = readFileSync(SURFACE_PATH, 'utf8');
  const literals = source.match(/className="([^"]*)"/g) ?? [];
  // 実物へ届いていないまま「一致している」と読まないための前置き（Req 7.4）。
  expect(literals.length, 'className の literal が 1 つも無い').toBeGreaterThan(0);
  return literals.flatMap((literal) =>
    literal
      .replace(/^className="/, '')
      .replace(/"$/, '')
      .split(/\s+/)
      .filter((token) => token !== ''),
  );
}

describe('店舗登録ウィザード: 検索の帯と候補一覧（task 5.1・Req 1.1, 3.2）', () => {
  it('検索の段はラベル・記入欄・押しボタンを 1 つの帯状の容器へ収める（Req 1.1）', async () => {
    stubHappyPath();
    render(<StoreRegisterPage />);
    const main = await advanceToStep('search');

    // 容器は共通部品から来る（面の側が塗りと角丸を手書きしない）。
    const bands = main.querySelectorAll('[data-slot="card"]');
    expect(bands).toHaveLength(1);
    const band = bands[0]!;
    // ラベル・記入欄・押しボタンが同じ箱の中にある = 帯である。
    expect(band.contains(within(main).getByLabelText('店名'))).toBe(true);
    expect(band.contains(within(main).getByText('店名'))).toBe(true);
    expect(band.contains(within(main).getByRole('button', { name: '検索' }))).toBe(true);
  });

  it('記入欄・ラベル・押しボタンを共通部品から描画する（Req 1.1, 1.2）', async () => {
    stubHappyPath();
    render(<StoreRegisterPage />);
    const main = await advanceToStep('search');
    const scope = within(main);
    expect(scope.getByLabelText('店名').getAttribute('data-slot')).toBe('input');
    expect(scope.getByText('店名').getAttribute('data-slot')).toBe('label');
    expect(scope.getByRole('button', { name: '検索' }).getAttribute('data-slot')).toBe('button');
  });

  it('候補は題名・補足・右端の指示子だけを積み、写真前提の意匠を採らない（正典 §7.6）', async () => {
    stubHappyPath();
    render(<StoreRegisterPage />);
    const scope = within(await screen.findByRole('main'));
    await selectOwnerAndSearchTo(scope, '鳥貴族');
    const item = await scope.findByRole('button', { name: '鳥貴族 渋谷店（東京都渋谷区1-1）' });

    // 押しボタンのままである（リンクにも別の役割にもしない・Req 3.3）。
    expect(item.tagName).toBe('BUTTON');
    expect(item.getAttribute('data-slot')).toBe('button');

    // 題名と補足が別々の行として積まれている。
    const stacked = Array.from(item.querySelectorAll('span')).map((span) => ownText(span));
    expect(stacked).toContain('鳥貴族 渋谷店');
    expect(stacked).toContain('（東京都渋谷区1-1）');

    // 右端の指示子は装飾であり、読み上げ名へ混ざらない。
    const indicators = item.querySelectorAll('svg[aria-hidden="true"]');
    expect(indicators).toHaveLength(1);

    // **写真プレートを前提にした意匠を採らない**（応答に写真は無く、空の矩形が並ぶだけになる）。
    expect(item.querySelector('img')).toBeNull();
    expect(item.getAttribute('class') ?? '').not.toMatch(/aspect-/);
    expect(item.innerHTML).not.toMatch(/aspect-/);
  });

  it('輪郭を打ち消すユーティリティを面の側に書かない（Req 4.1）', () => {
    const tokens = classTokensInSource();
    // フォーカス指標は theme.css の base 層へ一本化されている。面の側で打ち消すと
    // カスケードレイヤの順序により必ず勝ってしまい、焦点が不可視になる（Issue #49）。
    const cancels = tokens.filter((token) =>
      /(^|:)(outline-none|outline-0|ring-0|border-0|shadow-none|focus:outline-none)$/.test(token),
    );
    expect(cancels).toEqual([]);
  });
});

describe('店舗登録ウィザード: 段階表示とフォーム（task 5.2・Req 1.1, 2.3, 3.4）', () => {
  it('5 段階の進行を一覧で示し、現在の段だけに現在地の印を付ける（Req 1.1）', async () => {
    stubHappyPath();
    render(<StoreRegisterPage />);

    const expected = [
      ['owner', 'オーナー選択'],
      ['search', '店名検索'],
      ['confirm', '店舗の確認'],
      ['basic', '基本情報'],
      ['done', '完了'],
    ] as const;

    let visited = 0;
    for (const [step, label] of expected) {
      restart();
      const main = await advanceToStep(step);
      const scope = within(main);

      // ナビゲーション領域にはしない（帯が既に 1 つ持っており、2 つ目が増える・Req 3.3）。
      const progress = scope.getByRole('list', { name: '登録の進行' });
      expect(progress.tagName, step).toBe('OL');
      const items = within(progress).getAllByRole('listitem');
      expect(items, step).toHaveLength(expected.length);

      // 現在地はちょうど 1 つ。**5 段すべて**で見る（片方の段だけの照合では
      // 「常に先頭が現在地」のような改変が緑のまま通る。2.1 の教訓）。
      const current = items.filter((item) => item.getAttribute('aria-current') === 'step');
      expect(current, step).toHaveLength(1);
      expect(ownText(current[0]!), step).toContain(label);
      // 何番目が現在地かまで固定する（順序を入れ替える改変を捕まえる）。
      expect(items.indexOf(current[0]!), step).toBe(visited);
      visited += 1;
    }
    expect(visited).toBe(expected.length);
  });

  it('段階表示の現在地の印と見た目は同じ判定から出る（正典 §7.8 と同型）', async () => {
    stubHappyPath();
    render(<StoreRegisterPage />);
    const main = await advanceToStep('owner');
    const progress = within(main).getByRole('list', { name: '登録の進行' });
    const items = within(progress).getAllByRole('listitem');

    // 全項目の class 文字列が同一であること。条件分岐を class 側に持たせると
    // 「印は付くのに線が出ない」「線は出るのに印が無い」状態を作れてしまう。
    const classes = new Set(items.map((item) => item.getAttribute('class') ?? ''));
    expect(classes.size).toBe(1);

    // **包含では足りない**（既定側を `border-current` へ変えるだけで全項目が恒久的に
    // 線を持つのに包含は成立する。2.1 で差し戻された穴）。border-color を与える語の
    // **集合の完全一致**で見る。`border-b-2` は末尾が数字なので網に入らない（太さであり色ではない）。
    const tokens = (Array.from(classes)[0] ?? '').split(/\s+/).filter((t) => t !== '');
    const borderColorTokens = tokens.filter((t) => /(^|:)border-(?:b-|y-)?[a-z]+$/.test(t));
    expect(borderColorTokens).toEqual([
      'border-transparent',
      'aria-[current=step]:border-current',
    ]);
  });

  it('版面は本文系の外枠部品で描き、主要領域を入れ子にしない（Req 1.1）', async () => {
    stubHappyPath();
    render(<StoreRegisterPage />);
    const main = await screen.findByRole('main');
    // 既存の main を **置換** する（入れ子にすると主要領域が 2 つになる）。
    expect(main.getAttribute('data-slot')).toBe('page-shell');
    // 一覧ではなくウィザードのフォームが主体なので本文系の版面を使う。
    expect(main.getAttribute('data-width')).toBe('sm');
    expect(main.querySelector('[data-slot="page-shell"]')).toBeNull();
  });

  it('主見出しと段の見出しを共通の見出し部品から描画する（Req 1.1）', async () => {
    stubHappyPath();
    render(<StoreRegisterPage />);
    let visited = 0;
    for (const step of ['owner', 'search', 'confirm', 'basic', 'done'] as const) {
      restart();
      const main = await advanceToStep(step);
      const scope = within(main);
      expect(scope.getByRole('heading', { level: 1 }).getAttribute('data-slot'), step).toBe(
        'heading',
      );
      expect(scope.getByRole('heading', { level: 2 }).getAttribute('data-slot'), step).toBe(
        'heading',
      );
      visited += 1;
    }
    expect(visited).toBe(5);
  });

  it('選択 3 つを選択の部品で描き、包む要素を段落にしない（Req 1.1, 3.4）', async () => {
    // 代理店の選択は operator にしか出ない。**分岐を変えて 3 つとも通る**。
    readyOperator();
    api.getAgencies.mockResolvedValue({ ok: true, value: [{ id: 'a1', name: '代理店A' }] });
    api.getOwners.mockResolvedValue({ ok: true, value: [owner] });
    api.getCategories.mockResolvedValue({ ok: true, value: [{ code: 'izakaya', label: '居酒屋' }] });
    api.searchStores.mockResolvedValue({ ok: true, value: [candidate] });
    render(<StoreRegisterPage />);
    const scope = within(await screen.findByRole('main'));

    async function assertSelect(label: string) {
      const select = await scope.findByLabelText(label);
      expect(select.getAttribute('data-slot'), label).toBe('select');
      // 選択の部品は開閉の記号を重ねるために div を 1 枚挟む。段落の直下には置けない
      // （置くとブラウザの構文解析が段落を早期に閉じ、描画の木が食い違う）。
      expect(select.parentElement?.getAttribute('data-slot'), label).toBe('select-wrapper');
      expect(select.closest('p'), label).toBeNull();
      // ラベルも共通部品から来る。
      expect(scope.getByText(label).getAttribute('data-slot'), label).toBe('label');
    }

    await assertSelect('代理店');
    fireEvent.change(await scope.findByLabelText('代理店'), { target: { value: 'a1' } });
    await assertSelect('オーナー');

    fireEvent.change(await scope.findByLabelText('オーナー'), { target: { value: 'o1' } });
    fireEvent.click(scope.getByRole('button', { name: '次へ（店名検索）' }));
    fireEvent.change(await scope.findByLabelText('店名'), { target: { value: '鳥貴族' } });
    fireEvent.click(scope.getByRole('button', { name: '検索' }));
    fireEvent.click(await scope.findByRole('button', { name: /鳥貴族 渋谷店/ }));
    fireEvent.click(await scope.findByRole('button', { name: 'この店舗で進む' }));
    await assertSelect('カテゴリ（任意）');
  });

  it('処理中は文言を可視のまま残し、回転する図形を装飾として添える（Req 1.1, 4.5）', () => {
    api.getOwners.mockReturnValue(new Promise(() => {}));
    render(<StoreRegisterPage />);
    const main = screen.getByRole('main');

    const regions = within(main).getAllByRole('status');
    expect(regions).toHaveLength(1);
    const region = regions[0]!;
    // 文言が sr-only の子（Spinner の aria-label 経由）へ落ちていないことを構造で確かめる。
    // `<Spinner aria-label="読み込み中..." />` の 1 要素へ畳むとここが空になる。
    expect(ownText(region)).toBe('読み込み中...');
    // 図形側に aria-hidden が付いていないと読み上げ領域が二重になり、この値も二重になる。
    expect(announcedText(region)).toBe('読み込み中...');
    const spinner = region.querySelector('[data-slot="spinner"]');
    expect(spinner).not.toBeNull();
    expect(spinner!.getAttribute('aria-hidden')).toBe('true');
  });

  it('7 経路の通知が同じ危険の通知部品に載り、読み上げ役割を二重にしない（Req 1.1, 3.5）', async () => {
    const branches = [
      {
        name: 'オーナー取得の失敗',
        text: 'オーナー取得に失敗しました。',
        arrange: () => {
          api.getOwners.mockResolvedValue({
            ok: false,
            code: 'internal',
            message: 'オーナー取得に失敗しました。',
          });
        },
        reach: async () => {},
      },
      {
        name: '対象オーナー 0 件',
        text: '対象オーナーがいません。オーナーが先に LINE で招待コード入力を済ませる必要があります。',
        arrange: () => {
          api.getOwners.mockResolvedValue({ ok: true, value: [] });
        },
        reach: async () => {},
      },
      {
        name: '検索 0 件',
        text: '見つかりませんでした。表記を変えて再検索してください。',
        arrange: () => {
          api.getOwners.mockResolvedValue({ ok: true, value: [owner] });
          api.searchStores.mockResolvedValue({ ok: true, value: [] });
        },
        reach: async () => {
          await selectOwnerAndSearchTo(within(await screen.findByRole('main')), 'zzz');
        },
      },
      {
        name: '検索の失敗',
        text: '検索に失敗しました。時間をおいて再試行してください。',
        arrange: () => {
          api.getOwners.mockResolvedValue({ ok: true, value: [owner] });
          api.searchStores.mockResolvedValue({ ok: false, code: 'places_error', message: 'x' });
        },
        reach: async () => {
          await selectOwnerAndSearchTo(within(await screen.findByRole('main')), 'x');
        },
      },
      {
        name: '既登録',
        text: '既に登録済みの店舗です。',
        arrange: () => {
          stubHappyPath();
          api.registerStore.mockResolvedValue({
            ok: false,
            code: 'place_already_registered',
            message: 'x',
          });
        },
        reach: async () => {
          const main = await advanceToStep('basic');
          fireEvent.click(within(main).getByRole('button', { name: '登録を確定' }));
        },
      },
      {
        name: '権限外',
        text: 'この操作を行う権限がありません。運営までお問い合わせください。',
        arrange: () => {
          stubHappyPath();
          api.registerStore.mockResolvedValue({ ok: false, code: 'forbidden', message: 'x' });
        },
        reach: async () => {
          const main = await advanceToStep('basic');
          fireEvent.click(within(main).getByRole('button', { name: '登録を確定' }));
        },
      },
      {
        name: '確定のその他の失敗',
        text: '一時的な障害です。',
        arrange: () => {
          stubHappyPath();
          api.registerStore.mockResolvedValue({
            ok: false,
            code: 'internal',
            message: '一時的な障害です。',
          });
        },
        reach: async () => {
          const main = await advanceToStep('basic');
          fireEvent.click(within(main).getByRole('button', { name: '登録を確定' }));
        },
      },
    ];

    let visited = 0;
    for (const branch of branches) {
      cleanup();
      Object.values(api).forEach((m) => m.mockReset());
      readyAgency();
      branch.arrange();
      render(<StoreRegisterPage />);
      await branch.reach();
      const main = await screen.findByRole('main');
      const alert = await within(main).findByText(branch.text);

      // 危険を伝える変種は読み上げ役割 alert を **自ら** 持つ。
      const container = alert.closest('[data-slot="alert"]');
      expect(container, branch.name).not.toBeNull();
      expect(container!.getAttribute('role'), branch.name).toBe('alert');
      // 文言の側へ role を重ねると読み上げ領域が二重になる。
      expect(container!.querySelector('[role="alert"]'), branch.name).toBeNull();
      expect(alert.getAttribute('data-slot'), branch.name).toBe('alert-description');
      visited += 1;
    }
    expect(visited).toBe(branches.length);
  });

  it('面の側に色ユーティリティを持ち込まない（Req 1.4, 6.1）', () => {
    const tokens = classTokensInSource();

    // 色を運びうる接頭辞のうち、この面が持ってよいのは
    //  - 文字の寸法・揃え（意匠の値ではなく共有スケール §6）
    //  - 現在地の罫の対（正典 §7.8 と同型。`border-current` は currentColor を借りるので
    //    「面の側に置く色」の閉じた集合を 1 件も広げない）
    // だけである。**集合の完全一致**で見る（包含では 1 件足す改変を捕まえられない）。
    const colorish = tokens.filter((token) =>
      /(^|:)(bg|text|border|ring|outline|fill|stroke|decoration|shadow|accent|caret|placeholder|from|via|to)-(?!\[)[a-z][a-z-]*$/.test(
        token,
      ),
    );
    const allowed = [
      'text-sm',
      'text-xs',
      'text-left',
      'border-transparent',
      'aria-[current=step]:border-current',
    ];
    expect(colorish.filter((token) => !allowed.includes(token))).toEqual([]);
  });
});
