// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { announcedText, ownText } from './live-region';

// 認証コンテキストはモックし、ready な operator/agency を注入する（stores-page.test と同規約）。
const useAuthMock = vi.fn();
vi.mock('../src/lib/auth-context', () => ({ useAuth: () => useAuthMock() }));

// next/navigation・next/link はブラウザランタイム依存のためモックする。
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  // 帯（TopNav）が現在地の判定に使う。このページの実経路を返し、偽装が嘘をつかないようにする。
  usePathname: () => '/invite-codes',
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

// api クライアントは招待コード系メソッドをモックし、ネットワーク・firebase を発火させない。
const api = vi.hoisted(() => ({
  getInviteCodes: vi.fn(),
  issueInviteCode: vi.fn(),
  disableInviteCode: vi.fn(),
  getAgencies: vi.fn(),
}));
vi.mock('../src/lib/api', () => api);

import InviteCodesPage from '../src/app/invite-codes/page';

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

const activeCode = {
  id: 'ic1',
  agencyId: 'a1',
  code: 'ACTIVE01',
  disabled: false,
  createdAt: '2026-01-01T00:00:00Z',
};
const disabledCode = {
  id: 'ic2',
  agencyId: 'a1',
  code: 'DEAD0002',
  disabled: true,
  createdAt: '2026-01-02T00:00:00Z',
};
const agencyAlpha = { id: 'a1', operatorId: 'op1', name: '代理店アルファ', createdAt: '2026-01-01T00:00:00Z' };

beforeEach(() => {
  useAuthMock.mockReset();
  Object.values(api).forEach((m) => m.mockReset());
});
afterEach(cleanup);

describe('招待コードページ（agency ロール）', () => {
  it('有効・無効のバッジとともに一覧表示し、代理店セレクタは出さない（Req 5.1）', async () => {
    ready('agency');
    api.getInviteCodes.mockResolvedValue({ ok: true, value: [activeCode, disabledCode] });
    render(<InviteCodesPage />);
    const scope = within(await screen.findByRole('main'));
    expect(await scope.findByText('ACTIVE01')).toBeTruthy();
    expect(scope.getByText('有効')).toBeTruthy();
    expect(scope.getByText('無効')).toBeTruthy();
    // agency は自代理店固定のためセレクタ非表示。
    expect(scope.queryByLabelText('代理店')).toBeNull();
    // 自代理店分の取得は引数なし（agencyId を渡さない）。
    expect(api.getInviteCodes).toHaveBeenCalledTimes(1);
    expect(api.getInviteCodes.mock.calls[0]?.[0]?.agencyId).toBeUndefined();
  });

  it('発行ボタンで issueInviteCode(agencyId なし)を呼び、新コードを案内表示し一覧にも出す（Req 5.2）', async () => {
    ready('agency');
    const newCode = {
      id: 'ic9',
      agencyId: 'a1',
      code: 'NEWCODE9',
      disabled: false,
      createdAt: '2026-02-01T00:00:00Z',
    };
    api.getInviteCodes.mockResolvedValueOnce({ ok: true, value: [] }); // 初期ロード
    api.issueInviteCode.mockResolvedValue({ ok: true, value: newCode });
    api.getInviteCodes.mockResolvedValueOnce({ ok: true, value: [newCode] }); // 発行後の再取得
    render(<InviteCodesPage />);
    const scope = within(await screen.findByRole('main'));
    fireEvent.click(await scope.findByRole('button', { name: '発行' }));
    // オーナーに案内するため新コードを強調表示する。
    expect(await scope.findByText('NEWCODE9', { selector: 'strong' })).toBeTruthy();
    // 一覧（セル）にも新コードが出現する。
    expect(await scope.findByRole('cell', { name: 'NEWCODE9' })).toBeTruthy();
    // agencyId は渡さない（自代理店）。
    expect(api.issueInviteCode).toHaveBeenCalledTimes(1);
    expect(api.issueInviteCode.mock.calls[0]?.[0]?.agencyId).toBeUndefined();
  });

  it('無効化ボタンで disableInviteCode を呼び、行が無効に変わる（Req 5.3）', async () => {
    ready('agency');
    api.getInviteCodes.mockResolvedValueOnce({ ok: true, value: [activeCode] }); // 初期
    api.disableInviteCode.mockResolvedValue({ ok: true, value: { ...activeCode, disabled: true } });
    api.getInviteCodes.mockResolvedValueOnce({ ok: true, value: [{ ...activeCode, disabled: true }] }); // 再取得
    render(<InviteCodesPage />);
    const scope = within(await screen.findByRole('main'));
    expect(await scope.findByText('有効')).toBeTruthy();
    fireEvent.click(scope.getByRole('button', { name: '無効化' }));
    expect(await scope.findByText('無効')).toBeTruthy();
    expect(api.disableInviteCode).toHaveBeenCalledTimes(1);
    const arg = api.disableInviteCode.mock.calls[0]?.[0];
    expect(arg).toMatchObject({ id: 'ic1' });
    expect(arg?.agencyId).toBeUndefined();
    // 無効化済みの行に無効化ボタンは提供しない。
    expect(scope.queryByRole('button', { name: '無効化' })).toBeNull();
  });

  it('発行が失敗すると日本語エラーを表示しクラッシュしない（Req 7.4）', async () => {
    ready('agency');
    api.getInviteCodes.mockResolvedValue({ ok: true, value: [] });
    api.issueInviteCode.mockResolvedValue({ ok: false, code: 'server_error', message: 'x' });
    render(<InviteCodesPage />);
    const scope = within(await screen.findByRole('main'));
    fireEvent.click(await scope.findByRole('button', { name: '発行' }));
    expect(await scope.findByText(/発行に失敗しました/)).toBeTruthy();
  });
});

describe('招待コードページ（operator ロール）', () => {
  it('代理店セレクタを表示し、選択で getInviteCodes を選択 agencyId 付きで呼ぶ。選択前は一覧を取得しない（Req 5.4）', async () => {
    ready('operator');
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    api.getInviteCodes.mockResolvedValue({ ok: true, value: [activeCode] });
    render(<InviteCodesPage />);
    const scope = within(await screen.findByRole('main'));
    const select = await scope.findByLabelText('代理店');
    // 代理店未選択の間は一覧取得を行わない。
    expect(api.getInviteCodes).not.toHaveBeenCalled();
    fireEvent.change(select, { target: { value: 'a1' } });
    expect(await scope.findByText('ACTIVE01')).toBeTruthy();
    expect(api.getInviteCodes).toHaveBeenCalledWith({ agencyId: 'a1' });
  });

  it('発行・無効化は選択中の agencyId を渡す（Req 5.4）', async () => {
    ready('operator');
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    api.getInviteCodes
      .mockResolvedValueOnce({ ok: true, value: [activeCode] }) // 選択
      .mockResolvedValueOnce({ ok: true, value: [activeCode] }) // 発行後
      .mockResolvedValueOnce({ ok: true, value: [{ ...activeCode, disabled: true }] }); // 無効化後
    api.issueInviteCode.mockResolvedValue({
      ok: true,
      value: { ...activeCode, id: 'ic9', code: 'OPNEW009' },
    });
    api.disableInviteCode.mockResolvedValue({ ok: true, value: { ...activeCode, disabled: true } });
    render(<InviteCodesPage />);
    const scope = within(await screen.findByRole('main'));
    fireEvent.change(await scope.findByLabelText('代理店'), { target: { value: 'a1' } });
    await scope.findByText('ACTIVE01');

    fireEvent.click(scope.getByRole('button', { name: '発行' }));
    await scope.findByText('OPNEW009', { selector: 'strong' });
    expect(api.issueInviteCode).toHaveBeenCalledWith({ agencyId: 'a1' });

    fireEvent.click(scope.getByRole('button', { name: '無効化' }));
    await scope.findByText('無効');
    expect(api.disableInviteCode).toHaveBeenCalledWith({ id: 'ic1', agencyId: 'a1' });
  });
});

// ---------------------------------------------------------------------------
// ui-airbnb-surfaces task 2.4。以下は本タスクで追加した照合である。
//
// 上の 6 件は「発行・無効化が正しい引数で呼ばれる」ことだけを見ており、意匠の適用が壊しうる
// 契約（処理中の文言・0 件と未選択の案内・列見出し・取得失敗の分岐そのもの・選択の素性）には
// 照合が **1 件も無かった**。task 2.1 の「ログアウトに照合が 0 件」・2.2 の 6 件・2.3 の 5 件と
// 同型で 4 タスク連続である。実装に触れる前にここで固定し、素の実装に対して緑になることを
// 確認してから部品化へ進んだ。
// ---------------------------------------------------------------------------

/** DOM 上の改行・字下げを畳む（比較対象から外す）。 */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 走査範囲の全要素について、**直下のテキストノードだけ**を繋いだ文字列を集める。 */
function ownTextsIn(scope: HTMLElement): string[] {
  return Array.from(scope.querySelectorAll('*')).map((element) => ownText(element));
}

describe('招待コードページ: 着手前から在った契約（意匠の適用で壊しうる）', () => {
  it('一覧の列見出しの読み上げ文字列を変更しない（Req 5.1）', async () => {
    ready('agency');
    api.getInviteCodes.mockResolvedValue({ ok: true, value: [activeCode, disabledCode] });
    render(<InviteCodesPage />);
    const scope = within(await screen.findByRole('main'));
    await scope.findByText('ACTIVE01');
    // **集合の完全一致**で見る。包含では列を 1 つ足す改変を捕まえられない。
    expect(scope.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'コード',
      '状態',
      '作成日時',
      '操作',
    ]);
  });

  it('処理中の文言は ASCII 3 点である（三点リーダへ揃えない・Req 7.3）', async () => {
    ready('agency');
    api.getInviteCodes.mockReturnValue(new Promise(() => {}));
    render(<InviteCodesPage />);
    const main = await screen.findByRole('main');
    const texts = ownTextsIn(main);
    // 見た目がほぼ同じ 2 種類が本アプリに実在する（振り分けは U+2026・この面は ASCII 3 点）。
    // 一括置換で揃えると誰も気づかないまま文言が変わるため、両方向で固定する。
    expect(texts).toContain('読み込み中...');
    expect(texts).not.toContain('読み込み中…');
  });

  it('0 件の案内文言を変更しない（Req 5.1）', async () => {
    ready('agency');
    api.getInviteCodes.mockResolvedValue({ ok: true, value: [] });
    render(<InviteCodesPage />);
    const scope = within(await screen.findByRole('main'));
    expect(
      await scope.findByText('招待コードはまだありません。発行してオーナーにご案内ください。'),
    ).toBeTruthy();
  });

  it('代理店未選択のときの案内文言を変更しない（Req 5.4）', async () => {
    ready('operator');
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    render(<InviteCodesPage />);
    const scope = within(await screen.findByRole('main'));
    expect(await scope.findByText('代理店を選択すると招待コードを表示します。')).toBeTruthy();
    // 未選択の間は一覧も発行操作も出さない。
    expect(scope.queryByRole('table')).toBeNull();
    expect(scope.queryByRole('button', { name: '発行' })).toBeNull();
  });

  it('発行した新コードの案内は全文を保つ（コードだけでなく前後の案内も・Req 5.2）', async () => {
    ready('agency');
    const newCode = { ...activeCode, id: 'ic9', code: 'NEWCODE9' };
    api.getInviteCodes.mockResolvedValue({ ok: true, value: [] });
    api.issueInviteCode.mockResolvedValue({ ok: true, value: newCode });
    render(<InviteCodesPage />);
    const scope = within(await screen.findByRole('main'));
    fireEvent.click(await scope.findByRole('button', { name: '発行' }));
    const strong = await scope.findByText('NEWCODE9', { selector: 'strong' });
    expect(normalize(strong.parentElement?.textContent ?? '')).toBe(
      '新しい招待コードを発行しました: NEWCODE9（このコードをオーナーにご案内ください）',
    );
  });

  it('一覧の取得失敗は案内だけを出し、データを偽装しない（Req 7.4）', async () => {
    ready('agency');
    api.getInviteCodes.mockResolvedValue({
      ok: false,
      code: 'network',
      message: '取得に失敗しました',
    });
    render(<InviteCodesPage />);
    const scope = within(await screen.findByRole('main'));
    expect(await scope.findByText('取得に失敗しました')).toBeTruthy();
    // 表も 0 件案内も出さない（空の一覧を「0 件」と偽らない）。
    expect(scope.queryByRole('table')).toBeNull();
    expect(
      scope.queryByText('招待コードはまだありません。発行してオーナーにご案内ください。'),
    ).toBeNull();
  });

  it('無効化の失敗は日本語エラーを表示しクラッシュしない（Req 7.4）', async () => {
    ready('agency');
    api.getInviteCodes.mockResolvedValue({ ok: true, value: [activeCode] });
    api.disableInviteCode.mockResolvedValue({ ok: false, code: 'server_error', message: 'x' });
    render(<InviteCodesPage />);
    const scope = within(await screen.findByRole('main'));
    fireEvent.click(await scope.findByRole('button', { name: '無効化' }));
    expect(
      await scope.findByText('無効化に失敗しました。時間をおいて再試行してください。'),
    ).toBeTruthy();
  });

  it('選択は標準の選択要素であり、値の直接変更で操作でき必須属性を要素から読める（Req 5.4）', async () => {
    ready('operator');
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    api.getInviteCodes.mockResolvedValue({ ok: true, value: [activeCode] });
    render(<InviteCodesPage />);
    const scope = within(await screen.findByRole('main'));

    // ラベルが解決する先は包む要素ではなく選択要素そのものでなければならない。
    const select = await scope.findByLabelText<HTMLSelectElement>('代理店');
    expect(select.tagName).toBe('SELECT');
    expect(select.id).toBe('agency-select');

    // **必須属性を要素から読む。** required は HTMLSelectElement の IDL プロパティなので、
    // ラベルが包む要素（div）を指すようになると undefined になり、この行が赤くなる。
    // 現状は必須ではない（属性を増やさないことも「標準の選択要素と同一の属性を保つ」に含まれる）。
    expect(select.required).toBe(false);

    // 選択肢の並び（先頭は未選択を表す空値の案内）。
    expect(
      Array.from(select.options).map((option) => [option.value, option.textContent]),
    ).toEqual([
      ['', '代理店を選択してください'],
      ['a1', '代理店アルファ'],
    ]);

    // プログラムによる値の変更で操作できる（描画を伴う選択部品へ置き換えると届かなくなる）。
    fireEvent.change(select, { target: { value: 'a1' } });
    expect(select.value).toBe('a1');
    expect(await scope.findByText('ACTIVE01')).toBeTruthy();
  });
});

// --- 意匠の適用（task 2.4）------------------------------------------------------------

/** 代理店を選ぶ（operator は選択して初めて一覧の分岐に入る）。 */
async function selectAgencyAlpha(): Promise<void> {
  fireEvent.change(await screen.findByLabelText('代理店'), { target: { value: 'a1' } });
}

interface SurfaceBranch {
  /** 失敗メッセージへ出す分岐名（どの分岐が壊れたかを名指しさせる）。 */
  readonly name: string;
  readonly role: 'operator' | 'agency';
  /** 取得結果の偽装。 */
  readonly arrange: () => void;
  /** その分岐が実際に描かれたことの確認（描かれない状態を緑と読まないための前置き）。 */
  readonly settle: () => Promise<unknown>;
}

// **この面は分岐の数が多い**（ロール 2 × 状態 5）。task 2.2 の教訓「分岐を持つ画面では、
// 照合が全分岐を走査しているかを必ず確かめる」に従い、版面の照合は 9 分岐すべてを回す。
const SURFACE_BRANCHES: readonly SurfaceBranch[] = [
  {
    name: 'operator/代理店未選択',
    role: 'operator',
    arrange: () => {
      api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    },
    settle: () => screen.findByText('代理店を選択すると招待コードを表示します。'),
  },
  {
    name: 'operator/取得中',
    role: 'operator',
    arrange: () => {
      api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
      // 解決しない約束を返して取得中の分岐に留める。
      api.getInviteCodes.mockReturnValue(new Promise(() => {}));
    },
    settle: async () => {
      await selectAgencyAlpha();
      return screen.findByText('読み込み中...');
    },
  },
  {
    name: 'operator/失敗',
    role: 'operator',
    arrange: () => {
      api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
      api.getInviteCodes.mockResolvedValue({
        ok: false,
        code: 'network',
        message: '取得に失敗しました',
      });
    },
    settle: async () => {
      await selectAgencyAlpha();
      return screen.findByRole('alert');
    },
  },
  {
    name: 'operator/0 件',
    role: 'operator',
    arrange: () => {
      api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
      api.getInviteCodes.mockResolvedValue({ ok: true, value: [] });
    },
    settle: async () => {
      await selectAgencyAlpha();
      return screen.findByText('招待コードはまだありません。発行してオーナーにご案内ください。');
    },
  },
  {
    name: 'operator/1 件以上',
    role: 'operator',
    arrange: () => {
      api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
      api.getInviteCodes.mockResolvedValue({ ok: true, value: [activeCode, disabledCode] });
    },
    settle: async () => {
      await selectAgencyAlpha();
      return screen.findByText('ACTIVE01');
    },
  },
  {
    name: 'agency/取得中',
    role: 'agency',
    arrange: () => {
      api.getInviteCodes.mockReturnValue(new Promise(() => {}));
    },
    settle: () => screen.findByText('読み込み中...'),
  },
  {
    name: 'agency/失敗',
    role: 'agency',
    arrange: () => {
      api.getInviteCodes.mockResolvedValue({
        ok: false,
        code: 'network',
        message: '取得に失敗しました',
      });
    },
    settle: () => screen.findByRole('alert'),
  },
  {
    name: 'agency/0 件',
    role: 'agency',
    arrange: () => {
      api.getInviteCodes.mockResolvedValue({ ok: true, value: [] });
    },
    settle: () => screen.findByText('招待コードはまだありません。発行してオーナーにご案内ください。'),
  },
  {
    name: 'agency/1 件以上',
    role: 'agency',
    arrange: () => {
      api.getInviteCodes.mockResolvedValue({ ok: true, value: [activeCode, disabledCode] });
    },
    settle: () => screen.findByText('ACTIVE01'),
  },
];

describe('招待コードページ: 意匠の適用', () => {
  it('どの分岐でも一覧系の広い版面へ置換し、主要領域を 1 つに保つ（Req 1.1, 1.5, 3.3）', async () => {
    let visited = 0;
    for (const branch of SURFACE_BRANCHES) {
      useAuthMock.mockReset();
      Object.values(api).forEach((mock) => mock.mockReset());
      ready(branch.role);
      branch.arrange();
      const { container } = render(<InviteCodesPage />);
      await branch.settle();

      const shell = container.querySelector('[data-slot="page-shell"]');
      expect(shell, branch.name).not.toBeNull();
      // 版面は 2 段しかない。一覧が主なので広い側を使う。
      expect(shell!.getAttribute('data-width'), branch.name).toBe('lg');
      // 既存の main を **置換** する（入れ子にしない）。
      expect(shell!.tagName, branch.name).toBe('MAIN');
      expect(container.querySelectorAll('main'), branch.name).toHaveLength(1);
      // **包含では足りない**（task 2.1 で差し戻された「追加」型の穴）。max-w-* を後ろへ足せば
      // data-width は lg のまま実効の版面だけが縮む。幅を与えるクラスの集合を完全一致で固定する。
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

  it('主見出しを見出しの部品で描き、読み上げ名と階層を変えない（Req 1.1, 3.2）', async () => {
    ready('agency');
    api.getInviteCodes.mockResolvedValue({ ok: true, value: [activeCode] });
    render(<InviteCodesPage />);
    const heading = await screen.findByRole('heading', { level: 1, name: '招待コード' });
    expect(heading.getAttribute('data-slot')).toBe('heading');
    expect(heading.getAttribute('data-level')).toBe('1');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('一覧を表の部品で描き、行・列・セルの役割を保つ（Req 2.1, 2.2）', async () => {
    ready('agency');
    api.getInviteCodes.mockResolvedValue({ ok: true, value: [activeCode, disabledCode] });
    render(<InviteCodesPage />);
    const scope = within(await screen.findByRole('main'));
    await scope.findByText('ACTIVE01');

    const table = scope.getByRole('table');
    expect(table.getAttribute('data-slot')).toBe('table');
    expect(table.querySelector('thead')?.getAttribute('data-slot')).toBe('table-head');
    expect(table.querySelector('tbody')?.getAttribute('data-slot')).toBe('table-body');

    // 見出し行・データ行のいずれも行の部品を通る。**集合の完全一致**で見るのは、
    // 素の <tr> を 1 行だけ混ぜる改変を包含判定が捕まえないためである。
    expect(scope.getAllByRole('row').map((row) => row.getAttribute('data-slot'))).toEqual([
      'table-row',
      'table-row',
      'table-row',
    ]);
    const headers = scope.getAllByRole('columnheader');
    expect(headers.map((header) => header.getAttribute('data-slot'))).toEqual(
      Array.from({ length: 4 }, () => 'table-header-cell'),
    );
    // 素の <th> は scope を持っていなかった。部品化で支援技術に対する後退を作らない。
    expect(headers.map((header) => header.getAttribute('scope'))).toEqual(
      Array.from({ length: 4 }, () => 'col'),
    );
    // データセルも同様。1 つでも素の <td> が混ざれば余白と行の高さが揃わない。
    expect(scope.getAllByRole('cell').map((cell) => cell.getAttribute('data-slot'))).toEqual(
      Array.from({ length: 8 }, () => 'table-cell'),
    );
  });

  it('横方向の捲りは表の外側の容器が担い、キーボードで到達できる（Req 2.5, 4.1）', async () => {
    ready('agency');
    api.getInviteCodes.mockResolvedValue({ ok: true, value: [activeCode] });
    render(<InviteCodesPage />);
    const main = await screen.findByRole('main');
    await within(main).findByText('ACTIVE01');

    const table = within(main).getByRole('table');
    const container = table.parentElement;
    expect(container?.getAttribute('data-slot')).toBe('table-container');
    // 捲る領域が焦点を得られないと、溢れて隠れた列へ到達する手段が無くなる（WCAG 2.1.1）。
    expect(container?.getAttribute('tabindex')).toBe('0');
    // 面の側で捲れる領域を増やさない（増やすと e2e の件数宣言と食い違う）。
    expect(main.querySelectorAll('[data-slot="table-container"]')).toHaveLength(1);
  });

  it('処理中は文言を可視のまま残し、回転する図形を装飾として添える（両ロール・Req 1.1, 4.5）', async () => {
    let visited = 0;
    for (const role of ['agency', 'operator'] as const) {
      useAuthMock.mockReset();
      Object.values(api).forEach((mock) => mock.mockReset());
      ready(role);
      api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
      api.getInviteCodes.mockReturnValue(new Promise(() => {}));
      render(<InviteCodesPage />);
      const main = await screen.findByRole('main');
      if (role === 'operator') await selectAgencyAlpha();
      await within(main).findByText('読み込み中...');

      const regions = within(main).getAllByRole('status');
      expect(regions, role).toHaveLength(1);
      const region = regions[0]!;
      // 文言が sr-only の子（Spinner の aria-label 経由）へ落ちていないことを構造で確かめる。
      // <Spinner aria-label="読み込み中..." /> へ置き換えると、ここが空になる。
      expect(ownText(region), role).toBe('読み込み中...');
      // 図形側に aria-hidden が付いていないと読み上げ領域が二重になり、この値も二重になる。
      expect(announcedText(region), role).toBe('読み込み中...');
      const spinner = region.querySelector('[data-slot="spinner"]');
      expect(spinner, role).not.toBeNull();
      expect(spinner!.getAttribute('aria-hidden'), role).toBe('true');
      visited += 1;
      cleanup();
    }
    expect(visited).toBe(2);
  });

  it('取得の失敗は危険の通知の部品として読み上げ領域 1 つに載る（Req 1.1, 3.5）', async () => {
    ready('agency');
    api.getInviteCodes.mockResolvedValue({
      ok: false,
      code: 'network',
      message: '取得に失敗しました',
    });
    render(<InviteCodesPage />);
    const main = await screen.findByRole('main');
    // **外枠の到達を取得の完了と読み違えない。** 版面の部品は読み込み中でも即座に描かれるので、
    // `main` を待っても取得は終わっていない。実データの到達そのものを待たないと、以下の同期取得は
    // 読み込み中の画面を測り、負荷の高い環境でだけ落ちる（CI run 34003887862 で顕在化）。
    await within(main).findByText('取得に失敗しました');

    const alerts = within(main).getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    const alert = alerts[0]!;
    expect(alert.getAttribute('data-slot')).toBe('alert');
    // 危険の変種は自ら role="alert" を持つ。文言の側へ役割を重ねると領域が二重になる。
    expect(alert.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(alert.querySelector('[data-slot="alert-description"]')?.textContent).toBe(
      '取得に失敗しました',
    );
    expect(announcedText(alert)).toBe('取得に失敗しました');
    // 失敗のとき処理中の表示は残さない（読み上げ領域を 1 つに保つ）。
    expect(within(main).queryAllByRole('status')).toHaveLength(0);
  });

  it('発行・無効化の失敗も同じ危険の通知の部品へ載る（2 経路・Req 1.1, 3.5）', async () => {
    const failures = [
      { name: '発行', button: '発行', text: '発行に失敗しました。時間をおいて再試行してください。' },
      {
        name: '無効化',
        button: '無効化',
        text: '無効化に失敗しました。時間をおいて再試行してください。',
      },
    ] as const;
    let visited = 0;
    for (const failure of failures) {
      useAuthMock.mockReset();
      Object.values(api).forEach((mock) => mock.mockReset());
      ready('agency');
      api.getInviteCodes.mockResolvedValue({ ok: true, value: [activeCode] });
      api.issueInviteCode.mockResolvedValue({ ok: false, code: 'server_error', message: 'x' });
      api.disableInviteCode.mockResolvedValue({ ok: false, code: 'server_error', message: 'x' });
      render(<InviteCodesPage />);
      const main = await screen.findByRole('main');
      fireEvent.click(await within(main).findByRole('button', { name: failure.button }));
      await within(main).findByText(failure.text);

      const alerts = within(main).getAllByRole('alert');
      expect(alerts, failure.name).toHaveLength(1);
      expect(alerts[0]!.getAttribute('data-slot'), failure.name).toBe('alert');
      expect(alerts[0]!.querySelectorAll('[role="alert"]'), failure.name).toHaveLength(0);
      expect(announcedText(alerts[0]!), failure.name).toBe(failure.text);
      visited += 1;
      cleanup();
    }
    expect(visited).toBe(failures.length);
  });

  it('発行した新コードの案内も通知の部品へ載せ、全文と強調を保つ（Req 1.1, 3.5）', async () => {
    ready('agency');
    api.getInviteCodes.mockResolvedValue({ ok: true, value: [] });
    api.issueInviteCode.mockResolvedValue({ ok: true, value: { ...activeCode, code: 'NEWCODE9' } });
    render(<InviteCodesPage />);
    const scope = within(await screen.findByRole('main'));
    fireEvent.click(await scope.findByRole('button', { name: '発行' }));

    const strong = await scope.findByText('NEWCODE9', { selector: 'strong' });
    const alert = strong.closest('[data-slot="alert"]');
    expect(alert).not.toBeNull();
    // 失敗ではないので読み上げは polite（status）。危険の通知と役割を混ぜない。
    expect(alert!.getAttribute('role')).toBe('status');
    // 文言の側へ役割を重ねない（領域の二重化）。
    expect(alert!.querySelectorAll('[role="status"]')).toHaveLength(0);
    expect(normalize(alert!.textContent ?? '')).toBe(
      '新しい招待コードを発行しました: NEWCODE9（このコードをオーナーにご案内ください）',
    );
  });

  it('一覧を出さない 2 分岐の案内を空状態の部品へ移し、文言を変えない（Req 1.1, 2.3）', async () => {
    const branches = [
      {
        name: 'agency/0 件',
        role: 'agency' as const,
        arrange: () => {
          api.getInviteCodes.mockResolvedValue({ ok: true, value: [] });
        },
        text: '招待コードはまだありません。発行してオーナーにご案内ください。',
      },
      {
        name: 'operator/代理店未選択',
        role: 'operator' as const,
        arrange: () => {
          api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
        },
        text: '代理店を選択すると招待コードを表示します。',
      },
    ];
    let visited = 0;
    for (const branch of branches) {
      useAuthMock.mockReset();
      Object.values(api).forEach((mock) => mock.mockReset());
      ready(branch.role);
      branch.arrange();
      render(<InviteCodesPage />);
      const main = await screen.findByRole('main');
      await within(main).findByText(branch.text);

      const empties = main.querySelectorAll('[data-slot="empty-state"]');
      expect(empties, branch.name).toHaveLength(1);
      // 文言は 1 文字も変えない。
      expect(within(empties[0] as HTMLElement).getByText(branch.text), branch.name).toBeTruthy();
      visited += 1;
      cleanup();
    }
    expect(visited).toBe(branches.length);
  });

  it('選択を選択の部品へ移し、包む要素を段落から汎用の容器へ置き換える（Req 1.1, 3.4）', async () => {
    ready('operator');
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    api.getInviteCodes.mockResolvedValue({ ok: true, value: [activeCode] });
    render(<InviteCodesPage />);
    const main = await screen.findByRole('main');
    const select = await within(main).findByLabelText<HTMLSelectElement>('代理店');

    // 部品は選択要素を 1 枚の容器で包む。ラベルと id の結び付きは選択要素の側に残る。
    const wrapper = select.parentElement;
    expect(wrapper?.getAttribute('data-slot')).toBe('select-wrapper');
    expect(select.getAttribute('data-slot')).toBe('select');

    // **段落の中に容器を置かない。** 実ブラウザの構文解析は <p> を <div> の直前で閉じるため、
    // サーバ描画とクライアント描画の木が食い違う（jsdom は React の DOM 操作で組むため
    // 再現しない。ここは構造そのものを見て食い違いの種を断つ）。
    expect(wrapper?.closest('p')).toBeNull();
    expect(main.querySelector('label[for="agency-select"]')?.closest('p')).toBeNull();

    // ラベルも共通部品を通す（面ごとに文字寸法が食い違わないようにする）。
    expect(main.querySelector('label[for="agency-select"]')?.getAttribute('data-slot')).toBe(
      'label',
    );

    // 完了条件: 値の直接変更で操作でき、必須属性を要素から読める。
    expect(select.required).toBe(false);
    fireEvent.change(select, { target: { value: 'a1' } });
    expect(select.value).toBe('a1');
    expect(await within(main).findByText('ACTIVE01')).toBeTruthy();
  });

  it('発行の押しボタンを押しボタンの部品へ移し、読み上げ名と配線を変えない（Req 1.1, 3.2）', async () => {
    ready('agency');
    api.getInviteCodes.mockResolvedValue({ ok: true, value: [] });
    api.issueInviteCode.mockResolvedValue({ ok: true, value: { ...activeCode, code: 'NEWCODE9' } });
    render(<InviteCodesPage />);
    const scope = within(await screen.findByRole('main'));
    const issue = await scope.findByRole('button', { name: '発行' });
    expect(issue.getAttribute('data-slot')).toBe('button');
    // 押しボタンの既定の型は submit である。素の実装が持っていた type を落とさない。
    expect(issue.getAttribute('type')).toBe('button');
    fireEvent.click(issue);
    expect(api.issueInviteCode).toHaveBeenCalledTimes(1);
  });
});
