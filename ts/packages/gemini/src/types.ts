// Gemini 実行核の公開型。survey-web の draft/generator.ts から形状を維持したまま移設。
// @google/genai の ai.models.generateContent を GenAiClient 面で抽象化し、テストでモック可能にする。

/** @google/genai の応答が構造的に満たす最小面。 */
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

/** Gemini の safetySettings 1 件分（category × threshold）。 */
export interface SafetySetting {
  category: string;
  threshold: string;
}

/** 生成失敗の分類（安全性ブロック / API 障害 / 出力検証不合格）。 */
export type GenerationErrorKind = 'SAFETY_BLOCKED' | 'API_ERROR' | 'INVALID_OUTPUT';
export interface GenerationError {
  kind: GenerationErrorKind;
}
