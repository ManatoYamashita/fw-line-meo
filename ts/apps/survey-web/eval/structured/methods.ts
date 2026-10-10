import { createDraftGenerator, type GenAiClient, type GenAiResponse } from '../../src/lib/draft/generator';
import { pickVariation } from '../../src/lib/draft/prompt';
import { pendingStructuredDraft, type StructuredDraftPort } from '../../src/lib/draft/structured-draft';
import type { DraftMaterial } from '../../src/lib/domain';
import { claimsOf, exactOverlaps, type EvalClaim, type StructuredEvalCase } from './gates';

// structured survey の下書きを作る方式（Issue #440 の比較対象）。同じケース・同じモデル・同じ回数で比べる。
//
//   A legacy-direct      現行の生成器（createDraftGenerator・prompt.ts）へ、structured の素材を legacy の観点の
//                        ラベルへ平らにして流す。「現行に近い direct generation」
//   B claims-plain       claim を箇条書きで渡し、回答に無いことは書かないとだけ指示する。自然化の指示は弱い
//   C natural-realizer   本番の StructuredDraftPort（src/lib/draft/structured-draft.ts）。**Issue #439 で中身を実装する。**
//                        Stage 2 の暫定実装は下書きを作らないので、この時点では全件「生成なし」になる
//   D safe-fallback      claim から決定的に作るテンプレート（参考・API 不要）
//
// B と D は評価のためだけの方式で、本番の生成には使わない（Issue #439 の prompt / generator を先取りしない）。

export interface EvalMethod {
  readonly id: string;
  readonly label: string;
  /** 実 API を呼ぶか（GEMINI_API_KEY が無ければ skip する）。 */
  readonly requiresApi: boolean;
  /** 下書きを 1 本作る。作れなければ null（生成失敗・未実装）。 */
  generate(c: StructuredEvalCase, run: number): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// claim の表示名（A・B・D で共有）
// ---------------------------------------------------------------------------

function claimLabel(cl: EvalClaim): string {
  if (cl.targetLabel !== undefined && cl.facetLabel !== undefined) return `${cl.targetLabel}の${cl.facetLabel}`;
  if (cl.targetLabel !== undefined) return cl.targetLabel;
  return cl.facetLabel!;
}

/** A: structured の素材を legacy の素材（観点のラベル）へ平らにする。Target と facet は「刺身盛り合わせの味」の形。 */
export function toLegacyMaterial(c: StructuredEvalCase): DraftMaterial {
  const claims = claimsOf(c);
  const material: DraftMaterial = {
    storeName: c.storeName,
    star: c.star,
    aspectLabels: claims.filter((x) => x.polarity === 'positive').map(claimLabel),
    concernLabels: claims.filter((x) => x.polarity === 'concern').map(claimLabel),
  };
  if (c.comment !== undefined) material.comment = c.comment;
  return material;
}

/** B: claim を箇条書きにした素朴な指示。自然化の指示（文体・統合・省略）は与えない。 */
export function claimsPlainPrompt(c: StructuredEvalCase): { systemInstruction: string; userContent: string } {
  const line = (cl: EvalClaim) =>
    `- ${[cl.categoryCode === undefined ? '' : categoryLabelOf(c, cl), cl.targetLabel, cl.facetLabel].filter(Boolean).join(' > ')}`;
  const claims = claimsOf(c);
  const positive = claims.filter((x) => x.polarity === 'positive').map(line);
  const concern = claims.filter((x) => x.polarity === 'concern').map(line);
  const sections = [
    `店名: ${c.storeName}`,
    `今回の満足度: 5 段階中 ${c.star}`,
    ...(positive.length > 0 ? ['良かったところ:', ...positive] : []),
    ...(concern.length > 0 ? ['気になったところ:', ...concern] : []),
    ...(c.comment !== undefined ? [`一言: ${c.comment}`] : []),
  ];
  return {
    systemInstruction:
      'あなたは飲食店を利用した客です。与えられた回答の内容だけを使って、Google の口コミに投稿する文章を日本語で書いてください。' +
      '回答に無い事実は書かないでください。JSON {"draft": "..."} の形で返してください。',
    userContent: sections.join('\n'),
  };
}

function categoryLabelOf(c: StructuredEvalCase, cl: EvalClaim): string {
  return c.selections.find((s) => s.categoryCode === cl.categoryCode)?.categoryLabel ?? cl.categoryCode;
}

/**
 * D: claim から決定的に作る安全なテンプレート（参考）。主題（Target / カテゴリ全体の facet）ごとに 1 文で、
 * 回答した facet だけを名指す。exact overlap は「良かったところもあり、気になるところもありました」とだけ書く。
 * 強度・理由・意向は足さない。一言は文面に混ぜない（客の文章を書き換えないため）。
 */
export function safeFallback(c: StructuredEvalCase): string {
  const claims = claimsOf(c);
  const overlaps = new Set(exactOverlaps(c));
  const subjectKey = (cl: EvalClaim) => cl.targetId ?? `${cl.categoryCode}:${cl.facetCode}`;
  const sentences: string[] = [];
  const done = new Set<string>();
  for (const cl of claims) {
    const key = `${cl.polarity}:${subjectKey(cl)}`;
    if (done.has(key)) continue;
    done.add(key);
    const sameSubject = claims.filter((x) => x.polarity === cl.polarity && subjectKey(x) === subjectKey(cl));
    const facets = sameSubject.flatMap((x) => (x.facetLabel ? [x.facetLabel] : []));
    const overlap = sameSubject.some((x) => overlaps.has(`${x.targetId ?? x.categoryCode}:${x.facetCode ?? ''}`));
    if (overlap) {
      if (cl.polarity === 'concern') continue;
      const subject = cl.targetLabel !== undefined ? `${cl.targetLabel}の${facets.join('・')}` : facets.join('・');
      sentences.push(`${subject}は、良かったところもあり、気になるところもありました。`);
      continue;
    }
    const verb = cl.polarity === 'positive' ? '良かったです' : '気になりました';
    if (cl.targetLabel !== undefined) {
      sentences.push(facets.length > 0 ? `${cl.targetLabel}は${facets.join('と')}が${verb}。` : `${cl.targetLabel}が${verb}。`);
    } else {
      sentences.push(`${facets.join('と')}が${verb}。`);
    }
  }
  return sentences.join('');
}

// ---------------------------------------------------------------------------
// 方式の実体
// ---------------------------------------------------------------------------

const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
] as const;

export interface MethodOptions {
  readonly client?: GenAiClient;
  readonly model: string;
  /** C に差し込む本番の口。既定は本番の現在の実装（Stage 2 の暫定・下書きを作らない）。 */
  readonly structuredPort?: StructuredDraftPort;
}

function parseDraft(res: GenAiResponse): string | null {
  try {
    const parsed = JSON.parse(res.text ?? '') as { draft?: unknown };
    return typeof parsed.draft === 'string' && parsed.draft.trim() !== '' ? parsed.draft.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 比較する方式の一覧。A・B は同じクライアント・同じモデル・本番と同じ temperature（1.0）と安全設定で呼ぶ。
 * client が無い（キーが無い）ときも一覧は返し、requiresApi の方式は呼び手が skip する。
 */
export function evalMethods(options: MethodOptions): EvalMethod[] {
  const { client, model } = options;
  const port = options.structuredPort ?? pendingStructuredDraft;
  return [
    {
      id: 'legacy-direct',
      label: 'A 現行に近い direct generation（legacy の生成器へ平らにした素材）',
      requiresApi: true,
      async generate(c) {
        if (!client) return null;
        const material = toLegacyMaterial(c);
        const generator = createDraftGenerator(client, { model });
        const result = await generator.generate(material, pickVariation(material));
        return result.ok ? result.value : null;
      },
    },
    {
      id: 'claims-plain',
      label: 'B claim を渡す・自然化の指示は弱い',
      requiresApi: true,
      async generate(c) {
        if (!client) return null;
        const { systemInstruction, userContent } = claimsPlainPrompt(c);
        const res = await client.models.generateContent({
          model,
          contents: userContent,
          config: {
            systemInstruction,
            responseMimeType: 'application/json',
            responseSchema: { type: 'OBJECT', properties: { draft: { type: 'STRING' } }, required: ['draft'] },
            temperature: 1.0,
            maxOutputTokens: 1024,
            safetySettings: SAFETY_SETTINGS,
          },
        });
        return parseDraft(res);
      },
    },
    {
      id: 'natural-realizer',
      label: 'C Issue #439 の Natural LLM Realizer（本番の StructuredDraftPort）',
      requiresApi: true,
      async generate(c) {
        const result = (await port.prepare({
          storeName: c.storeName,
          surveyRevision: 1,
          star: c.star,
          selections: c.selections.map((s) => ({
            polarity: s.polarity,
            categoryCode: s.categoryCode,
            categoryLabel: s.categoryLabel,
            ...(s.targetId !== undefined ? { targetId: s.targetId, targetLabel: s.targetLabel! } : {}),
            facets: s.facets.map((f) => ({ code: f.code, label: f.label })),
          })),
          ...(c.comment !== undefined ? { comment: c.comment } : {}),
        })) as { kind: string; draft?: string };
        // Stage 2 の暫定実装は { kind: 'unavailable' } を返す（下書きなし）。Issue #439 で draft を返すようになる。
        return typeof result.draft === 'string' ? result.draft : null;
      },
    },
    {
      id: 'safe-fallback',
      label: 'D claim からの決定的なテンプレート（参考）',
      requiresApi: false,
      generate: (c) => Promise.resolve(safeFallback(c)),
    },
  ];
}
