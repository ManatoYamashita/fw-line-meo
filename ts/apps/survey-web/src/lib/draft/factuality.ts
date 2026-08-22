// 指定した評価軸への言及を検出する純関数（Issue #132）。
//
// Requirement 3.2「素材に含まれない体験・事実・固有名詞を下書きに含めない」に対する違反のうち、
// **客が選ばなかった評価軸について書いた** ケースだけを機械判定する。客の選択という明確な
// 境界があるため争いが起きない、という理由でこの範囲に限定している。
//
// 引数は「調べる軸」であって「選択済みの軸」ではない。呼び出し側が **プロンプトで禁止したのと
// 同じ値**（DraftMaterial.unselectedAspectCodes）をそのまま渡すことで、「禁止した軸」と
// 「検証する軸」が同一の情報源から来ることが保証される。ここを別々に導出すると、片方だけ
// 更新されて検証が実態からずれる余地が生まれる。
//
// この関数は実 API を呼ばない。生成器（generator.ts）と評価（eval/）の両方から使う。
// 検出器自身の正しさは test/factuality-detect.test.ts が検証する（実 API 不要・CI で常時実行）。
// 抽出器に自己検証が無いと「取りこぼしても緑」になるため、この対はどちらも欠かせない。

export interface AspectLexicon {
  readonly [aspectCode: string]: readonly string[];
}

export interface Violation {
  /** 言及が検出された評価軸の code */
  readonly aspectCode: string;
  /** 実際に本文へ現れた語（証拠として残す） */
  readonly matchedTerm: string;
}

/**
 * 下書き本文から、指定した評価軸への言及を検出する。
 *
 * @param draft 生成された下書き本文
 * @param targetAspectCodes 調べる評価軸の code（＝客が選ばなかった観点）
 * @param lexicon 評価軸ごとの検出語彙
 * @returns 検出した言及の一覧（同一軸で複数語が当たっても軸ごとに 1 件へ畳む）
 */
export function detectAspectMentions(
  draft: string,
  targetAspectCodes: readonly string[],
  lexicon: AspectLexicon,
): Violation[] {
  const violations: Violation[] = [];

  for (const aspectCode of targetAspectCodes) {
    const terms = lexicon[aspectCode];
    // 語彙を持たない軸は判定できない。ここで黙って通すのは「検証していない」と同義だが、
    // 例外を投げると客に下書きが出なくなる（実害の方が大きい）。代わりに
    // test/factuality-detect.test.ts が「lexicon が全ての評価軸を漏れなく持つ」ことを
    // seed と照合して強制しており、未知の軸が実行時に来る経路を CI で塞いでいる。
    if (terms === undefined) continue;

    // 軸ごとに最初に当たった語だけを証拠として記録する（件数は「言及された軸の数」で数える）。
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
