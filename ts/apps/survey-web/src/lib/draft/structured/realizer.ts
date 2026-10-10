import type { GenAiClient, GenAiResponse } from '../generator';
import type { StructuredDraftMaterial, StructuredDraftPort, StructuredDraftResult } from '../structured-draft';
import { compileStructuredClaims, type StructuredClaim } from './claims';
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
import { buildRealizerPrompt, RETRY_NOTES, STRUCTURE_HINTS, TONES } from './prompt';
import lexiconRaw from './lexicon.json';

// structured の通常生成（Natural LLM Realizer・Issue #439）。structured の回答から、事実の境界を claim に固定したうえで、
// LLM に自然な口コミの文章を書かせる。プロダクトの概念は「通常生成」と「safe fallback」の 2 つだけである。
//
//   compileStructuredClaims（決定的）
//   → 生成 1 回目 → hard gate（src/lib/draft/structured/gate.ts・評価と同じ物差し）
//       OK → 下書き
//       NG → 生成 2 回目（違反の種類に応じた決まった注意を足し、言い回し・順番・文の分け方を変えさせる）
//            → hard gate  OK → 下書き / NG → safe fallback（決定的なテンプレート）
//   生成そのものの失敗（API・安全性・形式）→ safe fallback
// LLM の呼び出しは最大 2 回。fallback は通常の経路ではない。
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
  /** 文章の形・文体の候補を選ぶ乱数（テストで固定する）。 */
  readonly random?: () => number;
  readonly lexicon?: StructuredGateLexicon;
  readonly legacyLexicons?: LegacyLexicons;
  /**
   * 1 回目が hard gate を通らず作り直したとき・safe fallback へ落ちたときに呼ばれる（記録は配線側が決める）。
   * 渡すのは失格の種類（頭の名前）と claim の件数だけで、本文・一言・料理名は渡さない。
   */
  readonly onRetry?: (kinds: readonly string[], claimCount: number) => void;
  readonly onFallback?: (reason: 'gate' | 'generation', kinds: readonly string[], claimCount: number) => void;
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

  async function generate(
    claims: readonly StructuredClaim[],
    comment: string | undefined,
    star: number,
    retryNotes: readonly string[],
  ): Promise<string | null> {
    const { systemInstruction, userContent } = buildRealizerPrompt({
      claims,
      ...(comment !== undefined ? { comment } : {}),
      star,
      structureHint: pick(STRUCTURE_HINTS),
      tone: pick(TONES),
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
      const failedKinds = (draft: string) => [
        ...new Set(evaluateStructuredDraft(input, draft, lexicon, legacy).findings.map((f) => gateFamily(f.kind))),
      ];

      const first = await generate(claims, comment, material.star, []);
      if (first === null) {
        options.onFallback?.('generation', [], claims.length);
        return { kind: 'draft', draft: structuredFallbackDraft(claims), source: 'fallback', attempts: 1 };
      }
      const firstKinds = failedKinds(first);
      if (firstKinds.length === 0) return { kind: 'draft', draft: first, source: 'llm', attempts: 1 };

      options.onRetry?.(firstKinds, claims.length);
      const notes = firstKinds.map((k) => RETRY_NOTES[k] ?? RETRY_NOTES.caseForbidden!).filter((n, i, a) => a.indexOf(n) === i);
      const second = await generate(claims, comment, material.star, notes);
      if (second === null) {
        options.onFallback?.('generation', firstKinds, claims.length);
        return { kind: 'draft', draft: structuredFallbackDraft(claims), source: 'fallback', attempts: 2 };
      }
      const secondKinds = failedKinds(second);
      if (secondKinds.length === 0) return { kind: 'draft', draft: second, source: 'llm', attempts: 2 };
      options.onFallback?.('gate', secondKinds, claims.length);
      return { kind: 'draft', draft: structuredFallbackDraft(claims), source: 'fallback', attempts: 2 };
    },
  };
}
