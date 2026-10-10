import type { StructuredSurveyDefinition, SurveyCategoryDefinition } from '@fwlm/db';
import type { Polarity, SelectionGroup } from './structured-answer';

// structured survey の客の選択（evidence）の状態と、送信する形への変換（Issue #438）。
//
// **ここは回答の意味だけを持つ。** どのカテゴリ・Target を開いているか（画面の展開状態）は持たない。画面は
// 展開状態を別に持ち、開いただけでは何もここへ書かない（「料理を開いた」≠「料理について回答した」）。
//
// 意味（Issue #435・Issue #436 の契約）:
//   categoryFacets に facet がある       → { categoryCode, facetCodes }（カテゴリ全体 → facet）
//   targets に Target がある（facet 0 可）→ { categoryCode, targetId, facetCodes }（Target → facet）
//   何も無いカテゴリ                     → グループを作らない（開いて閉じただけ・選択を外した）
// カテゴリ全体の facet と Target の facet は別の evidence で、互いへ読み替えない。
// 良かったところと気になったところは同じ定義・同じ関数で扱い、同じ選択が両方に在ってよい。
//
// このモジュールはクライアントに同梱される。@fwlm/db・structured-answer からは型だけを取り込む。

/** 1 つのカテゴリの選択。Target は「選んだ」こと自体が evidence なので、facet が空でも Map に残す。 */
export interface CategoryEvidence {
  readonly categoryFacets: ReadonlySet<string>;
  /** 選んだ Target の UUID → その Target について選んだ facet。 */
  readonly targets: ReadonlyMap<string, ReadonlySet<string>>;
}

/** 1 つの極性（良かったところ / 気になったところ）の選択。キーはカテゴリの code。 */
export type PolarityEvidence = ReadonlyMap<string, CategoryEvidence>;

export type EvidenceState = Readonly<Record<Polarity, PolarityEvidence>>;

export const EMPTY_EVIDENCE: EvidenceState = { positive: new Map(), concern: new Map() };

const EMPTY_CATEGORY: CategoryEvidence = { categoryFacets: new Set(), targets: new Map() };

function toggleIn(set: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/** 空になったカテゴリは消す（何も選んでいないカテゴリを状態に残さない）。 */
function withCategory(
  state: EvidenceState,
  polarity: Polarity,
  categoryCode: string,
  update: (current: CategoryEvidence) => CategoryEvidence,
): EvidenceState {
  const polarityMap = new Map(state[polarity]);
  const next = update(polarityMap.get(categoryCode) ?? EMPTY_CATEGORY);
  if (next.categoryFacets.size === 0 && next.targets.size === 0) polarityMap.delete(categoryCode);
  else polarityMap.set(categoryCode, next);
  return { ...state, [polarity]: polarityMap };
}

/** カテゴリ全体の facet を選ぶ / 外す。 */
export function toggleCategoryFacet(
  state: EvidenceState,
  polarity: Polarity,
  categoryCode: string,
  facetCode: string,
): EvidenceState {
  return withCategory(state, polarity, categoryCode, (c) => ({
    ...c,
    categoryFacets: toggleIn(c.categoryFacets, facetCode),
  }));
}

/** Target を選ぶ / 外す。外すと、その Target について選んだ facet も一緒に外れる。 */
export function toggleTarget(
  state: EvidenceState,
  polarity: Polarity,
  categoryCode: string,
  targetId: string,
): EvidenceState {
  return withCategory(state, polarity, categoryCode, (c) => {
    const targets = new Map(c.targets);
    if (targets.has(targetId)) targets.delete(targetId);
    else targets.set(targetId, new Set());
    return { ...c, targets };
  });
}

/** 選んだ Target について facet を選ぶ / 外す。選んでいない Target の facet は選べない（先に Target を選ぶ）。 */
export function toggleTargetFacet(
  state: EvidenceState,
  polarity: Polarity,
  categoryCode: string,
  targetId: string,
  facetCode: string,
): EvidenceState {
  const current = state[polarity].get(categoryCode)?.targets.get(targetId);
  if (current === undefined) return state;
  return withCategory(state, polarity, categoryCode, (c) => {
    const targets = new Map(c.targets);
    targets.set(targetId, toggleIn(current, facetCode));
    return { ...c, targets };
  });
}

export function categoryEvidence(state: EvidenceState, polarity: Polarity, categoryCode: string): CategoryEvidence {
  return state[polarity].get(categoryCode) ?? EMPTY_CATEGORY;
}

export function hasEvidence(evidence: CategoryEvidence): boolean {
  return evidence.categoryFacets.size > 0 || evidence.targets.size > 0;
}

/**
 * 送信する選択（SelectionGroup[]）へ変換する。並びは定義の順（カテゴリ → カテゴリ全体 → Target の順、facet も
 * 定義の順）で、定義に無いもの（非表示にしたカテゴリ・Target など）は送らない。空のグループは作らない。
 * Target は UUID で送る（名前では送らない）。
 */
export function toSelectionGroups(
  evidence: PolarityEvidence,
  definition: StructuredSurveyDefinition,
): SelectionGroup[] {
  const groups: SelectionGroup[] = [];
  for (const category of definition.categories) {
    const selected = evidence.get(category.code);
    if (!selected) continue;
    const categoryFacets = category.categoryFacets.map((f) => f.code).filter((c) => selected.categoryFacets.has(c));
    if (categoryFacets.length > 0) groups.push({ categoryCode: category.code, facetCodes: categoryFacets });
    for (const target of category.targets) {
      const facets = selected.targets.get(target.id);
      if (facets === undefined) continue;
      groups.push({
        categoryCode: category.code,
        targetId: target.id,
        facetCodes: category.targetFacets.map((f) => f.code).filter((c) => facets.has(c)),
      });
    }
  }
  return groups;
}

/** 折り畳んだカテゴリに出す、選んだ内容の要約（定義の順・表示名）。 */
export interface CategorySummary {
  /** カテゴリ全体の facet の表示名。無ければ空。 */
  readonly categoryFacets: readonly string[];
  /** 選んだ Target ごとの表示名と、その Target について選んだ facet の表示名（facet 0 件のこともある）。 */
  readonly targets: readonly { readonly id: string; readonly label: string; readonly facets: readonly string[] }[];
}

export function summarizeCategory(evidence: CategoryEvidence, category: SurveyCategoryDefinition): CategorySummary {
  return {
    categoryFacets: category.categoryFacets.filter((f) => evidence.categoryFacets.has(f.code)).map((f) => f.label),
    targets: category.targets
      .filter((t) => evidence.targets.has(t.id))
      .map((t) => {
        const facets = evidence.targets.get(t.id)!;
        return {
          id: t.id,
          label: t.label,
          facets: category.targetFacets.filter((f) => facets.has(f.code)).map((f) => f.label),
        };
      }),
  };
}

/**
 * 要約を 1 行の文字列にする（例: 「料理全体：味・量／刺身盛り合わせ：味・見た目／焼き鳥5種盛り」）。
 * カテゴリ全体の facet と Target は区切って書き、互いへ混ぜない。Target を持てるカテゴリ（定義の allowsTargets）
 * では、カテゴリ全体の facet であることを「〇〇全体：」で示す。カテゴリ名は定義の表示名を使う（taxonomy が SoT）。
 */
export function summaryText(summary: CategorySummary, category: SurveyCategoryDefinition): string {
  const parts: string[] = [];
  if (summary.categoryFacets.length > 0) {
    const whole = category.allowsTargets ? `${category.label}全体：` : '';
    parts.push(`${whole}${summary.categoryFacets.join('・')}`);
  }
  for (const t of summary.targets) parts.push(t.facets.length > 0 ? `${t.label}：${t.facets.join('・')}` : t.label);
  return parts.join('／');
}
