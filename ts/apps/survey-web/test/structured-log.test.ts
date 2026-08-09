import { describe, expect, it, vi } from 'vitest';
import { writeStructuredLog, type SurveyLogFields } from '../src/lib/structured-log';

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

  // 型は sink を守れない。TypeScript の excess property check は「その場で書かれた
  // object literal」にしか適用されず、変数・関数戻り値・キャスト経由で渡された余剰
  // プロパティは構造的部分型として合法に通る。したがって出力の allowlist は型ではなく
  // sink 側の実装で保証しなければならない（プライバシー制約: 自由記述・プロンプト・
  // 下書き本文・API キーをログへ出さない）。
  it('allowlist 外のフィールドは、呼び出し側が渡しても出力しない', () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    // 実際の混入経路を再現する。literal 直渡しではないため型検査は通ってしまう。
    const smuggled = {
      errorKind: 'API_ERROR',
      status: 400,
      comment: '客の自由記述',
      prompt: 'システムプロンプト全文',
    } as unknown as SurveyLogFields;

    writeStructuredLog('error', 'generation_failed', smuggled);

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

  it('fields 未指定なら level と event だけを出力する', () => {
    const output = vi.spyOn(console, 'warn').mockImplementation(() => {});

    writeStructuredLog('warn', 'tally_failed');

    expect(output).toHaveBeenCalledWith(JSON.stringify({ level: 'warn', event: 'tally_failed' }));
    output.mockRestore();
  });
});
