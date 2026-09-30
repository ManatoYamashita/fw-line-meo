// 下書きが「客が選ばなかったこと」を「無かった」と断定していないかを検出する純関数（Issue #414）。
//
// アンケートの観点は選ばせるだけで、選ばなかったことは無かったことではない。プロンプトは
// 「素材で「なし」となっている項目を「無かった」「特になかった」と書かない」と指示しているが、
// Issue #339 の本番確認で「その他の要素についての特筆すべき事項は特にない」が生成された。
// それまで eval が数えていたのは「良かった点は特にありません」の形（旧 ABSENCE_ASSERTION）だけで、
// この形は 0 件と出ていた。
//
// 形式と意味論は visit-context と同じである（分類ごとの正規表現と、一言に同じ分類の事情があれば数えない除外）。
// 検出ロジックは visit-context のものをそのまま使い、ここでは語彙と分類名の約束だけを持つ。
//
// この関数は実 API を呼ばない。評価（eval/）と、本番の事後検証（generator.ts・Issue #413）の両方から使う。
// 本番では、断定を検出したら 1 回だけ作り直す。検出器自身の正しさは
// test/absence-detect.test.ts が検証する（実 API 不要・CI で常時実行）。

import {
  detectVisitContextClaims,
  readVisitContextLexicon,
  type VisitContextClaim,
  type VisitContextLexicon,
} from './visit-context';

export type AbsenceLexicon = VisitContextLexicon;
export type AbsenceClaim = VisitContextClaim;

/** 分類。eval のレポートはこの順で出す。 */
export const ABSENCE_CATEGORIES = ['goodPoints', 'concerns', 'others'] as const;

/**
 * 下書き本文から、選ばなかったことを「無かった」と断定した箇所を検出する。
 *
 * @param draft 生成された下書き本文
 * @param comment 客の一言（未入力なら undefined）。ここに同じ分類の事情があれば、その分類は素材由来として数えない
 * @param lexicon 読み込み済みの語彙
 * @returns 検出した断定の一覧（同じ分類で複数当たっても分類ごとに 1 件へ畳む）
 */
export function detectAbsenceAssertions(
  draft: string,
  comment: string | undefined,
  lexicon: AbsenceLexicon,
): AbsenceClaim[] {
  return detectVisitContextClaims(draft, comment, lexicon);
}

/** 語彙の JSON を読み込む。分類は ABSENCE_CATEGORIES と過不足なく一致させる（片方にしか無い分類は黙って数えられない）。 */
export function readAbsenceLexicon(raw: unknown): AbsenceLexicon {
  const lexicon = readVisitContextLexicon(raw, 'absence lexicon');
  const actual = Object.keys(lexicon.patterns).sort().join(',');
  const expected = [...ABSENCE_CATEGORIES].sort().join(',');
  if (actual !== expected) {
    throw new Error(`absence lexicon の分類は ${expected} である必要があります（実際: ${actual}）`);
  }
  return lexicon;
}
