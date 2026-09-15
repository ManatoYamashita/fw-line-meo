// 競合店名の検索語の正規化と、競合一覧の絞り込み（store-detail-trend-dashboard task 2.3・Issue #265）。
//
// 検索語と店名は、同じ正規化を通してから比べる（要件 4.4）。正規化は次の順に行う。
// 1. NFKC 正規化: 半角カナを全角にし（半角の濁点・半濁点は前の仮名と結合する）、全角の英数字・記号・
//    空白を半角にする。
// 2. 小文字化: 英字の大文字と小文字を区別しない。ロケールに依らない toLowerCase を使う。
// 3. カタカナ（U+30A1〜U+30F6）をひらがなへ畳み込む: コード位置を 0x60 だけ下げる。半角カナは 1 で全角に
//    なっているので、この順でなければ畳み込まれない。長音記号（U+30FC）と中黒（U+30FB）は範囲の外にあり、
//    ひらがなの文でも同じ文字を使うので変えない。
// 4. 前後の空白を除く: 全角の空白は 1 で半角になっている。内側の空白は除かない。
//
// 照合は、正規化した店名が正規化した検索語を含むかどうか（文字列の包含）で判定する。検索語から正規表現を
// 組み立てないので、括弧・点・星印などの記号はその文字としてだけ一致し、例外も起きない。
//
// 一覧は、渡された並び（rank 順）の部分列として返し、要素は渡された競合そのもの（店名も正規化する前の
// 表記のまま）である。正規化した検索語が空なら全件を返す（要件 4.5）。総数は常に渡された全件の数で、
// 評価の無い店も数える（要件 4.6）。絞り込みは店名だけを見て、評価の有無を見ない。
//
// このモジュールはクライアントに同梱される（ts/eslint.config.js の store-detail のブロック）。依存を持たず、
// React・DOM・`@fwlm/db` の値に依存しない。

/** 検索欄を出す、当日の競合の数の下限（要件 4.1・4.2）。 */
export const SEARCH_MIN_COMPETITORS = 2;

/** カタカナの畳み込みの範囲の先頭（U+30A1、小書きのア）。 */
const KATAKANA_FIRST = 0x30a1;
/** カタカナの畳み込みの範囲の末尾（U+30F6、小書きのケ）。 */
const KATAKANA_LAST = 0x30f6;
/** カタカナと、対応するひらがなのコード位置の差。 */
const KATAKANA_TO_HIRAGANA = 0x60;

/** U+30A1〜U+30F6 のカタカナを、対応するひらがなへ置き換える。範囲の外の文字は変えない。 */
function foldKatakanaToHiragana(text: string): string {
  let folded = '';
  for (const char of text) {
    // 範囲は基本多言語面の中にあるので、先頭のコード単位だけで判定できる（サロゲートは範囲に入らない）。
    const code = char.charCodeAt(0);
    const isKatakana = code >= KATAKANA_FIRST && code <= KATAKANA_LAST;
    folded += isKatakana ? String.fromCharCode(code - KATAKANA_TO_HIRAGANA) : char;
  }
  return folded;
}

/** NFKC 正規化 → 小文字化 → カタカナ（U+30A1〜U+30F6）をひらがなへ → 前後の空白を除く。 */
export function normalizeForSearch(text: string): string {
  return foldKatakanaToHiragana(text.normalize('NFKC').toLowerCase()).trim();
}

export interface CompetitorFilterResult<T> {
  /** 店名が検索語を含む競合。渡された並びを保つ部分列で、要素は渡された値そのものである。 */
  readonly visible: readonly T[];
  /** 渡された競合の全件の数。評価の無い店も数え、絞り込みの結果に依らない。 */
  readonly total: number;
}

/**
 * 店名に検索語を含む競合だけを、渡された並びのまま残す（要件 4.3〜4.6）。
 *
 * 正規化した検索語が空（空文字か空白だけ）なら、全件を渡された並びのまま返す。
 */
export function filterCompetitors<T extends { readonly name: string }>(
  competitors: readonly T[],
  rawQuery: string,
): CompetitorFilterResult<T> {
  const query = normalizeForSearch(rawQuery);
  if (query === '') {
    return { visible: competitors, total: competitors.length };
  }
  const visible = competitors.filter((competitor) => normalizeForSearch(competitor.name).includes(query));
  return { visible, total: competitors.length };
}
