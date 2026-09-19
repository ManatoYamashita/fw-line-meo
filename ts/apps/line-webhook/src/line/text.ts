// LINE へ送る文言の数え方と長さの道具。
//
// 数え方（書記素・コードポイント・UTF-16 の単位）は LINE の仕様であって、レポート固有の関心ではない。
// オンボーディングの案内も、レポートも、帰属表示も同じ数え方で上限に収める必要があるため、
// LINE 面の基本部品として line/ に置く（report/format.ts は自分の利用者のためにそのまま再公開する）。
//
// DB にも LINE にも触れない純関数のみ。記録（ログ）も出さない。

/** 省略したことを示す記号。 */
export const ELLIPSIS = '…';

// 書記素（利用者が 1 文字と見る単位）に分ける。絵文字の連結・国旗・結合文字を 1 つとして扱う。
const graphemeSegmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });

/** コードポイントの数。UTF-16 の単位では数えない（BMP の外の漢字や絵文字を 2 と数えてしまう）。 */
export function codePointLength(text: string): number {
  return [...text].length;
}

/** UTF-16 の単位の数。LINE は altText などの長さをこの単位で数える（references/message-objects.md）。 */
export function utf16Length(text: string): number {
  return text.length;
}

/** 書記素の列に分ける。 */
export function splitGraphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment);
}

/**
 * text を max 以内に収める。収まればそのまま返し、収まらなければ先頭から書記素の境目で切って「…」を付ける
 * （「…」を含めて max 以内）。
 *
 * 数え方は measure で渡し、既定はコードポイントの数である。LINE はラベルと displayText を書記素で数え
 * （references/message-objects.md の Text Character Counting）、書記素の数はどの版の分け方で数えても
 * コードポイントの数を超えないので、コードポイントで収めれば LINE の数え方の細部によらず上限を超えない。
 * どちらの数え方も、つないだ文字列の長さは部分の長さの和になるので、書記素ごとに足し上げてよい。
 *
 * 絵文字の連結や結合文字を途中で割ると別の文字に見えるので、残りの枠に入り切らない書記素は丸ごと落とす。
 */
export function fitText(text: string, max: number, measure: (text: string) => number = codePointLength): string {
  const ellipsisLength = measure(ELLIPSIS);
  if (!Number.isInteger(max) || max < ellipsisLength) {
    throw new Error(`fitText: max must be an integer of at least ${ellipsisLength}`);
  }
  if (measure(text) <= max) {
    return text;
  }

  const budget = max - ellipsisLength;
  let kept = '';
  let used = 0;
  for (const segment of splitGraphemes(text)) {
    const size = measure(segment);
    if (used + size > budget) {
      break;
    }
    kept += segment;
    used += size;
  }
  return `${kept}${ELLIPSIS}`;
}

/** altText の上限（UTF-16 の単位。references/flex-message.md の Limits）。 */
export const ALT_TEXT_MAX_LENGTH = 400;
