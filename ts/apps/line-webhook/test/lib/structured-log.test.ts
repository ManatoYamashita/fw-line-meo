import { describe, expect, it, vi } from 'vitest';
import {
  logSignatureVerificationFailed,
  writeStructuredLog,
  type WebhookLogFields,
} from '../../src/lib/structured-log.js';

describe('writeStructuredLog', () => {
  it('level・event・allowlist の項目だけを 1 行 JSON で出力する', () => {
    const output = vi.spyOn(console, 'warn').mockImplementation(() => {});

    writeStructuredLog('warn', 'webhook_signature_verification_failed', {
      reason: 'mismatch',
      requestId: 'req-1',
    });

    expect(output).toHaveBeenCalledWith(
      JSON.stringify({
        level: 'warn',
        event: 'webhook_signature_verification_failed',
        reason: 'mismatch',
        requestId: 'req-1',
      }),
    );
    output.mockRestore();
  });

  it('未指定の項目はキーごと出力に現れない', () => {
    const output = vi.spyOn(console, 'warn').mockImplementation(() => {});

    writeStructuredLog('warn', 'webhook_signature_verification_failed', {
      reason: 'missing_header',
    });

    expect(output).toHaveBeenCalledWith(
      JSON.stringify({
        level: 'warn',
        event: 'webhook_signature_verification_failed',
        reason: 'missing_header',
      }),
    );
    output.mockRestore();
  });

  // 型は sink を守れない。TypeScript の excess property check は「その場で書かれた
  // object literal」にしか適用されず、変数・関数戻り値・キャスト経由で渡された余剰
  // プロパティは構造的部分型として合法に通る。sink が allowlist で取り出しているから
  // こそ出ない、という事実を実測で固定する（survey-web と同じ理由・PR #75）。
  it('型を通り抜けた余剰プロパティは出力しない', () => {
    const output = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const smuggled = {
      reason: 'mismatch',
      // 署名検証の境界で手元にあるが、決して記録してはいけない値（#227）。
      signature: 'aGVsbG8gd29ybGQ=',
      rawBody: '{"events":[{"source":{"userId":"U0123456789"}}]}',
      lineUserId: 'U0123456789',
    } as unknown as WebhookLogFields;

    writeStructuredLog('warn', 'webhook_signature_verification_failed', smuggled);

    const emitted = output.mock.calls[0]?.[0];
    expect(emitted).toBe(
      JSON.stringify({
        level: 'warn',
        event: 'webhook_signature_verification_failed',
        reason: 'mismatch',
      }),
    );
    expect(emitted).not.toContain('aGVsbG8gd29ybGQ=');
    expect(emitted).not.toContain('U0123456789');
    output.mockRestore();
  });
});

describe('logSignatureVerificationFailed', () => {
  it('固定の事象名と warn で記録する（単発は異常ではなく、率の判断はアラート側の責務）', () => {
    const log = vi.fn();

    logSignatureVerificationFailed(log, 'mismatch', 'req-2');

    expect(log).toHaveBeenCalledWith('warn', 'webhook_signature_verification_failed', {
      reason: 'mismatch',
      requestId: 'req-2',
    });
  });

  it('requestId が無くても記録は落とさない', () => {
    const log = vi.fn();

    logSignatureVerificationFailed(log, 'missing_header', undefined);

    expect(log).toHaveBeenCalledWith('warn', 'webhook_signature_verification_failed', {
      reason: 'missing_header',
      requestId: undefined,
    });
  });
});
