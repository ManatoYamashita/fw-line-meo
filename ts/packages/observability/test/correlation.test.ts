import { describe, expect, it, vi } from 'vitest';
import type { Sink } from '../src/sink.js';
import {
  correlationIdFromHeaders,
  executionCorrelationId,
  supportCodeFromCorrelationId,
  traceIdFromHeaders,
  withCorrelation,
} from '../src/correlation.js';

const traceId = 'A'.repeat(32);

describe('correlation', () => {
  it('Cloud Trace のヘッダからトレース ID を抽出する', () => {
    const headers = new Headers({ 'X-Cloud-Trace-Context': `${traceId}/0123456789abcdef;o=1` });
    expect(traceIdFromHeaders(headers)).toBe(traceId.toLowerCase());
    expect(correlationIdFromHeaders(headers, 'project-1')).toBe(
      `projects/project-1/traces/${traceId.toLowerCase()}`,
    );
  });

  it('traceparent をフォールバックとして扱い、不正値は無視する', () => {
    const headers = new Headers({ traceparent: `00-${traceId}-0123456789abcdef-01` });
    expect(traceIdFromHeaders(headers)).toBe(traceId.toLowerCase());
    expect(traceIdFromHeaders(new Headers({ traceparent: 'invalid' }))).toBeUndefined();
  });

  it('サポートコードはトレース ID の先頭 8 文字である', () => {
    expect(supportCodeFromCorrelationId(`projects/p/traces/${traceId}`)).toBe('aaaaaaaa');
    expect(supportCodeFromCorrelationId(undefined)).toBeUndefined();
  });

  it('Cloud Run Job は実行 ID を同じログ項目へ束ねる', () => {
    expect(
      executionCorrelationId({ GOOGLE_CLOUD_PROJECT: 'p', CLOUD_RUN_EXECUTION: 'exec-123' }),
    ).toBe('projects/p/traces/exec-123');
  });

  it('相関 sink は既存項目を保ったまま ID を上書きする', () => {
    const sink = vi.fn<Sink>();
    withCorrelation(sink, 'projects/p/traces/abc')('error', 'failed', { storeId: 's-1', correlationId: 'old' });
    expect(sink).toHaveBeenCalledWith('error', 'failed', {
      storeId: 's-1',
      correlationId: 'projects/p/traces/abc',
    });
  });
});
