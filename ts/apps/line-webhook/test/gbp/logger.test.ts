// GBP の記録を共有の出力口（@fwlm/observability）へ写す試験（Issue #323・docs/observability/log-field-canon.md の 1.10）。
// - GBP の項目を共有の語彙へ写すこと（errorName は例外のクラス名の errorKind へ、GBP の失敗の種別は gbpErrorKind へ）
// - allowlist の外の値（型を通り抜けた余剰プロパティ）を出さないこと
// - 重大度を集約基盤の綴り（WARNING / ERROR）で出すこと
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeGbpLog, type GbpLogMeta } from '../../src/gbp/logger.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function captured(level: 'warn' | 'error'): Record<string, unknown> {
  const spy = vi.mocked(console[level]);
  expect(spy).toHaveBeenCalledTimes(1);
  return JSON.parse(String(spy.mock.calls[0]![0])) as Record<string, unknown>;
}

describe('writeGbpLog', () => {
  it('GBP の項目を共有の語彙へ写して 1 行 JSON で出す', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeGbpLog('error', 'gbp.client.upstream_error', {
      flow: 'post',
      stage: 'executing',
      kind: 'linked',
      ownerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      storeId: '11111111-1111-4111-8111-111111111111',
      errorKind: 'upstream_error',
      errorName: 'TypeError',
      status: 503,
      reason: 'quota_exceeded',
    });
    expect(captured('error')).toEqual({
      severity: 'ERROR',
      event: 'gbp.client.upstream_error',
      gbpFlow: 'post',
      gbpStage: 'executing',
      gbpCallbackResult: 'linked',
      ownerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      storeId: '11111111-1111-4111-8111-111111111111',
      gbpErrorKind: 'upstream_error',
      errorKind: 'TypeError',
      status: 503,
      reason: 'quota_exceeded',
    });
  });

  it('警告は WARNING の綴りで出し、渡さなかった項目は出さない', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeGbpLog('warn', 'gbp.flow.session_expired');
    expect(captured('warn')).toEqual({ severity: 'WARNING', event: 'gbp.flow.session_expired' });
  });

  it('型を通り抜けた余剰プロパティ（下書き本文・トークンなど）は出さない', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const smuggled = { flow: 'post', draftText: '下書きの本文', accessToken: 'ya29.secret' } as GbpLogMeta;
    writeGbpLog('error', 'gbp.flow.failed', smuggled);
    const record = captured('error');
    expect(record).toEqual({ severity: 'ERROR', event: 'gbp.flow.failed', gbpFlow: 'post' });
    expect(JSON.stringify(record)).not.toContain('下書き');
    expect(JSON.stringify(record)).not.toContain('ya29');
  });
});
