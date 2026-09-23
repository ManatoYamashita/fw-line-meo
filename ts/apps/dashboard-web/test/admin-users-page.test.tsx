// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { settleEffects } from './focus-observation';
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
  // 行直下の編集パネル（dashboard-user-edit task 3.3）が既定で使う送信の窓口。ページはパネルへ
  // 送信関数を注入しないので、パネルは同じモジュールのこの関数を呼ぶ。差し替えを忘れると
  // undefined が呼ばれ、保存の経路が例外の汎用文言へ落ちる。
  updateDashboardUser: vi.fn(),
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
    // 表示名の列はロールの次に置く（dashboard-user-edit の design「Web: 利用者一覧」の 6 列の順）。
    expect(scope.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'ロール',
      '表示名',
      'メールアドレス',
      '所属代理店',
      '状態',
      '操作',
    ]);
  });

  it('行のセルの文字列を完全一致で固定する（ロール表示・不在の —・状態の語・編集の操作・Req 6.2, 6.4）', async () => {
    ready('operator');
    // 表示名も email も所属代理店も持たない無効化済みの行を混ぜ、`—` の 3 経路と `無効` を同時に走査する。
    const retiredUser = {
      ...operatorUser,
      id: 'u3',
      email: null,
      displayName: null,
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
    // 操作の列は、どの行でも編集を先頭に置き、有効化・無効化をその後ろに続ける。
    // 自分の行は無効化を持たないので編集だけになる。
    expect(
      bodyRows.map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent)),
    ).toEqual([
      ['運営', '運営太郎', 'op@example.com', '—', '有効', '編集'],
      ['代理店', '代理花子', 'agency@example.com', '代理店アルファ', '有効', '編集無効化'],
      ['運営', '—', '—', '—', '無効', '編集有効化'],
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
    // 見えている文言の並び。編集は全行に 1 つずつあり（自分の行を含む）、無効化は他人の有効な行だけ。
    expect(scope.getAllByRole('button').map((button) => button.textContent)).toEqual([
      '利用者登録',
      '編集',
      '編集',
      '無効化',
    ]);
    // 読み上げ名の並び。編集だけが対象の利用者を名指しする読み上げ名を持つ（同じ「編集」が
    // 行の数だけ並んでも、支援技術の一覧で区別できる）。
    // 読み上げ名を「aria-label、無ければ文言」で近似するので、先に aria-labelledby が無いことを確かめる
    // （あれば近似が成り立たず、この比較は別のものを見ることになる）。
    expect(
      scope.getAllByRole('button').filter((button) => button.hasAttribute('aria-labelledby')),
    ).toHaveLength(0);
    expect(
      scope
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label') ?? button.textContent),
    ).toEqual(['利用者登録', 'op@example.com を編集', 'agency@example.com を編集', '無効化']);
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
    // 走査対象が 1 件も無い状態で緑にならないようにする（要件 7.4）。件数は literal で持つ。
    // 配列の長さと比べると、分岐を空にする改変が 0 = 0 で緑になる。
    expect(visited).toBe(5);
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

  it('列の折り返しの規則を中身の種類で選んでいる（design-language.md 7.18・Issue #283）', async () => {
    // 規則を持たない列は、表が容器より広いとき 1 文字の幅まで細る（日本語はどの文字の間でも
    // 折り返せる）。**並びを完全一致で固定する**のは、1 列だけ指定を落とす改変が
    // 「ほかの列は正しい」まま素通りするためである。
    ready('operator');
    api.getDashboardUsers.mockResolvedValue({ ok: true, value: [operatorUser, agencyUser] });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    render(<AdminUsersPage />);
    const scope = within(await screen.findByRole('main'));
    await scope.findByText('agency@example.com');

    const rows = scope.getAllByRole('row').slice(1);
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(
        Array.from(row.children).map((cell) => cell.getAttribute('data-wrap')),
        'アドレスはどこでも折り返し、ロールと状態は折り返さない。操作の列は押しボタンだけなので規則を持たない',
      ).toEqual(['none', 'prose', 'anywhere', 'prose', 'none', null]);
    }
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
    // 列は 6 つ（表示名の列を足した・dashboard-user-edit task 3.3）。
    const headers = scope.getAllByRole('columnheader');
    expect(headers.map((header) => header.getAttribute('data-slot'))).toEqual(
      Array.from({ length: 6 }, () => 'table-header-cell'),
    );
    // 素の <th> は scope を持っていなかった。部品化で支援技術に対する後退を作らない。
    expect(headers.map((header) => header.getAttribute('scope'))).toEqual(
      Array.from({ length: 6 }, () => 'col'),
    );
    // 2 行 × 6 列。
    expect(scope.getAllByRole('cell').map((cell) => cell.getAttribute('data-slot'))).toEqual(
      Array.from({ length: 12 }, () => 'table-cell'),
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

  it('取得の失敗・登録の失敗・操作の失敗・編集の拒否・運営専用の案内が同じ危険の通知の部品に載る（5 経路・Req 1.1, 3.5）', async () => {
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
        // 行直下の編集パネルが出す拒否（dashboard-user-edit task 3.3）。ここはページに他の通知が無い
        // 状態からの 1 経路に留める。ページの操作エラー・成功通知が出ている状態から編集を始める経路は、
        // 「利用者管理ページ: 保存の結果の通知」の describe が経路ごとに固定している（task 3.4）。
        name: '編集の拒否',
        role: 'operator' as const,
        arrange: () => {
          api.getDashboardUsers.mockResolvedValue({ ok: true, value: [agencyUser] });
          api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
          api.updateDashboardUser.mockResolvedValue({ ok: false, code: 'not_found', message: 'x' });
        },
        act: async () => {
          fireEvent.click(
            await screen.findByRole('button', { name: 'agency@example.com を編集' }),
          );
          fireEvent.change(screen.getByLabelText('表示名', { selector: '#user-edit-display-name-u2' }), {
            target: { value: '代理花子（改）' },
          });
          fireEvent.click(screen.getByRole('button', { name: '保存' }));
        },
        text: '利用者が見つかりません。画面を再読み込みしてください。',
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
    // 件数は literal で持つ。配列の長さと比べると、経路を空にする改変が 0 = 0 で緑になる。
    expect(visited).toBe(5);
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
      expect(label!.getAttribute('data-slot'), id).toBe('field-label');
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

  it('押しボタン 4 種を部品へ移し、読み上げ名と型を変えない（Req 1.1, 3.2）', async () => {
    ready('operator');
    api.getDashboardUsers.mockResolvedValue({
      ok: true,
      value: [agencyUser, { ...agencyUser, id: 'u4', email: 'off@example.com', disabled: true }],
    });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    render(<AdminUsersPage />);
    const scope = within(await screen.findByRole('main'));
    await scope.findByText('off@example.com');

    // 編集（dashboard-user-edit task 3.3）は有効な行と無効化済みの行の両方で見る（Req 6.2）。
    const names = [
      '利用者登録',
      '無効化',
      '有効化',
      'agency@example.com を編集',
      'off@example.com を編集',
    ];
    let checked = 0;
    for (const name of names) {
      const button = scope.getByRole('button', { name });
      expect(button.getAttribute('data-slot'), name).toBe('button');
      // 押しボタンの既定の型は submit である。素の実装が持っていた type を落とさない。
      expect(button.getAttribute('type'), name).toBe('button');
      checked += 1;
    }
    // 件数は literal で持つ。配列の長さと比べると、配列を空にする改変が 0 = 0 で緑になる。
    expect(checked).toBe(5);
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
      expect(field.getAttribute('data-slot'), id).toBe('field');
      const tokens = field.className.split(/\s+/).filter((token) => token.length > 0);
      // Field 自身の w-full と子の幅の規則は共通部品の契約。面が選ぶ広い幅での上限だけを固定する。
      expect(
        tokens.filter((token) => token.startsWith('sm:') && /(?:max-|min-)?w-/.test(token)),
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
  // 起点は src である。利用者の編集パネルは src/components にあるので、src/app を起点にすると
  // 対象へ足せない（dashboard-user-edit task 3.3）。
  const SOURCE_ROOT = resolve(process.cwd(), 'src');

  // task 5.2（店舗登録）が同じ段を採ったので、この配列へ自分を足した。
  // 利用者の編集パネル（dashboard-user-edit）は一覧の行の直下に置くフォームで、登録フォームと
  // 同じ段を採る（design「Web: 編集パネル」）。面ではなく部品なので、置き場所が異なる。
  const SURFACE_SOURCES = [
    'app/admin/users/page.tsx',
    'app/admin/agencies/page.tsx',
    'app/invite-codes/page.tsx',
    'app/stores/new/page.tsx',
    'components/dashboard-user-edit-panel.tsx',
  ] as const;

  it('4 面と利用者の編集パネルのフォーム容器が同一の幅の段を使う', () => {
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

// ---------------------------------------------------------------------------
// dashboard-user-edit task 3.3。一覧に表示名の列・編集の押しボタン・行直下の編集パネルを統合した。
// 行直下パネルの形は店舗一覧の QR 発行（stores-page.test.tsx）に揃える。保存の成功通知・通知の
// 整理・代理店一覧の取得失敗の伝達は task 3.4 の範囲なので、ここでは扱わない。
// ---------------------------------------------------------------------------

// 無効化済みの代理店ロール（表示名は未設定）。編集は状態を問わず全行に出す（Req 6.2）。
const disabledAgencyUser = {
  ...agencyUser,
  id: 'u4',
  email: 'off@example.com',
  displayName: null,
  disabled: true,
};

/** 運営として一覧を開き、表が描かれるまで待って主要領域を返す。 */
async function renderUserList(users: readonly object[]): Promise<HTMLElement> {
  ready('operator');
  api.getDashboardUsers.mockResolvedValue({ ok: true, value: users });
  api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
  render(<AdminUsersPage />);
  const main = await screen.findByRole('main');
  await within(main).findByRole('table');
  return main;
}

/** 指定の文字列のセルを持つ本文の行を返す。 */
function rowOf(main: HTMLElement, cellText: string): HTMLTableRowElement {
  const row = within(main).getByRole('cell', { name: cellText }).closest('tr');
  if (row === null) throw new Error(`row not found for ${cellText}`);
  return row;
}

/**
 * 見出しで指定したパネルの取りやめを、キーボードで押した状態（焦点を取りやめに載せてから押す）で
 * 押し、パネルが閉じたことまでを確かめる。焦点が取りやめに載ったままパネルごと消えるので、
 * 戻り先を持たない実装では焦点が body へ落ちる。
 */
async function cancelPanel(main: HTMLElement, headingName: string): Promise<void> {
  const heading = await within(main).findByRole('heading', { level: 2, name: headingName });
  const cancel = within(heading.closest('td') as HTMLElement).getByRole('button', {
    name: 'キャンセル',
  });
  cancel.focus();
  expect(document.activeElement).toBe(cancel);
  fireEvent.click(cancel);
  expect(within(main).queryByRole('heading', { level: 2 })).toBeNull();
}

// 保存の成功を伝える文言（dashboard-user-edit design「Web: 利用者一覧」の保存の成功・Req 1.12）。
const USER_UPDATED_TEXT = '利用者情報を更新しました。';

/** 解決を手元で遅らせる約束。保存の送信を保留したまま、別の操作を挟む経路を作るのに使う。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 指定の行の編集を開き、パネルの表示名を書き換えて保存を押す（保存の結果は待たない）。 */
async function editDisplayNameAndSave(
  main: HTMLElement,
  userLabel: string,
  userId: string,
  value: string,
): Promise<void> {
  fireEvent.click(await within(main).findByRole('button', { name: `${userLabel} を編集` }));
  const input = await within(main).findByLabelText('表示名', {
    selector: `#user-edit-display-name-${userId}`,
  });
  fireEvent.change(input, { target: { value } });
  fireEvent.click(within(main).getByRole('button', { name: '保存' }));
}

describe('利用者管理ページ: 表示名の列と編集の押しボタン', () => {
  it('表示名の列を設け、未設定の利用者は「—」で未設定と分かるように出す（Req 6.1）', async () => {
    const main = await renderUserList([agencyUser, disabledAgencyUser]);
    // 列の位置は見出しから引く。見出しとセルの並びが食い違えば、ここで別の列を読んで赤くなる。
    const column = within(main)
      .getAllByRole('columnheader')
      .map((header) => header.textContent)
      .indexOf('表示名');
    expect(column).toBeGreaterThanOrEqual(0);
    const bodyRows = within(main).getAllByRole('row').slice(1);
    expect(
      bodyRows.map((row) => within(row).getAllByRole('cell')[column]?.textContent),
    ).toEqual(['代理花子', '—']);
  });

  it('すべての行（自分・有効・無効化済み）に編集を 1 つずつ、有効化・無効化より前に置く（Req 6.2, 2.2）', async () => {
    const main = await renderUserList([operatorUser, agencyUser, disabledAgencyUser]);
    const expected = [
      { label: 'op@example.com を編集', buttons: ['編集'] },
      { label: 'agency@example.com を編集', buttons: ['編集', '無効化'] },
      { label: 'off@example.com を編集', buttons: ['編集', '有効化'] },
    ];
    const bodyRows = within(main).getAllByRole('row').slice(1);
    expect(bodyRows).toHaveLength(expected.length);
    let visited = 0;
    bodyRows.forEach((row, index) => {
      const want = expected[index]!;
      const buttons = within(row).getAllByRole('button');
      // 編集は操作の先頭に置く（design「操作列では、編集ボタンを既存の有効化・無効化の前に置く」）。
      expect(buttons.map((button) => button.textContent), want.label).toEqual(want.buttons);
      const edit = buttons[0]!;
      expect(edit.getAttribute('data-slot'), want.label).toBe('button');
      expect(edit.getAttribute('type'), want.label).toBe('button');
      // 対象の利用者を名指しし、見えている文言をそのまま含める。含めないと、音声入力の利用者が
      // 見えているとおりに発話しても操作できない（WCAG 2.5.3 Label in Name）。
      expect(edit.getAttribute('aria-label'), want.label).toBe(want.label);
      const visible = edit.textContent ?? '';
      expect(visible, want.label).toBe('編集');
      expect(edit.getAttribute('aria-label') ?? '', want.label).toContain(visible);
      // 閉じている間は開閉の状態を false で伝え、制御先を指さない（開いているときだけ指す）。
      expect(edit.getAttribute('aria-expanded'), want.label).toBe('false');
      expect(edit.hasAttribute('aria-controls'), want.label).toBe(false);
      visited += 1;
    });
    // 自分・有効・無効化済みの 3 行を確かに走査した（literal で持つ）。
    expect(visited).toBe(3);
  });

  it('読み上げ名が名指す対象は、パネルの見出しと同じ規則（メール → 表示名 → 「利用者」）で引く', async () => {
    const noEmail = { ...agencyUser, id: 'u6', email: null, displayName: 'メール無し' };
    const anonymous = { ...agencyUser, id: 'u7', email: null, displayName: null };
    const main = await renderUserList([noEmail, anonymous]);
    const edits = within(main).getAllByRole('button', { name: /を編集$/ });
    expect(edits.map((button) => button.getAttribute('aria-label'))).toEqual([
      'メール無し を編集',
      '利用者 を編集',
    ]);
    fireEvent.click(edits[0]!);
    expect(
      await within(main).findByRole('heading', { level: 2, name: 'メール無し の編集' }),
    ).toBeTruthy();
    fireEvent.click(edits[1]!);
    expect(
      await within(main).findByRole('heading', { level: 2, name: '利用者 の編集' }),
    ).toBeTruthy();
  });
});

describe('利用者管理ページ: 行直下の編集パネル', () => {
  it('編集を始めると対象行の直後に 1 段だけパネル行を挿し、全列にまたがらせる（Req 6.3, 1.1）', async () => {
    const main = await renderUserList([operatorUser, agencyUser, disabledAgencyUser]);
    // 対象は中ほどの行にする。末尾の行を対象にすると、表の末尾へ挿す改変と区別できない。
    const targetRow = rowOf(main, 'agency@example.com');
    const nextUserRow = rowOf(main, 'off@example.com');
    const edit = within(targetRow).getByRole('button', { name: 'agency@example.com を編集' });
    fireEvent.click(edit);

    const heading = await within(main).findByRole('heading', {
      level: 2,
      name: 'agency@example.com の編集',
    });
    const panelRow = targetRow.nextElementSibling as HTMLElement | null;
    expect(panelRow).not.toBeNull();
    // 対象行の直後であり、その次は元の次の行である（間に挟まる。末尾に付くのではない）。
    expect(panelRow!.contains(heading)).toBe(true);
    expect(panelRow!.nextElementSibling).toBe(nextUserRow);
    // 表の部品を通り、tbody の直下で行として隣り合う（間に要素を挟むと隣接関係が壊れる）。
    expect(panelRow!.tagName).toBe('TR');
    expect(panelRow!.getAttribute('data-slot')).toBe('table-row');
    expect(panelRow!.parentElement).toBe(targetRow.parentElement);
    expect(targetRow.parentElement?.getAttribute('data-slot')).toBe('table-body');

    // セルは 1 つだけで全列にまたがる。桁数は列見出しの実数と一致する。列数の起点は
    // 見出しセルの並びとは別に持たれているので、両者をここで結び付ける。
    const cells = Array.from(panelRow!.children) as HTMLElement[];
    expect(cells).toHaveLength(1);
    const panelCell = cells[0]!;
    expect(panelCell.tagName).toBe('TD');
    expect(panelCell.getAttribute('data-slot')).toBe('table-cell');
    expect(panelCell.getAttribute('colspan')).toBe('6');
    expect(panelCell.getAttribute('colspan')).toBe(
      String(within(main).getAllByRole('columnheader').length),
    );

    // 押しボタンは開いていることと制御先を伝え、制御先はこのセルである。
    expect(edit.getAttribute('aria-expanded')).toBe('true');
    expect(panelCell.getAttribute('id')).toBe('user-edit-panel-u2');
    expect(edit.getAttribute('aria-controls')).toBe(panelCell.getAttribute('id'));

    // 行は見出し 1 ＋ 利用者 3 ＋ パネル 1。パネルは表の捲れる容器の内側にあり、捲れる領域を
    // 増やさない（e2e の件数宣言と食い違わない）。
    expect(within(main).getAllByRole('row')).toHaveLength(5);
    expect(main.querySelectorAll('[data-slot="table-container"]')).toHaveLength(1);

    // 開いた時点のロール・所属代理店・表示名を初期値として出す（Req 1.1）。所属の選択肢は
    // 一覧と同じ取得結果である。
    const inside = within(panelCell);
    expect(inside.getByLabelText<HTMLSelectElement>('ロール').value).toBe('agency');
    const agencySelect = inside.getByLabelText<HTMLSelectElement>('所属代理店');
    expect(agencySelect.value).toBe('a1');
    expect(Array.from(agencySelect.options).map((option) => option.textContent)).toEqual([
      '代理店を選択してください',
      '代理店アルファ',
    ]);
    expect(inside.getByLabelText<HTMLInputElement>('表示名').value).toBe('代理花子');
  });

  it('パネルを開いても文書内の id は重複しない（制御先の id はパネル内の入力の id と分ける）', async () => {
    const main = await renderUserList([operatorUser, agencyUser]);
    fireEvent.click(within(main).getByRole('button', { name: 'agency@example.com を編集' }));
    await within(main).findByRole('heading', { level: 2 });
    const ids = Array.from(document.querySelectorAll('[id]')).map((element) => element.id);
    // 走査の対象が空のまま緑にならないよう、制御先とパネル内の入力が含まれていることを先に確かめる。
    expect(ids).toContain('user-edit-panel-u2');
    expect(ids).toContain('user-edit-display-name-u2');
    expect(ids).toContain('user-display-name');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('別の行の編集を始めると前のパネルを閉じ、開いているパネルを 1 つに保つ（Req 6.4）', async () => {
    const main = await renderUserList([operatorUser, agencyUser, disabledAgencyUser]);
    const first = within(main).getByRole('button', { name: 'agency@example.com を編集' });
    const second = within(main).getByRole('button', { name: 'off@example.com を編集' });
    fireEvent.click(first);
    await within(main).findByRole('heading', { level: 2, name: 'agency@example.com の編集' });
    fireEvent.click(second);
    await within(main).findByRole('heading', { level: 2, name: 'off@example.com の編集' });

    expect(
      within(main)
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(['off@example.com の編集']);
    expect(main.querySelectorAll('[id^="user-edit-panel-"]')).toHaveLength(1);
    expect(within(main).getAllByRole('row')).toHaveLength(5);
    // 開閉の状態も 1 つだけが開いている。閉じた側は制御先を指さない。
    expect(first.getAttribute('aria-expanded')).toBe('false');
    expect(first.hasAttribute('aria-controls')).toBe(false);
    expect(second.getAttribute('aria-expanded')).toBe('true');
    expect(second.getAttribute('aria-controls')).toBe('user-edit-panel-u4');
    // 新しいパネルは、新しく押した行の直後にある。
    expect(
      rowOf(main, 'off@example.com').nextElementSibling?.querySelector('#user-edit-panel-u4'),
    ).not.toBeNull();
  });

  it('取りやめるとパネルを閉じ、焦点を編集を始めた押しボタンへ戻す（Req 6.5）', async () => {
    const main = await renderUserList([operatorUser, agencyUser]);
    const edit = within(main).getByRole('button', { name: 'agency@example.com を編集' });
    edit.focus();
    fireEvent.click(edit);
    const heading = await within(main).findByRole('heading', {
      level: 2,
      name: 'agency@example.com の編集',
    });
    const panelCell = heading.closest('td') as HTMLElement;
    const cancel = within(panelCell).getByRole('button', { name: 'キャンセル' });
    // キーボードで取りやめを押した状態を作る。焦点が取りやめに載ったままパネルごと消えると、
    // 焦点は body へ落ちる（戻さない実装はここで赤くなる）。
    cancel.focus();
    expect(document.activeElement).toBe(cancel);
    fireEvent.click(cancel);

    expect(within(main).queryByRole('heading', { level: 2 })).toBeNull();
    expect(main.querySelector('[id^="user-edit-panel-"]')).toBeNull();
    expect(within(main).getAllByRole('row')).toHaveLength(3);
    // 焦点は押下の処理の中で同期に移す（passive effect ではない）ので、待たずに比べる。
    expect(document.activeElement).toBe(edit);
    expect(edit.getAttribute('aria-expanded')).toBe('false');
    expect(edit.hasAttribute('aria-controls')).toBe(false);
  });

  // 上のテストはページで最初に押した編集だけを見ている。戻り先を最初の 1 回しか控えない実装
  // （控えが空のときだけ代入する等）はそれでは緑のままなので、押し替えた後の戻り先を 2 経路で固定する。
  // 経路ごとにテストを分ける。1 本にまとめると、先の経路で赤くなった時点で後の経路が走らない。
  it('別の行へ切り替えてから取りやめると、焦点は後から押した行の編集へ戻る（最初に押した行ではない・Req 6.5）', async () => {
    const main = await renderUserList([operatorUser, agencyUser, disabledAgencyUser]);
    const editA = within(main).getByRole('button', { name: 'agency@example.com を編集' });
    const editB = within(main).getByRole('button', { name: 'off@example.com を編集' });

    editA.focus();
    fireEvent.click(editA);
    await within(main).findByRole('heading', { level: 2, name: 'agency@example.com の編集' });
    editB.focus();
    fireEvent.click(editB);
    await cancelPanel(main, 'off@example.com の編集');

    // 焦点が「移る」向きの比較なので、収束を待って肯定側で観測する（Issue #166）。
    await waitFor(() => expect(document.activeElement).toBe(editB));
    expect(document.activeElement).not.toBe(editA);
    expect(editA.getAttribute('aria-expanded')).toBe('false');
    expect(editB.getAttribute('aria-expanded')).toBe('false');
  });

  it('取りやめた後に別の行を開いて取りやめると、焦点はその行の編集へ戻る（Req 6.5）', async () => {
    const main = await renderUserList([operatorUser, agencyUser, disabledAgencyUser]);
    const editA = within(main).getByRole('button', { name: 'agency@example.com を編集' });
    const editB = within(main).getByRole('button', { name: 'off@example.com を編集' });

    // 1 回目: A を開いて取りやめる。戻り先は A。
    editA.focus();
    fireEvent.click(editA);
    await cancelPanel(main, 'agency@example.com の編集');
    await waitFor(() => expect(document.activeElement).toBe(editA));

    // 2 回目: B を開いて取りやめる。戻り先は B へ替わる（1 回目の A のままではない）。
    editB.focus();
    fireEvent.click(editB);
    await cancelPanel(main, 'off@example.com の編集');
    await waitFor(() => expect(document.activeElement).toBe(editB));
    expect(document.activeElement).not.toBe(editA);
  });

  it('保存に成功すると一覧を取り直し、焦点を編集の押しボタンへ戻してパネルを閉じ、成功を読み上げ領域で伝える（Req 1.12, 6.5）', async () => {
    ready('operator');
    const renamed = { ...agencyUser, displayName: '代理花子（改）' };
    api.getDashboardUsers
      .mockResolvedValueOnce({ ok: true, value: [operatorUser, agencyUser] }) // 初期
      .mockResolvedValueOnce({ ok: true, value: [operatorUser, renamed] }); // 保存後
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    api.updateDashboardUser.mockResolvedValue({ ok: true, value: renamed });
    render(<AdminUsersPage />);
    const main = await screen.findByRole('main');
    const edit = await within(main).findByRole('button', { name: 'agency@example.com を編集' });
    // 焦点の呼び出しを数える。「取り直しに失敗したとき」のテストは同じ数え方で「呼ばない」ことを
    // 見るので、ページが焦点を戻すときにこの数え方へ掛かることを、ここで確かめておく（発火の対照）。
    const focusCalls = vi.spyOn(edit, 'focus');
    fireEvent.click(edit);
    // 既定側: 保存する前は成功通知を出さない（常に出す実装を緑にしない）。
    expect(within(main).queryAllByRole('status')).toHaveLength(0);
    const input = await within(main).findByLabelText<HTMLInputElement>('表示名', {
      selector: '#user-edit-display-name-u2',
    });
    fireEvent.change(input, { target: { value: '代理花子（改）' } });
    fireEvent.click(within(main).getByRole('button', { name: '保存' }));

    // 取り直した一覧が描かれる（表示名の列に新しい値が出る）。
    expect(await within(main).findByRole('cell', { name: '代理花子（改）' })).toBeTruthy();
    // 移る向きの比較なので収束を待つ（Issue #166）。
    await waitFor(() => expect(document.activeElement).toBe(edit));
    expect(focusCalls).toHaveBeenCalledTimes(1);
    expect(within(main).queryByRole('heading', { level: 2 })).toBeNull();
    expect(edit.getAttribute('aria-expanded')).toBe('false');

    // 成功通知は成功の変種の通知部品に載り、部品自身が役割 status（区切りのよい時点で読み上げる）を
    // 持つ。失敗ではないので alert にはしない（進行中の読み上げを中断させない）。
    const notices = within(main).getAllByRole('status');
    expect(notices).toHaveLength(1);
    const notice = notices[0]!;
    expect(notice.getAttribute('data-slot')).toBe('alert');
    expect(notice.className).toContain('text-success');
    // 文言の側へ役割を重ねない（領域の二重化）。
    expect(notice.querySelectorAll('[role="status"], [role="alert"]')).toHaveLength(0);
    expect(announcedText(notice)).toBe(USER_UPDATED_TEXT);
    expect(within(main).queryAllByRole('alert')).toHaveLength(0);

    // 送ったのは表示名だけで、一覧は初期と保存後の 2 回取得した。
    expect(api.updateDashboardUser.mock.calls).toStrictEqual([
      [{ id: 'u2', changes: { displayName: '代理花子（改）' } }],
    ]);
    expect(api.getDashboardUsers).toHaveBeenCalledTimes(2);
  });

  it('自分の行で開いたパネルはロールと所属を固定表示にし、他人の行では選べる（Req 2.2）', async () => {
    const main = await renderUserList([operatorUser, agencyUser]);
    fireEvent.click(within(main).getByRole('button', { name: 'op@example.com を編集' }));
    const selfHeading = await within(main).findByRole('heading', {
      level: 2,
      name: 'op@example.com の編集',
    });
    const selfPanel = within(selfHeading.closest('td') as HTMLElement);
    // 選択の部品を出さず、理由を添え、表示名だけを受け付ける。
    expect(selfPanel.queryAllByRole('combobox')).toHaveLength(0);
    expect(selfPanel.getByText('自分自身のロールは変更できません。')).toBeTruthy();
    expect(selfPanel.getAllByRole('textbox').map((input) => input.id)).toEqual([
      'user-edit-display-name-u1',
    ]);

    // 対照: 他人の行では同じページでロールと所属を選べる（常に固定表示にする実装を緑にしない）。
    fireEvent.click(within(main).getByRole('button', { name: 'agency@example.com を編集' }));
    const otherHeading = await within(main).findByRole('heading', {
      level: 2,
      name: 'agency@example.com の編集',
    });
    const otherPanel = within(otherHeading.closest('td') as HTMLElement);
    expect(otherPanel.getAllByRole('combobox').map((select) => select.id)).toEqual([
      'user-edit-role-u2',
      'user-edit-agency-u2',
    ]);
    expect(otherPanel.queryByText('自分自身のロールは変更できません。')).toBeNull();
  });
});

// dashboard-user-edit task 3.4。保存の成功の通知・通知の整理・代理店一覧の取得状態を固定する。
// 成功時の取り直し・焦点・閉じる・成功通知の基本形は、上の describe の「保存に成功すると…」が持つ。
describe('利用者管理ページ: 保存の結果の通知', () => {
  // パネルの送信中も取りやめは押せる（dashboard-user-edit task 3.2）。そのため、保存した行のパネルが
  // 閉じられ、別の行のパネルが開いた後に、先の保存の成功が届くことがある。
  it('保存を待つ間に取りやめて別の行を開くと、先の保存の成功は今のパネルを閉じず、入力も焦点も奪わない（取り直しと成功通知は行う・Req 1.12, 6.5）', async () => {
    ready('operator');
    const renamed = { ...agencyUser, displayName: '代理花子（改）' };
    api.getDashboardUsers
      .mockResolvedValueOnce({ ok: true, value: [operatorUser, agencyUser, disabledAgencyUser] })
      .mockResolvedValueOnce({ ok: true, value: [operatorUser, renamed, disabledAgencyUser] });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    const pendingSave = deferred<unknown>();
    api.updateDashboardUser.mockReturnValueOnce(pendingSave.promise);
    render(<AdminUsersPage />);
    const main = await screen.findByRole('main');
    await within(main).findByRole('table');
    const editB = within(main).getByRole('button', { name: 'off@example.com を編集' });

    // A（agency@example.com）の保存を送信中のまま取りやめる。
    await editDisplayNameAndSave(main, 'agency@example.com', 'u2', '代理花子（改）');
    expect(api.updateDashboardUser).toHaveBeenCalledTimes(1);
    await cancelPanel(main, 'agency@example.com の編集');

    // B（off@example.com）を開き、表示名の欄に焦点を置いて書き換える。
    fireEvent.click(editB);
    const inputB = await within(main).findByLabelText<HTMLInputElement>('表示名', {
      selector: '#user-edit-display-name-u4',
    });
    inputB.focus();
    fireEvent.change(inputB, { target: { value: '無効花子' } });
    expect(document.activeElement).toBe(inputB);

    // A の保存が確定する。保存そのものは確定しているので、一覧の取り直しと成功通知は行う。
    pendingSave.resolve({ ok: true, value: renamed });
    expect(await within(main).findByRole('cell', { name: '代理花子（改）' })).toBeTruthy();
    expect(await within(main).findByText(USER_UPDATED_TEXT)).toBeTruthy();
    expect(api.getDashboardUsers).toHaveBeenCalledTimes(2);

    // 以下は「閉じない・奪わない」向きの比較なので、待たずに観測点を確定させてから比べる（Issue #166）。
    await settleEffects();
    expect(
      within(main)
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(['off@example.com の編集']);
    expect(editB.getAttribute('aria-expanded')).toBe('true');
    expect(inputB.isConnected).toBe(true);
    expect(inputB.value).toBe('無効花子');
    expect(document.activeElement).toBe(inputB);
  });

  // 上のテストは別の行を開いた経路である。同じ行を開き直した経路は、開いている利用者は同じでも
  // 保存したパネルとは別のパネルである。利用者で比べる実装はここで開き直したパネルを閉じ、その後の
  // 保存の失敗の警告ごと捨てて、成功通知だけを残す（Req 6.6・2.6 の「成功と誤認させない」に反する）。
  it('保存を待つ間に取りやめて同じ行を開き直すと、先の保存の成功は開き直したパネルを閉じず、その後の保存の失敗は警告 1 件で伝わる（Req 1.12, 6.5, 6.6）', async () => {
    ready('operator');
    const renamed = { ...agencyUser, displayName: '代理花子（改）' };
    api.getDashboardUsers
      .mockResolvedValueOnce({ ok: true, value: [operatorUser, agencyUser, disabledAgencyUser] })
      .mockResolvedValueOnce({ ok: true, value: [operatorUser, renamed, disabledAgencyUser] });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    const firstSave = deferred<unknown>();
    api.updateDashboardUser
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce({ ok: false, code: 'not_found', message: 'x' });
    render(<AdminUsersPage />);
    const main = await screen.findByRole('main');
    const editA = await within(main).findByRole('button', { name: 'agency@example.com を編集' });

    // 1 回目: A の保存を送信中のまま取りやめる。
    await editDisplayNameAndSave(main, 'agency@example.com', 'u2', '代理花子（改）');
    expect(api.updateDashboardUser).toHaveBeenCalledTimes(1);
    await cancelPanel(main, 'agency@example.com の編集');

    // 同じ A を開き直し、表示名の欄に焦点を置いて書き換える。
    fireEvent.click(editA);
    const reopened = await within(main).findByLabelText<HTMLInputElement>('表示名', {
      selector: '#user-edit-display-name-u2',
    });
    reopened.focus();
    fireEvent.change(reopened, { target: { value: '代理花子（再）' } });
    expect(document.activeElement).toBe(reopened);

    // 1 回目の保存が確定する。一覧の取り直しと成功通知は行う。
    firstSave.resolve({ ok: true, value: renamed });
    expect(await within(main).findByRole('cell', { name: '代理花子（改）' })).toBeTruthy();
    expect(await within(main).findByText(USER_UPDATED_TEXT)).toBeTruthy();
    expect(api.getDashboardUsers).toHaveBeenCalledTimes(2);

    // 開き直したパネルは閉じず、入力も焦点も奪わない（「奪わない」向きなので観測点を確定させる）。
    await settleEffects();
    expect(
      within(main)
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(['agency@example.com の編集']);
    expect(editA.getAttribute('aria-expanded')).toBe('true');
    expect(reopened.isConnected).toBe(true);
    expect(reopened.value).toBe('代理花子（再）');
    expect(document.activeElement).toBe(reopened);

    // 開き直したパネルの保存が失敗すると、パネルは開いたまま警告を 1 件だけ出す（捨てられない）。
    fireEvent.click(within(main).getByRole('button', { name: '保存' }));
    const notFound = '利用者が見つかりません。画面を再読み込みしてください。';
    await within(main).findByText(notFound);
    await settleEffects();
    const alerts = within(main).getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(announcedText(alerts[0]!)).toBe(notFound);
    // 警告は開き直したパネルの中に出る（ページの操作エラーではない）。
    expect(main.querySelector('#user-edit-panel-u2')?.contains(alerts[0]!)).toBe(true);
    // 先の保存の成功通知は残る。先の保存は確定しているので事実として正しい（独立レビューで許容と判定。
    // 消すにはパネルの送信の開始を一覧へ伝える口が要る）。今の状態を記録として固定する。
    const notices = within(main).getAllByRole('status');
    expect(notices).toHaveLength(1);
    expect(announcedText(notices[0]!)).toBe(USER_UPDATED_TEXT);
    expect(reopened.isConnected).toBe(true);
    expect(reopened.value).toBe('代理花子（再）');
    expect(api.updateDashboardUser.mock.calls).toStrictEqual([
      [{ id: 'u2', changes: { displayName: '代理花子（改）' } }],
      [{ id: 'u2', changes: { displayName: '代理花子（再）' } }],
    ]);
    // 2 回目は失敗したので取り直さない（1 回目の成功で増えた 2 回のまま）。
    expect(api.getDashboardUsers).toHaveBeenCalledTimes(2);
  });

  // 取りやめただけで次のパネルを開いていない経路。パネルを開いたときだけ番号を進める実装は、上の 2 本
  // （別の行・同じ行を開き直す）では緑のまま、この経路で「閉じたパネルがまだ開いている」と読み違える。
  it('保存を待つ間に取りやめて他の欄へ移ると、先の保存の成功は焦点を編集の押しボタンへ引き戻さない（取り直しと成功通知は行う・Req 1.12, 6.5）', async () => {
    ready('operator');
    const renamed = { ...agencyUser, displayName: '代理花子（改）' };
    api.getDashboardUsers
      .mockResolvedValueOnce({ ok: true, value: [operatorUser, agencyUser] })
      .mockResolvedValueOnce({ ok: true, value: [operatorUser, renamed] });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    const pendingSave = deferred<unknown>();
    api.updateDashboardUser.mockReturnValueOnce(pendingSave.promise);
    render(<AdminUsersPage />);
    const main = await screen.findByRole('main');

    await editDisplayNameAndSave(main, 'agency@example.com', 'u2', '代理花子（改）');
    await cancelPanel(main, 'agency@example.com の編集');
    // 取りやめで焦点は編集の押しボタンへ戻る（task 3.3）。利用者はそこから登録フォームの欄へ移る。
    const email = within(main).getByLabelText('メールアドレス');
    email.focus();
    expect(document.activeElement).toBe(email);

    pendingSave.resolve({ ok: true, value: renamed });
    expect(await within(main).findByRole('cell', { name: '代理花子（改）' })).toBeTruthy();
    expect(await within(main).findByText(USER_UPDATED_TEXT)).toBeTruthy();
    expect(api.getDashboardUsers).toHaveBeenCalledTimes(2);

    // 「奪わない」向きの比較なので、観測点を確定させてから比べる（Issue #166）。
    await settleEffects();
    expect(document.activeElement).toBe(email);
    expect(within(main).queryByRole('heading', { level: 2 })).toBeNull();
  });

  // 上の 3 本はいずれも取りやめを挟む。取りやめを挟まずに別の行へ切り替える経路は別に固定する。
  // 閉じるときだけ番号を進める実装は、上の 3 本では緑のまま、この経路で今のパネルを閉じる。
  it('保存を待つ間に、取りやめずに別の行の編集を押すと、先の保存の成功は今のパネルを閉じず、入力も焦点も奪わない（取り直しと成功通知は行う・Req 1.12, 6.4, 6.5）', async () => {
    ready('operator');
    const renamed = { ...agencyUser, displayName: '代理花子（改）' };
    api.getDashboardUsers
      .mockResolvedValueOnce({ ok: true, value: [operatorUser, agencyUser, disabledAgencyUser] })
      .mockResolvedValueOnce({ ok: true, value: [operatorUser, renamed, disabledAgencyUser] });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    const pendingSave = deferred<unknown>();
    api.updateDashboardUser.mockReturnValueOnce(pendingSave.promise);
    render(<AdminUsersPage />);
    const main = await screen.findByRole('main');
    await within(main).findByRole('table');
    const editB = within(main).getByRole('button', { name: 'off@example.com を編集' });

    // A（agency@example.com）の保存を送信中のまま、取りやめずに B（off@example.com）の編集を押す。
    // A のパネルは状態の差し替えで閉じ、同時に開いているパネルは B の 1 つになる（Req 6.4）。
    await editDisplayNameAndSave(main, 'agency@example.com', 'u2', '代理花子（改）');
    expect(api.updateDashboardUser).toHaveBeenCalledTimes(1);
    fireEvent.click(editB);
    const inputB = await within(main).findByLabelText<HTMLInputElement>('表示名', {
      selector: '#user-edit-display-name-u4',
    });
    expect(
      within(main)
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(['off@example.com の編集']);
    inputB.focus();
    fireEvent.change(inputB, { target: { value: '無効花子' } });
    expect(document.activeElement).toBe(inputB);

    // A の保存が確定する。一覧の取り直しと成功通知は行う。
    pendingSave.resolve({ ok: true, value: renamed });
    expect(await within(main).findByRole('cell', { name: '代理花子（改）' })).toBeTruthy();
    expect(await within(main).findByText(USER_UPDATED_TEXT)).toBeTruthy();
    expect(api.getDashboardUsers).toHaveBeenCalledTimes(2);

    // 「閉じない・奪わない」向きの比較なので、観測点を確定させてから比べる（Issue #166）。
    await settleEffects();
    expect(
      within(main)
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(['off@example.com の編集']);
    expect(editB.getAttribute('aria-expanded')).toBe('true');
    expect(inputB.isConnected).toBe(true);
    expect(inputB.value).toBe('無効花子');
    expect(document.activeElement).toBe(inputB);
  });

  // 開いている行の編集をもう一度押しても、パネルは作り直されず同じ実体のまま残る。保存したパネルは
  // まだ開いているので、保存の成功はそのパネルを閉じて焦点を戻す。押すたびに番号を進める実装は、
  // ここで「別のパネルが開いた」と読み違え、閉じずに焦点も戻さない。
  it('保存を待つ間に、開いている行の編集をもう一度押しても、保存の成功はそのパネルを閉じて焦点を編集の押しボタンへ戻す（Req 1.12, 6.5）', async () => {
    ready('operator');
    const renamed = { ...agencyUser, displayName: '代理花子（改）' };
    api.getDashboardUsers
      .mockResolvedValueOnce({ ok: true, value: [operatorUser, agencyUser] })
      .mockResolvedValueOnce({ ok: true, value: [operatorUser, renamed] });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    const pendingSave = deferred<unknown>();
    api.updateDashboardUser.mockReturnValueOnce(pendingSave.promise);
    render(<AdminUsersPage />);
    const main = await screen.findByRole('main');
    const editA = await within(main).findByRole('button', { name: 'agency@example.com を編集' });

    await editDisplayNameAndSave(main, 'agency@example.com', 'u2', '代理花子（改）');
    const input = within(main).getByLabelText<HTMLInputElement>('表示名', {
      selector: '#user-edit-display-name-u2',
    });
    // 前提: 送信中である（保存を押せない状態）。
    expect(within(main).getByRole('button', { name: '保存' }).getAttribute('aria-disabled')).toBe(
      'true',
    );

    // 送信中のまま、開いている行の編集をもう一度押す。パネルは同じ実体のまま、入力も送信中の状態も保つ。
    fireEvent.click(editA);
    expect(
      within(main).getByLabelText('表示名', { selector: '#user-edit-display-name-u2' }),
    ).toBe(input);
    expect(input.value).toBe('代理花子（改）');
    expect(within(main).getByRole('button', { name: '保存' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    // 焦点はパネルの中に置いておく（押しボタンに載ったままだと、焦点を戻したかどうかを区別できない）。
    input.focus();
    expect(document.activeElement).toBe(input);

    pendingSave.resolve({ ok: true, value: renamed });
    expect(await within(main).findByRole('cell', { name: '代理花子（改）' })).toBeTruthy();
    // 移る向きの比較なので収束を待つ（Issue #166）。
    await waitFor(() => expect(document.activeElement).toBe(editA));
    expect(within(main).queryByRole('heading', { level: 2 })).toBeNull();
    expect(editA.getAttribute('aria-expanded')).toBe('false');
    expect(within(main).getByText(USER_UPDATED_TEXT)).toBeTruthy();
    expect(api.getDashboardUsers).toHaveBeenCalledTimes(2);
  });

  // 設計の決定（dashboard-user-edit design「Web: 利用者一覧」の保存の成功）: 取り直しの失敗は既存の
  // 登録・無効化・有効化と同じく一覧の失敗の通知で伝える。保存は確定しているので成功通知も出し、
  // パネルは閉じる。戻り先の押しボタンは表ごと外れるので、焦点は移さない。
  it('保存は成功したが一覧の取り直しに失敗すると、成功通知と一覧の失敗を 1 件ずつ出してパネルを閉じ、外れる押しボタンへ焦点を移さない（Req 1.12, 6.5, 6.6）', async () => {
    ready('operator');
    const renamed = { ...agencyUser, displayName: '代理花子（改）' };
    const created = { ...agencyUser, id: 'u5', email: 'new@example.com', displayName: null };
    api.getDashboardUsers
      .mockResolvedValueOnce({ ok: true, value: [operatorUser, agencyUser] }) // 初期
      .mockResolvedValueOnce({ ok: false, code: 'network', message: '取得に失敗しました' }) // 保存後
      .mockResolvedValueOnce({ ok: true, value: [operatorUser, renamed, created] }); // 登録後
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    api.updateDashboardUser.mockResolvedValue({ ok: true, value: renamed });
    api.createDashboardUser.mockResolvedValue({ ok: true, value: created });
    render(<AdminUsersPage />);
    const main = await screen.findByRole('main');
    const edit = await within(main).findByRole('button', { name: 'agency@example.com を編集' });
    // 呼び出しの有無で見る。終わりの焦点の位置（body）だけでは、外れる直前の押しボタンへ焦点を移して
    // から表ごと外れる実装と区別できない。数え方が掛かることは成功のテストで対照を取っている。
    const focusCalls = vi.spyOn(edit, 'focus');
    fireEvent.click(edit);
    const input = await within(main).findByLabelText('表示名', {
      selector: '#user-edit-display-name-u2',
    });
    fireEvent.change(input, { target: { value: '代理花子（改）' } });
    // キーボードで保存を押した状態を作る（焦点はパネルの中にある）。
    const save = within(main).getByRole('button', { name: '保存' });
    save.focus();
    fireEvent.click(save);

    // 一覧の失敗は既存の通知のまま出し、表を出さない（データを偽装しない）。
    await within(main).findByText('取得に失敗しました');
    expect(within(main).queryByRole('table')).toBeNull();
    // 危険の通知は一覧の失敗の 1 件だけで、パネルの警告と重ならない。
    const alerts = within(main).getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(announcedText(alerts[0]!)).toBe('取得に失敗しました');
    // 保存は確定しているので、成功通知も出す（隠すと、利用者が同じ保存を重ねて試みる）。
    const notices = within(main).getAllByRole('status');
    expect(notices).toHaveLength(1);
    expect(announcedText(notices[0]!)).toBe(USER_UPDATED_TEXT);

    // 「移さない」向きの比較なので、観測点を確定させてから比べる。
    await settleEffects();
    expect(edit.isConnected).toBe(false);
    expect(focusCalls).not.toHaveBeenCalled();

    // パネルは閉じている。次に一覧を取り直せたとき（ここでは登録の成功）に、パネルが開き直らない。
    fireEvent.change(within(main).getByLabelText('所属代理店', { selector: '#user-agency' }), {
      target: { value: 'a1' },
    });
    fireEvent.change(within(main).getByLabelText('メールアドレス'), {
      target: { value: 'new@example.com' },
    });
    fireEvent.click(within(main).getByRole('button', { name: '利用者登録' }));
    expect(await within(main).findByRole('cell', { name: 'new@example.com' })).toBeTruthy();
    expect(api.getDashboardUsers).toHaveBeenCalledTimes(3);
    expect(within(main).queryByRole('heading', { level: 2 })).toBeNull();
    expect(main.querySelector('[id^="user-edit-panel-"]')).toBeNull();
    expect(
      within(main)
        .getByRole('button', { name: 'agency@example.com を編集' })
        .getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('ページの操作エラーが出ている状態から編集を始めると操作エラーを消し、保存に失敗しても危険の通知は 1 件で、一覧を取り直さない（Req 6.6）', async () => {
    ready('operator');
    api.getDashboardUsers.mockResolvedValue({ ok: true, value: [operatorUser, agencyUser] });
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    api.disableDashboardUser.mockResolvedValue({ ok: false, code: 'network', message: 'x' });
    api.updateDashboardUser.mockResolvedValue({ ok: false, code: 'not_found', message: 'x' });
    render(<AdminUsersPage />);
    const main = await screen.findByRole('main');

    // 前提: ページの操作エラー（無効化の失敗）が出ている。
    fireEvent.click(await within(main).findByRole('button', { name: '無効化' }));
    const disableFailed = '無効化に失敗しました。時間をおいて再試行してください。';
    await within(main).findByText(disableFailed);
    expect(within(main).getAllByRole('alert')).toHaveLength(1);

    // 編集を始めた時点で消す（保存の結果を待たない）。
    fireEvent.click(within(main).getByRole('button', { name: 'agency@example.com を編集' }));
    expect(within(main).queryByText(disableFailed)).toBeNull();
    expect(within(main).queryAllByRole('alert')).toHaveLength(0);

    fireEvent.change(
      await within(main).findByLabelText('表示名', { selector: '#user-edit-display-name-u2' }),
      { target: { value: '代理花子（改）' } },
    );
    fireEvent.click(within(main).getByRole('button', { name: '保存' }));
    const notFound = '利用者が見つかりません。画面を再読み込みしてください。';
    await within(main).findByText(notFound);
    await settleEffects();
    const alerts = within(main).getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(announcedText(alerts[0]!)).toBe(notFound);
    // 失敗したパネルは開いたままである。
    expect(
      within(main).getByRole('heading', { level: 2, name: 'agency@example.com の編集' }),
    ).toBeTruthy();
    // 保存が失敗したので一覧は取り直さない（初期の 1 回だけ）。取り直しが同じ数え方に掛かることは、
    // 次のテストが成功の保存で 1 回増えることとして対で確かめている。
    expect(api.getDashboardUsers).toHaveBeenCalledTimes(1);
    expect(within(main).queryAllByRole('status')).toHaveLength(0);
  });

  it('成功通知が出ている状態から編集を始めると成功通知を消し、保存に失敗しても危険の通知は 1 件で、一覧を取り直さない（Req 1.12, 6.6）', async () => {
    ready('operator');
    const renamed = { ...agencyUser, displayName: '代理花子（改）' };
    api.getDashboardUsers
      .mockResolvedValueOnce({ ok: true, value: [operatorUser, agencyUser] }) // 初期
      .mockResolvedValueOnce({ ok: true, value: [operatorUser, renamed] }); // 1 回目の保存後
    api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
    api.updateDashboardUser
      .mockResolvedValueOnce({ ok: true, value: renamed })
      .mockResolvedValueOnce({ ok: false, code: 'not_found', message: 'x' });
    render(<AdminUsersPage />);
    const main = await screen.findByRole('main');

    // 前提: 1 回目の保存が成功して成功通知が出ている。取り直しはここで 1 回増える（数え方の対照）。
    await editDisplayNameAndSave(main, 'agency@example.com', 'u2', '代理花子（改）');
    await within(main).findByText(USER_UPDATED_TEXT);
    expect(api.getDashboardUsers).toHaveBeenCalledTimes(2);

    // 同じ行の編集をもう一度始める。成功通知は開始の時点で消す。
    await editDisplayNameAndSave(main, 'agency@example.com', 'u2', '代理花子（再）');
    const notFound = '利用者が見つかりません。画面を再読み込みしてください。';
    await within(main).findByText(notFound);
    await settleEffects();
    expect(within(main).queryByText(USER_UPDATED_TEXT)).toBeNull();
    expect(within(main).queryAllByRole('status')).toHaveLength(0);
    const alerts = within(main).getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(announcedText(alerts[0]!)).toBe(notFound);
    // 2 回目は失敗したので取り直さない（1 回目の成功で増えた 2 回のまま）。
    expect(api.getDashboardUsers).toHaveBeenCalledTimes(2);
  });

  it('成功通知は、編集の開始のほかに登録・無効化・有効化を始めた時点でも消す（Req 1.12）', async () => {
    // 操作は結果を返さないまま保留する。消えたのが「操作を始めたから」であって、結果や一覧の取り直しの
    // 副作用ではないことを確かめるため。
    const routes = [
      {
        name: '登録',
        arrange: () => api.createDashboardUser.mockReturnValue(new Promise(() => {})),
        act: (main: HTMLElement) => {
          fireEvent.change(within(main).getByLabelText('所属代理店', { selector: '#user-agency' }), {
            target: { value: 'a1' },
          });
          fireEvent.change(within(main).getByLabelText('メールアドレス'), {
            target: { value: 'new@example.com' },
          });
          fireEvent.click(within(main).getByRole('button', { name: '利用者登録' }));
        },
        started: () => api.createDashboardUser,
      },
      {
        name: '無効化',
        arrange: () => api.disableDashboardUser.mockReturnValue(new Promise(() => {})),
        act: (main: HTMLElement) => {
          fireEvent.click(within(main).getByRole('button', { name: '無効化' }));
        },
        started: () => api.disableDashboardUser,
      },
      {
        name: '有効化',
        arrange: () => api.enableDashboardUser.mockReturnValue(new Promise(() => {})),
        act: (main: HTMLElement) => {
          fireEvent.click(within(main).getByRole('button', { name: '有効化' }));
        },
        started: () => api.enableDashboardUser,
      },
    ];
    let visited = 0;
    for (const route of routes) {
      useAuthMock.mockReset();
      Object.values(api).forEach((mock) => mock.mockReset());
      ready('operator');
      api.getDashboardUsers.mockResolvedValue({
        ok: true,
        value: [operatorUser, agencyUser, disabledAgencyUser],
      });
      api.getAgencies.mockResolvedValue({ ok: true, value: [agencyAlpha] });
      api.updateDashboardUser.mockResolvedValue({ ok: true, value: agencyUser });
      route.arrange();
      render(<AdminUsersPage />);
      const main = await screen.findByRole('main');

      await editDisplayNameAndSave(main, 'agency@example.com', 'u2', '代理花子（改）');
      await within(main).findByText(USER_UPDATED_TEXT);
      route.act(main);
      // 操作が確かに始まった（押し損ねで何も起きていないのに「消えた」と読まない）。
      expect(route.started(), route.name).toHaveBeenCalledTimes(1);
      expect(within(main).queryByText(USER_UPDATED_TEXT), route.name).toBeNull();
      visited += 1;
      cleanup();
    }
    // 件数は literal で持つ。配列の長さと比べると、経路を空にする改変が 0 = 0 で緑になる。
    expect(visited).toBe(3);
  });
});

describe('利用者管理ページ: 代理店一覧の取得状態', () => {
  const AGENCIES_LOCKED_REASON =
    '代理店一覧を取得できないため、ロールと所属代理店は変更できません。画面を再読み込みしてください。';

  it('代理店一覧の取得に失敗した状態でパネルを開くと、ロールと所属を固定表示にして理由を添え、表示名だけを受け付ける（Req 1.14）', async () => {
    ready('operator');
    api.getDashboardUsers.mockResolvedValue({ ok: true, value: [operatorUser, agencyUser] });
    api.getAgencies.mockResolvedValue({ ok: false, code: 'network', message: '代理店の取得に失敗' });
    render(<AdminUsersPage />);
    const main = await screen.findByRole('main');
    const edit = await within(main).findByRole('button', { name: 'agency@example.com を編集' });
    // 取得の失敗をページの通知にしない（既存の挙動）。編集を始めるとページの操作エラーが消えるので、
    // パネルを開いた後だけで見ると、失敗を操作エラーとして出す改変を取りこぼす。開く前に観測する。
    // 「出さない」向きの比較なので、観測点を確定させてから比べる（Issue #166）。
    await settleEffects();
    expect(within(main).queryAllByRole('alert')).toHaveLength(0);

    fireEvent.click(edit);
    const heading = await within(main).findByRole('heading', {
      level: 2,
      name: 'agency@example.com の編集',
    });
    const panel = within(heading.closest('td') as HTMLElement);

    // 選択の部品を出さない。空の選択肢で出すと、現在の所属を未所属のように見せてしまう。
    expect(panel.queryAllByRole('combobox')).toHaveLength(0);
    expect(panel.getAllByRole('term').map((term) => term.textContent)).toEqual([
      'ロール',
      '所属代理店',
    ]);
    // 所属は名前を引けないので、一覧と同じ規則で id を出す。
    expect(panel.getAllByRole('definition').map((definition) => definition.textContent)).toEqual([
      '代理店',
      'a1',
    ]);
    expect(panel.getByText(AGENCIES_LOCKED_REASON)).toBeTruthy();
    expect(panel.getAllByRole('textbox').map((input) => input.id)).toEqual([
      'user-edit-display-name-u2',
    ]);

    // 登録フォームの既存の挙動は変えない: 所属代理店の選択は、未選択の選択肢だけの空の一覧のまま出す。
    // パネルを開いた後も危険の通知は無い（固定表示の理由は案内であって警告ではない）。
    const formAgency = within(main).getByLabelText<HTMLSelectElement>('所属代理店', {
      selector: '#user-agency',
    });
    expect(Array.from(formAgency.options).map((option) => option.textContent)).toEqual([
      '代理店を選択してください',
    ]);
    expect(within(main).queryAllByRole('alert')).toHaveLength(0);
  });
});
