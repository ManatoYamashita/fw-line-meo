// @fwlm/line-report の公開面（design.md「ReportPostbackCodec」の Service Interface）。
// line-webhook・delivery-job・リッチメニューのスクリプトが、レポートの postback の形式と
// メニューの判定を同じ定義から読む。実行時の依存を持たない。
export type { ReportKind, ReportRequest } from './postback.js';
export {
  REPORT_LABELS,
  decodeReportPostback,
  encodeReportPostback,
  isReportPostbackData,
} from './postback.js';
export type { RichMenuActionLike } from './menu.js';
export { exposesAllReportActions } from './menu.js';
