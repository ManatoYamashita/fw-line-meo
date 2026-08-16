// 未選択の評価軸への言及を検出する純関数（Issue #132）。
//
// Requirement 3.2「素材に含まれない体験・事実・固有名詞を下書きに含めない」に対する
// 違反のうち、**客が選ばなかった評価軸について書いた** ケースだけを機械判定する。
// 客の選択という明確な境界があるため争いが起きない、という理由でこの範囲に限定している。
//
// この関数は実 API を呼ばない。呼ぶ側（factuality.eval.test.ts）が生成結果を渡す。
// 検出器自身の正しさは test/factuality-detect.test.ts が検証する（実 API 不要・CI で常時実行）。
// 抽出器に自己検証が無いと「取りこぼしても緑」になるため、この対はどちらも欠かせない。

export interface AspectLexicon {
  readonly [aspectCode: string]: readonly string[];
}

export interface Violation {
  /** 客が選ばなかったのに言及された評価軸の code */
  readonly aspectCode: string;
  /** 実際に本文へ現れた語（証拠として残す） */
  readonly matchedTerm: string;
}

/**
 * 下書き本文から「客が選ばなかった評価軸への言及」を検出する。
 *
 * @param draft 生成された下書き本文
 * @param selectedAspectCodes 客が選んだ評価軸の code（この軸への言及は逸脱ではない）
 * @param lexicon 評価軸ごとの検出語彙
 * @returns 検出した逸脱の一覧（同一軸で複数語が当たっても軸ごとに 1 件へ畳む）
 */
export function detectUnselectedAspectMentions(
  draft: string,
  selectedAspectCodes: readonly string[],
  lexicon: AspectLexicon,
): Violation[] {
  const selected = new Set(selectedAspectCodes);
  const violations: Violation[] = [];

  for (const [aspectCode, terms] of Object.entries(lexicon)) {
    // 客が選んだ軸について書くのは素材の範囲内なので対象外。
    if (selected.has(aspectCode)) continue;

    // 軸ごとに最初に当たった語だけを証拠として記録する（件数は「逸脱した軸の数」で数える）。
    const matched = terms.find((term) => draft.includes(term));
    if (matched !== undefined) {
      violations.push({ aspectCode, matchedTerm: matched });
    }
  }

  return violations;
}

/** lexicon の JSON（`{"_comment": ..., "terms": {...}}`）から terms だけを取り出す。 */
export function readLexicon(raw: unknown): AspectLexicon {
  if (typeof raw !== 'object' || raw === null || !('terms' in raw)) {
    throw new Error('lexicon の形式が不正です（terms が存在しません）');
  }
  const terms = (raw as { terms: unknown }).terms;
  if (typeof terms !== 'object' || terms === null) {
    throw new Error('lexicon の terms が object ではありません');
  }
  for (const [code, list] of Object.entries(terms as Record<string, unknown>)) {
    if (!Array.isArray(list) || !list.every((t) => typeof t === 'string' && t.length >= 2)) {
      throw new Error(
        `lexicon.terms.${code} は 2 文字以上の文字列配列である必要があります（1 文字の語は部分一致で誤検出する）`,
      );
    }
  }
  return terms as AspectLexicon;
}
