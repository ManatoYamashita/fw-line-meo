import { describe, expect, it, vi } from 'vitest';
import {
  logFactualityResidual,
  logSurveyPageViewed,
  logSurveyResponseSubmitted,
  writeStructuredLog,
  type SurveyLogFields,
} from '../src/lib/structured-log';

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

// Issue #132・案B: 事後検証で作り直してもなお残った未選択観点の記録。
// 下書き自体は客へ返すため「失敗」ではない（level は warn）。合意した残差が実運用で
// どう推移するかを後から集計できるようにするために残す。
describe('logFactualityResidual', () => {
  it('観点の code だけを warn で出力する（本文・一言・プロンプトは載せない）', () => {
    const output = vi.spyOn(console, 'warn').mockImplementation(() => {});

    logFactualityResidual(writeStructuredLog, ['atmosphere', 'service']);

    expect(output).toHaveBeenCalledWith(
      JSON.stringify({
        level: 'warn',
        event: 'factuality_residual',
        violatedAspects: 'atmosphere,service',
      }),
    );
    output.mockRestore();
  });

  it('順序が違っても同じ文字列になる（集計時に同じ組み合わせが散らばらない）', () => {
    const seen: string[] = [];
    const log = (_l: unknown, _e: unknown, fields?: SurveyLogFields) => {
      if (fields?.violatedAspects !== undefined) seen.push(fields.violatedAspects);
    };
    logFactualityResidual(log as Parameters<typeof logFactualityResidual>[0], ['service', 'atmosphere']);
    logFactualityResidual(log as Parameters<typeof logFactualityResidual>[0], ['atmosphere', 'service']);
    expect(seen[0]).toBe(seen[1]);
  });
});

// Issue #137 段階3: 表示 → 送信のファネル。載せるのは storeId だけで、来店客に紐づく値は
// 一切出さない。storeId は事業者側の識別子である。
describe('ファネルの構造化ログ', () => {
  it('survey_page_viewed は storeId だけを info で出力する', () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => {});

    logSurveyPageViewed(writeStructuredLog, 'store-1');

    expect(output).toHaveBeenCalledWith(
      JSON.stringify({ level: 'info', event: 'survey_page_viewed', storeId: 'store-1' }),
    );
    output.mockRestore();
  });

  it('survey_response_submitted は storeId だけを info で出力する', () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => {});

    logSurveyResponseSubmitted(writeStructuredLog, 'store-1');

    expect(output).toHaveBeenCalledWith(
      JSON.stringify({ level: 'info', event: 'survey_response_submitted', storeId: 'store-1' }),
    );
    output.mockRestore();
  });

  it('storeId と一緒に渡された余剰プロパティは出力しない', () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => {});
    const smuggled = {
      storeId: 'store-1',
      comment: '客の自由記述',
      userAgent: 'Mozilla/5.0',
    } as unknown as SurveyLogFields;

    writeStructuredLog('info', 'survey_page_viewed', smuggled);

    expect(output).toHaveBeenCalledWith(
      JSON.stringify({ level: 'info', event: 'survey_page_viewed', storeId: 'store-1' }),
    );
    output.mockRestore();
  });
});
