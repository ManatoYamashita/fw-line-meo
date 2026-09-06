// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { announcedText, ownText } from './live-region';

// 認証コンテキストはモックし、ready な operator/agency を注入する（invite-codes-page.test と同規約）。
const useAuthMock = vi.fn();
vi.mock('../src/lib/auth-context', () => ({ useAuth: () => useAuthMock() }));

// next/navigation・next/link はブラウザランタイム依存のためモックする。
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  // 帯（TopNav）が現在地の判定に使う。このページの実経路を返し、偽装が嘘をつかないようにする。
  usePathname: () => '/admin/agencies',
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

// api クライアントは代理店系メソッドをモックし、ネットワーク・firebase を発火させない。
const api = vi.hoisted(() => ({
  getAgencies: vi.fn(),
  createAgency: vi.fn(),
}));
vi.mock('../src/lib/api', () => api);

import AdminAgenciesPage from '../src/app/admin/agencies/page';

function ready(role: 'operator' | 'agency') {
  useAuthMock.mockReturnValue({
    status: 'ready',
    me: {
      role,
      agencyId: role === 'agency' ? 'a1' : null,
      agencyName: role === 'agency' ? '代理店A' : null,
      displayName: 'テスト',
    },
    signIn: vi.fn(),
    signOut: vi.fn(),
  });
}

const agencyAlpha = { id: 'a1', operatorId: 'op1', name: '代理店アルファ', createdAt: '2026-01-01T00:00:00Z' };

beforeEach(() => {
  useAuthMock.mockReset();
  Object.values(api).forEach((m) => m.mockReset());
});
afterEach(cleanup);

describe('代理店管理ページ（operator）', () => {
  it('一覧を表示し、代理店作成フォームを提供する（Req 6.1）', async () => {
    ready('operator');
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    render(<AdminAgenciesPage />);
    const scope = within(await screen.findByRole('main'));
    expect(await scope.findByText('代理店アルファ')).toBeTruthy();
    expect(scope.getByLabelText('代理店名')).toBeTruthy();
    expect(scope.getByRole('button', { name: '代理店作成' })).toBeTruthy();
  });

  it('代理店名を送信すると createAgency({name}) を呼び、一覧を再取得する（Req 6.1）', async () => {
    ready('operator');
    api.getAgencies
      .mockResolvedValueOnce({ ok: true, value: [] }) // 初期ロード
      .mockResolvedValueOnce({ ok: true, value: [{ ...agencyAlpha, name: '新代理店' }] }); // 作成後の再取得
    api.createAgency.mockResolvedValue({ ok: true, value: { ...agencyAlpha, name: '新代理店' } });
    render(<AdminAgenciesPage />);
    const scope = within(await screen.findByRole('main'));
    fireEvent.change(await scope.findByLabelText('代理店名'), { target: { value: '新代理店' } });
    fireEvent.click(scope.getByRole('button', { name: '代理店作成' }));
    expect(await scope.findByText('新代理店')).toBeTruthy();
    expect(api.createAgency).toHaveBeenCalledTimes(1);
    expect(api.createAgency.mock.calls[0]?.[0]).toEqual({ name: '新代理店' });
  });

  it('空名の送信は日本語エラーを表示しクラッシュせず、createAgency を呼ばない（Req 6.1）', async () => {
    ready('operator');
    api.getAgencies.mockResolvedValue({ ok: true, value: [] });
    render(<AdminAgenciesPage />);
    const scope = within(await screen.findByRole('main'));
    await scope.findByLabelText('代理店名');
    fireEvent.click(scope.getByRole('button', { name: '代理店作成' }));
    expect(await scope.findByText(/代理店名を入力してください/)).toBeTruthy();
    expect(api.createAgency).not.toHaveBeenCalled();
  });
});

describe('代理店管理ページ（agency ロール）', () => {
  it('運営のみ利用可能の 403 案内を出し、一覧・フォームを描画せず getAgencies を呼ばない（Req 6.5）', async () => {
    ready('agency');
    render(<AdminAgenciesPage />);
    const scope = within(await screen.findByRole('main'));
    expect(await scope.findByText(/この画面は運営のみ利用できます/)).toBeTruthy();
    // 管理情報・作成手段を一切描画しない。
    expect(scope.queryByLabelText('代理店名')).toBeNull();
    expect(scope.queryByRole('button', { name: '代理店作成' })).toBeNull();
    // 依存 API を発火させない（クライアント側ゲート）。
    expect(api.getAgencies).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ui-airbnb-surfaces task 2.4。以下は本タスクで追加した照合である。
//
// 上の 4 件は「作成が正しい引数で呼ばれる」ことだけを見ており、意匠の適用が壊しうる契約
// （処理中の文言・0 件の案内・列見出し・取得失敗と作成失敗の分岐そのもの・主見出し）には
// 照合が **1 件も無かった**。実装に触れる前にここで固定し、素の実装に対して緑になることを
// 確認してから部品化へ進んだ。
// ---------------------------------------------------------------------------

/** 走査範囲の全要素について、**直下のテキストノードだけ**を繋いだ文字列を集める。 */
function ownTextsIn(scope: HTMLElement): string[] {
  return Array.from(scope.querySelectorAll('*')).map((element) => ownText(element));
}

describe('代理店管理ページ: 着手前から在った契約（意匠の適用で壊しうる）', () => {
  it('一覧の列見出しの読み上げ文字列を変更しない（Req 6.1）', async () => {
    ready('operator');
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    render(<AdminAgenciesPage />);
    const scope = within(await screen.findByRole('main'));
    await scope.findByText('代理店アルファ');
    // **集合の完全一致**で見る。包含では列を 1 つ足す改変を捕まえられない。
    expect(scope.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      '代理店名',
      '作成日時',
    ]);
  });

  it('処理中の文言は ASCII 3 点である（三点リーダへ揃えない・Req 7.3）', () => {
    ready('operator');
    api.getAgencies.mockReturnValue(new Promise(() => {}));
    render(<AdminAgenciesPage />);
    const main = screen.getByRole('main');
    const texts = ownTextsIn(main);
    expect(texts).toContain('読み込み中...');
    expect(texts).not.toContain('読み込み中…');
  });

  it('0 件の案内文言を変更しない（Req 6.1）', async () => {
    ready('operator');
    api.getAgencies.mockResolvedValue({ ok: true, value: [] });
    render(<AdminAgenciesPage />);
    const scope = within(await screen.findByRole('main'));
    expect(await scope.findByText('代理店はまだありません。作成してください。')).toBeTruthy();
  });

  it('一覧の取得失敗は案内だけを出し、データを偽装しない（Req 7.4）', async () => {
    ready('operator');
    api.getAgencies.mockResolvedValue({
      ok: false,
      code: 'network',
      message: '取得に失敗しました',
    });
    render(<AdminAgenciesPage />);
    const scope = within(await screen.findByRole('main'));
    expect(await scope.findByText('取得に失敗しました')).toBeTruthy();
    // 表も 0 件案内も出さない（空の一覧を「0 件」と偽らない）。
    expect(scope.queryByRole('table')).toBeNull();
    expect(scope.queryByText('代理店はまだありません。作成してください。')).toBeNull();
  });

  it('作成の失敗はサーバー由来の語ではなく日本語の案内を出す（Req 6.1, 7.4）', async () => {
    ready('operator');
    api.getAgencies.mockResolvedValue({ ok: true, value: [] });
    api.createAgency.mockResolvedValue({ ok: false, code: 'server_error', message: 'boom' });
    render(<AdminAgenciesPage />);
    const scope = within(await screen.findByRole('main'));
    fireEvent.change(await scope.findByLabelText('代理店名'), { target: { value: '新代理店' } });
    fireEvent.click(scope.getByRole('button', { name: '代理店作成' }));
    expect(
      await scope.findByText('代理店の作成に失敗しました。時間をおいて再試行してください。'),
    ).toBeTruthy();
    expect(scope.queryByText('boom')).toBeNull();
  });

  it('主見出しの読み上げ名と階層を、運営・代理店の両分岐で変更しない（Req 6.1, 6.5）', async () => {
    let visited = 0;
    for (const role of ['operator', 'agency'] as const) {
      ready(role);
      api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
      render(<AdminAgenciesPage />);
      await screen.findByRole('main');
      expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent), role).toEqual([
        '代理店管理',
      ]);
      visited += 1;
      cleanup();
      api.getAgencies.mockReset();
    }
    // 走査対象が 1 件も無い状態で緑にならないようにする。
    expect(visited).toBe(2);
  });

  it('運営専用の案内文言を完全一致で固定する（Req 6.5）', async () => {
    ready('agency');
    render(<AdminAgenciesPage />);
    const scope = within(await screen.findByRole('main'));
    expect(await scope.findByText('この画面は運営のみ利用できます。')).toBeTruthy();
  });
});

// --- 意匠の適用（task 2.4）------------------------------------------------------------

interface SurfaceBranch {
  /** 失敗メッセージへ出す分岐名（どの分岐が壊れたかを名指しさせる）。 */
  readonly name: string;
  readonly role: 'operator' | 'agency';
  /** 取得結果の偽装。 */
  readonly arrange: () => void;
  /** その分岐が実際に描かれたことの確認（描かれない状態を緑と読まないための前置き）。 */
  readonly settle: () => Promise<unknown>;
}

// **403 の分岐は別の return を持つ**（task 2.2 のログイン画面と同型）。片側だけを走査する照合は
// 「403 の版面だけ狭い」という改変に対して証明可能に盲目になるため、5 分岐すべてを回す。
const SURFACE_BRANCHES: readonly SurfaceBranch[] = [
  {
    // 403 は API を一切叩かず別の return を返す。ここを配列から外すと
    // 「403 の版面だけ狭い」という改変が緑のまま通る（実際にそうなることを実測した）。
    name: 'agency/運営専用の案内',
    role: 'agency',
    arrange: () => {},
    settle: () => screen.findByText('この画面は運営のみ利用できます。'),
  },
  {
    name: 'operator/取得中',
    role: 'operator',
    arrange: () => {
      // 解決しない約束を返して取得中の分岐に留める。
      api.getAgencies.mockReturnValue(new Promise(() => {}));
    },
    settle: () => screen.findByText('読み込み中...'),
  },
  {
    name: 'operator/失敗',
    role: 'operator',
    arrange: () => {
      api.getAgencies.mockResolvedValue({
        ok: false,
        code: 'network',
        message: '取得に失敗しました',
      });
    },
    settle: () => screen.findByRole('alert'),
  },
  {
    name: 'operator/0 件',
    role: 'operator',
    arrange: () => {
      api.getAgencies.mockResolvedValue({ ok: true, value: [] });
    },
    settle: () => screen.findByText('代理店はまだありません。作成してください。'),
  },
  {
    name: 'operator/1 件以上',
    role: 'operator',
    arrange: () => {
      api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    },
    settle: () => screen.findByText('代理店アルファ'),
  },
];

describe('代理店管理ページ: 意匠の適用', () => {
  it('どの分岐でも一覧系の広い版面へ置換し、主要領域を 1 つに保つ（Req 1.1, 1.5, 3.3）', async () => {
    let visited = 0;
    for (const branch of SURFACE_BRANCHES) {
      useAuthMock.mockReset();
      Object.values(api).forEach((mock) => mock.mockReset());
      ready(branch.role);
      branch.arrange();
      const { container } = render(<AdminAgenciesPage />);
      await branch.settle();

      const shell = container.querySelector('[data-slot="page-shell"]');
      expect(shell, branch.name).not.toBeNull();
      // 版面は 2 段しかない。一覧が主なので広い側を使う。
      expect(shell!.getAttribute('data-width'), branch.name).toBe('lg');
      // 既存の main を **置換** する（入れ子にしない）。
      expect(shell!.tagName, branch.name).toBe('MAIN');
      expect(container.querySelectorAll('main'), branch.name).toHaveLength(1);
      // **包含では足りない**。max-w-* を後ろへ足せば data-width は lg のまま実効の版面だけが縮む。
      const tokens = shell!.className.split(/\s+/).filter((token) => token.length > 0);
      expect(
        tokens.filter((token) => /(^|:)(?:max-|min-)?w-/.test(token)),
        branch.name,
      ).toEqual(['w-full', 'max-w-7xl']);
      visited += 1;
      cleanup();
    }
    // 走査対象が 1 件も無い状態で緑にならないようにする（要件 7.4）。
    expect(visited).toBe(SURFACE_BRANCHES.length);
  });

  it('主見出しを見出しの部品で描き、読み上げ名と階層を変えない（両分岐・Req 1.1, 3.2）', async () => {
    let visited = 0;
    for (const role of ['operator', 'agency'] as const) {
      useAuthMock.mockReset();
      Object.values(api).forEach((mock) => mock.mockReset());
      ready(role);
      api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
      render(<AdminAgenciesPage />);
      const heading = await screen.findByRole('heading', { level: 1, name: '代理店管理' });
      expect(heading.getAttribute('data-slot'), role).toBe('heading');
      expect(heading.getAttribute('data-level'), role).toBe('1');
      expect(screen.getAllByRole('heading', { level: 1 }), role).toHaveLength(1);
      visited += 1;
      cleanup();
    }
    expect(visited).toBe(2);
  });

  it('一覧を表の部品で描き、行・列・セルの役割を保つ（Req 2.1, 2.2）', async () => {
    ready('operator');
    api.getAgencies.mockResolvedValue({
      ok: true,
      value: [agencyAlpha, { ...agencyAlpha, id: 'a2', name: '代理店ベータ' }],
    });
    render(<AdminAgenciesPage />);
    const scope = within(await screen.findByRole('main'));
    await scope.findByText('代理店アルファ');

    const table = scope.getByRole('table');
    expect(table.getAttribute('data-slot')).toBe('table');
    expect(table.querySelector('thead')?.getAttribute('data-slot')).toBe('table-head');
    expect(table.querySelector('tbody')?.getAttribute('data-slot')).toBe('table-body');

    // **集合の完全一致**で見る。素の <tr> を 1 行だけ混ぜる改変を包含判定は捕まえない。
    expect(scope.getAllByRole('row').map((row) => row.getAttribute('data-slot'))).toEqual([
      'table-row',
      'table-row',
      'table-row',
    ]);
    const headers = scope.getAllByRole('columnheader');
    expect(headers.map((header) => header.getAttribute('data-slot'))).toEqual([
      'table-header-cell',
      'table-header-cell',
    ]);
    // 素の <th> は scope を持っていなかった。部品化で支援技術に対する後退を作らない。
    expect(headers.map((header) => header.getAttribute('scope'))).toEqual(['col', 'col']);
    expect(scope.getAllByRole('cell').map((cell) => cell.getAttribute('data-slot'))).toEqual(
      Array.from({ length: 4 }, () => 'table-cell'),
    );
  });

  it('横方向の捲りは表の外側の容器が担い、キーボードで到達できる（Req 2.5, 4.1）', async () => {
    ready('operator');
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    render(<AdminAgenciesPage />);
    const main = await screen.findByRole('main');
    await within(main).findByText('代理店アルファ');

    const table = within(main).getByRole('table');
    const container = table.parentElement;
    expect(container?.getAttribute('data-slot')).toBe('table-container');
    // 捲る領域が焦点を得られないと、溢れて隠れた列へ到達する手段が無くなる（WCAG 2.1.1）。
    expect(container?.getAttribute('tabindex')).toBe('0');
    // 面の側で捲れる領域を増やさない（増やすと e2e の件数宣言と食い違う）。
    expect(main.querySelectorAll('[data-slot="table-container"]')).toHaveLength(1);
  });

  it('処理中は文言を可視のまま残し、回転する図形を装飾として添える（Req 1.1, 4.5）', () => {
    ready('operator');
    api.getAgencies.mockReturnValue(new Promise(() => {}));
    render(<AdminAgenciesPage />);
    const main = screen.getByRole('main');

    const regions = within(main).getAllByRole('status');
    expect(regions).toHaveLength(1);
    const region = regions[0]!;
    // 文言が sr-only の子（Spinner の aria-label 経由）へ落ちていないことを構造で確かめる。
    expect(ownText(region)).toBe('読み込み中...');
    // 図形側に aria-hidden が付いていないと読み上げ領域が二重になり、この値も二重になる。
    expect(announcedText(region)).toBe('読み込み中...');
    const spinner = region.querySelector('[data-slot="spinner"]');
    expect(spinner).not.toBeNull();
    expect(spinner!.getAttribute('aria-hidden')).toBe('true');
  });

  it('取得の失敗・作成の失敗・運営専用の案内が同じ危険の通知の部品に載る（3 経路・Req 1.1, 3.5）', async () => {
    const branches = [
      {
        name: '一覧の取得失敗',
        role: 'operator' as const,
        arrange: () => {
          api.getAgencies.mockResolvedValue({
            ok: false,
            code: 'network',
            message: '取得に失敗しました',
          });
        },
        act: async () => {},
        text: '取得に失敗しました',
      },
      {
        name: '空名の送信',
        role: 'operator' as const,
        arrange: () => {
          api.getAgencies.mockResolvedValue({ ok: true, value: [] });
        },
        act: async () => {
          fireEvent.click(await screen.findByRole('button', { name: '代理店作成' }));
        },
        text: '代理店名を入力してください。',
      },
      {
        name: '運営専用の案内',
        role: 'agency' as const,
        arrange: () => {},
        act: async () => {},
        text: 'この画面は運営のみ利用できます。',
      },
    ];
    let visited = 0;
    for (const branch of branches) {
      useAuthMock.mockReset();
      Object.values(api).forEach((mock) => mock.mockReset());
      ready(branch.role);
      branch.arrange();
      render(<AdminAgenciesPage />);
      const main = await screen.findByRole('main');
      await branch.act();
      await within(main).findByText(branch.text);

      const alerts = within(main).getAllByRole('alert');
      expect(alerts, branch.name).toHaveLength(1);
      const alert = alerts[0]!;
      expect(alert.getAttribute('data-slot'), branch.name).toBe('alert');
      // 危険の変種は自ら role="alert" を持つ。文言の側へ役割を重ねると領域が二重になる。
      expect(alert.querySelectorAll('[role="alert"]'), branch.name).toHaveLength(0);
      expect(announcedText(alert), branch.name).toBe(branch.text);
      visited += 1;
      cleanup();
    }
    expect(visited).toBe(branches.length);
  });

  it('0 件の案内を空状態の部品へ移し、文言を変えない（Req 1.1, 2.3）', async () => {
    ready('operator');
    api.getAgencies.mockResolvedValue({ ok: true, value: [] });
    render(<AdminAgenciesPage />);
    const main = await screen.findByRole('main');
    await within(main).findByText('代理店はまだありません。作成してください。');

    const empties = main.querySelectorAll('[data-slot="empty-state"]');
    expect(empties).toHaveLength(1);
    // 文言は 1 文字も変えない。
    expect(
      within(empties[0] as HTMLElement).getByText('代理店はまだありません。作成してください。'),
    ).toBeTruthy();
  });

  it('作成フォームの記入欄・ラベル・押しボタンを部品へ移し、配線と読み上げ名を変えない（Req 1.1, 3.2）', async () => {
    ready('operator');
    api.getAgencies
      .mockResolvedValueOnce({ ok: true, value: [] })
      .mockResolvedValueOnce({ ok: true, value: [{ ...agencyAlpha, name: '新代理店' }] });
    api.createAgency.mockResolvedValue({ ok: true, value: { ...agencyAlpha, name: '新代理店' } });
    render(<AdminAgenciesPage />);
    const main = await screen.findByRole('main');
    const scope = within(main);

    const input = await scope.findByLabelText<HTMLInputElement>('代理店名');
    expect(input.tagName).toBe('INPUT');
    expect(input.getAttribute('data-slot')).toBe('input');
    expect(input.getAttribute('type')).toBe('text');
    expect(main.querySelector('label[for="agency-name"]')?.getAttribute('data-slot')).toBe('label');

    const create = scope.getByRole('button', { name: '代理店作成' });
    expect(create.getAttribute('data-slot')).toBe('button');
    // 押しボタンの既定の型は submit である。素の実装が持っていた type を落とさない。
    expect(create.getAttribute('type')).toBe('button');

    // 値の直接変更で操作でき、配線はそのまま届く。
    fireEvent.change(input, { target: { value: '新代理店' } });
    expect(input.value).toBe('新代理店');
    fireEvent.click(create);
    expect(await scope.findByText('新代理店')).toBeTruthy();
    expect(api.createAgency).toHaveBeenCalledWith({ name: '新代理店' });
  });
});
