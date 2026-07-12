// index.ts（Task 4.4）のユニットテスト。DB・実ネットワークに依存しない純関数・エントリの
// 致命的エラーハンドリングのみを対象とする（DB＋LINE モックの一気通貫検証は index.e2e.test.ts）。
import { afterEach, describe, expect, it, vi } from 'vitest';

import { describePushOutcome, loadConfig, main, resolveJstNow } from '../src/index.js';
import type { LinePushResult } from '../src/line.js';

describe('loadConfig', () => {
  it('必須 env が揃っていれば config を返す', () => {
    const config = loadConfig({
      LINE_CHANNEL_ID: 'channel-id',
      LINE_CHANNEL_SECRET: 'channel-secret',
      LIFF_URL: 'https://liff.line.me/test-id',
    } as NodeJS.ProcessEnv);

    expect(config).toEqual({
      lineChannelId: 'channel-id',
      lineChannelSecret: 'channel-secret',
      liffUrl: 'https://liff.line.me/test-id',
    });
  });

  it('LINE_CHANNEL_ID 欠落は明示エラーで fail-fast する', () => {
    expect(() =>
      loadConfig({ LINE_CHANNEL_SECRET: 's', LIFF_URL: 'https://liff.line.me/x' } as NodeJS.ProcessEnv),
    ).toThrow('LINE_CHANNEL_ID is required');
  });

  it('LINE_CHANNEL_SECRET 欠落は明示エラーで fail-fast する', () => {
    expect(() =>
      loadConfig({ LINE_CHANNEL_ID: 'c', LIFF_URL: 'https://liff.line.me/x' } as NodeJS.ProcessEnv),
    ).toThrow('LINE_CHANNEL_SECRET is required');
  });

  it('LIFF_URL 欠落は明示エラーで fail-fast する', () => {
    expect(() =>
      loadConfig({ LINE_CHANNEL_ID: 'c', LINE_CHANNEL_SECRET: 's' } as NodeJS.ProcessEnv),
    ).toThrow('LIFF_URL is required');
  });
});

describe('resolveJstNow', () => {
  it('UTC 0時はJST 9時（同日）になる', () => {
    expect(resolveJstNow(new Date('2026-07-12T00:00:00Z'))).toEqual({ hour: 9, date: '2026-07-12' });
  });

  it('UTC 15時はJST 0時（翌日）になる（日付繰り上がり）', () => {
    expect(resolveJstNow(new Date('2026-07-11T15:00:00Z'))).toEqual({ hour: 0, date: '2026-07-12' });
  });

  it('UTC 14時59分はJST 23時59分（同日・繰り上がり直前）になる', () => {
    expect(resolveJstNow(new Date('2026-07-11T14:59:00Z'))).toEqual({ hour: 23, date: '2026-07-11' });
  });
});

describe('describePushOutcome', () => {
  it('success → delivered（deliveredAt を現在時刻で埋める）', () => {
    const result: LinePushResult = { status: 'success', duplicate: false, requestId: 'req-1' };
    const outcome = describePushOutcome(result);
    expect(outcome.status).toBe('delivered');
    expect(outcome.errorDetail).toBeNull();
    expect(outcome.deliveredAt).toBeInstanceOf(Date);
  });

  it('success(duplicate=true・409) も delivered として扱う', () => {
    const result: LinePushResult = { status: 'success', duplicate: true, requestId: 'req-409' };
    const outcome = describePushOutcome(result);
    expect(outcome.status).toBe('delivered');
    expect(outcome.deliveredAt).toBeInstanceOf(Date);
  });

  it('failed → failed（errorDetail に message・deliveredAt は null）', () => {
    const result: LinePushResult = { status: 'failed', requestId: 'req-2', httpStatus: 400, message: 'Not found' };
    const outcome = describePushOutcome(result);
    expect(outcome).toEqual({ status: 'failed', errorDetail: 'Not found', deliveredAt: null });
  });

  it('quota_exceeded → quota_exceeded（errorDetail に message・deliveredAt は null）', () => {
    const result: LinePushResult = {
      status: 'quota_exceeded',
      requestId: 'req-3',
      message: 'You have reached your monthly limit.',
    };
    const outcome = describePushOutcome(result);
    expect(outcome).toEqual({
      status: 'quota_exceeded',
      errorDetail: 'You have reached your monthly limit.',
      deliveredAt: null,
    });
  });
});

// --- main() の致命的エラーハンドリング（config欠落・token発行失敗）------------------------------
// design.md「認証: Stateless channel access token をジョブ開始時に発行」「exit code semantics:
// 0 for a normal run even with some per-owner failures, non-zero only for a total/catastrophic
// failure e.g. token issuance failure or DB connection failure」を検証する。
// process.exit() ではなく process.exitCode を使う設計のため、テストプロセスを道連れにせず検証できる。

describe('main — 致命的エラー時は例外を投げずに process.exitCode=1 で終了する', () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it('config欠落（LINE_CHANNEL_ID 等が未設定）: クラッシュせず process.exitCode=1 で終了する', async () => {
    delete process.env.LINE_CHANNEL_ID;
    delete process.env.LINE_CHANNEL_SECRET;
    delete process.env.LIFF_URL;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(main()).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const loggedLine = errorSpy.mock.calls[0]?.[0];
    expect(typeof loggedLine).toBe('string');
    expect((loggedLine as string).includes('\n')).toBe(false); // スタックトレース丸出しにしない
    const parsed = JSON.parse(loggedLine as string) as { event: string; error: string };
    expect(parsed.event).toBe('delivery-job.fatal');
    expect(parsed.error).toContain('LINE_CHANNEL_ID');
  });

  it('LINE token 発行失敗（ネットワークエラー）: クラッシュせず process.exitCode=1 で終了する', async () => {
    process.env.LINE_CHANNEL_ID = 'test-channel-id';
    process.env.LINE_CHANNEL_SECRET = 'test-channel-secret';
    process.env.LIFF_URL = 'https://liff.line.me/test-id';
    // Pool コンストラクタは接続を即座には確立しないため、到達不能な接続文字列でも
    // token 発行より前段では例外にならない（実クエリが走る前に token 発行で先に失敗する）。
    process.env.DATABASE_URL = 'postgres://postgres@127.0.0.1:1/does-not-matter';

    globalThis.fetch = (async () => {
      throw new Error('simulated network failure');
    }) as typeof fetch;

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(main()).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    const loggedLine = errorSpy.mock.calls.at(-1)?.[0];
    expect(typeof loggedLine).toBe('string');
    expect((loggedLine as string).includes('\n')).toBe(false);
    const parsed = JSON.parse(loggedLine as string) as { event: string; error: string };
    expect(parsed.event).toBe('delivery-job.fatal');
  });
});
