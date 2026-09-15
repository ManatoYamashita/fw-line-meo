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
// 選択肢のラベル（省略と、同じ頁で衝突したときの区別）もここで決める。選択肢のメッセージの組立
// （displayText・postback・「ほかの店舗」）は StoreChoiceBuilder（builders/store-choice.ts）の責務である。

import type { ReportableStore } from '@fwlm/db';
import type { ReportRequest } from '@fwlm/line-report';
import { ELLIPSIS, codePointLength, fitText, splitGraphemes } from './format.js';

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

/**
 * 選択肢のラベル用に店名を省略する。20 文字以内ならそのまま返し、超えれば先頭の 19 文字と「…」にする。
 * 選択後の回答と displayText には、省略しない店名を使う（3.9）。
 *
 * 文字はコードポイントで数え、書記素の境目で切る（format.ts の fitText）。LINE はラベルを書記素で数え
 * （references/message-objects.md）、上限を超えるラベルが 1 つでもあると Reply の要求そのものが 400 で
 * 拒否され、選択肢が 1 件も届かない（references/api-common.md）。UTF-16 の単位では数えない（BMP の外の
 * 漢字や絵文字を 2 文字と数えて不要に省略するうえ、境目でサロゲートペアを割る）。
 */
export function abbreviateStoreLabel(name: string): string {
  return fitText(name, STORE_LABEL_MAX_LENGTH);
}

// 同じ頁でラベルが衝突したときの形。先頭 9 文字＋「…」＋末尾 10 文字で、ラベルの上限の 20 文字に収める。
// 衝突した店舗は先頭の 19 文字が同じなので、区別に効くのは末尾である（支店名が入ることが多い）。
// 先頭も短く残すのは、どの系列の店かを読み取れるようにするため。
const COLLISION_HEAD_LENGTH = 9;
const COLLISION_TAIL_LENGTH = STORE_LABEL_MAX_LENGTH - COLLISION_HEAD_LENGTH - codePointLength(ELLIPSIS);

/** 選択肢に並べる店舗と、そのラベル。 */
export interface LabeledStore {
  /** 入力の配列の要素そのもの。 */
  readonly store: ReportableStore;
  readonly label: string;
}

/**
 * 同じ頁に並べる店舗の選択肢のラベルを、入力と同じ順で返す（3.9 の「識別できる形」）。
 *
 * ラベルは abbreviateStoreLabel で作る。同じ頁で 2 店以上が同じラベルになったときだけ、そのうち省略した
 * 店舗（名前が 20 文字を超える店舗）のラベルを、先頭 9 文字＋「…」＋末尾 10 文字の形に替える。
 * 衝突しないラベルは 19 文字＋「…」のままにする。
 *
 * 名前が 20 文字以内の店舗は、省略していない全文なので替えない。名前そのものが同じ店舗と、先頭 9 文字と
 * 末尾 10 文字がどちらも同じ店舗は、この形でも区別できない（名前のほかに表示できるものが無い）。
 */
export function labelStoreChoices(stores: readonly ReportableStore[]): LabeledStore[] {
  const labeled = stores.map((store) => ({ store, label: abbreviateStoreLabel(store.name) }));
  const counts = new Map<string, number>();
  for (const { label } of labeled) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return labeled.map(({ store, label }) =>
    (counts.get(label) ?? 0) > 1 && codePointLength(store.name) > STORE_LABEL_MAX_LENGTH
      ? { store, label: abbreviateKeepingTail(store.name) }
      : { store, label },
  );
}

// 先頭と末尾を書記素の境目で残し、間を「…」にする。入り切らない書記素は丸ごと落とす。
// name は 20 文字を超えるので、先頭（9 文字以内）と末尾（10 文字以内）は重ならない。
function abbreviateKeepingTail(name: string): string {
  const graphemes = splitGraphemes(name);

  let headEnd = 0;
  let headUsed = 0;
  for (const segment of graphemes) {
    const size = codePointLength(segment);
    if (headUsed + size > COLLISION_HEAD_LENGTH) {
      break;
    }
    headUsed += size;
    headEnd += 1;
  }

  let tailStart = graphemes.length;
  let tailUsed = 0;
  while (tailStart > headEnd) {
    const size = codePointLength(graphemes[tailStart - 1] ?? '');
    if (tailUsed + size > COLLISION_TAIL_LENGTH) {
      break;
    }
    tailUsed += size;
    tailStart -= 1;
  }

  return `${graphemes.slice(0, headEnd).join('')}${ELLIPSIS}${graphemes.slice(tailStart).join('')}`;
}
