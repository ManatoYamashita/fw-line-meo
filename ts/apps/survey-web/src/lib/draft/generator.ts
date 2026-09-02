import {
  createDefaultGenAiClient,
  generateText,
  type GenAiClient,
} from '@fwlm/gemini';
import type { DraftMaterial } from '../domain';
import type { Result } from '../result';
import { buildPrompt, type VariationSeed } from './prompt';
import { detectAspectMentions, readLexicon, type AspectLexicon } from './factuality';
import lexiconRaw from './aspect-lexicon.json';

// 下書き生成（Gemini）。実行核（safetySettings 既定付与・1 回リトライ・安全性ブロック分類・出力検証の枠組み）
// は @fwlm/gemini に移設済み。本モジュールは口コミ下書きに固有のモデル選定・プロンプト・スキーマ・
// 出力抽出（JSON の draft キー・文字数上限）のみを所有する。

// 既存の公開面を維持するための re-export（テスト・消費者の import 元は本モジュールのまま）。
export type { GenAiClient, GenAiRequest, GenAiResponse } from '@fwlm/gemini';

export type DraftError =
  | { kind: 'SAFETY_BLOCKED' }
  | { kind: 'API_ERROR'; status?: number }
  | { kind: 'INVALID_OUTPUT' };
export type DraftErrorKind = DraftError['kind'];

export interface DraftGenerator {
  generate(material: DraftMaterial, variation: VariationSeed): Promise<Result<string, DraftError>>;
}

// 構造化出力: {draft: string} を強制。
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: { draft: { type: 'STRING' } },
  required: ['draft'],
} as const;

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const DEFAULT_LEXICON = readLexicon(lexiconRaw);

export interface DraftGeneratorOptions {
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  maxDraftChars?: number;
  backoff?: (attempt: number) => Promise<void>;
  /**
   * 生成後に「客が選ばなかった観点へ言及していないか」を検証し、していれば 1 回だけ作り直す
   * （Issue #132・案B）。既定 true。
   *
   * false にできるのは **測定の独立性のため**である。これが無いと eval が案A（プロンプトでの
   * 禁止）単体の効果を測れなくなり、前後比較の意味が失われる。
   */
  factualityCheck?: boolean;
  lexicon?: AspectLexicon;
  /**
   * 作り直してもなお言及が残ったときに呼ばれる（下書き自体は客へ返す）。
   * 生成器はロガーを持たないので、記録の仕方は配線側（route.ts）が決める。
   */
  onResidual?: (aspectCodes: string[]) => void;
}

/** テスト可能な生成器を作る（client を注入）。 */
export function createDraftGenerator(
  client: GenAiClient,
  options: DraftGeneratorOptions = {},
): DraftGenerator {
  const model = options.model ?? DEFAULT_MODEL;
  const temperature = options.temperature ?? 1.0;
  // 100-200 字の日本語＋JSON ラッパに加え、Gemini 3.x の thinking トークン消費に余裕を持たせる
  // （cap なので短出力では無駄がなく、truncation による誤 INVALID_OUTPUT を避ける）。
  const maxOutputTokens = options.maxOutputTokens ?? 1024;
  const maxDraftChars = options.maxDraftChars ?? 400;
  // backoff の既定（200ms * 2^attempt）は @fwlm/gemini の実行核が持つ。ここでは素通しする。
  const factualityCheck = options.factualityCheck ?? true;
  const lexicon = options.lexicon ?? DEFAULT_LEXICON;
  const onResidual = options.onResidual;

  return {
    async generate(material, variation) {
      const { systemInstruction, userContent } = buildPrompt(material, variation);

      // 1 回分の生成（呼出 → 安全性 → 出力検証）。事後検証で作り直すため関数へ括る。
      // 呼出・safetySettings の既定付与（4 カテゴリ BLOCK_MEDIUM_AND_ABOVE・Req 3.4）・
      // 429/5xx の 1 回リトライ・安全性ブロック分類は @fwlm/gemini の実行核が所有する。
      //
      // **事後検証を validateOutput へ載せてはならない**: null を返すと INVALID_OUTPUT へ化け、
      // 「逸脱していても下書き自体は客へ返す」という案B（Issue #132）の設計意図が壊れる。
      // 検証は生成結果を受け取ってから本関数の外で行う。
      const attempt = (): Promise<Result<string, DraftError>> =>
        generateText(client, {
          model,
          contents: userContent,
          config: {
            systemInstruction,
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
            // seed は固定しない（同一素材から毎回異なる文面・Req 3.3）。
            temperature,
            maxOutputTokens,
          },
          backoff: options.backoff,
          validateOutput: (text) => extractDraft(text, maxDraftChars),
        });

      const first = await attempt();
      if (!first.ok) return first;

      // --- 事後検証（Issue #132・案B）---
      // 検証する観点は、プロンプトで禁止したのと同じ差集合（material 由来）をそのまま使う。
      // 項目を持たない旧 sessionToken 由来の素材では検証がかからず、案A のみの挙動へ劣化する。
      const targets = material.unselectedAspectCodes ?? [];
      if (!factualityCheck || targets.length === 0) return first;
      if (detectAspectMentions(first.value, targets, lexicon).length === 0) return first;

      // 1 回だけ作り直す。variation は呼び出し側から受けた値のまま使う（temperature 1.0 なので
      // 同じ入力でも出力は変わる）。これは生成器内部の再試行であり、客の再生成回数
      // （REGEN_MAX）は消費しない。
      const second = await attempt();
      // 作り直しに失敗したときは初回の下書きを返す。客に何も出さない方が実害が大きい。
      if (!second.ok) return first;

      const residual = detectAspectMentions(second.value, targets, lexicon);
      if (residual.length > 0) {
        onResidual?.(residual.map((v) => v.aspectCode));
      }
      return second;
    },
  };
}

/** 本番用の生成器（GEMINI_API_KEY 自動検出の既定クライアント）。Cloud Run 実行時のみ使用。 */
export async function createDefaultDraftGenerator(
  options: DraftGeneratorOptions = {},
): Promise<DraftGenerator> {
  const client = await createDefaultGenAiClient();
  return createDraftGenerator(client, { model: process.env.GEMINI_MODEL, ...options });
}

function extractDraft(text: string | undefined, maxChars: number): string | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const draft = (parsed as Record<string, unknown>).draft;
  if (typeof draft !== 'string') return null;
  const trimmed = draft.trim();
  if (trimmed.length === 0 || [...trimmed].length > maxChars) return null;
  return trimmed;
}
