// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { OwnerRosterTable } from '../src/components/owner-roster-table';
import type { OwnerListItem } from '../src/lib/types';

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
