import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LogFields } from '../src/fields.js';
import { writeStructuredLog } from '../src/sink.js';

/**
 * 出力を 1 件捕捉する。**完全一致で比較する**ため、余剰項目が 1 つでも増えれば落ちる。
 * 部分一致では「許可していない項目が出力に現れた」ことを検出できない。
 */
function captureOutput(level: 'info' | 'warn' | 'error', run: () => void): string {
  const spy = vi.spyOn(console, level).mockImplementation(() => undefined);
  try {
    run();
    expect(spy).toHaveBeenCalledTimes(1);
    return String(spy.mock.calls[0]?.[0]);
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('writeStructuredLog', () => {
  it('重大度と事象名だけを出す（項目なし）', () => {
    const line = captureOutput('info', () => {
      writeStructuredLog('info', 'survey_page_viewed');
    });
    expect(line).toBe(JSON.stringify({ severity: 'INFO', event: 'survey_page_viewed' }));
  });

  it('許可した項目を出す', () => {
    const line = captureOutput('info', () => {
      writeStructuredLog('info', 'survey_page_viewed', { storeId: 's-1' });
    });
    expect(line).toBe(
      JSON.stringify({ severity: 'INFO', event: 'survey_page_viewed', storeId: 's-1' }),
    );
  });

  it('lineRequestId は許可された形だけを出す', () => {
    const line = captureOutput('warn', () => {
      writeStructuredLog('warn', 'webhook_signature_verification_failed', {
        lineRequestId: 'not allowed: arbitrary input',
      });
    });
    expect(line).toBe(
      JSON.stringify({ severity: 'WARNING', event: 'webhook_signature_verification_failed' }),
    );
  });

  it('警告の綴りは WARNING である（WARN ではない）', () => {
    // 単純な大文字化だと WARN になり、集約基盤が重大度として解釈しない。
    const line = captureOutput('warn', () => {
      writeStructuredLog('warn', 'factuality_residual');
    });
    expect(line).toBe(JSON.stringify({ severity: 'WARNING', event: 'factuality_residual' }));
  });

  it('error は ERROR として出る', () => {
    const line = captureOutput('error', () => {
      writeStructuredLog('error', 'generation_failed', { errorKind: 'API_ERROR', status: 503 });
    });
    expect(line).toBe(
      JSON.stringify({
        severity: 'ERROR',
        event: 'generation_failed',
        errorKind: 'API_ERROR',
        status: 503,
      }),
    );
  });

  it('型を迂回して渡した余剰項目は出力に現れない', () => {
    // 型検査の余剰プロパティ検査は「その場で書かれた object literal」にしか効かない。
    // 変数経由・キャスト経由の余剰項目は構造的部分型として合法に通るため、
    // **出力側の取り出しが許可制であることが実行時の防壁になる**。
    const smuggled = {
      storeId: 's-1',
      comment: '客が書いた自由記述',
      prompt: '生成指示',
      lineUserId: 'U0123456789abcdef',
    } as unknown as LogFields;

    const line = captureOutput('info', () => {
      writeStructuredLog('info', 'survey_response_submitted', smuggled);
    });

    expect(line).toBe(
      JSON.stringify({ severity: 'INFO', event: 'survey_response_submitted', storeId: 's-1' }),
    );
    expect(line).not.toContain('comment');
    expect(line).not.toContain('自由記述');
    expect(line).not.toContain('prompt');
    expect(line).not.toContain('lineUserId');
  });

  it('相関識別子が未設定なら項目ごと出さない', () => {
    // 空文字を出すと、集約側が空のトレースとして解釈しうる。
    const line = captureOutput('info', () => {
      writeStructuredLog('info', 'survey_page_viewed', { storeId: 's-1' });
    });
    expect(line).not.toContain('logging.googleapis.com/trace');
  });

  it('相関識別子が設定されたら集約基盤の特別な名前で出す', () => {
    const line = captureOutput('info', () => {
      writeStructuredLog('info', 'survey_page_viewed', { correlationId: 'projects/p/traces/abc' });
    });
    expect(line).toBe(
      JSON.stringify({
        severity: 'INFO',
        event: 'survey_page_viewed',
        'logging.googleapis.com/trace': 'projects/p/traces/abc',
      }),
    );
    // 呼び出し側の名前（correlationId）は出力に現れない。
    expect(line).not.toContain('correlationId');
  });

  it('配列の項目をそのまま出せる', () => {
    const line = captureOutput('info', () => {
      writeStructuredLog('info', 'delivery-job.exit', {
        exitCode: 0,
        activeResources: ['TCPSocketWrap'],
      });
    });
    expect(line).toBe(
      JSON.stringify({
        severity: 'INFO',
        event: 'delivery-job.exit',
        exitCode: 0,
        activeResources: ['TCPSocketWrap'],
      }),
    );
  });

  it('出力先が失敗しても呼び出し側へ伝播させない', () => {
    // 記録できないことを理由に利用者の体験を変えてはならない（要件 3.2 / 3.3）。
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('stdout closed');
    });
    try {
      expect(() => {
        writeStructuredLog('error', 'generation_failed');
      }).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it('鍵の順序は重大度・事象名・項目の順で固定される', () => {
    // 順序が揺れると、出力の完全一致で契約を固定しているテストが壊れる。
    const line = captureOutput('info', () => {
      writeStructuredLog('info', 'store-detail.store_hint_ignored', {
        authorizedCount: 2,
        reason: 'not_in_authorized_set',
        storeId: 's-1',
      });
    });
    expect(line).toBe(
      JSON.stringify({
        severity: 'INFO',
        event: 'store-detail.store_hint_ignored',
        storeId: 's-1',
        reason: 'not_in_authorized_set',
        authorizedCount: 2,
      }),
    );
  });
});
