// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';

// 認証コンテキストはモックし、ready な operator/agency を注入する（stores-page.test と同規約）。
const useAuthMock = vi.fn();
vi.mock('../src/lib/auth-context', () => ({ useAuth: () => useAuthMock() }));

// next/navigation・next/link はブラウザランタイム依存のためモックする。
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
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
    expect(api.getInviteCodes.mock.calls[0][0]?.agencyId).toBeUndefined();
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
    expect(api.issueInviteCode.mock.calls[0][0]?.agencyId).toBeUndefined();
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
    const arg = api.disableInviteCode.mock.calls[0][0];
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
