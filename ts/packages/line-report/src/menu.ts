// メニューの action 群がレポート 3 導線を持つかの判定（design.md「ReportPostbackCodec」・Requirement 1.10）。
//
// delivery-job は、設定された完了後メニューの区画の action にこの判定を当て、真のときに限り
// 「メニューから確認できる」と誘導する通知を送る。張り替えのスクリプトも、張り替え先のメニューを
// 同じ判定で確かめる。1 導線でも欠けていれば偽とする（押しても答えの返らない導線へ誘導しないため）。

import { REPORT_KINDS, decodeReportPostback, type ReportKind } from './postback.js';

/** リッチメニューの区画の action のうち、判定に使う項目だけを持つ形（LINE の Action の部分集合）。 */
export interface RichMenuActionLike {
  readonly type: string;
  readonly data?: string;
}

/** 3 種類すべてについて、店舗も頁も持たない postback の区画があるとき true。 */
export function exposesAllReportActions(actions: readonly RichMenuActionLike[]): boolean {
  const exposed = new Set<ReportKind>();
  for (const action of actions) {
    if (action.type !== 'postback' || action.data === undefined) {
      continue;
    }
    const request = decodeReportPostback(action.data);
    // 店舗つき・頁つきの data は選択肢の応答が使う形であり、メニューの区画の形ではない。
    if (request !== null && request.storeId === null && request.page === 0) {
      exposed.add(request.kind);
    }
  }
  return REPORT_KINDS.every((kind) => exposed.has(kind));
}
