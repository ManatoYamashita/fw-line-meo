import type { GenAiClient, GenAiResponse } from '../generator';
import type { StructuredDraftMaterial, StructuredDraftPort, StructuredDraftResult } from '../structured-draft';
import { compileStructuredClaims, type StructuredClaim } from './claims';
import {
  readLegacyLexicons,
  runtimeViolations,
  readStructuredGateLexicon,
  type LegacyLexicons,
  type StructuredGateInput,
  type StructuredGateLexicon,
} from './gate';
import { buildRealizerPrompt, RETRY_NOTES } from './prompt';
import lexiconRaw from './lexicon.json';

// structured の通常生成（Natural LLM Realizer・Issue #439）。structured の回答から、事実の境界を claim に固定したうえで、
// LLM に自然な口コミの文章を書かせる。**ユーザーに表示する下書きは、最初の生成も再生成も、すべてこの通常生成の文である。**
// 決定的な safe fallback（fallback.ts）は本番の応答では使わない（単体テスト・内部の診断・将来の非常用に限る）。
//
//   compileStructuredClaims（決定的）
//   → 生成（最大 MAX_ATTEMPTS = 3 回）→ runtime hard gate（gate.ts の runtimeViolations）
//       OK                 → その下書き（言い回し・構成・どの項目をどうまとめたかは問わない）
//       明確な捏造         → 違反の種類に応じた決まった注意を足して作り直す
//       生成そのものの失敗 → 同じ注意のまま作り直す
//   3 回とも使えなければ generation error（{ kind: 'failed' }）。**safe fallback の文を下書きとして返さない。**
// 文章は Gemini に任せ、コードは明確な捏造だけを止める（2026-10-11 の大幅簡素化）。style（言い回しの好み）や
// claim ごとの coverage では作り直さない（それらは評価の診断だけが見る）。
//
// 「hard gate を通った = 完全に事実どおり」とは扱わない（語彙の判定は違反の下限）。評価（eval/structured）で
// 通常生成の残差（事実性と自然さ）を測る。

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
/**
 * 1 回の下書き（ユーザーの 1 回の送信・1 回の「別の文章を生成」）で LLM を呼ぶ最大回数。実 Gemini で 2 回では
 * 落ちる回答があった。これより増やすと待ち時間と API の利用量が増える。
 */
export const MAX_ATTEMPTS = 3;
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
  readonly lexicon?: StructuredGateLexicon;
  readonly legacyLexicons?: LegacyLexicons;
  /**
   * 作り直したとき（attempt 1〜2 が使えなかった）・最後まで下書きを作れなかったときに呼ばれる（記録は配線側が決める）。
   * 渡すのは失格の種類（頭の名前・生成の失敗は `generation`）と claim の件数だけで、本文・一言・料理名は渡さない。
   */
  readonly onRetry?: (kinds: readonly string[], claimCount: number) => void;
  readonly onFailed?: (reason: 'gate' | 'generation', kinds: readonly string[], claimCount: number) => void;
  /**
   * 最終の結果（ローカル検証の記録用）。結果（llm / generation_error）・LLM の呼び出し回数・試行ごとの失格の種類だけを
   * 渡し、本文・一言・料理名は渡さない。
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

/** 1 回の試行の結果（種類だけ）。 */
export interface AttemptRecord {
  readonly attempt: number;
  /** 生成そのものの失敗（API・安全性・形式・空）。 */
  readonly generationFailed: boolean;
  readonly factuality: readonly string[];
}

export interface RealizerOutcome {
  /** 最終の結果。safe fallback は本番の経路では出ない。 */
  readonly result: 'llm' | 'generation_error';
  /** LLM を呼んだ回数（1〜MAX_ATTEMPTS）。 */
  readonly attempts: number;
  /** 返した下書きの試行の番号（generation_error なら null）。 */
  readonly acceptedAttempt: number | null;
  readonly history: readonly AttemptRecord[];
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
  const lexicon = options.lexicon ?? DEFAULT_LEXICON;
  const legacy = options.legacyLexicons ?? DEFAULT_LEGACY;

  // 初回の生成も再生成も同じ。文体・組み立て・並び・総評をサーバーで抽選しない（Gemini 自身の揺らぎに任せる）。
  async function generate(claims: readonly StructuredClaim[], comment: string | undefined, retryNotes: readonly string[]): Promise<string | null> {
    const { systemInstruction, userContent } = buildRealizerPrompt({
      claims,
      ...(comment !== undefined ? { comment } : {}),
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
    async prepare(material: StructuredDraftMaterial): Promise<StructuredDraftResult> {
      const claims = compileStructuredClaims(material.selections);
      // claim が無い（星だけ・一言だけ）回答からは下書きを作らない。素材の無い文章は創作になる。
      if (claims.length === 0) return { kind: 'unavailable' };
      const comment = material.comment !== undefined && material.comment.trim() !== '' ? material.comment : undefined;
      const input = gateInputOf(material);
      const history: AttemptRecord[] = [];
      let notes: string[] = [];
      const accept = (draft: string, attempt: number) => {
        options.onResult?.({ result: 'llm', attempts: history.length, acceptedAttempt: attempt, history }, claims.length);
        return { kind: 'draft' as const, draft, source: 'llm' as const, attempts: history.length };
      };

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const draft = await generate(claims, comment, notes);
        if (draft === null) {
          history.push({ attempt, generationFailed: true, factuality: [] });
          if (attempt < MAX_ATTEMPTS) options.onRetry?.(['generation'], claims.length);
          continue;
        }
        const factuality = runtimeViolations(input, draft, lexicon, legacy);
        history.push({ attempt, generationFailed: false, factuality });
        if (factuality.length === 0) return accept(draft, attempt);
        if (attempt < MAX_ATTEMPTS) {
          options.onRetry?.(factuality, claims.length);
          notes = factuality.map((k) => RETRY_NOTES[k] ?? RETRY_NOTES.caseForbidden!).filter((n, i, a) => a.indexOf(n) === i);
        }
      }

      // 下書きを作れなかった（generation error）。safe fallback の文は返さない。
      const lastFactuality = [...history].reverse().find((h) => !h.generationFailed)?.factuality ?? [];
      const reason = history.every((h) => h.generationFailed) ? 'generation' : 'gate';
      options.onFailed?.(reason, reason === 'gate' ? lastFactuality : [], claims.length);
      options.onResult?.({ result: 'generation_error', attempts: history.length, acceptedAttempt: null, history }, claims.length);
      return { kind: 'failed', attempts: history.length };
    },
  };
}
