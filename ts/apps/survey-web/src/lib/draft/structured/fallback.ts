import { claimSubjectKey, overlappingIdentities, type StructuredClaim } from './claims';

// structured survey の下書きの safe fallback（Issue #439）。**通常の経路ではない。** Natural LLM Realizer が 2 回とも
// hard gate を通らなかった・生成に失敗したときだけ使う。自然さより事実性を優先し、必ず返せることが目的である。
//
// claim から決定的に作る。主題（Target / カテゴリ全体の facet）ごとに、回答した facet だけを名指す。
// exact overlap（同じ identity が両極性）は identity ごとに「良かったところもあり、気になるところもありました」とだけ
// 書く（理由を作らない・Issue #418）。同じ主題でも overlap でない facet は、その極性の文へ分けて書く（片方の極性に
// しか無い facet を、両面があったように書かない）。強度・理由・意向・星から導く表現は足さない。一言は文面に混ぜない。

function identity(c: StructuredClaim): string {
  return `${claimSubjectKey(c)}:${c.kind === 'target' ? '' : c.facetCode}`;
}

function subjectLabel(c: StructuredClaim): string {
  return c.kind === 'category_facet' ? '' : c.targetLabel;
}

export function structuredFallbackDraft(claims: readonly StructuredClaim[]): string {
  const overlaps = new Set(overlappingIdentities(claims));
  const sentences: string[] = [];
  const doneGroups = new Set<string>();
  const doneOverlap = new Set<string>();

  for (const claim of claims) {
    // exact overlap は、最初に現れた位置で 1 文にする（両極性のどちらの側でも 1 回だけ）。
    if (overlaps.has(identity(claim))) {
      if (doneOverlap.has(identity(claim))) continue;
      doneOverlap.add(identity(claim));
      const subject =
        claim.kind === 'target'
          ? claim.targetLabel
          : claim.kind === 'target_facet'
            ? `${claim.targetLabel}の${claim.facetLabel}`
            : claim.facetLabel;
      sentences.push(`${subject}は、良かったところもあり、気になるところもありました。`);
      continue;
    }
    const group = `${claim.polarity}:${claimSubjectKey(claim)}`;
    if (doneGroups.has(group)) continue;
    doneGroups.add(group);
    const same = claims.filter(
      (c) => c.polarity === claim.polarity && claimSubjectKey(c) === claimSubjectKey(claim) && !overlaps.has(identity(c)),
    );
    const facets = same.flatMap((c) => (c.kind === 'target' ? [] : [c.facetLabel]));
    const verb = claim.polarity === 'positive' ? '良かったです' : '気になりました';
    const target = subjectLabel(claim);
    if (target === '') sentences.push(`${facets.join('と')}が${verb}。`);
    else sentences.push(facets.length > 0 ? `${target}は${facets.join('と')}が${verb}。` : `${target}が${verb}。`);
  }
  return sentences.join('');
}
