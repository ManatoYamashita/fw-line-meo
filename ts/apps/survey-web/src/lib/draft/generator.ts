import {
  createDefaultGenAiClient,
  generateText,
  type GenAiClient,
} from '@fwlm/gemini';
import type { DraftMaterial } from '../domain';
import type { Result } from '../result';
import { buildPrompt, type VariationSeed } from './prompt';

// 下書き生成（Gemini）。実行核（safetySettings 既定付与・1 回リトライ・安全性ブロック分類・出力検証の枠組み）
// は @fwlm/gemini に移設済み。本モジュールは口コミ下書きに固有のモデル選定・プロンプト・スキーマ・
// 出力抽出（JSON の draft キー・文字数上限）のみを所有する。

// 既存の公開面を維持するための re-export（テスト・消費者の import 元は本モジュールのまま）。
export type { GenAiClient, GenAiRequest, GenAiResponse } from '@fwlm/gemini';

export type DraftErrorKind = 'SAFETY_BLOCKED' | 'API_ERROR' | 'INVALID_OUTPUT';
export interface DraftError {
  kind: DraftErrorKind;
}

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

export interface DraftGeneratorOptions {
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  maxDraftChars?: number;
  backoff?: (attempt: number) => Promise<void>;
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

  return {
    async generate(material, variation) {
      const { systemInstruction, userContent } = buildPrompt(material, variation);
      // safetySettings は @fwlm/gemini の既定（4 カテゴリ BLOCK_MEDIUM_AND_ABOVE・Req 3.4）を使用。
      return generateText(client, {
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
