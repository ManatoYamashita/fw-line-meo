// delivery-job の Cloud Run Job エントリポイント（Task 4.4）。
//
// Task 4.1–4.3 で実装済みの各コンポーネントを統合する:
//   - targets.ts:    対象抽出（配信可能 / skip 候補）
//   - flex.ts:        Flex Message 組立
//   - line.ts:        LINE Push（トークン発行・再送規則込み）
//   - deliveries.ts:  summary_deliveries への事前確保・結果記録
//
// design.md「毎時配信（HH:00 JST）」System Flow・「TS / delivery-job」Batch/Job Contract を
// 実装のブループリントとする:
//   SC->>DJ: run
//   DJ->>DB: 対象抽出（配信可能対象＋当日summary欠損のskip候補）
//   loop 対象オーナーごと: 予約→Flex組立→push→結果記録
//   DJ->>DJ: 実行サマリーを構造化ログ出力
//
// オーナー単位のエラー隔離が本タスクの核心的な正しさの性質: 1 オーナーの Flex 組立失敗・
// Push 例外が他オーナーの処理を止めてはならない（design.md Error Strategy「店舗単位・オーナー
// 単位でエラーを隔離し、失敗は必ず行またはログに痕跡を残す（silent drop 禁止）」）。

import { randomUUID } from 'node:crypto';

import { closePool, getPool } from '@fwlm/db';
import type { Queryable, SummaryDeliveryStatus } from '@fwlm/db';

import { buildDailySummaryFlex } from './flex.js';
import type { FlexMessagePayload } from './flex.js';
import { LineClient } from './line.js';
import type { LinePushResult } from './line.js';
import { queryDeliveryTargets, queryOwnersDueWithoutSummary } from './targets.js';
import type { DeliveryTarget, SkippedNoSummaryTarget } from './targets.js';
import { recordDeliveryResult, reserveDelivery } from './deliveries.js';

// --- 設定読取（Task 4.4 の一部・dashboard-api の loadConfig 規約に準拠: 必須 env 欠落は
// 起動時に明示エラーで fail-fast する） -------------------------------------------------

export interface DeliveryJobConfig {
  /** LINE チャネル ID（Stateless token 発行の client_id）。 */
  readonly lineChannelId: string;
  /** LINE チャネルシークレット（Stateless token 発行の client_secret。ログに出さない）。 */
  readonly lineChannelSecret: string;
  /** 「詳細を見る」ボタンの遷移先 LIFF URL（design.md: `https://liff.line.me/{liffId}`）。
   * LIFF チャネル自体の作成・ID 発行は store-detail 側（task 5.x・6.2）の責務であり、
   * 本タスクは完成済みの URL 文字列を env 経由で受け取るのみとする（CONCERNS 参照）。 */
  readonly liffUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DeliveryJobConfig {
  const lineChannelId = env.LINE_CHANNEL_ID;
  const lineChannelSecret = env.LINE_CHANNEL_SECRET;
  const liffUrl = env.LIFF_URL;

  if (!lineChannelId) {
    throw new Error('LINE_CHANNEL_ID is required');
  }
  if (!lineChannelSecret) {
    throw new Error('LINE_CHANNEL_SECRET is required');
  }
  if (!liffUrl) {
    throw new Error('LIFF_URL is required');
  }

  return { lineChannelId, lineChannelSecret, liffUrl };
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
 * line.ts の LinePushResult（'success'|'failed'|'quota_exceeded'）は summary_deliveries.status
 * の許容値（'delivered'|'failed'|'quota_exceeded'|'skipped_no_summary'）のうち 'skipped_no_summary'
 * を除く 3 値と 1:1 対応する。
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

export interface DeliveryJobLogger {
  isolatedError(message: string, storeId: string, err: unknown): void;
  fatal(message: string, err: unknown): void;
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const defaultLogger: DeliveryJobLogger = {
  isolatedError(message, storeId, err) {
    console.error(
      JSON.stringify({
        event: 'delivery-job.isolated_error',
        message,
        storeId,
        error: errorMessageOf(err),
      }),
    );
  },
  fatal(message, err) {
    console.error(
      JSON.stringify({
        event: 'delivery-job.fatal',
        message,
        error: errorMessageOf(err),
      }),
    );
  },
};

// --- 1 オーナー分の処理（対象抽出済みの配信可能対象） ----------------------------------------

type ReadyOutcome = 'delivered' | 'failed' | 'quota_exceeded' | 'already_processed';

async function processReadyTarget(
  pool: Queryable,
  lineClient: LineClient,
  liffUrl: string,
  summaryDate: string,
  accessToken: string,
  target: DeliveryTarget,
): Promise<ReadyOutcome> {
  const retryKey = randomUUID();
  const reserveOutcome = await reserveDelivery(pool, target.storeId, summaryDate, target.lineUserId, retryKey);
  if (reserveOutcome === 'already_processed') {
    // 他の実行（同時実行・再実行）が既に処理済み。R3.9: 同日重複配信禁止。
    return 'already_processed';
  }

  let flexPayload: FlexMessagePayload;
  try {
    flexPayload = buildDailySummaryFlex(target.summary, liffUrl);
  } catch (err) {
    // Flex 組立失敗（FlexBubbleTooLargeError 等）はこのオーナーのみの failed として記録し、
    // 他オーナーの処理は継続する（silent drop にしない・design.md Error Strategy）。
    await recordDeliveryResult(
      pool,
      target.storeId,
      summaryDate,
      'failed',
      null,
      `flex build failed: ${errorMessageOf(err)}`,
    );
    return 'failed';
  }

  const pushResult = await lineClient.pushMessage(accessToken, target.lineUserId, [flexPayload], retryKey);
  const outcome = describePushOutcome(pushResult);
  await recordDeliveryResult(
    pool,
    target.storeId,
    summaryDate,
    outcome.status,
    pushResult.requestId,
    outcome.errorDetail,
    outcome.deliveredAt,
  );

  if (outcome.status === 'delivered') return 'delivered';
  if (outcome.status === 'quota_exceeded') return 'quota_exceeded';
  return 'failed';
}

/**
 * 月次クォータ超過（quota_exceeded）検知後の「残対象」向け処理。
 *
 * design.md「LINE 429（月次クォータ超過）: 残対象を quota_exceeded 記録し即終了（無駄な連打を
 * しない）」の解釈: 「即終了」は Push の連打停止を意味し、残対象を未記録のまま放置すること
 * ではない（design.md の silent drop 禁止原則・Error Strategy と整合させるための安全側の判断。
 * CONCERNS 参照）。Push は一切試みず、summary_deliveries 行のみを quota_exceeded で確保する。
 */
async function backfillQuotaExceeded(
  pool: Queryable,
  summaryDate: string,
  target: DeliveryTarget,
): Promise<'quota_exceeded' | 'already_processed'> {
  const retryKey = randomUUID();
  const reserveOutcome = await reserveDelivery(pool, target.storeId, summaryDate, target.lineUserId, retryKey);
  if (reserveOutcome === 'already_processed') {
    return 'already_processed';
  }
  await recordDeliveryResult(
    pool,
    target.storeId,
    summaryDate,
    'quota_exceeded',
    null,
    'skipped: LINE monthly quota exceeded earlier in this run (push not attempted for this target)',
  );
  return 'quota_exceeded';
}

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
  await recordDeliveryResult(
    pool,
    candidate.storeId,
    summaryDate,
    'skipped_no_summary',
    null,
    'daily_summaries not found for today (06:00 batch failure or not yet run)',
  );
  return 'skipped';
}

// --- オーケストレーション本体（テスト可能に DI 化。main() から実配線で呼ばれる） ----------------

export interface RunSummary {
  readonly event: 'delivery-job.run';
  readonly currentJstHour: number;
  readonly summaryDate: string;
  /** 今回の実行で見つかった対象の総数（配信可能対象＋skip候補）。 */
  readonly targetsTotal: number;
  readonly delivered: number;
  readonly failed: number;
  readonly skipped: number;
  readonly quotaExceeded: number;
  /** true = 実行中に quota_exceeded を検知し、以降の配信可能対象への Push を打ち切った。 */
  readonly quotaExceededStopped: boolean;
}

export interface RunDeliveryJobParams {
  readonly pool: Queryable;
  readonly lineClient: LineClient;
  readonly liffUrl: string;
  /** テスト用に現在時刻を注入する（既定 `() => new Date()`）。 */
  readonly now?: () => Date;
  readonly logger?: DeliveryJobLogger;
}

/**
 * delivery-job 1 回分の実行本体。
 *
 * 手順（design.md「毎時配信（HH:00 JST）」System Flow に対応）:
 *  1. Stateless channel access token をジョブ開始時に発行（design.md Batch/Job Contract）
 *  2. 配信可能対象（queryDeliveryTargets）と skip 候補（queryOwnersDueWithoutSummary）を抽出
 *  3. 配信可能対象を storeId 昇順の決定的な順序で処理（予約→Flex組立→push→記録）。
 *     quota_exceeded 検知後は残対象を Push なしで quota_exceeded 記録する
 *  4. skip 候補を処理（予約→skipped_no_summary 記録）。quota_exceeded の有無に関わらず必ず実行する
 *     （LINE API を一切呼ばないため「無駄な連打」に該当しない）
 *  5. 実行サマリーを返す（ログ出力は呼出元 main() の責務）
 *
 * 戻り値の Promise が reject するのは「ジョブ全体が実行不能だった」致命的エラーのみ
 * （token 発行失敗・対象抽出クエリ自体の失敗）。個々のオーナーの失敗はここでは投げず
 * RunSummary の件数に反映される（オーナー単位のエラー隔離）。
 */
export async function runDeliveryJob(params: RunDeliveryJobParams): Promise<RunSummary> {
  const now = params.now ?? (() => new Date());
  const logger = params.logger ?? defaultLogger;
  const { hour, date } = resolveJstNow(now());

  // design.md「認証: Stateless channel access token をジョブ開始時に発行」。
  // 失敗はジョブ全体の致命的エラー（呼出元 main() が非0終了させる）。
  const token = await params.lineClient.issueAccessToken();

  // design.md「対象抽出: owners.delivery_hour = 現在JST時 AND 当日 daily_summaries 存在 AND
  // summary_deliveries 未存在」。クエリ自体の失敗もジョブ全体の致命的エラーとして呼出元へ伝播する。
  const readyTargets = [...(await queryDeliveryTargets(params.pool, hour, date))].sort((a, b) =>
    a.storeId.localeCompare(b.storeId),
  );
  const skipCandidates = await queryOwnersDueWithoutSummary(params.pool, hour, date);

  let delivered = 0;
  let failed = 0;
  let skipped = 0;
  let quotaExceeded = 0;
  let quotaExceededStopped = false;

  for (const target of readyTargets) {
    try {
      if (quotaExceededStopped) {
        const outcome = await backfillQuotaExceeded(params.pool, date, target);
        if (outcome === 'quota_exceeded') {
          quotaExceeded++;
        }
        continue;
      }

      const outcome = await processReadyTarget(
        params.pool,
        params.lineClient,
        params.liffUrl,
        date,
        token.accessToken,
        target,
      );

      if (outcome === 'delivered') {
        delivered++;
      } else if (outcome === 'failed') {
        failed++;
      } else if (outcome === 'quota_exceeded') {
        quotaExceeded++;
        quotaExceededStopped = true;
      }
      // 'already_processed' は他実行との競合によるskipであり、本実行の集計には含めない。
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
    const summary = await runDeliveryJob({ pool, lineClient, liffUrl: config.liffUrl });
    console.log(JSON.stringify(summary));
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
  main().catch((err: unknown) => {
    // main() 内部で全て捕捉している想定の安全網（防御的多重化）。
    defaultLogger.fatal('main() rejected unexpectedly', err);
    process.exitCode = 1;
  });
}
