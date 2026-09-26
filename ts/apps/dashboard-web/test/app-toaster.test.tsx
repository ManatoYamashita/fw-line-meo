// @vitest-environment jsdom
// 操作結果の Toast の置き場（2026-09-26・狭い画面で帯の操作要素を覆った不具合の是正）。
// 狭い画面では下部中央、帯が 1 段になる広い画面（lg 以上）では上部中央に置く。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const toasterProps = vi.fn();
vi.mock('sonner', () => ({
  Toaster: (props: Record<string, unknown>) => {
    toasterProps(props);
    return null;
  },
}));

import { AppToaster, WIDE_SCREEN_QUERY } from '../src/components/app-toaster';

function stubMatchMedia(wide: boolean) {
  const queries: string[] = [];
  vi.stubGlobal('matchMedia', (query: string) => {
    queries.push(query);
    return {
      matches: wide,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });
  return queries;
}

afterEach(() => {
  cleanup();
  toasterProps.mockClear();
  vi.unstubAllGlobals();
});

describe('AppToaster の置き場', () => {
  it('狭い画面では右下に置く（帯の操作要素を覆わない）', () => {
    stubMatchMedia(false);
    render(<AppToaster />);
    expect(toasterProps).toHaveBeenLastCalledWith(expect.objectContaining({ position: 'bottom-right' }));
  });

  it('帯が 1 段になる広い画面では右上に置く', () => {
    const queries = stubMatchMedia(true);
    render(<AppToaster />);
    expect(toasterProps).toHaveBeenLastCalledWith(expect.objectContaining({ position: 'top-right' }));
    // 帯の段組みの境目（lg = 1024px）と同じ問い合わせを使う。
    expect(queries).toContain(WIDE_SCREEN_QUERY);
    expect(WIDE_SCREEN_QUERY).toBe('(min-width: 1024px)');
  });
});
