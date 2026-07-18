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
    expect(api.createAgency.mock.calls[0][0]).toEqual({ name: '新代理店' });
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
