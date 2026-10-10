import {
  type GateFacet,
  type GateMenuTarget,
  type GateSelection,
  type Polarity,
  type StructuredGateInput,
} from '../../src/lib/draft/structured/gate';

// structured survey の下書き評価（Issue #440）の固定ケースの読み込み。判定そのもの（hard gate・coverage）は本番の
// 事後検証と同じ src/lib/draft/structured/gate.ts を使う（Issue #439 で移した。評価と本番で物差しを分けない）。
// ここはケースの形の検証と、評価の道具が使ってきた名前の再輸出だけを持つ。

export * from '../../src/lib/draft/structured/gate';
export {
  readStructuredGateLexicon as readStructuredEvalLexicon,
  type StructuredGateLexicon as StructuredEvalLexicon,
  type GateClaim as EvalClaim,
} from '../../src/lib/draft/structured/gate';

export type EvalFacet = GateFacet;
export type EvalSelection = GateSelection;
export type EvalMenuTarget = GateMenuTarget;

export interface EvalExample {
  readonly text: string;
  readonly kinds: readonly string[];
}

/** 評価の固定ケース。判定の入力（StructuredGateInput）に、星・題・参照例を足したもの。 */
export interface StructuredEvalCase extends StructuredGateInput {
  readonly id: string;
  readonly title: string;
  readonly star: 1 | 2 | 3 | 4 | 5;
  readonly commentTone?: 'formal' | 'neutral' | 'casual';
  readonly allowedParaphrases: readonly string[];
  readonly forbiddenExamples: readonly EvalExample[];
}

const POLARITIES: readonly Polarity[] = ['positive', 'concern'];
const TONES = ['formal', 'neutral', 'casual'] as const;

function fail(message: string): never {
  throw new Error(`structured eval cases: ${message}`);
}

function str(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.trim() === '') fail(`${where} は空でない文字列である必要があります`);
  return v;
}

function strList(v: unknown, where: string): string[] {
  if (!Array.isArray(v)) fail(`${where} は配列である必要があります`);
  return v.map((x, i) => str(x, `${where}[${i}]`));
}

/**
 * cases.json を読み、形を検証する。形の誤り（極性の綴り・facet の欠落・同じ id の重複・参照例の欠落）は
 * 測定の前に止める。誤ったまま流すと、存在しない claim を測って結果を読み違える。
 */
export function readStructuredCases(raw: unknown): StructuredEvalCase[] {
  const root = raw as { cases?: unknown };
  if (!Array.isArray(root.cases) || root.cases.length === 0) fail('cases が空です');
  const ids = new Set<string>();
  return root.cases.map((c: Record<string, unknown>, ci) => {
    const where = `cases[${ci}]`;
    const id = str(c.id, `${where}.id`);
    if (ids.has(id)) fail(`id ${id} が重複しています`);
    ids.add(id);
    const star = c.star;
    if (typeof star !== 'number' || !Number.isInteger(star) || star < 1 || star > 5) fail(`${id}.star は 1〜5 の整数`);
    if (!Array.isArray(c.selections) || c.selections.length === 0) fail(`${id}.selections が空です`);
    const selections = c.selections.map((s: Record<string, unknown>, si) => {
      const sw = `${id}.selections[${si}]`;
      if (!POLARITIES.includes(s.polarity as Polarity)) fail(`${sw}.polarity は positive / concern`);
      if (!Array.isArray(s.facets)) fail(`${sw}.facets は配列`);
      const hasTarget = s.targetId !== undefined;
      if (hasTarget !== (s.targetLabel !== undefined)) fail(`${sw} は targetId と targetLabel を対で持つ`);
      if (!hasTarget && s.facets.length === 0) fail(`${sw} は Target も facet も無い（開いただけは回答ではない）`);
      const selection: EvalSelection = {
        polarity: s.polarity as Polarity,
        categoryCode: str(s.categoryCode, `${sw}.categoryCode`),
        categoryLabel: str(s.categoryLabel, `${sw}.categoryLabel`),
        facets: s.facets.map((f: Record<string, unknown>, fi) => ({
          code: str(f.code, `${sw}.facets[${fi}].code`),
          label: str(f.label, `${sw}.facets[${fi}].label`),
        })),
        ...(hasTarget
          ? { targetId: str(s.targetId, `${sw}.targetId`), targetLabel: str(s.targetLabel, `${sw}.targetLabel`) }
          : {}),
      };
      return selection;
    });
    const subjectsRaw = (c.subjects ?? {}) as Record<string, unknown>;
    const subjects: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(subjectsRaw)) subjects[k] = strList(v, `${id}.subjects.${k}`);
    if (c.comment !== undefined) str(c.comment, `${id}.comment`);
    if (c.commentTone !== undefined && !(TONES as readonly unknown[]).includes(c.commentTone)) {
      fail(`${id}.commentTone は formal / neutral / casual`);
    }
    const allowed = strList(c.allowedParaphrases, `${id}.allowedParaphrases`);
    if (allowed.length === 0) fail(`${id}.allowedParaphrases に許す言い換えの例が 1 つも無い`);
    return {
      id,
      title: str(c.title, `${id}.title`),
      storeName: str(c.storeName, `${id}.storeName`),
      star: star as StructuredEvalCase['star'],
      ...(c.comment !== undefined ? { comment: c.comment as string } : {}),
      ...(c.commentTone !== undefined ? { commentTone: c.commentTone as StructuredEvalCase['commentTone'] } : {}),
      selections,
      subjects,
      menuTargets: ((c.menuTargets ?? []) as Record<string, unknown>[]).map((m, mi) => ({
        id: str(m.id, `${id}.menuTargets[${mi}].id`),
        label: str(m.label, `${id}.menuTargets[${mi}].label`),
        categoryCode: str(m.categoryCode, `${id}.menuTargets[${mi}].categoryCode`),
        aliases: strList(m.aliases ?? [], `${id}.menuTargets[${mi}].aliases`),
      })),
      commentKeywords: strList(c.commentKeywords ?? [], `${id}.commentKeywords`),
      forbiddenMeanings: ((c.forbiddenMeanings ?? []) as Record<string, unknown>[]).map((f, fi) => ({
        id: str(f.id, `${id}.forbiddenMeanings[${fi}].id`),
        pattern: new RegExp(str(f.pattern, `${id}.forbiddenMeanings[${fi}].pattern`)),
        ...(typeof f.note === 'string' ? { note: f.note } : {}),
      })),
      allowedParaphrases: allowed,
      forbiddenExamples: ((c.forbiddenExamples ?? []) as Record<string, unknown>[]).map((e, ei) => ({
        text: str(e.text, `${id}.forbiddenExamples[${ei}].text`),
        kinds: strList(e.kinds, `${id}.forbiddenExamples[${ei}].kinds`),
      })),
    };
  });
}

// ---------------------------------------------------------------------------