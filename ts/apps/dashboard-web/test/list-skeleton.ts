import { expect } from 'vitest';

/**
 * 一覧の取得中の形（ListLoading → TableSkeleton）の契約を確かめる。
 *
 * - 形は読み上げ領域の外にあり、形自身は aria-hidden で支援技術から外れる
 * - 形は表の要素も捲れる容器も焦点可能な要素も持たない（取得前から表や捲れる領域として数えられない）
 * - 各行の押しボタンの形の数は、その面の行の操作の数に一致する（渡し忘れると 0 で素通りするので、
 *   0 の面も明示して固定する）
 */
export function expectListSkeleton(
  main: HTMLElement,
  region: HTMLElement,
  expected: { readonly actions: number },
  label?: string,
): void {
  const skeleton = main.querySelector('[data-slot="table-skeleton"]');
  expect(skeleton, label).not.toBeNull();
  expect(region.contains(skeleton), label).toBe(false);
  expect(skeleton!.getAttribute('aria-hidden'), label).toBe('true');
  expect(main.querySelector('table'), label).toBeNull();
  expect(main.querySelector('[data-slot="table-container"]'), label).toBeNull();
  expect(skeleton!.querySelector('[tabindex]'), label).toBeNull();
  const rows = skeleton!.querySelectorAll('[data-slot="table-skeleton-row"]');
  expect(rows.length, label).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.querySelectorAll('[data-slot="skeleton-action"]'), label).toHaveLength(
      expected.actions,
    );
  }
}
