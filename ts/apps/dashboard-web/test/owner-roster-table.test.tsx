// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

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

import { OwnerRosterTable } from '../src/components/owner-roster-table';
import type { OwnerListItem, StoreListItem } from '../src/lib/types';

// オーナーの表（Issue #485）を代理店詳細（Issue #486・agency-dashboard Req 9.2・9.4）でも使う。
// 招待コードの列は `showInviteCode` を渡したときだけ描き、渡さない呼び出し（店舗登録）の描画は変えない。

afterEach(cleanup);

const OWNERS: OwnerListItem[] = [
  {
    id: 'o-recorded',
    displayName: '記録あり太郎',
    onboardingStatus: 'store_identified',
    createdAt: '2026-10-01T00:00:00.000Z',
    inviteCode: { id: 'c-active', code: 'ABCD-EFGH-JKLM', disabled: false },
    agencyName: '代理店A',
    lineLink: 'linked',
    menuUnlinkPending: false,
    agencyId: 'a1',
    stores: [],
    storeNames: [],
    takenOverBy: null,
  },
  {
    id: 'o-disabled-code',
    displayName: '無効コード花子',
    onboardingStatus: 'active',
    createdAt: '2026-10-02T00:00:00.000Z',
    inviteCode: { id: 'c-disabled', code: 'MNOP-QRST-UVWX', disabled: true },
    agencyName: '代理店A',
    lineLink: 'linked',
    menuUnlinkPending: false,
    agencyId: 'a1',
    stores: [],
    storeNames: [],
    takenOverBy: null,
  },
  {
    id: 'o-unrecorded',
    displayName: '記録なし次郎',
    onboardingStatus: 'pending',
    createdAt: '2026-09-01T00:00:00.000Z',
    inviteCode: null,
    agencyName: '代理店A',
    lineLink: 'linked',
    menuUnlinkPending: false,
    agencyId: 'a1',
    stores: [],
    storeNames: [],
    takenOverBy: null,
  },
];

const LOADED_EMPTY = { kind: 'loaded', byOwner: new Map() } as const;

function headerNames(): string[] {
  return screen.getAllByRole('columnheader').map((cell) => cell.textContent ?? '');
}

function rowOf(displayName: string): HTMLElement {
  const row = screen.getAllByRole('row').find((r) => within(r).queryByText(displayName) !== null);
  if (row === undefined) throw new Error(`行が見つかりません: ${displayName}`);
  return row;
}

describe('OwnerRosterTable の招待コードの列（Issue #486・Req 9.2・9.4）', () => {
  it('showInviteCode を渡さないときは列を足さない（店舗登録の描画を変えない）', () => {
    render(<OwnerRosterTable label="オーナー" owners={OWNERS} stores={LOADED_EMPTY} />);
    expect(headerNames()).toEqual(['表示名', '状態', '登録済みの店舗', '作成日']);
    expect(screen.queryByText('記録なし（この機能より前の登録）')).toBeNull();
    expect(screen.queryByText('ABCD-EFGH-JKLM')).toBeNull();
  });

  it('showInviteCode のときだけ「招待コード」の列を作成日の後に足す', () => {
    render(<OwnerRosterTable label="オーナー" owners={OWNERS} stores={LOADED_EMPTY} showInviteCode />);
    expect(headerNames()).toEqual(['表示名', '状態', '登録済みの店舗', '作成日', '招待コード']);
  });

  it('記録あり・無効のコード・記録なしの 3 通りを区別して出す', () => {
    render(<OwnerRosterTable label="オーナー" owners={OWNERS} stores={LOADED_EMPTY} showInviteCode />);
    const lastCell = (name: string) => within(rowOf(name)).getAllByRole('cell').at(-1)!;

    const recorded = lastCell('記録あり太郎');
    expect(recorded.textContent).toContain('ABCD-EFGH-JKLM');
    expect(recorded.textContent).not.toContain('無効');

    const disabled = lastCell('無効コード花子');
    expect(disabled.textContent).toContain('MNOP-QRST-UVWX');
    expect(within(disabled).getByText('無効')).toBeTruthy();

    // 記録なしを推定のコードで埋めない（Req 8.4・9.4）。
    const unrecorded = lastCell('記録なし次郎');
    expect(unrecorded.textContent).toBe('記録なし（この機能より前の登録）');
  });

  it('操作の列（renderAction）は招待コードの列の後に置く', () => {
    render(
      <OwnerRosterTable
        label="オーナー"
        owners={OWNERS}
        stores={LOADED_EMPTY}
        showInviteCode
        renderAction={() => <button type="button">選ぶ</button>}
      />,
    );
    expect(headerNames()).toEqual(['表示名', '状態', '登録済みの店舗', '作成日', '招待コード', '操作']);
  });
});

describe('OwnerRosterTable の名前のリンク（Issue #526・Req 10.1・10.2・10.7）', () => {
  const STORE: StoreListItem = {
    id: 'abcdef44-4444-4444-4444-444444444444',
    name: '炭火焼 あいう',
    placeStatus: 'confirmed',
    suspendedAt: null,
    competitorConfigured: false,
    ownerId: 'o-recorded',
    ownerDisplayName: null,
    agencyId: 'a1',
    agencyName: '代理店A',
    createdAt: '2026-10-01T00:00:00.000Z',
  };
  const WITH_STORE = { kind: 'loaded', byOwner: new Map([['o-recorded', [STORE]]]) } as const;

  it('linkNames を渡すと、表示名をオーナーの詳細へ、登録済みの店舗名を店舗の詳細へのリンクにする', () => {
    render(<OwnerRosterTable label="オーナー" owners={OWNERS} stores={WITH_STORE} linkNames />);
    const row = rowOf('炭火焼 あいう');
    const owner = within(row).getByRole('link', { name: ownerName(OWNERS[0]!) });
    expect(owner.getAttribute('href')).toBe('/owners/o-recorded');
    const store = within(row).getByRole('link', { name: '炭火焼 あいう' });
    expect(store.getAttribute('href')).toBe(`/stores/${STORE.id}`);
    // 店舗の無いオーナーの表示名もリンクにする
    expect(screen.getByRole('link', { name: '記録なし次郎' }).getAttribute('href')).toBe('/owners/o-unrecorded');
  });

  it('linkNames を渡さないときはリンクを 1 つも描かない（店舗登録の手順の中の名前・10.7）', () => {
    render(<OwnerRosterTable label="オーナー" owners={OWNERS} stores={WITH_STORE} />);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });
});

function ownerName(owner: OwnerListItem): string {
  return owner.displayName ?? '（表示名なし）';
}
