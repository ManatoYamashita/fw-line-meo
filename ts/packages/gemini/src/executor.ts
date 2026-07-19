import { ok, err, type Result } from './result.js';
import type {
  GenAiClient,
  GenAiRequest,
  GenAiResponse,
  GenerationError,
  SafetySetting,
} from './types.js';

// Gemini 呼出の実行核: safetySettings の既定付与・1 回リトライ（指数バックオフ）・
// 安全性ブロック分類・出力検証。プロンプト組立と用途固有の検証は消費者側の責務。

// safetySettings は Gemini 2.5/3 系でデフォルト Off のため、生成用途では明示付与を既定とする。
export const DEFAULT_SAFETY_SETTINGS: readonly SafetySetting[] = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
];

export interface GenerateTextOptions {
  /** モデル ID（例: gemini-3.1-flash-lite）。既定値の選定は消費者側の責務。 */
  model: string;
  /** ユーザーコンテンツ（プロンプト本文）。 */
  contents: string;
  /** systemInstruction・responseSchema・temperature 等の追加 config（safetySettings は本実行核が付与）。 */
  config?: Record<string, unknown> | undefined;
  /** 安全設定（省略時は DEFAULT_SAFETY_SETTINGS）。 */
  safetySettings?: readonly SafetySetting[] | undefined;
  /** リトライ前の待機（省略時は 200ms * 2^attempt の指数バックオフ）。テストで注入可能。 */
  backoff?: ((attempt: number) => Promise<void>) | undefined;
  /** 出力の検証・抽出。null を返すと INVALID_OUTPUT に分類される。 */
  validateOutput: (text: string | undefined) => string | null;
}

/**
 * Gemini でテキストを 1 件生成する。
 * 429/5xx・ネットワーク断は指数バックオフで 1 回だけ再試行し、
 * 安全性ブロック（prompt レベル・候補の finishReason=SAFETY）と出力検証不合格を分類して返す。
 */
export async function generateText(
  client: GenAiClient,
  options: GenerateTextOptions,
): Promise<Result<string, GenerationError>> {
  const safetySettings = options.safetySettings ?? DEFAULT_SAFETY_SETTINGS;
  const backoff = options.backoff ?? ((attempt) => delay(200 * 2 ** attempt));
  const req: GenAiRequest = {
    model: options.model,
    contents: options.contents,
    config: { ...options.config, safetySettings },
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

  // 出力検証（消費者供給の検証・抽出関数。null で不合格）。
  const validated = options.validateOutput(res.text);
  if (validated === null) return err({ kind: 'INVALID_OUTPUT' });
  return ok(validated);
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
