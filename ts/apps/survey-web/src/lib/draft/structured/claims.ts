import type { Polarity } from '../../structured-answer';

/** claim の元になる選択（回答受付の ResolvedSelection と、評価の固定ケースの selections の共通の形）。 */
export interface ClaimSelection {
  readonly polarity: Polarity;
  readonly categoryCode: string;
  readonly categoryLabel: string;
  readonly targetId?: string;
  readonly targetLabel?: string;
  readonly facets: readonly { readonly code: string; readonly label: string }[];
}

// structured survey の回答から「言ってよい意味」を決定的に作る（Issue #439）。
//
// 流れは StructuredSurveyAnswer → resolveStructuredAnswer（回答時点の表示名の snapshot）→ **compileStructuredClaims**
// → Natural LLM Realizer の順で、LLM に structured answer を直接解釈させない。claim が事実の芯で、LLM が任されるのは
// その意味を保った言い換え・統合・接続・語順だけである。
//
// 意味（Issue #435・Issue #439）:
//   target          … Target 自体について polarity（「刺身盛り合わせについて良かった」まで。味・量・鮮度を補わない）
//   target_facet    … Target の facet について polarity（「刺身盛り合わせの味が良かった」まで）
//   category_facet  … カテゴリ全体の facet について polarity（「居心地が良かった」）
// 同じ identity が良かったところと気になったところの両方にあってよい（exact overlap）。並びは素材の順
// （回答受付の検証が定義の順へ正規化している）で、同じ入力からは同じ並びになる。

interface ClaimBase {
  readonly polarity: Polarity;
  readonly categoryCode: string;
  readonly categoryLabel: string;
}

export type StructuredClaim =
  | (ClaimBase & { readonly kind: 'category_facet'; readonly facetCode: string; readonly facetLabel: string })
  | (ClaimBase & { readonly kind: 'target'; readonly targetId: string; readonly targetLabel: string })
  | (ClaimBase & {
      readonly kind: 'target_facet';
      readonly targetId: string;
      readonly targetLabel: string;
      readonly facetCode: string;
      readonly facetLabel: string;
    });

/** 素材の選択から claim を作る（純関数）。Target も facet も無い選択（開いただけ）は claim を作らない。 */
export function compileStructuredClaims(selections: readonly ClaimSelection[]): StructuredClaim[] {
  const claims: StructuredClaim[] = [];
  for (const s of selections) {
    const base: ClaimBase = { polarity: s.polarity, categoryCode: s.categoryCode, categoryLabel: s.categoryLabel };
    if (s.targetId !== undefined && s.targetLabel !== undefined) {
      if (s.facets.length === 0) {
        claims.push({ ...base, kind: 'target', targetId: s.targetId, targetLabel: s.targetLabel });
      }
      for (const f of s.facets) {
        claims.push({
          ...base,
          kind: 'target_facet',
          targetId: s.targetId,
          targetLabel: s.targetLabel,
          facetCode: f.code,
          facetLabel: f.label,
        });
      }
      continue;
    }
    for (const f of s.facets) claims.push({ ...base, kind: 'category_facet', facetCode: f.code, facetLabel: f.label });
  }
  return claims;
}

/** claim の主題（Target、またはカテゴリ全体の facet）。同じ主題の claim はまとめて書いてよい。 */
export function claimSubjectKey(claim: StructuredClaim): string {
  return claim.kind === 'category_facet' ? `${claim.categoryCode}:${claim.facetCode}` : claim.targetId;
}

/** 同じ identity（主題と facet）が両極性にある組の key（exact overlap）。 */
export function overlappingIdentities(claims: readonly StructuredClaim[]): string[] {
  const identity = (c: StructuredClaim) => `${claimSubjectKey(c)}:${c.kind === 'target' ? '' : c.facetCode}`;
  const positive = new Set(claims.filter((c) => c.polarity === 'positive').map(identity));
  return [...new Set(claims.filter((c) => c.polarity === 'concern').map(identity))].filter((k) => positive.has(k));
}
