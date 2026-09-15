// 競合の検索欄と、件数の文言（store-detail-trend-dashboard task 3.3・Issue #265）。
//
// 競合の節で、競合店名で一覧を絞り込む検索欄と、絞り込みの件数の文言を描く。判断の正典は
// docs/design/design-language.md §7.18 であり、ここでは結論も数値も転記せず参照する。部品の選び方の審議は、
// 同 spec の research.md（「部品と環境の制約」）にある。
//
// 検索欄:
// - 縦に積む Field に、見えるラベル（FieldLabel）と、検索の種類の入力欄（Input）を置く。ラベルは for と id で
//   入力欄に結び、入力欄の名前にする（要件 5.7）。id は useId の値だけを使う。手書きの id を参照する記法は、
//   直書きの色と誤検出される。
// - 操作領域の大きさ（§7.10）は、ラベルの行と入力欄を縦に積んだ Field の全体で満たす。入力欄の部品の
//   高さだけでは下限に届かないが、ラベルを押しても入力欄へ焦点が移る（実測は同 spec のタスク 5.2）。
// - search 要素は使わない。jsdom 25 が未知の要素として扱い、Testing Library も役割で取れないため
//   （research.md「部品と環境の制約」）。
// - 自動補完を切る。店名の検索語は、端末に覚えさせて候補に出すものではない。
// - name を渡さない。入力欄が name を持つと、構造契約（test/store-page.test.tsx）の検査に当たる（要件 7.2）。
//
// 件数の文言:
// - Field の下に、常に置いた状態通知の要素（p・role="status"）で「競合{総数}店のうち{表示数}店を表示」と
//   出す（要件 4.7・4.8）。要素を常に置くのは、読み上げ領域が文字の変わる前から存在していないと、変化が
//   読み上げられないためである。通知の強さと範囲は、status の役割の既定（割り込まずに、文言の全体を読む）に
//   任せ、aria-live などを重ねない。
// - 文字が変わるのは件数が変わるときだけなので、打つたびには読み上げない。
// - 入力された検索語は、画面のどこにも表示し直さない。長い英字列が 320px で溢れる経路を作らないため（要件 6.4）。
//
// 状態: 部品は検索語を持たず、絞り込みもしない。検索語は競合の節が持ち（同 spec の research.md の決定 D8）、
// 件数は lib/competitor-filter.ts の結果から節が渡す。入力は、打った文字列のまま通知する。正規化は絞り込みの
// 側が行うので、ここで前後の空白を落とすと、語の間の空白を打った瞬間に消えてしまう。
//
// 色: 検索欄は色を書かない（§7.18。店舗詳細の面で色を書くのは推移グラフの部品だけである）。検索欄の色は
// 部品の側がトークンから解決し、件数の文言は本文色を継承する。
// 件数の文言の文字の段は、同じ節の注記（評価の無い店の注記）とラベルの段にそろえる。
//
// この部品は、page.tsx（Client Component）の中で描く。test/competitor-search.test.tsx が部品単体を検証する。

import { useId } from 'react';
import { Field, FieldLabel } from '@fwlm/ui/components/field';
import { Input } from '@fwlm/ui/components/input';

export interface CompetitorSearchProps {
  /** 検索語。競合の節が持つ状態で、打った文字列のまま（正規化する前の形）である。 */
  readonly query: string;
  /** 入力が変わったときの通知。打った文字列をそのまま渡す。 */
  readonly onQueryChange: (query: string) => void;
  /** 当日の競合の総数（評価の無い店も数える）。 */
  readonly total: number;
  /** 絞り込みの結果として一覧に残る競合の数。 */
  readonly visibleCount: number;
}

/** 検索欄の見えるラベル。入力欄の名前にもなる。 */
const SEARCH_LABEL = '店名で絞り込む';

/** 件数の文言（要件 4.7）。 */
function countText(total: number, visibleCount: number): string {
  return `競合${total}店のうち${visibleCount}店を表示`;
}

export function CompetitorSearch({ query, onQueryChange, total, visibleCount }: CompetitorSearchProps): React.JSX.Element {
  const inputId = useId();

  return (
    <div className="flex flex-col gap-2">
      <Field>
        <FieldLabel htmlFor={inputId}>{SEARCH_LABEL}</FieldLabel>
        <Input
          id={inputId}
          type="search"
          autoComplete="off"
          value={query}
          onChange={(event) => {
            onQueryChange(event.currentTarget.value);
          }}
        />
      </Field>
      <p role="status" className="text-sm">
        {countText(total, visibleCount)}
      </p>
    </div>
  );
}
