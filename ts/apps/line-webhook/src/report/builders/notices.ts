// 店舗なし・初回データ準備中・取得失敗の案内（design.md「Report builders（表示）」の NoticeBuilders・
// Requirements 3.7, 3.8, 7.1, 7.2）。
//
// どれも案内のテキストで、Flex にしない（docs/design/design-language.md §7.16: 1 文 1 行・3 行以内・
// 絵文字を使わない・テキスト案内の Flex 化は行わない）。店舗別の案内（準備中・取得失敗）には、
// 省略しない店舗名を「」で括って入れる（3.8）。
//
// 帰属表示は付けない。店舗名は createConfirmedStore が Places の候補名をそのまま保存した値だが、
// オーナーが自ら店名で検索し候補から選んで確定した自店の識別情報として扱い、帰属は Places の指標
// （評価・順位・口コミ）を出す Flex に置く（design.md「残るリスクと未決事項」の判断）。確定前の
// 検索結果を出す面（オンボーディングの候補）に帰属が欠けている件は Issue #287 が追う。

import type { LineMessage } from '../../line/client.js';
import { formatDataDate, type ReportContext } from '../format.js';

/**
 * レポートを要求したオーナーに対象の店舗が無いときの案内（3.7）。店舗別の案内ではない。
 * 登録を担当した代理店か運営へ確かめるよう案内する。
 */
export function buildNoStoreNotice(): LineMessage {
  return {
    type: 'text',
    text: 'レポートを表示できる店舗がありません。\n店舗の登録を担当した代理店または運営にご確認ください。',
  };
}

/** 対象店舗の日次集計が 1 件も無いときの案内（7.1）。登録の直後などで、初回のデータを準備している旨を返す。 */
export function buildPreparingNotice(ctx: ReportContext): LineMessage {
  return {
    type: 'text',
    text:
      `「${ctx.storeName}」の初回のデータを準備しています。\n` +
      '店舗の登録直後は、データがそろうまで時間がかかります。\n' +
      'しばらくしてから、もう一度お試しください。',
  };
}

/**
 * 対象店舗の最新の日次集計が取得失敗を示すときの案内（7.2）。店舗名とデータ対象日を添え、
 * 次のデータの更新の後に確かめるよう案内する。dataDate は最新の日次集計の summary_date（'YYYY-MM-DD'）。
 */
export function buildFetchFailedNotice(ctx: ReportContext, dataDate: string): LineMessage {
  return {
    type: 'text',
    text:
      `「${ctx.storeName}」の最新のデータ（${formatDataDate(dataDate)}分）を取得できませんでした。\n` +
      '次のデータの更新の後に、もう一度ご確認ください。',
  };
}
