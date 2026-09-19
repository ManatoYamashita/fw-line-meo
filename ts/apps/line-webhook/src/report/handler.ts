// レポート要求の応答（design.md「ReportHandler」・Requirements 2.3, 3.1, 3.2, 3.3, 3.6, 3.7, 3.8, 4.1, 5.1,
// 6.1, 7.1, 7.2, 7.4, 7.5）。
//
// 1 つのレポート要求に、次の順で応える。
// 1. オーナー本人の確定店舗の一覧を読む
// 2. 要求の店舗の指定と頁から、一覧の内側で対象店舗を決める（resolveTargetStore）。店舗が無ければ店舗なしの
//    案内（3.7）、決まらなければ店舗の選択肢（3.2・3.6）を返す
// 3. 対象店舗の最新の日次集計を読む。行が無ければ準備中の案内を返す（7.1）
// 4. 種類ごとに組み立てる
//    - 新着口コミ・競合店との比較: 最新の行が取得失敗なら取得失敗の案内（7.2）、そうでなければ最新の行を
//      正規化して組み立てたレポート（4.1・5.1）
//    - 直近の推移: 最新の行の日付を終点に 7 暦日の範囲を読み、正規化して日ごとに分類した表のレポート（6.1）。
//      最新の行が取得失敗なら、ビルダーが失敗日を示した表に取得失敗の注記を添える（7.2）
// 5. Reply を 1 回だけ送り、応答の区分を記録する（7.4）
//
// 読み出しの基準日（asOf）は日本時間の今日である。Go は日本時間の当日を summary_date に書くので、UTC の日付を
// 渡すと、日本時間の 0〜9 時に当日の行を窓の外として取りこぼす。日本時間は固定の +9 時間で求め、実行環境の TZ と
// tzdata に依存させない（delivery-job の resolveJstNow と同じ方式。アプリをまたいだ import は作らない）。
//
// 例外の扱い（7.4・7.5）:
// - 例外を投げずに戻るときは Reply を 1 回送っている。例外を投げるときは Reply を送っていない。メッセージを
//   組み立て終えてから、最後に Reply を送るためである
// - 店舗を決めた後の例外は StoreScopedReportError（店舗名つき）に包んで投げ直す。店舗を決める前の例外は
//   包まずに投げる。どちらの場合も、エラー境界（app.ts）が再試行案内を 1 回だけ返す
//
// 記録（ログ）には店舗 ID・オーナー ID・LINE ユーザー ID を載せない。載せるのはレポートの種類と応答の区分だけ
// である。集合外の店舗の指定は、指定された ID を載せずに事象だけを残す（store-detail の store_hint_ignored と
// 同じ考え方。集合外の値は攻撃者に由来しうる）。

import {
  findLatestDailySummary,
  listDailySummariesEndingAt,
  listReportableStores,
  type DailySummaryReadRow,
  type Queryable,
  type ReportableStore,
} from '@fwlm/db';
import type { ReportKind, ReportRequest } from '@fwlm/line-report';
import type { LineMessage, LineMessenger } from '../line/client.js';
import type { ConversationLogger } from '../onboarding/conversation.js';
import { buildComparisonReport } from './builders/comparison.js';
import { buildNewReviewsReport } from './builders/new-reviews.js';
import { buildFetchFailedNotice, buildNoStoreNotice, buildPreparingNotice } from './builders/notices.js';
import { buildStoreChoiceMessage } from './builders/store-choice.js';
import { TREND_DAYS, buildTrendReport, classifyTrendDays, storeDetailUrlFor } from './builders/trend.js';
import { StoreScopedReportError } from './errors.js';
import { normalizeReadRow, type ReportContext } from './format.js';
import { resolveTargetStore } from './stores.js';

/**
 * 応答の区分。記録の reportOutcome に載せる。
 * fetch_failed は最新の日次集計が取得失敗だった応答で、推移のレポート（失敗日を示した表と注記）も含む。
 */
export type ReportOutcome = 'report' | 'store_choice' | 'no_store' | 'preparing' | 'fetch_failed';

/** レポートの読み出し。@fwlm/db の report-reads の 3 関数と同じ形で、試験では偽物に差し替える。 */
export interface ReportReadsAccessor {
  listReportableStores(db: Queryable, ownerId: string): Promise<ReportableStore[]>;
  findLatestDailySummary(db: Queryable, storeId: string, asOf: string): Promise<DailySummaryReadRow | null>;
  listDailySummariesEndingAt(
    db: Queryable,
    storeId: string,
    endDate: string,
    days: number,
    asOf: string,
  ): Promise<DailySummaryReadRow[]>;
}

const DEFAULT_REPORT_READS: ReportReadsAccessor = {
  listReportableStores,
  findLatestDailySummary,
  listDailySummariesEndingAt,
};

export interface ReportHandlerDeps {
  readonly db: Queryable;
  readonly messenger: Pick<LineMessenger, 'reply'>;
  /** 詳細画面の LIFF URL（既存の env LIFF_STORE_DETAIL_URL）。推移のレポートの導線に使う。 */
  readonly liffStoreDetailUrl: string;
  readonly logger: ConversationLogger;
  /** 読み出し。省略すると @fwlm/db の関数を使う。 */
  readonly reads?: ReportReadsAccessor;
  /** 現在時刻。省略すると実行時の時刻を使う。読み出しの基準日（日本時間の今日）を決める。 */
  readonly now?: () => Date;
}

export interface ReportHandleInput {
  readonly replyToken: string;
  /** 店舗特定済みのオーナーの ID。署名検証済みの LINE ユーザーから導いたものに限る。 */
  readonly ownerId: string;
  readonly request: ReportRequest;
}

export interface ReportHandler {
  /**
   * 1 つのレポート要求に応える。例外を投げずに戻るときは Reply を 1 回送っている。例外を投げるときは
   * Reply を送っていない（店舗を決めた後の例外は StoreScopedReportError に包む）。
   */
  handle(input: ReportHandleInput): Promise<ReportOutcome>;
}

/** 送るメッセージと、その応答の区分。 */
interface ReportAnswer {
  readonly message: LineMessage;
  readonly outcome: ReportOutcome;
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** now の日本時間の暦日 'YYYY-MM-DD'。固定の +9 時間を足し、getUTC* で読む（実行環境の TZ に依存しない）。 */
function jstToday(now: Date): string {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const month = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const day = String(jst.getUTCDate()).padStart(2, '0');
  return `${jst.getUTCFullYear()}-${month}-${day}`;
}

export function createReportHandler(deps: ReportHandlerDeps): ReportHandler {
  const reads = deps.reads ?? DEFAULT_REPORT_READS;
  const now = deps.now ?? (() => new Date());

  // Reply を 1 回送り、応答の区分を記録する。メッセージは組み立て終えたものだけを受け取る。
  async function replyWith(input: ReportHandleInput, answer: ReportAnswer): Promise<ReportOutcome> {
    await deps.messenger.reply(input.replyToken, [answer.message]);
    deps.logger.info('line-webhook.report_replied', {
      reportKind: input.request.kind,
      reportOutcome: answer.outcome,
    });
    return answer.outcome;
  }

  // 対象店舗が決まった後の読み出しと組立。store は listReportableStores が返した集合の要素である。
  async function answerForStore(store: ReportableStore, kind: ReportKind): Promise<ReportAnswer> {
    const ctx: ReportContext = { storeName: store.name };
    const asOf = jstToday(now());
    const latest = await reads.findLatestDailySummary(deps.db, store.id, asOf);
    if (latest === null) {
      return { message: buildPreparingNotice(ctx), outcome: 'preparing' };
    }
    const latestFailed = latest.status === 'failed';

    switch (kind) {
      case 'new_reviews':
        return latestFailed
          ? { message: buildFetchFailedNotice(ctx, latest.summary_date), outcome: 'fetch_failed' }
          : { message: buildNewReviewsReport(ctx, normalizeReadRow(latest)), outcome: 'report' };
      case 'comparison':
        return latestFailed
          ? { message: buildFetchFailedNotice(ctx, latest.summary_date), outcome: 'fetch_failed' }
          : { message: buildComparisonReport(ctx, normalizeReadRow(latest)), outcome: 'report' };
      case 'trend': {
        // 範囲の終点は今日ではなく最新の行の日付である（6.1）。バッチが止まった日が続いても、表は最後に
        // 取得できた日までを示し、行の無い日で埋まらない。
        const rows = await reads.listDailySummariesEndingAt(deps.db, store.id, latest.summary_date, TREND_DAYS, asOf);
        const days = classifyTrendDays(latest.summary_date, rows.map(normalizeReadRow), TREND_DAYS);
        // latestFailed と最新の日の分類が食い違えば（2 回の読み出しの間に行が書き直された場合）、ビルダーが
        // 例外を投げる。値を示す行の上に「取得できませんでした」を出さないためで、店舗名つきの再試行案内になる。
        const message = buildTrendReport(ctx, days, latestFailed, storeDetailUrlFor(deps.liffStoreDetailUrl, store.id));
        return { message, outcome: latestFailed ? 'fetch_failed' : 'report' };
      }
    }
  }

  return {
    async handle(input: ReportHandleInput): Promise<ReportOutcome> {
      const { request } = input;
      const stores = await reads.listReportableStores(deps.db, input.ownerId);
      const resolution = resolveTargetStore(stores, request);

      switch (resolution.kind) {
        case 'none':
          return replyWith(input, { message: buildNoStoreNotice(), outcome: 'no_store' });
        case 'choose':
          if (resolution.reason === 'invalid_choice') {
            // 指定された店舗 ID は載せない。他のオーナーに実在する ID でも存在しない ID でも、同じ記録と応答にする。
            deps.logger.warn('line-webhook.report_store_hint_ignored', { reportKind: request.kind });
          }
          return replyWith(input, {
            message: buildStoreChoiceMessage(request.kind, resolution.page, resolution.reason),
            outcome: 'store_choice',
          });
        case 'resolved': {
          const { store } = resolution;
          try {
            return await replyWith(input, await answerForStore(store, request.kind));
          } catch (err) {
            throw new StoreScopedReportError(store.name, { cause: err });
          }
        }
      }
    },
  };
}
