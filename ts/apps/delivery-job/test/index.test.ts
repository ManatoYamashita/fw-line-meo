import { describe, expect, it, vi } from 'vitest';
import { buildSummary, main } from '../src/index.js';

describe('delivery-job entrypoint', () => {
  it('骨格段階の実行サマリーを構造化オブジェクトとして組み立てる', () => {
    const summary = buildSummary();
    expect(summary).toEqual({
      event: 'delivery-job.run',
      status: 'skeleton_only',
      targetsFound: 0,
      delivered: 0,
      failed: 0,
      skipped: 0,
    });
  });

  it('main はサマリーを JSON 1 行として1回だけログ出力し、例外を投げずに正常終了する', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(() => main()).not.toThrow();
    expect(logSpy).toHaveBeenCalledTimes(1);

    const loggedLine = logSpy.mock.calls[0]?.[0];
    expect(typeof loggedLine).toBe('string');
    expect((loggedLine as string).includes('\n')).toBe(false);

    const parsed: unknown = JSON.parse(loggedLine as string);
    expect(parsed).toEqual(buildSummary());

    logSpy.mockRestore();
  });
});
