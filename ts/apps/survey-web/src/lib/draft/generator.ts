import { createDefaultGenAiClient, generateText, type GenAiClient, type GenerationError } from '@fwlm/gemini';
import type { DraftMaterial } from '../domain';
import { ok, type Result } from '../result';
import { buildPrompt, type VariationSeed } from './prompt';
import { detectAspectMentions, readLexicon, type AspectLexicon } from './factuality';
import { detectEmbellishments, readEmbellishmentLexicon, type EmbellishmentLexicon } from './embellishment';
import { detectAbsenceAssertions, readAbsenceLexicon, type AbsenceLexicon } from './absence';
import lexiconRaw from './aspect-lexicon.json';
import embellishmentLexiconRaw from './embellishment-lexicon.json';
import absenceLexiconRaw from './absence-lexicon.json';

// 口コミ下書きの生成。モデル・スキーマ・生成パラメータ・出力検証・事後検証による作り直しをここが持ち、
// 呼び出し・安全設定・再試行・エラー分類は @fwlm/gemini の generateText に任せる（line-webhook と同じ実行核）。

export type { GenAiClient, GenAiRequest, GenAiResponse } from '@fwlm/gemini';
export { toApiError } from '@fwlm/gemini';

export type DraftError = GenerationError;
export type DraftErrorKind = DraftError['kind'];

export interface DraftGenerator {
  generate(
    material: DraftMaterial,
    variation: VariationSeed,
    onResidual?: (aspectCodes: string[]) => void,
    onClaimResidual?: (categories: string[]) => void,
  ): Promise<Result<string, DraftError>>;
}

// 構造化出力: {draft: string} を強制。
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: { draft: { type: 'STRING' } },
  required: ['draft'],
} as const;

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const DEFAULT_LEXICON = readLexicon(lexiconRaw);
const DEFAULT_EMBELLISHMENT_LEXICON = readEmbellishmentLexicon(embellishmentLexiconRaw);
const DEFAULT_ABSENCE_LEXICON = readAbsenceLexicon(absenceLexiconRaw);

/**
 * 事後検証で作り直す補完の分類（Issue #413）。語の形で決まり、誤検出の少ないものに限る。
 * 再訪の意向と観点の属性は、発生が多く（約 11%）、属性は言い換えとの境界が曖昧なので引き金にしない。
 */
const REGENERATED_EMBELLISHMENTS: readonly string[] = ['expectation'];

/**
 * 下書きから、作り直しの対象になる来店前の期待と「無かった」の断定を検出する（Issue #413）。
 * 返すのは分類名だけ（`expectation` / `absence:<分類>`）。一言に同じ事情があれば数えない（検出器の意味論）。
 */
function detectRegeneratedClaims(
  draft: string,
  material: DraftMaterial,
  embellishmentLexicon: EmbellishmentLexicon,
  absenceLexicon: AbsenceLexicon,
): string[] {
  // 空白だけの一言は「一言なし」として扱う（プロンプトの素材の描画と同じ）。
  const comment = material.comment !== undefined && material.comment.trim() !== '' ? material.comment : undefined;
  const source = comment === undefined ? { storeName: material.storeName } : { storeName: material.storeName, comment };
  const expectation = detectEmbellishments(draft, source, embellishmentLexicon)
    .map((c) => c.category)
    .filter((category) => REGENERATED_EMBELLISHMENTS.includes(category));
  const absence = detectAbsenceAssertions(draft, comment, absenceLexicon).map((c) => `absence:${c.category}`);
  return [...expectation, ...absence].sort();
}

export interface DraftGeneratorOptions {
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  maxDraftChars?: number;
  backoff?: (attempt: number) => Promise<void>;
  /**
   * 生成後に「客が選ばなかった観点へ言及していないか」（Issue #132・案B）と、「来店前の期待・
   * 選ばなかったことを無かったと書く断定」（Issue #413）を検証し、どれかがあれば 1 回だけ作り直す。既定 true。
   *
   * false にできるのは **測定の独立性のため**である。これが無いと eval が案A（プロンプトでの
   * 禁止）単体の効果を測れなくなり、前後比較の意味が失われる。
   */
  factualityCheck?: boolean;
  lexicon?: AspectLexicon;
  embellishmentLexicon?: EmbellishmentLexicon;
  absenceLexicon?: AbsenceLexicon;
  /**
   * 作り直してもなお言及が残ったときに呼ばれる（下書き自体は客へ返す）。
   * 生成器はロガーを持たないので、記録の仕方は配線側（route.ts）が決める。
   */
  onResidual?: (aspectCodes: string[]) => void;
  /**
   * 作り直してもなお来店前の期待か「無かった」の断定が残ったときに呼ばれる（Issue #413・下書き自体は客へ返す）。
   * 未選択の観点の onResidual とは分ける（既存の `factuality_residual` の意味を変えないため）。
   */
  onClaimResidual?: (categories: string[]) => void;
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
  const factualityCheck = options.factualityCheck ?? true;
  const lexicon = options.lexicon ?? DEFAULT_LEXICON;
  const embellishmentLexicon = options.embellishmentLexicon ?? DEFAULT_EMBELLISHMENT_LEXICON;
  const absenceLexicon = options.absenceLexicon ?? DEFAULT_ABSENCE_LEXICON;
  const onResidual = options.onResidual;
  const onClaimResidual = options.onClaimResidual;

  return {
    async generate(material, variation, requestOnResidual, requestOnClaimResidual) {
      const { systemInstruction, userContent } = buildPrompt(material, variation);
      // safetySettings は generateText が既定（DEFAULT_SAFETY_SETTINGS）を付ける。Gemini 2.5/3 系は既定で Off のため、
      // 口コミ用途では明示が必須（Req 3.4）。上書きしないこと。
      const config = {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        // seed は固定しない（同一素材から毎回異なる文面・Req 3.3）。
        temperature,
        maxOutputTokens,
      };

      // 1 回分の生成（呼出・429/5xx とネットワーク断の 1 回再試行・安全性ブロック・出力検証）。事後検証で作り直すため関数へ括る。
      const attempt = (): Promise<Result<string, DraftError>> =>
        generateText(client, {
          model,
          contents: userContent,
          config,
          backoff: options.backoff,
          validateOutput: (text) => extractDraft(text, maxDraftChars),
        });

      const first = await attempt();
      if (!first.ok) return first;

      // --- 事後検証（Issue #132・案B ／ Issue #413）---
      // 検証する観点は、プロンプトで禁止したのと同じ差集合（material 由来）をそのまま使う。
      // 項目を持たない旧 sessionToken 由来の素材では観点の検証がかからず、案A のみの挙動へ劣化する。
      // 来店前の期待と「無かった」の断定は、観点の差集合に依存しないので、どの素材でも検証する。
      if (!factualityCheck) return first;
      const targets = material.unselectedAspectCodes ?? [];
      const aspectsOf = (draft: string) => (targets.length === 0 ? [] : detectAspectMentions(draft, targets, lexicon));
      const claimsOf = (draft: string) => detectRegeneratedClaims(draft, material, embellishmentLexicon, absenceLexicon);
      if (aspectsOf(first.value).length === 0 && claimsOf(first.value).length === 0) return first;

      // 1 回だけ作り直す。variation は呼び出し側から受けた値のまま使う（temperature 1.0 なので
      // 同じ入力でも出力は変わる）。これは生成器内部の再試行であり、客の再生成回数
      // （REGEN_MAX）は消費しない。
      const second = await attempt();
      // 作り直しに失敗したときは初回の下書きを返す。客に何も出さない方が実害が大きい。
      if (!second.ok) return first;

      const residual = aspectsOf(second.value);
      if (residual.length > 0) {
        (requestOnResidual ?? onResidual)?.(residual.map((v) => v.aspectCode));
      }
      const claimResidual = claimsOf(second.value);
      if (claimResidual.length > 0) {
        (requestOnClaimResidual ?? onClaimResidual)?.(claimResidual);
      }
      return ok(second.value);
    },
  };
}

/** 本番用の生成器（GoogleGenAI は GEMINI_API_KEY を自動検出）。Cloud Run 実行時のみ使用。 */
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
