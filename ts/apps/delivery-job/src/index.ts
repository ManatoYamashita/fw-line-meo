// delivery-job の Cloud Run Job エントリポイント（line-on-demand-report tasks 4.4）。
//
// 各コンポーネントを統合する:
//   - targets.ts:      対象抽出（配信可能 / 当日の集計が無い skip 候補）と当日・前日の正規化
//   - notification.ts: 送るかどうかの判定と、変化を知らせる通知の組立
//   - menu.ts:         完了後メニューの準備判定とオーナーの照合
//   - line.ts:         LINE の Push とリッチメニューの呼出（トークン発行・再送規則込み）
//   - deliveries.ts:   summary_deliveries への事前確保・結果記録
//
// design.md「DeliveryOrchestrator」の順序をそのまま実装する:
//   実行の冒頭で準備判定を 1 回 → 対象ごとに 予約 → 判定 → （送らないなら理由つきで記録）
//   → 通知の組立 → オーナーの照合 → push → 記録
//
// **準備判定は対象の有無によらず実行ごとに 1 回行う**（実行サマリーの `reportMenuReady` に出す）。
// 差し替え（メニューの張り替え）の後もメニューが未準備のままであることは、この値でしか追えない。
//
// オーナー単位のエラー隔離が本モジュールの核心的な正しさの性質: 1 オーナーの組立失敗・Push 例外が
// 他オーナーの処理を止めてはならない（design.md Error Strategy「店舗単位・オーナー単位でエラーを
// 隔離し、失敗は必ず行またはログに痕跡を残す（silent drop 禁止）」）。

import { randomUUID } from 'node:crypto';
import { executionCorrelationId, withCorrelation, writeStructuredLog } from '@fwlm/observability';
import type { LogFields } from '@fwlm/observability';

import { closePool, getPool } from '@fwlm/db';
import type { DailySummaryRow, Queryable, SummaryDeliveryStatus } from '@fwlm/db';

import { recordDeliveryResult, reserveDelivery } from './deliveries.js';
import { LineClient } from './line.js';
import type { LinePushResult } from './line.js';
import { createReportMenuGate } from './menu.js';
import type { ReportMenuGate } from './menu.js';
import { buildChangeNotification, decideNotification } from './notification.js';
import type { FlexMessagePayload, NotificationToday } from './notification.js';
import { queryDeliveryTargets, queryOwnersDueWithoutSummary } from './targets.js';
import type { DeliveryTarget, SkippedNoSummaryTarget } from './targets.js';

const correlationLog = withCorrelation(writeStructuredLog, executionCorrelationId());

// --- 設定読取（dashboard-api の loadConfig 規約に準拠: 必須 env 欠落は起動時に明示エラーで
// fail-fast する） -------------------------------------------------------------------------

export interface DeliveryJobConfig {
  /** LINE チャネル ID（Stateless token 発行の client_id）。 */
  readonly lineChannelId: string;
  /** LINE チャネルシークレット（Stateless token 発行の client_secret。ログに出さない）。 */
  readonly lineChannelSecret: string;
  /**
   * 完了後リッチメニューの ID（要件 1.10・2.8）。
   *
   * 通知はオーナーを「メニューの該当導線」へ誘導するので、その導線を持つメニューの ID を
   * 知らないまま実行しても、送れる通知が 1 通も無い。したがって必須の設定とする。
   * `LIFF_URL` はここでは読まない（旧来の日次カードの「詳細を見る」ボタンのためのもので、
   * 通知はボタンを持たない）。
   */
  readonly completedRichMenuId: string;
}

/**
 * 必須設定の欠落。**欠けた設定の識別子を構造として持つ。**
 *
 * 記録には例外の本文を載せない（要件 2.5）。本文へ頼ると、原因の特定と引き換えに
 * 接続情報や入力値が混ざる経路を開くことになる。環境変数名は有限集合の識別子なので、
 * 構造として持てば本文なしで原因を追える。
 */
export class MissingConfigError extends Error {
  readonly configKey: string;

  constructor(configKey: string) {
    super(`${configKey} is required`);
    this.name = 'MissingConfigError';
    this.configKey = configKey;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DeliveryJobConfig {
  const lineChannelId = env.LINE_CHANNEL_ID;
  const lineChannelSecret = env.LINE_CHANNEL_SECRET;
  const completedRichMenuId = env.LINE_RICHMENU_COMPLETED_ID;

  if (!lineChannelId) {
    throw new MissingConfigError('LINE_CHANNEL_ID');
  }
  if (!lineChannelSecret) {
    throw new MissingConfigError('LINE_CHANNEL_SECRET');
  }
  if (!completedRichMenuId) {
    throw new MissingConfigError('LINE_RICHMENU_COMPLETED_ID');
  }

  return { lineChannelId, lineChannelSecret, completedRichMenuId };
}

// --- JST 時刻算出（純関数・依存追加なしの固定 +9:00 オフセット。
// go/internal/batch/run.go の jstDateAsUTC と同じ「tzdata に依存しない確実な方式」の方針） ---

export interface JstNow {
  /** 現在の JST 時（0–23）。 */
  readonly hour: number;
  /** 現在の JST 暦日（'YYYY-MM-DD'。daily_summaries.summary_date と比較可能）。 */
  readonly date: string;
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function resolveJstNow(now: Date): JstNow {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const year = jst.getUTCFullYear();
  const month = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const day = String(jst.getUTCDate()).padStart(2, '0');
  return { hour: jst.getUTCHours(), date: `${year}-${month}-${day}` };
}

// --- LinePushResult → summary_deliveries の記録内容への変換（純関数） -----------------------

export interface PushOutcome {
  readonly status: SummaryDeliveryStatus;
  readonly errorDetail: string | null;
  readonly deliveredAt: Date | null;
}

/**
 * design.md「失敗分類」: 400 等 = failed 記録・継続／429（月次クォータ）= quota_exceeded。
 * line.ts の LinePushResult（'success'|'failed'|'quota_exceeded'）は summary_deliveries.status の
 * 7 値のうち、送ろうとした結果を表す 3 値と 1:1 対応する（残る 4 値は「送らなかった理由」であり、
 * 判定・準備判定・当日の集計の有無から決まる）。
 */
export function describePushOutcome(result: LinePushResult): PushOutcome {
  switch (result.status) {
    case 'success':
      return { status: 'delivered', errorDetail: null, deliveredAt: new Date() };
    case 'failed':
      return { status: 'failed', errorDetail: result.message, deliveredAt: null };
    case 'quota_exceeded':
      return { status: 'quota_exceeded', errorDetail: result.message, deliveredAt: null };
  }
}

// --- ロガー（構造化 JSON 1行・オーナー単位のエラー隔離をログに残す） -------------------------

/**
 * 配信ジョブの記録の手段。
 *
 * `info`・`warn` は完了後メニューの門（menu.ts の ReportMenuLogger）がそのまま使う形である。
 * 門へ別のアダプタを渡すのではなくこの型に 2 つを持たせるのは、記録の出口を 1 つに保つためで
 * ある（試験が差し替える先も 1 つで済む）。
 */
export interface DeliveryJobLogger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  isolatedError(message: string, storeId: string, err: unknown): void;
  fatal(message: string, err: unknown): void;
}

/**
 * 例外の**種別**だけを取り出す。**記録（ログ）にはこちらを使う。**
 * 自由文には接続情報・問い合わせ内容・入力値が混ざりうるため、記録へ載せる経路を作らない（要件 2.5）。
 */
function errorKindOf(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'UnknownError';
}

/**
 * 例外の本文を取り出す。**用途は DB の失敗詳細に限る**（summary_deliveries.error_detail）。
 * 運営が配信の失敗理由を追うための業務データであり、記録経路とは別である。
 * これを記録へ載せてはならない。
 */
function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 外部呼び出しの失敗が状態コードを持つか（LINE API 由来の例外が持つ）。 */
function hasHttpStatus(err: unknown): err is { httpStatus: number | null } {
  return typeof err === 'object' && err !== null && 'httpStatus' in err;
}

const defaultLogger: DeliveryJobLogger = {
  info(event, fields) {
    correlationLog('info', event, fields);
  },
  warn(event, fields) {
    correlationLog('warn', event, fields);
  },
  isolatedError(message, storeId, err) {
    // 失敗の要約は detail で出す。**message という名前は使えない** —
    // 集約基盤がこれを本文として吸い、項目検索から消えてしまう。
    correlationLog('error', 'delivery-job.isolated_error', {
      detail: message,
      storeId,
      errorKind: errorKindOf(err),
    });
  },
  fatal(message, err) {
    // 欠けた設定は識別子として、外部呼び出しの失敗は状態コードとして載せる。
    // 本文を載せずに原因を追えるようにするため（要件 2.5 は「種別**および状態コード**」を許す）。
    // 状態コードが無いと、Issue 151 の再発時に 401 / 429 / ネットワーク断を区別できない。
    correlationLog('error', 'delivery-job.fatal', {
      detail: message,
      errorKind: errorKindOf(err),
      ...(err instanceof MissingConfigError ? { configKey: err.configKey } : {}),
      ...(hasHttpStatus(err) && err.httpStatus !== null ? { status: err.httpStatus } : {}),
    });
  },
};

// --- 送らなかった理由の記録（summary_deliveries.error_detail・業務データ） -------------------
//
// status だけでも理由の区分は残るが、運営が行を 1 件読んだときに、その区分が何を意味するかを
// 言葉で読めるようにする。内容はリテラルに限る（利用者の入力や例外の本文を混ぜない）。

const DETAIL_NO_CHANGE = 'skipped: comparable but no new reviews and no rank change on this day';
const DETAIL_NOT_COMPARABLE =
  'skipped: daily summary is not comparable (fetch failed, no rated competitor, or the store itself is unrated)';
const DETAIL_MENU_NOT_READY =
  'skipped: the configured completed rich menu does not expose the report actions (or could not be fetched)';
const DETAIL_MENU_LINK_FAILED = 'skipped: could not put the completed rich menu in front of this owner';
const DETAIL_QUOTA_BACKFILL =
  'skipped: LINE monthly quota exceeded earlier in this run (push not attempted for this target)';
const DETAIL_NO_SUMMARY = 'daily_summaries not found for today (06:00 batch failure or not yet run)';

// --- 1 対象分の処理 -------------------------------------------------------------------------

/** 1 対象の処理結果。'already_processed' 以外は summary_deliveries の status と 1:1 で対応する。 */
type ReadyOutcome =
  | 'delivered'
  | 'failed'
  | 'quota_exceeded'
  | 'already_processed'
  | 'skipped_no_change'
  | 'skipped_not_comparable'
  | 'skipped_menu_unavailable';

/** 1 回の実行の間だけ変わらない文脈（対象ごとの処理が読む）。 */
interface RunContext {
  readonly pool: Queryable;
  readonly lineClient: LineClient;
  readonly gate: ReportMenuGate;
  readonly accessToken: string;
  readonly summaryDate: string;
  /** 実行の冒頭で 1 回だけ行った準備判定の結果。 */
  readonly reportMenuReady: boolean;
}

/**
 * 当日の行から、判定が読む列だけを取り出す。
 *
 * 当日の行の `rank_prev`（Go が当日の競合集合で前日の値を計算し直したもの）は **NotificationToday が
 * 持たない**ので、ここで渡すことはできない。順位変動は前日の行の `rank` と比べる（1.2）。
 */
function toNotificationToday(summary: DailySummaryRow): NotificationToday {
  return {
    status: summary.status,
    rank: summary.rank,
    rank_total: summary.rank_total,
    review_count_prev: summary.review_count_prev,
    new_review_count: summary.new_review_count,
  };
}

/**
 * 配信可能な 1 対象を処理する。
 *
 * 順序は design.md「DeliveryOrchestrator」のとおり: 予約 → 判定 → （送らないなら理由つきで記録）
 * → 通知の組立 → オーナーの照合 → push → 記録。**送らないと決めた対象も必ず予約してから記録する**
 * ので、同じ日の再実行が同じ店舗を判定し直すことはない（1.8）。
 */
async function processReadyTarget(ctx: RunContext, target: DeliveryTarget, quotaStopped: boolean): Promise<ReadyOutcome> {
  const retryKey = randomUUID();
  const reserveOutcome = await reserveDelivery(ctx.pool, target.storeId, ctx.summaryDate, target.lineUserId, retryKey);
  if (reserveOutcome === 'already_processed') {
    // 他の実行（同時実行・再実行）が既に処理済み。1.8: 同じ日に重複して送らない。
    return 'already_processed';
  }

  const record = (
    status: SummaryDeliveryStatus,
    lineRequestId: string | null = null,
    errorDetail: string | null = null,
    deliveredAt: Date | null = null,
  ): Promise<void> =>
    recordDeliveryResult(ctx.pool, target.storeId, ctx.summaryDate, status, lineRequestId, errorDetail, deliveredAt);

  const decision = decideNotification(toNotificationToday(target.summary), target.yesterday);
  if (decision.kind === 'skip') {
    if (decision.reason === 'no_change') {
      await record('skipped_no_change', null, DETAIL_NO_CHANGE);
      return 'skipped_no_change';
    }
    await record('skipped_not_comparable', null, DETAIL_NOT_COMPARABLE);
    return 'skipped_not_comparable';
  }

  // 準備判定の不成立（1.10）。押しても答えの返らない導線へ誘導するくらいなら、その日は送らない。
  if (!ctx.reportMenuReady) {
    await record('skipped_menu_unavailable', null, DETAIL_MENU_NOT_READY);
    return 'skipped_menu_unavailable';
  }

  // 月次クォータ超過の検知後は、LINE を一切呼ばずに行だけ残す（無駄な連打をしない・silent drop もしない）。
  if (quotaStopped) {
    await record('quota_exceeded', null, DETAIL_QUOTA_BACKFILL);
    return 'quota_exceeded';
  }

  let notification: FlexMessagePayload;
  try {
    notification = buildChangeNotification(target.storeName, decision.changes);
  } catch (err) {
    // 組立の失敗（FlexBubbleTooLargeError 等）はこのオーナーだけの失敗として記録し、
    // 他オーナーの処理は続ける（silent drop にしない・design.md Error Strategy）。
    await record('failed', null, `notification build failed: ${errorMessageOf(err)}`);
    return 'failed';
  }

  // 最初の通知より前に、オーナーが完了後メニューを見ている状態にする（2.8）。張れなければ送らない。
  const ownerOutcome = await ctx.gate.ensureOwner(ctx.accessToken, target.lineUserId);
  if (ownerOutcome === 'link_failed') {
    await record('skipped_menu_unavailable', null, DETAIL_MENU_LINK_FAILED);
    return 'skipped_menu_unavailable';
  }

  const pushResult = await ctx.lineClient.pushMessage(ctx.accessToken, target.lineUserId, [notification], retryKey);
  const outcome = describePushOutcome(pushResult);
  await record(outcome.status, pushResult.requestId, outcome.errorDetail, outcome.deliveredAt);

  if (outcome.status === 'delivered') return 'delivered';
  if (outcome.status === 'quota_exceeded') return 'quota_exceeded';
  return 'failed';
}

/** 当日の集計が無い対象（06:00 のバッチ失敗等）を、理由つきで記録する。LINE は呼ばない。 */
async function processSkipCandidate(
  pool: Queryable,
  summaryDate: string,
  candidate: SkippedNoSummaryTarget,
): Promise<'skipped' | 'already_processed'> {
  const retryKey = randomUUID();
  const reserveOutcome = await reserveDelivery(pool, candidate.storeId, summaryDate, candidate.lineUserId, retryKey);
  if (reserveOutcome === 'already_processed') {
    return 'already_processed';
  }
  await recordDeliveryResult(pool, candidate.storeId, summaryDate, 'skipped_no_summary', null, DETAIL_NO_SUMMARY);
  return 'skipped';
}

// --- オーケストレーション本体（テスト可能に DI 化。main() から実配線で呼ばれる） ----------------

export interface RunSummary {
  readonly event: 'delivery-job.run';
  readonly currentJstHour: number;
  readonly summaryDate: string;
  /** 今回の実行で見つかった対象の総数（配信可能対象＋当日の集計が無い対象）。 */
  readonly targetsTotal: number;
  readonly delivered: number;
  readonly failed: number;
  /** 当日の集計が無くて送らなかった件数。 */
  readonly skipped: number;
  readonly quotaExceeded: number;
  /** true = 実行中に quota_exceeded を検知し、以降の対象への Push を打ち切った。 */
  readonly quotaExceededStopped: boolean;
  /** 比較可能だが新着も順位変動も無くて送らなかった件数（1.4）。 */
  readonly skippedNoChange: number;
  /** 当日の集計が比較可能でなくて送らなかった件数（1.5）。 */
  readonly skippedNotComparable: number;
  /** 完了後メニューが未準備・張れなくて送らなかった件数（1.10）。 */
  readonly skippedMenuUnavailable: number;
  /** 完了後メニューの準備判定の結果。**対象が 1 件も無い実行でも出す。** */
  readonly reportMenuReady: boolean;
}

export interface RunDeliveryJobParams {
  readonly pool: Queryable;
  readonly lineClient: LineClient;
  /** 完了後リッチメニューの ID（env LINE_RICHMENU_COMPLETED_ID）。 */
  readonly completedRichMenuId: string;
  /** テスト用に現在時刻を注入する（既定 `() => new Date()`）。 */
  readonly now?: () => Date;
  readonly logger?: DeliveryJobLogger;
}

/**
 * delivery-job 1 回分の実行本体。
 *
 * 手順（design.md「DeliveryOrchestrator」）:
 *  1. Stateless channel access token をジョブ開始時に発行（Batch/Job Contract）
 *  2. **完了後メニューの準備判定を 1 回行う**（対象の有無によらず・実行サマリーへ出す）
 *  3. 配信可能対象（queryDeliveryTargets）と当日の集計が無い対象（queryOwnersDueWithoutSummary）を抽出
 *  4. 配信可能対象を storeId 昇順の決定的な順序で処理（予約→判定→記録／通知→照合→push→記録）。
 *     quota_exceeded の検知後は、残る対象へ Push を試みずに行だけ残す
 *  5. 当日の集計が無い対象を処理（予約→skipped_no_summary 記録）。LINE を呼ばないので上限の影響を受けない
 *  6. 実行サマリーを返す（ログ出力は呼出元 main() の責務）
 *
 * 戻り値の Promise が reject するのは「ジョブ全体が実行不能だった」致命的エラーのみ
 * （token 発行失敗・対象抽出クエリ自体の失敗）。準備判定の失敗は致命的エラーではなく、
 * 「その実行では 1 通も送らない（理由つきで記録する）」という結果に倒す。
 */
export async function runDeliveryJob(params: RunDeliveryJobParams): Promise<RunSummary> {
  const now = params.now ?? (() => new Date());
  const logger = params.logger ?? defaultLogger;
  const { hour, date } = resolveJstNow(now());

  // design.md「認証: Stateless channel access token をジョブ開始時に発行」。
  // 失敗はジョブ全体の致命的エラー（呼出元 main() が非0終了させる）。
  const token = await params.lineClient.issueAccessToken();

  // 準備判定は**実行の冒頭で 1 回**。対象を読む前に行うので、対象が 0 件でも結果が出る。
  const gate = createReportMenuGate({
    lineClient: params.lineClient,
    completedRichMenuId: params.completedRichMenuId,
    logger,
  });
  const reportMenuReady = (await gate.checkReady(token.accessToken)) === 'ready';

  // design.md「対象抽出: owners.delivery_hour = 現在JST時 AND 当日 daily_summaries 存在 AND
  // summary_deliveries 未存在」。クエリ自体の失敗もジョブ全体の致命的エラーとして呼出元へ伝播する。
  const readyTargets = [...(await queryDeliveryTargets(params.pool, hour, date))].sort((a, b) =>
    a.storeId.localeCompare(b.storeId),
  );
  const skipCandidates = await queryOwnersDueWithoutSummary(params.pool, hour, date);

  const ctx: RunContext = {
    pool: params.pool,
    lineClient: params.lineClient,
    gate,
    accessToken: token.accessToken,
    summaryDate: date,
    reportMenuReady,
  };

  let delivered = 0;
  let failed = 0;
  let skipped = 0;
  let quotaExceeded = 0;
  let quotaExceededStopped = false;
  let skippedNoChange = 0;
  let skippedNotComparable = 0;
  let skippedMenuUnavailable = 0;

  for (const target of readyTargets) {
    try {
      const outcome = await processReadyTarget(ctx, target, quotaExceededStopped);

      if (outcome === 'delivered') {
        delivered++;
      } else if (outcome === 'failed') {
        failed++;
      } else if (outcome === 'quota_exceeded') {
        quotaExceeded++;
        quotaExceededStopped = true;
      } else if (outcome === 'skipped_no_change') {
        skippedNoChange++;
      } else if (outcome === 'skipped_not_comparable') {
        skippedNotComparable++;
      } else if (outcome === 'skipped_menu_unavailable') {
        skippedMenuUnavailable++;
      }
      // 'already_processed' は他実行との競合による skip であり、本実行の集計には含めない。
    } catch (err) {
      // 予期しない例外（DB接続断等）からのオーナー単位隔離。この 1 件が failed として
      // 記録できているとは限らないが、少なくとも他オーナーの処理は継続する（silent drop 回避）。
      logger.isolatedError('unexpected error while processing ready target', target.storeId, err);
      failed++;
    }
  }

  for (const candidate of skipCandidates) {
    try {
      const outcome = await processSkipCandidate(params.pool, date, candidate);
      if (outcome === 'skipped') {
        skipped++;
      }
    } catch (err) {
      logger.isolatedError('unexpected error while processing skip candidate', candidate.storeId, err);
    }
  }

  return {
    event: 'delivery-job.run',
    currentJstHour: hour,
    summaryDate: date,
    targetsTotal: readyTargets.length + skipCandidates.length,
    delivered,
    failed,
    skipped,
    quotaExceeded,
    quotaExceededStopped,
    skippedNoChange,
    skippedNotComparable,
    skippedMenuUnavailable,
    reportMenuReady,
  };
}

// --- Cloud Run Job エントリ本体 -------------------------------------------------------------

/**
 * エントリの本体。必須 env を検証し、LINE クライアント・DB プールを実配線して
 * `runDeliveryJob` を実行し、実行サマリーを JSON 1 行として stdout へ出力する。
 *
 * 終了コード（go/cmd/daily-batch/main.go の「致命的エラーのみ非0終了」方針に合わせる）:
 *  - 0: 正常終了。個々のオーナーの failed/quota_exceeded/skipped が含まれていても 0
 *  - 非0（`process.exitCode = 1`）: config 欠落・DB プール構築失敗・token 発行失敗・対象抽出
 *    クエリ失敗など、ジョブ全体が実行不能だった場合のみ
 *
 * `process.exit()` ではなく `process.exitCode` を使う（プロセスを即座に kill せず、保留中の
 * I/O・`finally` の `closePool()` を完了させてから自然終了させるため。テスト容易性の面でも
 * `process.exit()` はテストプロセスごと終了させてしまうため使わない）。
 */
export async function main(): Promise<void> {
  let config: DeliveryJobConfig;
  try {
    config = loadConfig();
  } catch (err) {
    defaultLogger.fatal('config load failed', err);
    process.exitCode = 1;
    return;
  }

  const lineClient = new LineClient({
    channelId: config.lineChannelId,
    channelSecret: config.lineChannelSecret,
  });

  let pool: Awaited<ReturnType<typeof getPool>>;
  try {
    pool = await getPool();
  } catch (err) {
    defaultLogger.fatal('db pool initialization failed', err);
    process.exitCode = 1;
    return;
  }

  try {
    const summary = await runDeliveryJob({
      pool,
      lineClient,
      completedRichMenuId: config.completedRichMenuId,
    });
    const { event, ...summaryFields } = summary;
    correlationLog('info', event, summaryFields);
  } catch (err) {
    // token 発行失敗・対象抽出クエリ失敗などジョブ全体の致命的エラー（R5.1: 当日中に検知可能に）。
    defaultLogger.fatal('delivery-job run failed fatally (token issuance or target query)', err);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main()
    .catch((err: unknown) => {
      // main() 内部で全て捕捉している想定の安全網（防御的多重化）。
      defaultLogger.fatal('main() rejected unexpectedly', err);
      process.exitCode = 1;
    })
    .finally(() => {
      // closePool() 後に残っているハンドルを 1 行だけ記録する（Issue #151）。
      // 挙動は変えない（process.exit() は使わず自然終了を待つ）。ここが空でなければ、
      // 次にプロセスが終われなくなったとき 600 秒の無言タイムアウトではなく、
      // 残存ハンドルの種類がログに出て原因の起点になる。
      // main() の中ではなくここに置くのは、テストが呼ぶ main() へテストプロセス自身の
      // ハンドルを混ぜないため（テストは main() を直接 await する）。
      correlationLog('info', 'delivery-job.exit', {
        // process.exitCode は string も取りうる（Node の型定義）。移送前は直接
        // 文字列化していたため型が緩かったが、記録の型は数値を要求する。
        exitCode: typeof process.exitCode === 'number' ? process.exitCode : 0,
        activeResources: process.getActiveResourcesInfo(),
      });
    });
}
