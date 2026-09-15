// 店舗の解決・選択肢の頁・ラベルの省略（design.md「StoreSelection」・Requirements 3.1, 3.2, 3.3, 3.6, 3.9, 3.10）。
//
// 入力の店舗の集合は、署名検証済みの LINE ユーザーから導いたオーナー本人の確定店舗
// （@fwlm/db の listReportableStores の戻り値）である。postback が運ぶ店舗 ID は、この集合の内側で
// 店舗を絞り込むためだけに使う。DB にも LINE にも触れない純関数なので、postback の値は SQL に届かない。
//
// 不変条件:
// - resolved の店舗は必ず入力の配列の要素そのものである（IDOR の構造的排除。store-detail の
//   selectAuthorizedStore と同じ考え方）。呼出元は以後の読み出しに、要求の店舗 ID ではなく
//   この要素の id を使う
// - 集合外の店舗 ID には、その ID が他所に実在するかどうか・uuid の形をしているかどうかに関わらず、
//   同じ invalid_choice を返す（非オラクル）。応答は店舗の集合と頁だけから決まり、指定された ID を含まない
// - 範囲外の頁（負の数・小数・頁の数以上）は 0 頁目として扱う
//
// 選択肢の組立（ラベル・displayText・「ほかの店舗」の postback）は StoreChoiceBuilder の責務である。

import type { ReportableStore } from '@fwlm/db';
import type { ReportRequest } from '@fwlm/line-report';

/** 1 頁に並べる店舗の数。クイックリプライ 13 件のうち 1 件を「ほかの店舗」に使う。 */
export const STORE_CHOICE_PAGE_SIZE = 12;

/** 選択肢のラベルの上限の文字数。クイックリプライのラベルの上限（references/action-objects.md）。 */
export const STORE_LABEL_MAX_LENGTH = 20;

export interface StoreChoicePage {
  /** この頁に並べる店舗。入力の配列の要素そのもので、入力の順を保つ。 */
  readonly stores: readonly ReportableStore[];
  readonly pageIndex: number;
  /** 次の頁の番号。この頁が最後の頁なら null（「ほかの店舗」を出さない）。 */
  readonly nextPageIndex: number | null;
}

export type StoreResolution =
  | { readonly kind: 'resolved'; readonly store: ReportableStore }
  | { readonly kind: 'choose'; readonly page: StoreChoicePage; readonly reason: 'multiple' | 'invalid_choice' }
  | { readonly kind: 'none' };

/**
 * レポートの対象店舗を、認可済みの店舗の集合の内側で決める。
 *
 * - 店舗が 1 つも無ければ none（店舗の指定と頁によらない）
 * - 店舗の指定が集合の要素の id と一致すれば、その要素に決まる（店舗の数によらない）
 * - 店舗の指定が集合外なら、要求の頁の選択肢を invalid_choice として再提示する（店舗が 1 店でも同じ）
 * - 店舗の指定が無く、店舗が 1 店ならその店舗に決まり、複数なら要求の頁の選択肢を multiple として出す
 */
export function resolveTargetStore(stores: readonly ReportableStore[], request: ReportRequest): StoreResolution {
  if (stores.length === 0) {
    return { kind: 'none' };
  }

  if (request.storeId !== null) {
    // 厳密な一致で集合の要素を探す。集合の id は DB が返した正規形で、選択肢の postback もその値を
    // そのまま運ぶので、正当な選択は必ず一致する。大文字などの表記揺れは一致せずに再提示へ倒れる
    // （拒否の側へ倒れるだけで、集合外の店舗を採ることはない）。
    const chosen = stores.find((store) => store.id === request.storeId);
    if (chosen !== undefined) {
      return { kind: 'resolved', store: chosen };
    }
    return { kind: 'choose', page: choicePage(stores, request.page), reason: 'invalid_choice' };
  }

  const onlyStore = stores.length === 1 ? stores[0] : undefined;
  if (onlyStore !== undefined) {
    return { kind: 'resolved', store: onlyStore };
  }
  return { kind: 'choose', page: choicePage(stores, request.page), reason: 'multiple' };
}

// 要求の頁の選択肢を切り出す。stores は 1 店以上である。
function choicePage(stores: readonly ReportableStore[], requestedPage: number): StoreChoicePage {
  const pageCount = Math.ceil(stores.length / STORE_CHOICE_PAGE_SIZE);
  // 0 を下回る値・小数・NaN・無限大・頁の数以上の値は 0 頁目にする。`> 0` で比べるので -0 も 0 になる。
  const pageIndex =
    Number.isInteger(requestedPage) && requestedPage > 0 && requestedPage < pageCount ? requestedPage : 0;
  const start = pageIndex * STORE_CHOICE_PAGE_SIZE;
  const end = start + STORE_CHOICE_PAGE_SIZE;
  return {
    stores: stores.slice(start, end),
    pageIndex,
    // 次の頁の番号は「ほかの店舗」の postback に載る。@fwlm/line-report の符号化は 0〜99 の頁を受理するので、
    // 1 頁 12 店で 1200 店までを符号化できる。
    nextPageIndex: end < stores.length ? pageIndex + 1 : null,
  };
}

const ELLIPSIS = '…';

// 書記素（利用者が 1 文字と見る単位）に分ける。絵文字の連結・国旗・結合文字を 1 つとして扱う。
const graphemeSegmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });

function codePointLength(text: string): number {
  return [...text].length;
}

/**
 * 選択肢のラベル用に店名を省略する。20 文字以内ならそのまま返し、超えれば先頭の 19 文字と「…」にする。
 * 選択後の回答と displayText には、省略しない店名を使う（3.9）。
 *
 * 文字はコードポイントで数える。LINE はラベルを書記素で数え（references/message-objects.md）、上限を
 * 超えるラベルが 1 つでもあると Reply の要求そのものが 400 で拒否され、選択肢が 1 件も届かない
 * （references/api-common.md）。書記素の数は、どの版の分け方で数えてもコードポイントの数を超えないので、
 * コードポイントで 20 以内に収めれば LINE の数え方の細部によらず上限を超えない。UTF-16 の単位では
 * 数えない（BMP の外の漢字や絵文字を 2 文字と数えて不要に省略するうえ、境目でサロゲートペアを割る）。
 *
 * 切るときは書記素の境目で切る。絵文字の連結や結合文字を途中で割ると別の文字に見えるので、
 * 残りの枠に入り切らない書記素は丸ごと落とす。
 */
export function abbreviateStoreLabel(name: string): string {
  if (codePointLength(name) <= STORE_LABEL_MAX_LENGTH) {
    return name;
  }

  const budget = STORE_LABEL_MAX_LENGTH - codePointLength(ELLIPSIS);
  let kept = '';
  let used = 0;
  for (const { segment } of graphemeSegmenter.segment(name)) {
    const size = codePointLength(segment);
    if (used + size > budget) {
      break;
    }
    kept += segment;
    used += size;
  }
  return `${kept}${ELLIPSIS}`;
}
