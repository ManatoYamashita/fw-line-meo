// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  usePathname: () => '/admin/users',
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

// api クライアントは利用者・代理店系メソッドをモックする。
const api = vi.hoisted(() => ({
  getDashboardUsers: vi.fn(),
  createDashboardUser: vi.fn(),
  disableDashboardUser: vi.fn(),
  enableDashboardUser: vi.fn(),
  getAgencies: vi.fn(),
}));
vi.mock('../src/lib/api', () => api);

import AdminUsersPage from '../src/app/admin/users/page';

// operator の me.id は operatorUser（u1）と一致させ、自己行判定（自己無効化ボタン非表示）を検証可能にする。
function ready(role: 'operator' | 'agency') {
  useAuthMock.mockReturnValue({
    status: 'ready',
    me: {
      id: role === 'operator' ? 'u1' : 'u2',
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
const operatorUser = {
  id: 'u1',
  role: 'operator' as const,
  operatorId: 'op1',
  agencyId: null,
  email: 'op@example.com',
  displayName: '運営太郎',
  disabled: false,
  createdAt: '2026-01-01T00:00:00Z',
};
const agencyUser = {
  id: 'u2',
  role: 'agency' as const,
  operatorId: 'op1',
  agencyId: 'a1',
  email: 'agency@example.com',
  displayName: '代理花子',
  disabled: false,
  createdAt: '2026-01-02T00:00:00Z',
};

beforeEach(() => {
  useAuthMock.mockReset();
  Object.values(api).forEach((m) => m.mockReset());
});
afterEach(cleanup);

describe('利用者管理ページ（operator）', () => {
  it('ロール・メール・有効/無効を含む一覧を表示する（Req 6.2）', async () => {
    ready('operator');
    api.getDashboardUsers.mockResolvedValue({ ok: true, value: [operatorUser, agencyUser] });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    render(<AdminUsersPage />);
    const scope = within(await screen.findByRole('main'));
    expect(await scope.findByText('op@example.com')).toBeTruthy();
    expect(scope.getByText('agency@example.com')).toBeTruthy();
    // 有効・無効バッジ（両利用者とも有効）。
    expect(scope.getAllByText('有効').length).toBeGreaterThan(0);
    // 代理店ユーザーの所属代理店名を表示する。
    expect(scope.getByRole('cell', { name: '代理店アルファ' })).toBeTruthy();
  });

  it('role=agency で所属代理店セレクタが必須表示、role=operator では代理店欄が出ない（Req 6.3）', async () => {
    ready('operator');
    api.getDashboardUsers.mockResolvedValue({ ok: true, value: [] });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    render(<AdminUsersPage />);
    const scope = within(await screen.findByRole('main'));
    // 既定 role=代理店 → 所属代理店セレクタが表示され、required。
    const agencySelect = await scope.findByLabelText('所属代理店');
    expect(agencySelect).toBeTruthy();
    expect(agencySelect.hasAttribute('required')).toBe(true);
    // role=運営 に切替 → 代理店欄が消える（ck_dashboard_role_scope の先取り）。
    fireEvent.change(scope.getByLabelText('ロール'), { target: { value: 'operator' } });
    expect(scope.queryByLabelText('所属代理店')).toBeNull();
  });

  it('代理店ユーザー登録で createDashboardUser を {role,agencyId,email} 付きで呼び一覧を再取得する（Req 6.2, 6.3）', async () => {
    ready('operator');
    api.getDashboardUsers
      .mockResolvedValueOnce({ ok: true, value: [] }) // 初期
      .mockResolvedValueOnce({ ok: true, value: [agencyUser] }); // 登録後
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    api.createDashboardUser.mockResolvedValue({ ok: true, value: agencyUser });
    render(<AdminUsersPage />);
    const scope = within(await screen.findByRole('main'));
    fireEvent.change(await scope.findByLabelText('所属代理店'), { target: { value: 'a1' } });
    fireEvent.change(scope.getByLabelText('メールアドレス'), { target: { value: 'agency@example.com' } });
    fireEvent.change(scope.getByLabelText('表示名'), { target: { value: '代理花子' } });
    fireEvent.click(scope.getByRole('button', { name: '利用者登録' }));
    expect(await scope.findByText('agency@example.com')).toBeTruthy();
    expect(api.createDashboardUser).toHaveBeenCalledTimes(1);
    expect(api.createDashboardUser.mock.calls[0]?.[0]).toMatchObject({
      role: 'agency',
      agencyId: 'a1',
      email: 'agency@example.com',
    });
  });

  it('email 重複（409）で日本語案内「既に登録済みのメールアドレスです」を表示する（Req 6.2）', async () => {
    ready('operator');
    api.getDashboardUsers.mockResolvedValue({ ok: true, value: [] });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    api.createDashboardUser.mockResolvedValue({ ok: false, code: 'email_conflict', message: 'x' });
    render(<AdminUsersPage />);
    const scope = within(await screen.findByRole('main'));
    fireEvent.change(await scope.findByLabelText('所属代理店'), { target: { value: 'a1' } });
    fireEvent.change(scope.getByLabelText('メールアドレス'), { target: { value: 'dup@example.com' } });
    fireEvent.click(scope.getByRole('button', { name: '利用者登録' }));
    expect(await scope.findByText(/既に登録済みのメールアドレスです/)).toBeTruthy();
  });

  it('無効化ボタンで disableDashboardUser({id}) を呼び、行が無効に変わる（Req 6.4）', async () => {
    ready('operator');
    api.getDashboardUsers
      .mockResolvedValueOnce({ ok: true, value: [agencyUser] }) // 初期
      .mockResolvedValueOnce({ ok: true, value: [{ ...agencyUser, disabled: true }] }); // 無効化後
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    api.disableDashboardUser.mockResolvedValue({ ok: true, value: { ...agencyUser, disabled: true } });
    render(<AdminUsersPage />);
    const scope = within(await screen.findByRole('main'));
    expect(await scope.findByText('有効')).toBeTruthy();
    fireEvent.click(scope.getByRole('button', { name: '無効化' }));
    expect(await scope.findByText('無効')).toBeTruthy();
    expect(api.disableDashboardUser).toHaveBeenCalledWith({ id: 'u2' });
    // 無効化済みの行に無効化ボタンは提供しない。
    expect(scope.queryByRole('button', { name: '無効化' })).toBeNull();
  });

  it('自分自身の行には無効化ボタンを出さない・他人の有効行には出す（Req 2.2）', async () => {
    ready('operator'); // me.id = 'u1' = operatorUser
    api.getDashboardUsers.mockResolvedValue({ ok: true, value: [operatorUser, agencyUser] });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    render(<AdminUsersPage />);
    const scope = within(await screen.findByRole('main'));
    // 自分（op@example.com=u1）の行には無効化ボタンが無い。
    const selfRow = (await scope.findByText('op@example.com')).closest('tr') as HTMLElement;
    expect(within(selfRow).queryByRole('button', { name: '無効化' })).toBeNull();
    // 他人（agency@example.com=u2）の有効行には無効化ボタンがある。
    const otherRow = scope.getByText('agency@example.com').closest('tr') as HTMLElement;
    expect(within(otherRow).getByRole('button', { name: '無効化' })).toBeTruthy();
  });

  it('無効化済み行に有効化ボタンを出し、enableDashboardUser({id}) を呼び行が有効に戻る（Req 1.6）', async () => {
    ready('operator');
    api.getDashboardUsers
      .mockResolvedValueOnce({ ok: true, value: [{ ...agencyUser, disabled: true }] }) // 初期（無効）
      .mockResolvedValueOnce({ ok: true, value: [{ ...agencyUser, disabled: false }] }); // 有効化後
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    api.enableDashboardUser.mockResolvedValue({ ok: true, value: { ...agencyUser, disabled: false } });
    render(<AdminUsersPage />);
    const scope = within(await screen.findByRole('main'));
    expect(await scope.findByText('無効')).toBeTruthy();
    fireEvent.click(scope.getByRole('button', { name: '有効化' }));
    expect(await scope.findByText('有効')).toBeTruthy();
    expect(api.enableDashboardUser).toHaveBeenCalledWith({ id: 'u2' });
    // 有効に戻った行に有効化ボタンは残らない。
    expect(scope.queryByRole('button', { name: '有効化' })).toBeNull();
  });

  it('無効化が last_operator を返すと専用文言を表示し、行は有効のまま（Req 2.6）', async () => {
    ready('operator');
    api.getDashboardUsers.mockResolvedValue({ ok: true, value: [agencyUser] });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    api.disableDashboardUser.mockResolvedValue({ ok: false, code: 'last_operator', message: 'x' });
    render(<AdminUsersPage />);
    const scope = within(await screen.findByRole('main'));
    fireEvent.click(await scope.findByRole('button', { name: '無効化' }));
    expect(await scope.findByText(/最後の運営は無効化できません/)).toBeTruthy();
    // 成功扱いされず、行は有効のまま（無効化ボタンが残る・再取得しない）。
    expect(scope.getByRole('button', { name: '無効化' })).toBeTruthy();
    expect(api.getDashboardUsers).toHaveBeenCalledTimes(1); // reload していない
  });

  it('無効化が self_disable_forbidden を返すと専用文言を表示する（Req 2.6）', async () => {
    ready('operator');
    api.getDashboardUsers.mockResolvedValue({ ok: true, value: [agencyUser] });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    api.disableDashboardUser.mockResolvedValue({ ok: false, code: 'self_disable_forbidden', message: 'x' });
    render(<AdminUsersPage />);
    const scope = within(await screen.findByRole('main'));
    fireEvent.click(await scope.findByRole('button', { name: '無効化' }));
    expect(await scope.findByText(/自分自身は無効化できません/)).toBeTruthy();
  });

  it('登録が email_conflict_disabled を返すと有効化での復旧を案内する（Req 3.2）', async () => {
    ready('operator');
    api.getDashboardUsers.mockResolvedValue({ ok: true, value: [] });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    api.createDashboardUser.mockResolvedValue({ ok: false, code: 'email_conflict_disabled', message: 'x' });
    render(<AdminUsersPage />);
    const scope = within(await screen.findByRole('main'));
    fireEvent.change(await scope.findByLabelText('所属代理店'), { target: { value: 'a1' } });
    fireEvent.change(scope.getByLabelText('メールアドレス'), { target: { value: 'disabled@example.com' } });
    fireEvent.click(scope.getByRole('button', { name: '利用者登録' }));
    expect(await scope.findByText(/このメールアドレスは無効化済みの利用者です。利用者一覧から有効化してください/)).toBeTruthy();
  });
});

describe('利用者管理ページ（agency ロール）', () => {
  it('運営のみ利用可能の 403 案内を出し、依存 API を呼ばない（Req 6.5）', async () => {
    ready('agency');
    render(<AdminUsersPage />);
    const scope = within(await screen.findByRole('main'));
    expect(await scope.findByText(/この画面は運営のみ利用できます/)).toBeTruthy();
    expect(scope.queryByLabelText('メールアドレス')).toBeNull();
    expect(api.getDashboardUsers).not.toHaveBeenCalled();
    expect(api.getAgencies).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ui-airbnb-surfaces task 2.5。以下は本タスクで追加した照合である。
//
// 上の 11 件は「登録・無効化・有効化が正しい引数で呼ばれる」ことと役割の出し分けを見ているが、
// 意匠の適用が壊しうる契約（処理中の文言・0 件の案内・取得失敗の分岐そのもの・列見出し・
// セルの不在表示・主見出し・403 の案内・送信中の無効化・操作要素の個数）には照合が
// **1 件も無かった**。実装に触れる前にここで固定し、素の実装に対して緑になることを
// 確認してから部品化へ進んだ（task 2.1〜2.4 と同じ順序）。
// ---------------------------------------------------------------------------

/** 走査範囲の全要素について、**直下のテキストノードだけ**を繋いだ文字列を集める。 */
function ownTextsIn(scope: HTMLElement): string[] {
  return Array.from(scope.querySelectorAll('*')).map((element) => ownText(element));
}

describe('利用者管理ページ: 着手前から在った契約（意匠の適用で壊しうる）', () => {
  it('一覧の列見出しの読み上げ文字列を変更しない（Req 6.2）', async () => {
    ready('operator');
    api.getDashboardUsers.mockResolvedValue({ ok: true, value: [agencyUser] });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    render(<AdminUsersPage />);
    const scope = within(await screen.findByRole('main'));
    await scope.findByText('agency@example.com');
    // **集合の完全一致**で見る。包含では列を 1 つ足す改変を捕まえられない。
    expect(scope.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'ロール',
      'メールアドレス',
      '所属代理店',
      '状態',
      '操作',
    ]);
  });

  it('行のセルの文字列を完全一致で固定する（ロール表示・不在の —・状態の語・Req 6.2, 6.4）', async () => {
    ready('operator');
    // email も所属代理店も持たない無効化済みの行を混ぜ、`—` の 2 経路と `無効` を同時に走査する。
    const retiredUser = {
      ...operatorUser,
      id: 'u3',
      email: null,
      agencyId: null,
      disabled: true,
    };
    api.getDashboardUsers.mockResolvedValue({
      ok: true,
      value: [operatorUser, agencyUser, retiredUser],
    });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    render(<AdminUsersPage />);
    const scope = within(await screen.findByRole('main'));
    await scope.findByText('op@example.com');
    // 状態を表す語を装飾で包んでも、テキストとしての完全一致は保つ（tasks.md 2.5 の指定）。
    // 見出し行を除いた本体行の全セルを行列で突き合わせる。
    const bodyRows = scope.getAllByRole('row').slice(1);
    expect(
      bodyRows.map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent)),
    ).toEqual([
      ['運営', 'op@example.com', '—', '有効', ''],
      ['代理店', 'agency@example.com', '代理店アルファ', '有効', '無効化'],
      ['運営', '—', '—', '無効', '有効化'],
    ]);
  });

  it('処理中の文言は ASCII 3 点である（三点リーダへ揃えない・Req 7.3）', () => {
    ready('operator');
    // 解決しない約束を返して取得中の分岐に留める（Promise.all なので両方を止める）。
    api.getDashboardUsers.mockReturnValue(new Promise(() => {}));
    api.getAgencies.mockReturnValue(new Promise(() => {}));
    render(<AdminUsersPage />);
    const main = screen.getByRole('main');
    const texts = ownTextsIn(main);
    expect(texts).toContain('読み込み中...');
    expect(texts).not.toContain('読み込み中…');
  });

  it('0 件の案内文言を変更しない（Req 6.2）', async () => {
    ready('operator');
    api.getDashboardUsers.mockResolvedValue({ ok: true, value: [] });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    render(<AdminUsersPage />);
    const scope = within(await screen.findByRole('main'));
    expect(await scope.findByText('利用者はまだいません。登録してください。')).toBeTruthy();
  });

  it('一覧の取得失敗は案内だけを出し、データを偽装しない（Req 7.4）', async () => {
    ready('operator');
    api.getDashboardUsers.mockResolvedValue({
      ok: false,
      code: 'network',
      message: '取得に失敗しました',
    });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    render(<AdminUsersPage />);
    const scope = within(await screen.findByRole('main'));
    expect(await scope.findByText('取得に失敗しました')).toBeTruthy();
    // 表も 0 件案内も出さない（空の一覧を「0 件」と偽らない）。
    expect(scope.queryByRole('table')).toBeNull();
    expect(scope.queryByText('利用者はまだいません。登録してください。')).toBeNull();
  });

  it('主見出しの読み上げ名と階層を、運営・代理店の両分岐で変更しない（Req 6.2, 6.5）', async () => {
    let visited = 0;
    for (const role of ['operator', 'agency'] as const) {
      useAuthMock.mockReset();
      Object.values(api).forEach((mock) => mock.mockReset());
      ready(role);
      api.getDashboardUsers.mockResolvedValue({ ok: true, value: [agencyUser] });
      api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
      render(<AdminUsersPage />);
      await screen.findByRole('main');
      expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent), role).toEqual([
        '利用者管理',
      ]);
      visited += 1;
      cleanup();
    }
    // 走査対象が 1 件も無い状態で緑にならないようにする（要件 7.4）。
    expect(visited).toBe(2);
  });

  it('運営専用の案内文言を完全一致で固定し、管理情報も登録手段も描かない（Req 6.5）', async () => {
    ready('agency');
    render(<AdminUsersPage />);
    const scope = within(await screen.findByRole('main'));
    expect(await scope.findByText('この画面は運営のみ利用できます。')).toBeTruthy();
    expect(scope.queryByRole('table')).toBeNull();
    expect(scope.queryByLabelText('ロール')).toBeNull();
    expect(scope.queryByRole('button', { name: '利用者登録' })).toBeNull();
  });

  it('送信中は利用者登録の押しボタンを無効にする（Req 3.5）', async () => {
    ready('operator');
    api.getDashboardUsers.mockResolvedValue({ ok: true, value: [] });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    // 解決しない約束を返し、送信中の状態に留める。
    api.createDashboardUser.mockReturnValue(new Promise(() => {}));
    render(<AdminUsersPage />);
    const scope = within(await screen.findByRole('main'));
    fireEvent.change(await scope.findByLabelText('所属代理店'), { target: { value: 'a1' } });
    fireEvent.change(scope.getByLabelText('メールアドレス'), {
      target: { value: 'pending@example.com' },
    });
    const submit = scope.getByRole('button', { name: '利用者登録' });
    // 送信前は無効ではない（無効が常時付いている実装を「緑」と読まないための対照）。
    expect(submit.hasAttribute('disabled')).toBe(false);
    fireEvent.click(submit);
    expect(scope.getByRole('button', { name: '利用者登録' }).hasAttribute('disabled')).toBe(true);
  });

  it('主要領域の操作要素の読み上げ名と個数を変えない（Req 3.3）', async () => {
    ready('operator');
    api.getDashboardUsers.mockResolvedValue({ ok: true, value: [operatorUser, agencyUser] });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    render(<AdminUsersPage />);
    const scope = within(await screen.findByRole('main'));
    await scope.findByText('op@example.com');
    // **集合の完全一致**で見る。押しボタンを 1 つ足す改変を包含判定は捕まえない。
    expect(scope.getAllByRole('button').map((button) => button.textContent)).toEqual([
      '利用者登録',
      '無効化',
    ]);
    // 選択は既定 role=代理店 なので 2 つ（ロール・所属代理店）。
    expect(scope.getAllByRole('combobox').map((select) => select.getAttribute('id'))).toEqual([
      'user-role',
      'user-agency',
    ]);
    // 主要領域にリンクは無い（帯の 5 件は main の外にある）。
    expect(scope.queryAllByRole('link')).toHaveLength(0);
  });
});

// --- 意匠の適用（task 2.5）------------------------------------------------------------

interface SurfaceBranch {
  /** 失敗メッセージへ出す分岐名（どの分岐が壊れたかを名指しさせる）。 */
  readonly name: string;
  readonly role: 'operator' | 'agency';
  /** 取得結果の偽装。 */
  readonly arrange: () => void;
  /** その分岐が実際に描かれたことの確認（描かれない状態を緑と読まないための前置き）。 */
  readonly settle: () => Promise<unknown>;
}

// **403 の分岐は別の return を持つ**（task 2.2 のログイン画面・task 2.4 の代理店管理と同型）。
// 片側だけを走査する照合は「403 の版面だけ狭い」という改変に対して証明可能に盲目になるため、
// 5 分岐すべてを回す。
const SURFACE_BRANCHES: readonly SurfaceBranch[] = [
  {
    // 403 は API を一切叩かず別の return を返す。ここを配列から外すと
    // 「403 の版面だけ狭い」という改変が緑のまま通る（task 2.4 で実際にそうなった）。
    name: 'agency/運営専用の案内',
    role: 'agency',
    arrange: () => {},
    settle: () => screen.findByText('この画面は運営のみ利用できます。'),
  },
  {
    name: 'operator/取得中',
    role: 'operator',
    arrange: () => {
      // 解決しない約束を返して取得中の分岐に留める（Promise.all なので両方を止める）。
      api.getDashboardUsers.mockReturnValue(new Promise(() => {}));
      api.getAgencies.mockReturnValue(new Promise(() => {}));
    },
    settle: () => screen.findByText('読み込み中...'),
  },
  {
    name: 'operator/失敗',
    role: 'operator',
    arrange: () => {
      api.getDashboardUsers.mockResolvedValue({
        ok: false,
        code: 'network',
        message: '取得に失敗しました',
      });
      api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    },
    settle: () => screen.findByText('取得に失敗しました'),
  },
  {
    name: 'operator/0 件',
    role: 'operator',
    arrange: () => {
      api.getDashboardUsers.mockResolvedValue({ ok: true, value: [] });
      api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    },
    settle: () => screen.findByText('利用者はまだいません。登録してください。'),
  },
  {
    name: 'operator/1 件以上',
    role: 'operator',
    arrange: () => {
      api.getDashboardUsers.mockResolvedValue({ ok: true, value: [operatorUser, agencyUser] });
      api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    },
    settle: () => screen.findByText('agency@example.com'),
  },
];

describe('利用者管理ページ: 意匠の適用', () => {
  it('どの分岐でも一覧系の広い版面へ置換し、主要領域を 1 つに保つ（Req 1.1, 1.5, 3.3）', async () => {
    let visited = 0;
    for (const branch of SURFACE_BRANCHES) {
      useAuthMock.mockReset();
      Object.values(api).forEach((mock) => mock.mockReset());
      ready(branch.role);
      branch.arrange();
      const { container } = render(<AdminUsersPage />);
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
      api.getDashboardUsers.mockResolvedValue({ ok: true, value: [agencyUser] });
      api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
      render(<AdminUsersPage />);
      const heading = await screen.findByRole('heading', { level: 1, name: '利用者管理' });
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
    api.getDashboardUsers.mockResolvedValue({ ok: true, value: [operatorUser, agencyUser] });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    render(<AdminUsersPage />);
    const scope = within(await screen.findByRole('main'));
    await scope.findByText('agency@example.com');

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
    expect(headers.map((header) => header.getAttribute('data-slot'))).toEqual(
      Array.from({ length: 5 }, () => 'table-header-cell'),
    );
    // 素の <th> は scope を持っていなかった。部品化で支援技術に対する後退を作らない。
    expect(headers.map((header) => header.getAttribute('scope'))).toEqual(
      Array.from({ length: 5 }, () => 'col'),
    );
    expect(scope.getAllByRole('cell').map((cell) => cell.getAttribute('data-slot'))).toEqual(
      Array.from({ length: 10 }, () => 'table-cell'),
    );
  });

  it('横方向の捲りは表の外側の容器が担い、キーボードで到達できる（Req 2.5, 4.1）', async () => {
    ready('operator');
    api.getDashboardUsers.mockResolvedValue({ ok: true, value: [agencyUser] });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    render(<AdminUsersPage />);
    const main = await screen.findByRole('main');
    await within(main).findByText('agency@example.com');

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
    api.getDashboardUsers.mockReturnValue(new Promise(() => {}));
    api.getAgencies.mockReturnValue(new Promise(() => {}));
    render(<AdminUsersPage />);
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

  it('取得の失敗・登録の失敗・操作の失敗・運営専用の案内が同じ危険の通知の部品に載る（4 経路・Req 1.1, 3.5）', async () => {
    const branches = [
      {
        name: '一覧の取得失敗',
        role: 'operator' as const,
        arrange: () => {
          api.getDashboardUsers.mockResolvedValue({
            ok: false,
            code: 'network',
            message: '取得に失敗しました',
          });
          api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
        },
        act: async () => {},
        text: '取得に失敗しました',
      },
      {
        name: '登録の失敗（未入力）',
        role: 'operator' as const,
        arrange: () => {
          api.getDashboardUsers.mockResolvedValue({ ok: true, value: [] });
          api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
        },
        act: async () => {
          fireEvent.click(await screen.findByRole('button', { name: '利用者登録' }));
        },
        text: 'メールアドレスを入力してください。',
      },
      {
        name: '無効化の拒否',
        role: 'operator' as const,
        arrange: () => {
          api.getDashboardUsers.mockResolvedValue({ ok: true, value: [agencyUser] });
          api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
          api.disableDashboardUser.mockResolvedValue({
            ok: false,
            code: 'last_operator',
            message: 'x',
          });
        },
        act: async () => {
          fireEvent.click(await screen.findByRole('button', { name: '無効化' }));
        },
        text: '最後の運営は無効化できません。先に別の運営を追加してください。',
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
      render(<AdminUsersPage />);
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
    api.getDashboardUsers.mockResolvedValue({ ok: true, value: [] });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    render(<AdminUsersPage />);
    const main = await screen.findByRole('main');
    await within(main).findByText('利用者はまだいません。登録してください。');

    const empties = main.querySelectorAll('[data-slot="empty-state"]');
    expect(empties).toHaveLength(1);
    // 文言は 1 文字も変えない。
    expect(
      within(empties[0] as HTMLElement).getByText('利用者はまだいません。登録してください。'),
    ).toBeTruthy();
  });

  it('選択 2 つ・記入欄 2 つ・ラベルを部品へ移し、属性と配線を保つ（Req 1.1, 3.2, 3.4）', async () => {
    ready('operator');
    api.getDashboardUsers.mockResolvedValue({ ok: true, value: [] });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    render(<AdminUsersPage />);
    const main = await screen.findByRole('main');
    const scope = within(main);

    const roleSelect = await scope.findByLabelText<HTMLSelectElement>('ロール');
    expect(roleSelect.tagName).toBe('SELECT');
    expect(roleSelect.getAttribute('data-slot')).toBe('select');
    const agencySelect = scope.getByLabelText<HTMLSelectElement>('所属代理店');
    expect(agencySelect.tagName).toBe('SELECT');
    expect(agencySelect.getAttribute('data-slot')).toBe('select');

    const emailInput = scope.getByLabelText<HTMLInputElement>('メールアドレス');
    expect(emailInput.tagName).toBe('INPUT');
    expect(emailInput.getAttribute('data-slot')).toBe('input');
    expect(emailInput.getAttribute('type')).toBe('email');
    const nameInput = scope.getByLabelText<HTMLInputElement>('表示名');
    expect(nameInput.tagName).toBe('INPUT');
    expect(nameInput.getAttribute('data-slot')).toBe('input');
    expect(nameInput.getAttribute('type')).toBe('text');

    // ラベル 4 つとも部品を通す（同一役割が面内で 2 通りに描かれる状態を残さない）。
    let labelled = 0;
    for (const id of ['user-role', 'user-agency', 'user-email', 'user-display-name']) {
      const label = main.querySelector(`label[for="${id}"]`);
      expect(label, id).not.toBeNull();
      expect(label!.getAttribute('data-slot'), id).toBe('label');
      labelled += 1;
    }
    expect(labelled).toBe(4);

    // **必須属性は包む要素ではなく元の要素から読める**（Req 3.4）。選択の部品は箱を 1 枚挟むので、
    // 属性がそちらへ載ると支援技術もフォーム検証も必須を認識しなくなる。
    expect(agencySelect.hasAttribute('required')).toBe(true);
    expect(agencySelect.parentElement?.hasAttribute('required')).toBe(false);
    expect(emailInput.hasAttribute('required')).toBe(true);
    // **必須属性を足さない。** Req 3.4 は「属性を保つ」であり、増やすのは保つことの反対である。
    expect(roleSelect.hasAttribute('required')).toBe(false);
    expect(nameInput.hasAttribute('required')).toBe(false);

    // 値の直接変更が届く（ブラウザ標準の選択要素の振る舞いを保つ・Req 3.4）。
    fireEvent.change(agencySelect, { target: { value: 'a1' } });
    expect(agencySelect.value).toBe('a1');
    fireEvent.change(emailInput, { target: { value: 'x@example.com' } });
    expect(emailInput.value).toBe('x@example.com');
  });

  it('役割の切り替えに応じた所属代理店の出し分けが従来どおり動く（Req 3.4・完了条件）', async () => {
    ready('operator');
    api.getDashboardUsers.mockResolvedValue({ ok: true, value: [] });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    render(<AdminUsersPage />);
    const scope = within(await screen.findByRole('main'));
    const roleSelect = await scope.findByLabelText<HTMLSelectElement>('ロール');
    // 既定は代理店。所属代理店の選択が出ている。
    expect(roleSelect.value).toBe('agency');
    expect(scope.getByLabelText('所属代理店')).toBeTruthy();
    // 運営へ切り替えると消える。
    fireEvent.change(roleSelect, { target: { value: 'operator' } });
    expect(scope.queryByLabelText('所属代理店')).toBeNull();
    // 代理店へ戻すと再び出る（片道だけの照合にしない）。
    fireEvent.change(roleSelect, { target: { value: 'agency' } });
    expect(scope.getByLabelText('所属代理店')).toBeTruthy();
    // 選択肢の読み上げ文字列も変えない。
    expect(Array.from(roleSelect.options).map((option) => option.textContent)).toEqual([
      '運営',
      '代理店',
    ]);
  });

  it('押しボタン 3 種を部品へ移し、読み上げ名と型を変えない（Req 1.1, 3.2）', async () => {
    ready('operator');
    api.getDashboardUsers.mockResolvedValue({
      ok: true,
      value: [agencyUser, { ...agencyUser, id: 'u4', email: 'off@example.com', disabled: true }],
    });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    render(<AdminUsersPage />);
    const scope = within(await screen.findByRole('main'));
    await scope.findByText('off@example.com');

    let checked = 0;
    for (const name of ['利用者登録', '無効化', '有効化']) {
      const button = scope.getByRole('button', { name });
      expect(button.getAttribute('data-slot'), name).toBe('button');
      // 押しボタンの既定の型は submit である。素の実装が持っていた type を落とさない。
      expect(button.getAttribute('type'), name).toBe('button');
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it('フォーム部品を包むのは段落ではなく汎用の容器であり、幅の段は面をまたいで同一である（Req 1.2, 1.3）', async () => {
    ready('operator');
    api.getDashboardUsers.mockResolvedValue({ ok: true, value: [] });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    render(<AdminUsersPage />);
    const main = await screen.findByRole('main');
    await within(main).findByLabelText('ロール');

    let visited = 0;
    for (const id of ['user-role', 'user-agency', 'user-email', 'user-display-name']) {
      const label = main.querySelector(`label[for="${id}"]`) as HTMLElement | null;
      expect(label, id).not.toBeNull();
      // 段落の中に容器を置くと、ブラウザの構文解析が段落を早期に閉じ、サーバ描画との
      // 突き合わせが崩れる（design.md の Modified Files が名指しで警告している事故）。
      expect(label!.closest('p'), id).toBeNull();
      const field = label!.parentElement!;
      expect(field.tagName, id).toBe('DIV');
      const tokens = field.className.split(/\s+/).filter((token) => token.length > 0);
      // **包含では足りない**。幅を与えるクラスの集合を完全一致で見る。
      expect(
        tokens.filter((token) => /(^|:)(?:max-|min-)?w-/.test(token)),
        id,
      ).toEqual(['sm:max-w-xs']);
      visited += 1;
    }
    expect(visited).toBe(4);
  });
});

// 面をまたいだ同一の寸法（要件 1.2）は、1 つの面の DOM を見るだけでは言えない。
// task 2.4 が招待コード・代理店管理で採った段と、本タスクが採る段が同じであることを
// **ソースの実物から**照合する（表への書き写しは修正を固定しない）。
describe('管理ダッシュボードのフォーム部品の幅は面をまたいで同一である（Req 1.2, 1.3）', () => {
  // vitest の作業ディレクトリは各パッケージの根である（`RUN v3.2.6 …/ts/apps/dashboard-web`）。
  // 解決に失敗したら下の存在確認が赤くなるので、静かに読み飛ばされることはない。
  const SOURCE_ROOT = resolve(process.cwd(), 'src/app');

  // task 5.2（店舗登録）が同じ段を採ったら、この配列へ自分を足すこと。
  const SURFACE_SOURCES = [
    'admin/users/page.tsx',
    'admin/agencies/page.tsx',
    'invite-codes/page.tsx',
  ] as const;

  it('3 面のフォーム容器が同一の幅の段を使う', () => {
    const found = new Set<string>();
    let scanned = 0;
    for (const relative of SURFACE_SOURCES) {
      const path = resolve(SOURCE_ROOT, relative);
      // 実物へ届いていないまま「一致している」と読まないための前置き（要件 7.4）。
      expect(existsSync(path), path).toBe(true);
      const source = readFileSync(path, 'utf8');
      const matches = source.match(/sm:max-w-[a-z0-9]+/g) ?? [];
      // **面ごとに非空を要求する**。1 件も無い面を「一致している」と読まないため（要件 7.4）。
      expect(matches.length, relative).toBeGreaterThan(0);
      matches.forEach((match) => found.add(match));
      scanned += 1;
    }
    expect(scanned).toBe(SURFACE_SOURCES.length);
    // 段が 2 つに割れた時点で赤くなる。
    expect(Array.from(found)).toEqual(['sm:max-w-xs']);
  });
});
