import type { SelectionGroup, StructuredSurveyAnswer } from './structured-answer';

// structured survey の「回答材料」の数え方（Issue #443 のレビュー対応）。
//
// 口コミ文を作るのに要る材料の下限と数え方の **唯一の定義** である。客の画面（lib/structured-selection.ts の
// countMaterials・押しボタンの可否と案内）と /api/responses（下限に満たない回答を VALIDATION で拒否）が、
// どちらもここを呼ぶ。片方だけに数え方を書くと、画面では作れないのに API では作れる（またはその逆の）回答が生まれる。
//
// このモジュールはクライアントに同梱される。structured-answer からは型だけを取り込む。

/** 口コミ文を作るのに要る、独立した回答材料の数（良かったところと気になったところの合計）。 */
export const MIN_MATERIALS = 2;

/**
 * 送信する形の選択（SelectionGroup[]）から、独立した回答材料の数を数える。
 *
 *   カテゴリ全体の facet          → facet 1 つにつき 1 件（料理全体：味・量 = 2 件）
 *   Target → facet               → facet 1 つにつき 1 件（刺身盛り合わせ：味・温度 = 2 件）
 *   Target だけ（facet 0 件）     → 1 件（Target を選んだこと自体が evidence）
 *
 * Target とその facet を別々に数えない（刺身盛り合わせ + 刺身盛り合わせ：味 は 1 件）。同じ意味の操作を二重に
 * 数えると、実質 1 つの回答で下限を満たしてしまう。カテゴリを開いただけ・星・一言は evidence ではないので数えない
 * （開いただけのカテゴリは SelectionGroup にならない）。
 */
export function countSelectionGroupMaterials(groups: readonly SelectionGroup[]): number {
  let count = 0;
  for (const group of groups) {
    count += group.targetId === undefined ? group.facetCodes.length : Math.max(1, group.facetCodes.length);
  }
  return count;
}

/** 回答全体（良かったところ＋気になったところ）の材料の数。極性ごとの下限は持たない。 */
export function countStructuredAnswerMaterials(
  answer: Pick<StructuredSurveyAnswer, 'positiveSelections' | 'concernSelections'>,
): number {
  return countSelectionGroupMaterials(answer.positiveSelections) + countSelectionGroupMaterials(answer.concernSelections);
}

export function hasEnoughMaterials(count: number): boolean {
  return count >= MIN_MATERIALS;
}
