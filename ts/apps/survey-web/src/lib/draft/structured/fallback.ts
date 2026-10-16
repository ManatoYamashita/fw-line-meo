import { claimSubjectKey, overlappingIdentities, type StructuredClaim } from './claims';

// structured survey の下書きの safe fallback（Issue #439）。**通常の経路ではない。** 通常生成が factuality の hard gate を
// 2 回とも通らなかった・生成に失敗した（かつ 1 回目も使えない）ときだけ使う。自然さより事実性を優先し、必ず返せることが
// 目的である。通常生成との違いが分かる定型のままにし、高度な生成器にはしない。
//
// claim から決定的に作る。主題（Target / カテゴリ全体の facet）ごとに、回答した facet だけを名指す。
// exact overlap（同じ identity が両極性）は identity ごとに「〜については、良かった点と気になる点の両方がありました」と
// だけ書く（理由を作らない・Issue #418）。同じ主題でも overlap でない facet は、その極性の文へ分けて書く。
// 強度・理由・意向・星から導く表現は足さない。一言は文面に混ぜない。
//
// 日本語として最低限自然にするための決まった言い方（意味を広げない範囲・2026-10-11）:
//   - 料理・ドリンクのカテゴリ全体の facet は「料理の量」のようにカテゴリ名を添える（「量が良かったです」にしない）
//   - positive の量は「〜に満足できました」、positive の入店までの待ち時間は「入店まではスムーズでした」
//     （「入店までの待ち時間が良かったです」にしない）
//   - 同じカテゴリの全体の facet と Target の同じ facet が同じ極性（positive）にあるときは 1 文にまとめる
//     （「料理全体の量に満足でき、焼き鳥5種盛りの量も良かったです。」）

/** カテゴリ名を添えるカテゴリ（Target を持てるカテゴリ・facet の表示名が「味」「量」のように短い）。 */
const LABELLED_CATEGORIES: ReadonlySet<string> = new Set(['food', 'drink']);

function identity(c: StructuredClaim): string {
  return `${claimSubjectKey(c)}:${c.kind === 'target' ? '' : c.facetCode}`;
}

function categoryFacetSubject(c: StructuredClaim & { kind: 'category_facet' }): string {
  return LABELLED_CATEGORIES.has(c.categoryCode) ? `${c.categoryLabel}の${c.facetLabel}` : c.facetLabel;
}

function categoryFacetSentence(c: StructuredClaim & { kind: 'category_facet' }): string {
  if (c.polarity === 'concern') return `${categoryFacetSubject(c)}が気になりました。`;
  if (c.facetCode === 'entry_wait') return '入店まではスムーズでした。';
  if (c.facetCode === 'volume') return `${categoryFacetSubject(c)}に満足できました。`;
  return `${categoryFacetSubject(c)}が良かったです。`;
}

export function structuredFallbackDraft(claims: readonly StructuredClaim[]): string {
  const overlaps = new Set(overlappingIdentities(claims));
  const sentences: string[] = [];
  const doneGroups = new Set<string>();
  const doneOverlap = new Set<string>();
  // カテゴリ全体の facet（positive）→ 同じカテゴリ・同じ facet・positive の Target の facet（overlap でないもの）。
  // 並びに依らず、まとめた Target の facet は Target の文から先に除く（同じ claim を 2 回書かない）。
  const partnersOf = new Map<StructuredClaim, (StructuredClaim & { kind: 'target_facet' })[]>();
  for (const claim of claims) {
    if (claim.kind !== 'category_facet' || claim.polarity !== 'positive' || !LABELLED_CATEGORIES.has(claim.categoryCode)) continue;
    if (overlaps.has(identity(claim))) continue;
    const partners = claims.filter(
      (c): c is StructuredClaim & { kind: 'target_facet' } =>
        c.kind === 'target_facet' &&
        c.polarity === 'positive' &&
        c.categoryCode === claim.categoryCode &&
        c.facetCode === claim.facetCode &&
        !overlaps.has(identity(c)),
    );
    if (partners.length > 0) partnersOf.set(claim, partners);
  }
  const merged = new Set<StructuredClaim>([...partnersOf.values()].flat());

  for (const claim of claims) {
    if (merged.has(claim)) continue;
    // exact overlap は、最初に現れた位置で 1 文にする（両極性のどちらの側でも 1 回だけ）。
    if (overlaps.has(identity(claim))) {
      if (doneOverlap.has(identity(claim))) continue;
      doneOverlap.add(identity(claim));
      const subject =
        claim.kind === 'target'
          ? claim.targetLabel
          : claim.kind === 'target_facet'
            ? `${claim.targetLabel}の${claim.facetLabel}`
            : categoryFacetSubject(claim);
      sentences.push(`${subject}については、良かった点と気になる点の両方がありました。`);
      continue;
    }
    if (claim.kind === 'category_facet') {
      // 同じカテゴリ・同じ facet・positive の Target の facet があれば 1 文にまとめる。
      const partners = partnersOf.get(claim) ?? [];
      if (partners.length > 0) {
        const targets = [...new Set(partners.map((p) => p.targetLabel))].join('と');
        const whole = `${claim.categoryLabel}全体の${claim.facetLabel}`;
        sentences.push(
          claim.facetCode === 'volume'
            ? `${whole}に満足でき、${targets}の${claim.facetLabel}も良かったです。`
            : `${whole}が良く、${targets}の${claim.facetLabel}も良かったです。`,
        );
      } else {
        sentences.push(categoryFacetSentence(claim));
      }
      continue;
    }
    const group = `${claim.polarity}:${claimSubjectKey(claim)}`;
    if (doneGroups.has(group)) continue;
    const same = claims.filter(
      (c) =>
        c.polarity === claim.polarity &&
        claimSubjectKey(c) === claimSubjectKey(claim) &&
        !overlaps.has(identity(c)) &&
        !merged.has(c),
    );
    if (same.length === 0) continue;
    doneGroups.add(group);
    const facets = same.flatMap((c) => (c.kind === 'target' ? [] : [c.facetLabel]));
    const verb = claim.polarity === 'positive' ? '良かったです' : '気になりました';
    sentences.push(facets.length > 0 ? `${claim.targetLabel}は${facets.join('と')}が${verb}。` : `${claim.targetLabel}が${verb}。`);
  }
  return sentences.join('');
}
