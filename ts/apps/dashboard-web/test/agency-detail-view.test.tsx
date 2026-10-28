// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';

// 代理店ごとの詳細（Issue #486・agency-dashboard Requirement 9）の描画。

const useAuthMock = vi.fn();
vi.mock('../src/lib/auth-context', () => ({ useAuth: () => useAuthMock() }));
vi.mock('next/link', () => ({
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

// 取得 5 本に加え、書込の API も差し替える。書込は 1 度も呼ばれてはならない（Req 9.10）。
const api = vi.hoisted(() => ({
  getAgencies: vi.fn(),
  getDashboardUsers: vi.fn(),
  getOwners: vi.fn(),
  getStores: vi.fn(),
  getInviteCodes: vi.fn(),
  issueInviteCode: vi.fn(),
  disableInviteCode: vi.fn(),
  suspendStore: vi.fn(),
  resumeStore: vi.fn(),
  disableDashboardUser: vi.fn(),
  enableDashboardUser: vi.fn(),
}));
vi.mock('../src/lib/api', async () => (await import('./deferred-mocks')).deferResolution(api));

import { AgencyDetailView } from '../src/app/admin/agencies/[agencyId]/agency-detail-view';

// 英字を含める。数字だけの id は toUpperCase() で値が変わらず、大文字の URL の試験が空振りする。
const AGENCY_ID = 'abcdef22-2222-2222-2222-222222222222';
const OTHER_AGENCY_ID = '22222222-2222-2222-2222-222222222299';
const FETCHERS = ['getAgencies', 'getDashboardUsers', 'getOwners', 'getStores', 'getInviteCodes'] as const;
const WRITERS = [
  'issueInviteCode',
  'disableInviteCode',
  'suspendStore',
  'resumeStore',
  'disableDashboardUser',
  'enableDashboardUser',
] as const;

const AGENCY = { id: AGENCY_ID, operatorId: 'op', name: '代理店アルファ', createdAt: '2026-08-01T00:00:00.000Z' };
const USERS = [
  {
    id: 'u-mine',
    role: 'agency',
    operatorId: 'op',
    agencyId: AGENCY_ID,
    email: 'alpha@example.com',
    displayName: 'アルファ担当',
    disabled: false,
    createdAt: '2026-08-02T00:00:00.000Z',
  },
  {
    id: 'u-mine-disabled',
    role: 'agency',
    operatorId: 'op',
    agencyId: AGENCY_ID,
    email: 'old@example.com',
    displayName: null,
    disabled: true,
    createdAt: '2026-08-03T00:00:00.000Z',
  },
  {
    id: 'u-other',
    role: 'agency',
    operatorId: 'op',
    agencyId: OTHER_AGENCY_ID,
    email: 'other@example.com',
    displayName: '他代理店',
    disabled: false,
    createdAt: '2026-08-02T00:00:00.000Z',
  },
  {
    id: 'u-operator',
    role: 'operator',
    operatorId: 'op',
    agencyId: null,
    email: 'operator@example.com',
    displayName: '運営',
    disabled: false,
    createdAt: '2026-08-02T00:00:00.000Z',
  },
];
const CODE_ACTIVE = { id: 'c-active', agencyId: AGENCY_ID, code: 'ABCD-EFGH-JKLM', disabled: false, createdAt: '2026-08-05T00:00:00.000Z' };
const CODE_DISABLED = { id: 'c-disabled', agencyId: AGENCY_ID, code: 'MNOP-QRST-UVWX', disabled: true, createdAt: '2026-08-06T00:00:00.000Z' };
const OWNERS = [
  {
    id: 'o-recorded',
    displayName: '記録あり太郎',
    onboardingStatus: 'store_identified',
    createdAt: '2026-08-10T00:00:00.000Z',
    inviteCode: { id: CODE_ACTIVE.id, code: CODE_ACTIVE.code, disabled: false },
  },
  {
    id: 'o-unrecorded',
    displayName: '記録なし次郎',
    onboardingStatus: 'pending',
    createdAt: '2026-07-10T00:00:00.000Z',
    inviteCode: null,
  },
  {
    // 同じコードで複数のオーナーが登録できる（Req 2.5）。
    id: 'o-recorded-2',
    displayName: '記録あり三郎',
    onboardingStatus: 'active',
    createdAt: '2026-08-20T00:00:00.000Z',
    inviteCode: { id: CODE_ACTIVE.id, code: CODE_ACTIVE.code, disabled: false },
  },
];
const STORES = [
  {
    id: 's1',
    name: '太郎食堂',
    placeStatus: 'confirmed',
    suspendedAt: null,
    competitorConfigured: true,
    ownerId: 'o-recorded',
    ownerDisplayName: '記録あり太郎',
    agencyId: AGENCY_ID,
    agencyName: AGENCY.name,
    createdAt: '2026-08-11T00:00:00.000Z',
  },
  {
    id: 's2',
    name: '太郎食堂 駅前店',
    placeStatus: 'confirmed',
    suspendedAt: '2026-09-01T00:00:00.000Z',
    competitorConfigured: false,
    ownerId: 'o-recorded',
    ownerDisplayName: '記録あり太郎',
    agencyId: AGENCY_ID,
    agencyName: AGENCY.name,
    createdAt: '2026-08-12T00:00:00.000Z',
  },
  {
    id: 's3',
    name: '次郎食堂',
    placeStatus: 'pending',
    suspendedAt: null,
    competitorConfigured: false,
    ownerId: 'o-unrecorded',
    ownerDisplayName: '記録なし次郎',
    agencyId: AGENCY_ID,
    agencyName: AGENCY.name,
    createdAt: '2026-08-13T00:00:00.000Z',
  },
  {
    id: 's4',
    name: '三郎食堂',
    placeStatus: 'confirmed',
    suspendedAt: null,
    competitorConfigured: true,
    ownerId: 'o-recorded-2',
    ownerDisplayName: '記録あり三郎',
    agencyId: AGENCY_ID,
    agencyName: AGENCY.name,
    createdAt: '2026-08-21T00:00:00.000Z',
  },
];
// 正常系の件数は互いに違う値にしておく（利用者 2・オーナー 3・店舗 4・有効な招待コード 1）。
// 揃っていると、ある件数を別の区分の長さから数える取り違えが緑のまま通る。
const EXPECTED_COUNTS = {
  ダッシュボードの利用者: '2',
  オーナー: '3',
  店舗: '4',
  有効な招待コード: '1',
};

function ready(role: 'operator' | 'agency') {
  useAuthMock.mockReturnValue({
    status: 'ready',
    me: {
      role,
      agencyId: role === 'agency' ? AGENCY_ID : null,
      agencyName: role === 'agency' ? AGENCY.name : null,
      displayName: 'テスト',
    },
    signIn: vi.fn(),
    signOut: vi.fn(),
  });
}

function ok<T>(value: T) {
  return { ok: true as const, value };
}
const FAILED = { ok: false as const, code: 'internal', message: 'boom' };

function resolveAll(overrides: Partial<Record<(typeof FETCHERS)[number], unknown>> = {}) {
  api.getAgencies.mockResolvedValue(overrides.getAgencies ?? ok([AGENCY]));
  api.getDashboardUsers.mockResolvedValue(overrides.getDashboardUsers ?? ok(USERS));
  api.getOwners.mockResolvedValue(overrides.getOwners ?? ok(OWNERS));
  api.getStores.mockResolvedValue(overrides.getStores ?? ok(STORES));
  api.getInviteCodes.mockResolvedValue(overrides.getInviteCodes ?? ok([CODE_ACTIVE, CODE_DISABLED]));
}

/** 概要（dl）の件数を「項目名 → 値」で返す。 */
function summary(): Record<string, string> {
  const terms = screen.getAllByRole('term');
  expect(terms.length).toBeGreaterThan(0);
  // 定義リストのまま描いていること（dt の暗黙の役割だけを見ると、dl を div に替えても通る）。
  for (const term of terms) expect(term.closest('dl'), term.textContent ?? '').not.toBeNull();
  return Object.fromEntries(terms.map((term) => [term.textContent ?? '', term.nextElementSibling?.textContent ?? '']));
}

/** 区分（h2）の直後から次の h2 までの範囲。 */
function section(title: string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 2, name: title });
  const container = heading.closest('section');
  if (container === null) throw new Error(`区分が見つかりません: ${title}`);
  return container;
}

beforeEach(() => {
  useAuthMock.mockReset();
  Object.values(api).forEach((m) => m.mockReset());
});
afterEach(cleanup);

describe('代理店詳細: 表示の前提（Req 9.6・9.9）', () => {
  it('代理店ロールには管理情報を描かず、API を 1 本も呼ばない（9.9）', async () => {
    ready('agency');
    resolveAll();
    render(<AgencyDetailView agencyId={AGENCY_ID} />);
    expect(await screen.findByText('この画面は運営のみ利用できます。')).toBeTruthy();
    for (const name of FETCHERS) expect(api[name], name).not.toHaveBeenCalled();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText(AGENCY.name)).toBeNull();
  });

  it('UUID の形でない id は API を呼ばずに「見つかりません」を出す（9.6）', async () => {
    ready('operator');
    resolveAll();
    render(<AgencyDetailView agencyId="not-a-uuid" />);
    expect(await screen.findByText(/代理店が見つかりません/)).toBeTruthy();
    for (const name of FETCHERS) expect(api[name], name).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: '代理店管理へ戻る' }).getAttribute('href')).toBe('/admin/agencies');
  });

  it('大文字の URL でも同じ代理店として扱い、利用者の区分を偽の 0 件にしない', async () => {
    ready('operator');
    resolveAll();
    render(<AgencyDetailView agencyId={AGENCY_ID.toUpperCase()} />);
    expect(await screen.findByRole('heading', { level: 1, name: AGENCY.name })).toBeTruthy();
    await screen.findByRole('region', { name: 'ダッシュボードの利用者' });
    expect(summary()['ダッシュボードの利用者']).toBe('2');
    // API へは正規化した小文字の id を渡す。
    expect(api.getOwners).toHaveBeenCalledWith({ agencyId: AGENCY_ID });
  });

  it('存在の判定を待つ間は、他の取得が届いていても区分も件数も描かない（9.6）', async () => {
    ready('operator');
    resolveAll();
    // 代理店一覧だけ応答を保留する（解決しない約束は deferResolution で包んでも解決しない）。
    api.getAgencies.mockReturnValue(new Promise(() => {}));
    render(<AgencyDetailView agencyId={AGENCY_ID} />);
    // 他の 4 本の応答（遅延 30ms）が確実に届くまで実時間で待つ。
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(api.getOwners).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toContain('読み込み中');
    expect(screen.queryAllByRole('heading', { level: 2 })).toHaveLength(0);
    expect(screen.queryAllByRole('term')).toHaveLength(0);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('一覧に無い代理店では、他の取得が空で成功しても区分も件数も描かない（9.6）', async () => {
    ready('operator');
    resolveAll({
      getAgencies: ok([{ ...AGENCY, id: OTHER_AGENCY_ID }]),
      getDashboardUsers: ok([]),
      getOwners: ok([]),
      getStores: ok([]),
      getInviteCodes: ok([]),
    });
    render(<AgencyDetailView agencyId={AGENCY_ID} />);
    expect(await screen.findByText(/代理店が見つかりません/)).toBeTruthy();
    expect(screen.queryAllByRole('heading', { level: 2 })).toHaveLength(0);
    expect(screen.queryAllByRole('term')).toHaveLength(0);
    expect(screen.queryByText(/いません|まだ/)).toBeNull();
  });

  it('代理店一覧の取得に失敗したら区分を描かず、再読み込みで取り直す（9.6・7.4）', async () => {
    ready('operator');
    resolveAll({ getAgencies: FAILED });
    render(<AgencyDetailView agencyId={AGENCY_ID} />);
    expect(await screen.findByText(/代理店の情報を読み込めませんでした/)).toBeTruthy();
    expect(screen.queryAllByRole('heading', { level: 2 })).toHaveLength(0);
    api.getAgencies.mockResolvedValue(ok([AGENCY]));
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }));
    expect(await screen.findByRole('heading', { level: 1, name: AGENCY.name })).toBeTruthy();
    expect(api.getAgencies).toHaveBeenCalledTimes(2);
  });
});

describe('代理店詳細: 取得と 4 区分（Req 9.2・9.3・9.4・9.5）', () => {
  it('5 本の取得を、どれかの応答を待たずに同時に発行する', () => {
    ready('operator');
    resolveAll();
    render(<AgencyDetailView agencyId={AGENCY_ID} />);
    // 描画の直後（応答はまだ 1 本も届いていない）に 5 本とも発行済みであること。
    for (const name of FETCHERS) expect(api[name], name).toHaveBeenCalledTimes(1);
    expect(api.getOwners).toHaveBeenCalledWith({ agencyId: AGENCY_ID });
    expect(api.getStores).toHaveBeenCalledWith({ agencyId: AGENCY_ID });
    expect(api.getInviteCodes).toHaveBeenCalledWith({ agencyId: AGENCY_ID });
  });

  it('代理店名・4 区分・4 つの件数を出す（利用者はその代理店の代理店ロールだけ）', async () => {
    ready('operator');
    resolveAll();
    render(<AgencyDetailView agencyId={AGENCY_ID} />);
    expect(await screen.findByRole('heading', { level: 1, name: AGENCY.name })).toBeTruthy();
    await screen.findByRole('region', { name: 'オーナー' });
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'ダッシュボードの利用者',
      'オーナー',
      '店舗',
      '招待コード',
    ]);
    expect(summary()).toEqual(EXPECTED_COUNTS);
    const users = within(section('ダッシュボードの利用者'));
    expect(users.getByText('alpha@example.com')).toBeTruthy();
    expect(users.getByText('old@example.com')).toBeTruthy();
    expect(users.queryByText('other@example.com')).toBeNull();
    expect(users.queryByText('operator@example.com')).toBeNull();
    expect(users.getByText('無効')).toBeTruthy();
  });

  it('表の捲れる領域の名前は面の中で重複しない', async () => {
    ready('operator');
    resolveAll();
    render(<AgencyDetailView agencyId={AGENCY_ID} />);
    await screen.findByRole('region', { name: '招待コード' });
    await screen.findByRole('region', { name: 'オーナー' });
    const names = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label') ?? '');
    expect(names).toEqual(['ダッシュボードの利用者', 'オーナー', '店舗', '招待コード']);
  });

  it('オーナーの表に登録済みの店舗と招待コードを出し、記録なしを推定で埋めない（9.2・9.4）', async () => {
    ready('operator');
    resolveAll();
    render(<AgencyDetailView agencyId={AGENCY_ID} />);
    const owners = within(await screen.findByRole('region', { name: 'オーナー' }));
    expect(owners.getAllByRole('columnheader').map((c) => c.textContent)).toContain('招待コード');
    expect(owners.getByText('太郎食堂 駅前店')).toBeTruthy();
    expect(owners.getByText('記録なし（この機能より前の登録）')).toBeTruthy();
  });

  it('ブロックを区別しない旨をオーナーの区分に明示する（9.5）', async () => {
    ready('operator');
    resolveAll();
    render(<AgencyDetailView agencyId={AGENCY_ID} />);
    await screen.findByRole('region', { name: 'オーナー' });
    expect(
      within(section('オーナー')).getByText(
        'LINE の友だち登録を解除（ブロック）したオーナーも、区別せずに表示しています。',
      ),
    ).toBeTruthy();
  });

  it('招待コードごとに登録したオーナーを出し、記録なしの人数を添える（9.2・9.4）', async () => {
    ready('operator');
    resolveAll();
    render(<AgencyDetailView agencyId={AGENCY_ID} />);
    const codes = within(await screen.findByRole('region', { name: '招待コード' }));
    const row = (code: string) =>
      codes.getAllByRole('row').find((r) => within(r).queryByText(code) !== null)!;
    expect(within(row(CODE_ACTIVE.code)).getByText('記録あり太郎')).toBeTruthy();
    expect(within(row(CODE_ACTIVE.code)).getByText('記録あり三郎')).toBeTruthy();
    expect(within(row(CODE_ACTIVE.code)).queryByText('記録なし次郎')).toBeNull();
    expect(within(row(CODE_DISABLED.code)).getByText('まだいません')).toBeTruthy();
    expect(
      within(section('招待コード')).getByText(
        '招待コードの記録がないオーナーが 1 人います（この機能より前の登録）。',
      ),
    ).toBeTruthy();
  });

  it('閲覧のみ: 押しボタンを 1 つも描かず、書込の API を呼ばない（9.10）', async () => {
    ready('operator');
    resolveAll();
    render(<AgencyDetailView agencyId={AGENCY_ID} />);
    await screen.findByRole('region', { name: '招待コード' });
    await screen.findByRole('region', { name: 'オーナー' });
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    for (const name of WRITERS) expect(api[name], name).not.toHaveBeenCalled();
  });
});

describe('代理店詳細: 区分ごとの失敗と 0 件（Req 9.7・9.8）', () => {
  it('オーナーの取得に失敗しても他の区分は残し、オーナーを 0 と出さず、その区分だけを取り直す', async () => {
    ready('operator');
    resolveAll({ getOwners: FAILED });
    render(<AgencyDetailView agencyId={AGENCY_ID} />);
    expect(await within(await waitSection('オーナー')).findByText('オーナーを読み込めませんでした。')).toBeTruthy();
    await screen.findByRole('region', { name: '店舗' });
    expect(summary()['オーナー']).toBe('読み込めませんでした');
    // 招待コードの「登録したオーナー」も 0 人（まだいません）と出さない。
    const codes = within(await screen.findByRole('region', { name: '招待コード' }));
    expect(codes.queryByText('まだいません')).toBeNull();
    expect(codes.getAllByText('読み込めませんでした').length).toBeGreaterThan(0);

    api.getOwners.mockResolvedValue(ok(OWNERS));
    fireEvent.click(within(section('オーナー')).getByRole('button', { name: 'もう一度読み込む' }));
    expect(await screen.findByRole('region', { name: 'オーナー' })).toBeTruthy();
    expect(api.getOwners).toHaveBeenCalledTimes(2);
    for (const name of ['getAgencies', 'getDashboardUsers', 'getStores', 'getInviteCodes'] as const) {
      expect(api[name], name).toHaveBeenCalledTimes(1);
    }
  });

  it('店舗だけの取得に失敗したら、オーナーの表で「登録済みの店舗はありません」と出さない', async () => {
    ready('operator');
    resolveAll({ getStores: FAILED });
    render(<AgencyDetailView agencyId={AGENCY_ID} />);
    const owners = within(await screen.findByRole('region', { name: 'オーナー' }));
    expect(owners.queryByText('登録済みの店舗はありません')).toBeNull();
    expect(owners.getAllByText('読み込めませんでした').length).toBe(OWNERS.length);
    expect(within(section('店舗')).getByText('店舗を読み込めませんでした。')).toBeTruthy();
    expect(summary()['店舗']).toBe('読み込めませんでした');
  });

  it('利用者と招待コードの取得に失敗しても、0 と出さずにそれぞれの区分で取り直せる', async () => {
    ready('operator');
    resolveAll({ getDashboardUsers: FAILED, getInviteCodes: FAILED });
    render(<AgencyDetailView agencyId={AGENCY_ID} />);
    expect(
      await within(await waitSection('ダッシュボードの利用者')).findByText(
        'ダッシュボードの利用者を読み込めませんでした。',
      ),
    ).toBeTruthy();
    expect(within(section('招待コード')).getByText('招待コードを読み込めませんでした。')).toBeTruthy();
    await screen.findByRole('region', { name: 'オーナー' });
    const counts = summary();
    expect(counts['ダッシュボードの利用者']).toBe('読み込めませんでした');
    expect(counts['有効な招待コード']).toBe('読み込めませんでした');
    expect(counts['オーナー']).toBe(EXPECTED_COUNTS.オーナー);

    api.getInviteCodes.mockResolvedValue(ok([CODE_ACTIVE, CODE_DISABLED]));
    fireEvent.click(within(section('招待コード')).getByRole('button', { name: 'もう一度読み込む' }));
    expect(await screen.findByRole('region', { name: '招待コード' })).toBeTruthy();
    expect(api.getInviteCodes).toHaveBeenCalledTimes(2);
    expect(api.getDashboardUsers).toHaveBeenCalledTimes(1);
  });

  it('0 件の区分は 0 件である旨を出す（9.8）', async () => {
    ready('operator');
    resolveAll({
      getDashboardUsers: ok([]),
      getOwners: ok([]),
      getStores: ok([]),
      getInviteCodes: ok([]),
    });
    render(<AgencyDetailView agencyId={AGENCY_ID} />);
    expect(await screen.findByText('この代理店のダッシュボード利用者はいません。')).toBeTruthy();
    expect(
      await screen.findByText(
        'この代理店のオーナーはいません。オーナーが LINE で招待コードを入力すると、ここに表示されます。',
      ),
    ).toBeTruthy();
    expect(await screen.findByText('この代理店の店舗はまだ登録されていません。')).toBeTruthy();
    expect(await screen.findByText('この代理店の招待コードはまだ発行されていません。')).toBeTruthy();
    expect(summary()).toEqual({
      ダッシュボードの利用者: '0',
      オーナー: '0',
      店舗: '0',
      有効な招待コード: '0',
    });
    expect(screen.queryByRole('table')).toBeNull();
  });
});

async function waitSection(title: string): Promise<HTMLElement> {
  await screen.findByRole('heading', { level: 2, name: title });
  return section(title);
}
