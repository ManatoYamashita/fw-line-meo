import type { GenAiClient, GenAiResponse } from '../generator';
import type { StructuredDraftMaterial, StructuredDraftOptions, StructuredDraftPort, StructuredDraftResult } from '../structured-draft';
import { claimSubjectKey, compileStructuredClaims, type StructuredClaim } from './claims';
import { structuredFallbackDraft } from './fallback';
import {
  evaluateStructuredDraft,
  gateFamily,
  readLegacyLexicons,
  readStructuredGateLexicon,
  type LegacyLexicons,
  type StructuredGateInput,
  type StructuredGateLexicon,
} from './gate';
import { availableCompositions, buildRealizerPrompt, OVERALL_RATE, RETRY_NOTES, TONES } from './prompt';
import { detectStyleIssues } from './style';
import lexiconRaw from './lexicon.json';

// structured の通常生成（Natural LLM Realizer・Issue #439）。structured の回答から、事実の境界を claim に固定したうえで、
// LLM に自然な口コミの文章を書かせる。プロダクトの概念は「通常生成」と「safe fallback」の 2 つだけである。
//
//   compileStructuredClaims（決定的）
//   → 生成 1 回目 → factuality の hard gate（gate.ts・評価と同じ物差し）と style check（style.ts）
//       両方 OK → 下書き
//       どちらか NG → 生成 2 回目（違反の種類に応じた決まった注意を足す）
//            factuality OK → 2 回目の下書き（style の問題が残っていても返す）
//            factuality NG → 1 回目が factuality OK（style だけの問題）だったなら 1 回目の下書き、そうでなければ safe fallback
//   生成そのものの失敗（API・安全性・形式）→ 1 回目が factuality OK ならその下書き、そうでなければ safe fallback
// LLM の呼び出しは最大 2 回。**safe fallback へ落とすのは factuality の違反と生成の失敗だけで、style の問題では落とさない。**
// fallback は通常の経路ではない。
//
// 「hard gate を通った = 完全に事実どおり」とは扱わない（語彙の判定は違反の下限）。評価（eval/structured）で
// 通常生成の残差（事実性と自然さ）を測る。

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const MAX_DRAFT_CHARS = 400;

const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
] as const;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: { draft: { type: 'STRING' } },
  required: ['draft'],
} as const;

const DEFAULT_LEXICON = readStructuredGateLexicon(lexiconRaw);
const DEFAULT_LEGACY = readLegacyLexicons();

export interface NaturalRealizerOptions {
  readonly model?: string;
  readonly temperature?: number;
  /** 文章の組み立て・項目の並び・文体・総評の有無を選ぶ乱数（テストで固定する）。 */
  readonly random?: () => number;
  readonly lexicon?: StructuredGateLexicon;
  readonly legacyLexicons?: LegacyLexicons;
  /**
   * 1 回目が hard gate を通らず作り直したとき・safe fallback へ落ちたときに呼ばれる（記録は配線側が決める）。
   * 渡すのは失格の種類（頭の名前）と claim の件数だけで、本文・一言・料理名は渡さない。
   */
  readonly onRetry?: (kinds: readonly string[], claimCount: number) => void;
  readonly onFallback?: (reason: 'gate' | 'generation', kinds: readonly string[], claimCount: number) => void;
  /**
   * 最終の結果（ローカル検証の記録用）。source・LLM の呼び出し回数・作り直しの有無と、最終の下書きに残った種類
   * （style の問題を受け入れた・safe fallback へ落ちた理由）だけを渡し、本文・一言・料理名は渡さない。
   */
  readonly onResult?: (result: RealizerOutcome, claimCount: number) => void;
}

/**
 * 素材から hard gate の入力を作る。未回答の Target は素材の unselectedTargets（回答時点の定義）から作り、名前の
 * 完全一致だけで照合する。Target の言い換え・一言の内容の語・ケース固有の禁止は本番の素材に無い（評価だけが持つ）。
 */
export function gateInputOf(material: StructuredDraftMaterial): StructuredGateInput {
  return {
    storeName: material.storeName,
    ...(material.comment !== undefined ? { comment: material.comment } : {}),
    selections: material.selections,
    subjects: {},
    menuTargets: (material.unselectedTargets ?? []).map((t) => ({ ...t, aliases: [] })),
    commentKeywords: [],
    forbiddenMeanings: [],
  };
}

/**
 * 主題（極性 × Target / カテゴリ全体の facet）の単位で claim の並びを入れ替える。プロンプトの回答の行の順が変わるだけで、
 * claim の中身・極性は変えない（事後検証は素材から作るので、並びに依存しない）。
 */
export function shuffleSubjects(claims: readonly StructuredClaim[], random: () => number): StructuredClaim[] {
  const keys = [...new Set(claims.map((c) => `${c.polarity}:${claimSubjectKey(c)}`))];
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    [keys[i], keys[j]] = [keys[j]!, keys[i]!];
  }
  return keys.flatMap((k) => claims.filter((c) => `${c.polarity}:${claimSubjectKey(c)}` === k));
}

export interface RealizerOutcome {
  readonly source: 'llm' | 'fallback';
  readonly attempts: number;
  /** 1 回目が作り直しになったか（factuality / style のどちらでも）。 */
  readonly retried: boolean;
  /** 1 回目の作り直しの理由が style だけだったか。 */
  readonly styleOnlyRetry: boolean;
  /** 最終の下書きに残った種類（LLM の文なら受け入れた style の問題、fallback なら落ちた理由）。 */
  readonly residualKinds: readonly string[];
}

/** 1 回の下書き作り（作り直しを含む）で固定する文章の組み立て。作り直しでは回答と組み立てを変えない。 */
interface Plan {
  readonly claims: readonly StructuredClaim[];
  readonly composition: string;
  readonly tone: string;
  readonly includeOverall: boolean;
  readonly regeneration: boolean;
}

function extractDraft(res: GenAiResponse): string | null {
  if (res.promptFeedback?.blockReason) return null;
  try {
    const parsed = JSON.parse(res.text ?? '') as { draft?: unknown };
    if (typeof parsed.draft !== 'string') return null;
    const draft = parsed.draft.trim();
    return draft === '' || [...draft].length > MAX_DRAFT_CHARS ? null : draft;
  } catch {
    return null;
  }
}

export function createNaturalRealizer(client: GenAiClient, options: NaturalRealizerOptions = {}): StructuredDraftPort {
  const model = options.model ?? DEFAULT_MODEL;
  const temperature = options.temperature ?? 1.0;
  const random = options.random ?? Math.random;
  const lexicon = options.lexicon ?? DEFAULT_LEXICON;
  const legacy = options.legacyLexicons ?? DEFAULT_LEGACY;

  const pick = (items: readonly string[]) => items[Math.floor(random() * items.length)] ?? items[0]!;

  function planOf(claims: readonly StructuredClaim[], options: StructuredDraftOptions): Plan {
    const compositions = availableCompositions(claims);
    return {
      claims: shuffleSubjects(claims, random),
      composition: (compositions[Math.floor(random() * compositions.length)] ?? compositions[0]!).text,
      tone: pick(TONES),
      includeOverall: random() < OVERALL_RATE,
      regeneration: options.regeneration === true,
    };
  }

  async function generate(
    plan: Plan,
    comment: string | undefined,
    star: number,
    retryNotes: readonly string[],
  ): Promise<string | null> {
    const { systemInstruction, userContent } = buildRealizerPrompt({
      claims: plan.claims,
      ...(comment !== undefined ? { comment } : {}),
      star,
      includeOverall: plan.includeOverall,
      composition: plan.composition,
      tone: plan.tone,
      regeneration: plan.regeneration,
      retryNotes,
    });
    try {
      const res = await client.models.generateContent({
        model,
        contents: userContent,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          temperature,
          maxOutputTokens: 1024,
          safetySettings: SAFETY_SETTINGS,
        },
      });
      return extractDraft(res);
    } catch {
      return null;
    }
  }

  return {
    async prepare(material: StructuredDraftMaterial, draftOptions: StructuredDraftOptions = {}): Promise<StructuredDraftResult> {
      const claims = compileStructuredClaims(material.selections);
      // claim が無い（星だけ・一言だけ）回答からは下書きを作らない。素材の無い文章は創作になる。
      if (claims.length === 0) return { kind: 'unavailable' };
      const comment = material.comment !== undefined && material.comment.trim() !== '' ? material.comment : undefined;
      const input = gateInputOf(material);
      const factualityKinds = (draft: string) => [
        ...new Set(evaluateStructuredDraft(input, draft, lexicon, legacy).findings.map((f) => gateFamily(f.kind))),
      ];
      const done = (draft: string, source: 'llm' | 'fallback', attempts: number, outcome: Omit<RealizerOutcome, 'source' | 'attempts'>) => {
        options.onResult?.({ source, attempts, ...outcome }, claims.length);
        return { kind: 'draft' as const, draft, source, attempts };
      };
      const fallback = (reason: 'gate' | 'generation', kinds: readonly string[], attempts: number, retried: boolean, styleOnlyRetry: boolean) => {
        options.onFallback?.(reason, kinds, claims.length);
        return done(structuredFallbackDraft(claims), 'fallback', attempts, { retried, styleOnlyRetry, residualKinds: [...kinds] });
      };

      const plan = planOf(claims, draftOptions);
      const first = await generate(plan, comment, material.star, []);
      if (first === null) return fallback('generation', [], 1, false, false);
      const firstFact = factualityKinds(first);
      const firstStyle = detectStyleIssues(first, lexicon, comment);
      if (firstFact.length === 0 && firstStyle.length === 0) {
        return done(first, 'llm', 1, { retried: false, styleOnlyRetry: false, residualKinds: [] });
      }

      const firstKinds = [...firstFact, ...firstStyle];
      const styleOnlyRetry = firstFact.length === 0;
      options.onRetry?.(firstKinds, claims.length);
      const notes = firstKinds.map((k) => RETRY_NOTES[k] ?? RETRY_NOTES.caseForbidden!).filter((n, i, a) => a.indexOf(n) === i);
      const second = await generate(plan, comment, material.star, notes);
      // 1 回目が factuality OK（style だけの問題）なら、2 回目が使えなくても 1 回目の LLM の文を返す。
      const keepFirst = () => done(first, 'llm', 2, { retried: true, styleOnlyRetry, residualKinds: firstStyle });
      if (second === null) return styleOnlyRetry ? keepFirst() : fallback('generation', firstKinds, 2, true, false);
      const secondFact = factualityKinds(second);
      if (secondFact.length === 0) {
        return done(second, 'llm', 2, { retried: true, styleOnlyRetry, residualKinds: detectStyleIssues(second, lexicon, comment) });
      }
      if (styleOnlyRetry) return keepFirst();
      return fallback('gate', secondFact, 2, true, false);
    },
  };
}
