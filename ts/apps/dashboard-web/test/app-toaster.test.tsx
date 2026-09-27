// @vitest-environment jsdom
// 操作結果の Toast の置き場。画面の幅にかかわらず常に右下に置く（design-language 7.5）。
// 幅で右上・右下を切り替えていた版は、利用者からは画面によって通知の場所が変わって見えた（2026-09-27）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const toasterProps = vi.fn();
vi.mock('sonner', () => ({
  Toaster: (props: Record<string, unknown>) => {
    toasterProps(props);
    return null;
  },
}));

import { AppToaster, TOASTER_POSITION } from '../src/components/app-toaster';

function stubMatchMedia(matches: boolean) {
  const queries: string[] = [];
  vi.stubGlobal('matchMedia', (query: string) => {
    queries.push(query);
    return { matches, media: query, addEventListener: () => {}, removeEventListener: () => {} };
  });
  return queries;
}

afterEach(() => {
  cleanup();
  toasterProps.mockClear();
  vi.unstubAllGlobals();
});

describe('AppToaster の置き場', () => {
  it('右下に置く（狭い画面の 3 段の帯の操作要素を覆わない）', () => {
    expect(TOASTER_POSITION).toBe('bottom-right');
  });

  it.each([
    ['狭い画面', false],
    ['広い画面', true],
  ])('%sでも同じ右下に置き、画面の幅を問い合わせない', (_label, wide) => {
    const queries = stubMatchMedia(wide);
    render(<AppToaster />);
    expect(toasterProps).toHaveBeenLastCalledWith(expect.objectContaining({ position: 'bottom-right' }));
    // 幅で切り替える作りに戻すと、描き始めと描き終わりで場所が変わる。問い合わせ自体が無いことを固定する。
    expect(queries).toEqual([]);
  });
});
