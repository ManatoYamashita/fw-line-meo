import { describe, expect, it, vi } from 'vitest';
import { writeStructuredLog } from '../src/lib/structured-log';

describe('writeStructuredLog', () => {
  it('event・errorKind・status だけを 1 行 JSON で出力する', () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});

    writeStructuredLog('error', 'generation_failed', {
      errorKind: 'API_ERROR',
      status: 400,
    });

    expect(output).toHaveBeenCalledWith(
      JSON.stringify({
        level: 'error',
        event: 'generation_failed',
        errorKind: 'API_ERROR',
        status: 400,
      }),
    );
    output.mockRestore();
  });
});
