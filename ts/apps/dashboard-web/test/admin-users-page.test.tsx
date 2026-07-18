// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';

// 認証コンテキストはモックし、ready な operator/agency を注入する（invite-codes-page.test と同規約）。
const useAuthMock = vi.fn();
vi.mock('../src/lib/auth-context', () => ({ useAuth: () => useAuthMock() }));

// next/navigation・next/link はブラウザランタイム依存のためモックする。
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

// api クライアントは利用者・代理店系メソッドをモックする。
const api = vi.hoisted(() => ({
  getDashboardUsers: vi.fn(),
  createDashboardUser: vi.fn(),
  disableDashboardUser: vi.fn(),
  getAgencies: vi.fn(),
}));
vi.mock('../src/lib/api', () => api);

import AdminUsersPage from '../src/app/admin/users/page';

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
    expect(api.createDashboardUser.mock.calls[0][0]).toMatchObject({
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
