// Google Maps の帰属表示（Places API のポリシー・line-on-demand-report Requirements 1.6, 8.1）。
//
// Places のデータを Google Map なしで出す面は、種類を問わず帰属表示を要する。出す面はレポートだけでは
// なく、オンボーディングの候補カルーセルと確認バブル（確定前の検索結果）と、変化の通知も含む（#287）。
// レポート固有の関心ではないので、LINE 面の基本部品として line/ に置く。
//
// 帰属を付けない面: 確定後の店舗名（stores.name）だけを出すテキストの案内。オーナーが自ら店名で検索し、
// 候補から選んで確定した自店の識別情報として扱う（.kiro/specs/line-on-demand-report/design.md の
// 「残るリスクと未決事項」の判断）。
//
// DB にも LINE にも触れない純関数のみ。記録（ログ）も出さない。

import { lineColors, lineLayout } from '@fwlm/design-tokens';
import type { FlexBoxComponent, FlexBoxContent, FlexTextComponent } from './flex-types.js';
import { ALT_TEXT_MAX_LENGTH, fitText, utf16Length } from './text.js';

/** Google Maps の帰属表示の文言。Places API のポリシーは「Google Maps」の改変・改行・翻訳を禁じる（8.1）。 */
export const ATTRIBUTION_TEXT = 'データ提供: Google Maps';

/**
 * 帰属表示の text 部品（8.1）。
 *
 * - 大きさは lineLayout.attributionSize（ポリシーが定める 12〜16sp の範囲のピクセル値）、色は
 *   lineColors.attribution（ポリシーが定める 3 色の 1 つ）を使う。caption と muted はどちらもポリシーの外にある
 * - 折り返さない（1 行で表示する）。kilo のバブル（幅約 300px）に対して 13px の約 20 文字は十分に短い。
 *   ほかの部品と横に並べると幅が縮んで省略記号で切られうるので、footer の中で 1 行を占めさせる（attributionFooter）
 * - adjustMode（shrink-to-fit）のような大きさを変える指定を持たない。縮めると 12sp を下回りうる
 * - 書体は満たしている。ポリシーは「Roboto（読み込みは任意）」とし、フォールバックとして
 *   「product 内で既に使っている任意の sans serif か `Sans-Serif`」を明示的に許す。LINE Flex は書体を
 *   指定するプロパティを持たないが、既定の書体がそのフォールバックに当たる（#287 で原文を当たり直して確認）
 */
export function buildAttributionText(): FlexTextComponent {
  return {
    type: 'text',
    text: ATTRIBUTION_TEXT,
    size: lineLayout.attributionSize,
    color: lineColors.attribution,
    wrap: false,
    align: 'center',
  };
}

/**
 * 帰属表示を末尾に置いた footer。帰属表示は、ポリシーの言う「同じ容器の上端か下端」として、同じバブルの
 * footer の最後に 1 つだけ置く。contents（操作のボタンや、推移の詳細画面への導線など）は帰属表示の上に
 * 順に並べる。
 *
 * カルーセルのバブルは LINE の画面上でそれぞれ独立して見えるので、「同じ容器」はバブル 1 つであり、
 * 帰属表示はカルーセルに 1 つではなく**バブルごとに 1 つ**置く。
 */
export function attributionFooter(contents: readonly FlexBoxContent[] = []): FlexBoxComponent {
  return {
    type: 'box',
    layout: 'vertical',
    spacing: lineLayout.itemGap,
    paddingAll: lineLayout.blockPadding,
    contents: [...contents, buildAttributionText()],
  };
}

/** altText の末尾に付ける帰属表示。 */
export const ALT_TEXT_ATTRIBUTION = `（${ATTRIBUTION_TEXT}）`;

/**
 * altText に帰属表示を付ける。altText はトークの一覧や通知でバブルの代わりに出るので、バブルと同じく
 * 帰属表示を持たせる。本文が長ければ書記素の境目で切り、**帰属表示は切らない**（上限から先に差し引く）。
 */
export function withAttributionAltText(altText: string): string {
  const body = fitText(altText, ALT_TEXT_MAX_LENGTH - utf16Length(ALT_TEXT_ATTRIBUTION), utf16Length);
  return `${body}${ALT_TEXT_ATTRIBUTION}`;
}
