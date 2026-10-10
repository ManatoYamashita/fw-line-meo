import type { GenAiClient, GenAiResponse } from './generator';

// 本番の Gemini クライアント（GoogleGenAI は GEMINI_API_KEY を自動検出する）。structured の Natural LLM Realizer
// （Issue #439）が使う。legacy の生成器（generator.ts の createDefaultDraftGenerator）は自前で同じものを作っており、
// legacy へ手を入れないためにここでは共有しない。テストは GenAiClient の偽物を注入する。
export async function createDefaultGenAiClient(): Promise<GenAiClient> {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({});
  return {
    models: {
      generateContent: (req) =>
        ai.models.generateContent(req as Parameters<typeof ai.models.generateContent>[0]) as Promise<GenAiResponse>,
    },
  };
}
