import { describe, expect, it, vi } from 'vitest';
import {
  logFabricationResidual,
  logFactualityResidual,
  logStructuredDraftFailed,
  logStructuredDraftResult,
  logStructuredDraftRetry,
  logSurveyPageViewed,
  logSurveyResponseSubmitted,
  logSurveyReviewLinkOpened,
  writeStructuredLog,
  type SurveyLogFields,
} from '../src/lib/structured-log';

describe('writeStructuredLog', () => {
  it('重大度・event・errorKind・status だけを 1 行 JSON で出力する', () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});

    writeStructuredLog('error', 'generation_failed', {
      errorKind: 'API_ERROR',
      status: 400,
    });

    expect(output).toHaveBeenCalledWith(
      JSON.stringify({
        severity: 'ERROR',
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
        severity: 'ERROR',
        event: 'generation_failed',
        errorKind: 'API_ERROR',
        status: 400,
      }),
    );
    output.mockRestore();
  });

  it('fields 未指定なら重大度と event だけを出力する', () => {
    const output = vi.spyOn(console, 'warn').mockImplementation(() => {});

    writeStructuredLog('warn', 'tally_failed');

    expect(output).toHaveBeenCalledWith(JSON.stringify({ severity: 'WARNING', event: 'tally_failed' }));
    output.mockRestore();
  });
});

// Issue #132・案B: 事後検証で作り直してもなお残った未選択観点の記録。
// 下書き自体は客へ返すため「失敗」ではない（重大度は警告）。合意した残差が実運用で
// どう推移するかを後から集計できるようにするために残す。
describe('logFactualityResidual', () => {
  it('観点の code だけを warn で出力する（本文・一言・プロンプトは載せない）', () => {
    const output = vi.spyOn(console, 'warn').mockImplementation(() => {});

    logFactualityResidual(writeStructuredLog, ['atmosphere', 'service']);

    expect(output).toHaveBeenCalledWith(
      JSON.stringify({
        severity: 'WARNING',
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

// Issue #413: 事後検証で作り直しても残った来店前の期待と「無かった」の断定。未選択の観点とは事象名を分ける。
describe('logFabricationResidual', () => {
  it('分類名だけを warn で出力し、並び順を固定する（本文・一言・プロンプトは載せない）', () => {
    const output = vi.spyOn(console, 'warn').mockImplementation(() => {});

    logFabricationResidual(writeStructuredLog, ['expectation', 'absence:concerns']);

    expect(output).toHaveBeenCalledWith(
      JSON.stringify({
        severity: 'WARNING',
        event: 'fabrication_residual',
        residualClaims: 'absence:concerns,expectation',
      }),
    );
    output.mockRestore();
  });
});

// Issue #439: structured の下書きの作り直し・generation error。匿名の metadata（失格の種類・claim の件数）だけを載せる。
describe('structured の下書きの作り直し・generation error', () => {
  it('失格の種類（並び順を固定）と claim の件数だけを出し、下書き・一言・料理名は載せない', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    logStructuredDraftRetry(writeStructuredLog, ['unselectedTarget', 'commentLinkage'], 3);
    logStructuredDraftFailed(writeStructuredLog, 'gate', ['commentLinkage'], 3);

    expect(info).toHaveBeenCalledWith(
      JSON.stringify({ severity: 'INFO', event: 'survey-web.structured_draft_retry', residualClaims: 'commentLinkage,unselectedTarget', claimCount: 3 }),
    );
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({ severity: 'WARNING', event: 'survey-web.structured_draft_failed', residualClaims: 'commentLinkage', claimCount: 3, reason: 'gate' }),
    );
    info.mockRestore();
    warn.mockRestore();
  });

  it('最終の結果（ローカル検証用）は決まった形の reason と残った種類・claim の件数だけを出す', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    logStructuredDraftResult(
      writeStructuredLog,
      {
        result: 'llm',
        attempts: 3,
        acceptedAttempt: 3,
        history: [
          { attempt: 1, generationFailed: false, factuality: ['cause', 'ungrounded'] },
          { attempt: 2, generationFailed: true, factuality: [] },
          { attempt: 3, generationFailed: false, factuality: [] },
        ],
      },
      6,
    );
    logStructuredDraftResult(
      writeStructuredLog,
      { result: 'generation_error', attempts: 3, acceptedAttempt: null, history: [1, 2, 3].map((attempt) => ({ attempt, generationFailed: false, factuality: ['cause'] })) },
      6,
    );
    expect(info).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({ severity: 'INFO', event: 'survey-web.structured_draft_result', residualClaims: 'a1=cause+ungrounded;a2=generation;a3=ok', claimCount: 6, reason: 'llm:attempts=3:accepted=3' }),
    );
    expect(info).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({ severity: 'INFO', event: 'survey-web.structured_draft_result', residualClaims: 'a1=cause;a2=cause;a3=cause', claimCount: 6, reason: 'generation_error:attempts=3:accepted=none' }),
    );
    info.mockRestore();
  });
});

// Issue #137 段階3: 表示 → 送信のファネル。載せるのは storeId だけで、来店客に紐づく値は
// 一切出さない。storeId は事業者側の識別子である。
describe('ファネルの構造化ログ', () => {
  it('survey_page_viewed は storeId だけを info で出力する', () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => {});

    logSurveyPageViewed(writeStructuredLog, 'store-1');

    expect(output).toHaveBeenCalledWith(
      JSON.stringify({ severity: 'INFO', event: 'survey_page_viewed', storeId: 'store-1' }),
    );
    output.mockRestore();
  });

  it('survey_response_submitted は storeId だけを info で出力する', () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => {});

    logSurveyResponseSubmitted(writeStructuredLog, 'store-1');

    expect(output).toHaveBeenCalledWith(
      JSON.stringify({ severity: 'INFO', event: 'survey_response_submitted', storeId: 'store-1' }),
    );
    output.mockRestore();
  });

  it('survey_review_link_opened は storeId だけを info で出力する（Issue #137）', () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => {});

    logSurveyReviewLinkOpened(writeStructuredLog, 'store-1');

    expect(output).toHaveBeenCalledWith(
      JSON.stringify({ severity: 'INFO', event: 'survey_review_link_opened', storeId: 'store-1' }),
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
      JSON.stringify({ severity: 'INFO', event: 'survey_page_viewed', storeId: 'store-1' }),
    );
    output.mockRestore();
  });
});
