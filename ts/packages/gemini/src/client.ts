import type { GenAiClient, GenAiRequest, GenAiResponse } from './types.js';

/**
 * 本番用の GenAiClient を作る（GoogleGenAI は GEMINI_API_KEY を環境変数から自動検出）。
 * @google/genai はサーバー実行時のみ必要なため動的 import とする（ビルド成果物の肥大化防止）。
 */
export async function createDefaultGenAiClient(): Promise<GenAiClient> {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({});
  return {
    models: {
      generateContent: (req: GenAiRequest) =>
        ai.models.generateContent(
          req as Parameters<typeof ai.models.generateContent>[0],
        ) as Promise<GenAiResponse>,
    },
  };
}
