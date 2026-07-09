import type { DraftMaterial } from '../domain';
import { ok, err, type Result } from '../result';
import { buildPrompt, type VariationSeed } from './prompt';

// 下書き生成（Gemini）。Gemini 呼出の全パラメータ（モデル・スキーマ・安全設定・再試行・出力検証）を単一所有。
// @google/genai の ai.models.generateContent を GenAiClient 面で抽象化し、テストでモック可能にする。

export type DraftErrorKind = 'SAFETY_BLOCKED' | 'API_ERROR' | 'INVALID_OUTPUT';
export interface DraftError {
  kind: DraftErrorKind;
}

export interface DraftGenerator {
  generate(material: DraftMaterial, variation: VariationSeed): Promise<Result<string, DraftError>>;
}

// @google/genai の応答が構造的に満たす最小面。
export interface GenAiResponse {
  text?: string;
  promptFeedback?: { blockReason?: string };
  candidates?: Array<{ finishReason?: string }>;
}

export interface GenAiRequest {
  model: string;
  contents: string;
  config: Record<string, unknown>;
}

export interface GenAiClient {
  models: { generateContent(req: GenAiRequest): Promise<GenAiResponse> };
}

// safetySettings は Gemini 2.5/3 系でデフォルト Off のため、口コミ用途では明示必須（Req 3.4）。
const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
] as const;

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
  const backoff = options.backoff ?? ((attempt) => delay(200 * 2 ** attempt));

  return {
    async generate(material, variation) {
      const { systemInstruction, userContent } = buildPrompt(material, variation);
      const req: GenAiRequest = {
        model,
        contents: userContent,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          // seed は固定しない（同一素材から毎回異なる文面・Req 3.3）。
          temperature,
          maxOutputTokens,
          safetySettings: SAFETY_SETTINGS,
        },
      };

      // 呼出（429/5xx・ネットワーク断は指数バックオフで 1 回だけ再試行）。
      let res: GenAiResponse;
      try {
        res = await client.models.generateContent(req);
      } catch (firstError) {
        if (!isRetryable(firstError)) return err({ kind: 'API_ERROR' });
        await backoff(0);
        try {
          res = await client.models.generateContent(req);
        } catch {
          return err({ kind: 'API_ERROR' });
        }
      }

      // 安全性ブロック（prompt レベル・候補の finishReason=SAFETY）。
      if (
        res.promptFeedback?.blockReason != null ||
        res.candidates?.some((c) => c.finishReason === 'SAFETY')
      ) {
        return err({ kind: 'SAFETY_BLOCKED' });
      }

      // 出力検証（非空・maxDraftChars 以内・スキーマ準拠）。
      const draft = extractDraft(res.text, maxDraftChars);
      if (draft === null) return err({ kind: 'INVALID_OUTPUT' });
      return ok(draft);
    },
  };
}

/** 本番用の生成器（GoogleGenAI は GEMINI_API_KEY を自動検出）。Cloud Run 実行時のみ使用。 */
export async function createDefaultDraftGenerator(
  options: DraftGeneratorOptions = {},
): Promise<DraftGenerator> {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({});
  const client: GenAiClient = {
    models: {
      generateContent: (req) =>
        ai.models.generateContent(
          req as Parameters<typeof ai.models.generateContent>[0],
        ) as Promise<GenAiResponse>,
    },
  };
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

function isRetryable(error: unknown): boolean {
  const e = error as { status?: number; code?: number } | null;
  const status = e?.status ?? e?.code;
  if (status === undefined) return true; // ネットワーク断等は 1 回だけ再試行
  return status === 429 || (status >= 500 && status < 600);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
