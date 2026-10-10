import type { GenAiClient } from '../../src/lib/draft/generator';
import { pendingStructuredDraft, type StructuredDraftMaterial, type StructuredDraftPort } from '../../src/lib/draft/structured-draft';
import { compileStructuredClaims } from '../../src/lib/draft/structured/claims';
import { structuredFallbackDraft } from '../../src/lib/draft/structured/fallback';
import { createNaturalRealizer, type NaturalRealizerOptions } from '../../src/lib/draft/structured/realizer';
import type { StructuredEvalCase } from './gates';

// structured survey の下書きの評価の対象（Issue #440・自然さ重視への方針変更で 2 つに整理した）。
// プロダクトの概念は「通常生成」と「safe fallback」の 2 つだけで、評価もこの 2 つだけを測る。
//
//   production     本番の通常生成（src/lib/draft/structured/realizer.ts の createNaturalRealizer）。作り直しと safe fallback
//                  を含む本番の経路そのもの。下書きが LLM の文か safe fallback の文かも記録する
//   safe-fallback  本番の safe fallback（claim から決定的に作るテンプレート・API 不要）。事実性の対照
//
// 以前の方式比較（legacy の生成器へ平らにした素材・素朴な claim の箇条書き）は、評価のためだけの方式だったので外した。

export type DraftSource = 'llm' | 'fallback';

export interface GeneratedDraft {
  /** 下書き（作れなかったときは null）。 */
  readonly draft: string | null;
  /** 本番の経路のどちらで作ったか（safe-fallback は常に fallback）。 */
  readonly source: DraftSource | null;
  /** LLM を呼んだ回数（作り直しがあれば 2）。 */
  readonly attempts: number;
}

export interface EvalGenerator {
  readonly id: 'production' | 'safe-fallback';
  readonly label: string;
  /** 実 API を呼ぶか（GEMINI_API_KEY が無ければ skip する）。 */
  readonly requiresApi: boolean;
  generate(c: StructuredEvalCase, run: number): Promise<GeneratedDraft>;
}

/** 本番の safe fallback（Natural LLM Realizer が 2 回とも hard gate を通らないときに本番が返す文と同じ）。 */
export function safeFallback(c: StructuredEvalCase): string {
  return structuredFallbackDraft(compileStructuredClaims(c.selections));
}

/**
 * 固定ケースから本番の素材を作る。未回答の Target は本番と同じく名前だけ（言い方は渡さない）を事後検証へ渡す。
 * 言い方・一言の内容の語・ケース固有の禁止は、評価の offline gate（recordSample）だけが使う。
 */
export function materialOf(c: StructuredEvalCase): StructuredDraftMaterial {
  return {
    storeName: c.storeName,
    surveyRevision: 1,
    star: c.star,
    selections: c.selections.map((s) => ({
      polarity: s.polarity,
      categoryCode: s.categoryCode,
      categoryLabel: s.categoryLabel,
      ...(s.targetId !== undefined ? { targetId: s.targetId, targetLabel: s.targetLabel! } : {}),
      facets: s.facets.map((f) => ({ code: f.code, label: f.label })),
    })),
    ...(c.comment !== undefined ? { comment: c.comment } : {}),
    unselectedTargets: c.menuTargets.map((m) => ({ id: m.id, label: m.label, categoryCode: m.categoryCode })),
  };
}

export interface GeneratorOptions {
  readonly client?: GenAiClient;
  readonly model: string;
  /** 通常生成に差し込む口。既定は client があれば本番の Natural LLM Realizer、無ければ下書きを作らない口。 */
  readonly structuredPort?: StructuredDraftPort;
  /** 作り直し・safe fallback の通知（種類と claim の件数だけ・本番と同じ口）。 */
  readonly realizerEvents?: Pick<NaturalRealizerOptions, 'onRetry' | 'onFallback'>;
}

/** 評価の対象の一覧。client が無い（キーが無い）ときも一覧は返し、requiresApi のものは呼び手が skip する。 */
export function evalGenerators(options: GeneratorOptions): EvalGenerator[] {
  const { client, model } = options;
  const port =
    options.structuredPort ?? (client ? createNaturalRealizer(client, { model, ...options.realizerEvents }) : pendingStructuredDraft);
  return [
    {
      id: 'production',
      label: '本番の通常生成（作り直しと safe fallback を含む）',
      requiresApi: true,
      async generate(c) {
        const result = await port.prepare(materialOf(c));
        // claim の無いケースは無いので、本番の実装なら常に draft（LLM か fallback）を返す。
        if (result.kind !== 'draft') return { draft: null, source: null, attempts: 0 };
        return { draft: result.draft, source: result.source, attempts: result.attempts };
      },
    },
    {
      id: 'safe-fallback',
      label: '本番の safe fallback（決定的なテンプレート・事実性の対照）',
      requiresApi: false,
      generate: (c) => Promise.resolve({ draft: safeFallback(c), source: 'fallback', attempts: 0 }),
    },
  ];
}
