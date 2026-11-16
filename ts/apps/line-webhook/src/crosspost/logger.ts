// 一括発信の構造化ログ（line-crosspost design.md「Monitoring」・Requirement 7.4, 8.5）。
//
// 不変条件（gbp/logger.ts と同じ規律）:
// - 項目は allowlist（CrosspostLogMeta）。投稿文・素材・修正指示・写真・URL・トークン・LINE ユーザー ID は
//   型として渡せない。sink 側でも明示的に取り出す（余剰プロパティを spread しない）。
// - 例外は名前（Error.name）だけを errorKind に載せる。message は載せない。
// - 事象名は docs/observability/log-field-canon.md に登録したものだけを使う。

import { writeStructuredLog } from '@fwlm/observability';
import type { CrosspostDestination } from './domain.js';

export type CrosspostLogEvent =
  /** 投稿先の 1 回の試行が終わった（結果の記録の後）。 */
  | 'crosspost.delivery_finished'
  /** 写真を受け付けなかった（形式・大きさ・取得できない）。 */
  | 'crosspost.media_rejected'
  /** 投稿文を作れなかった。 */
  | 'crosspost.generation_failed'
  /** 写真の実体の削除に失敗した（置き場の寿命の規則が後で消す）。 */
  | 'crosspost.media_cleanup_failed'
  /** 投稿の結果を Reply でも Push でも届けられなかった（結果は DB にあり、次の操作で示す）。 */
  | 'crosspost.notify_failed'
  /** 想定外の例外（会話の処理・アダプタ・置き場）。 */
  | 'crosspost.operation_failed';

export interface CrosspostLogMeta {
  ownerId?: string;
  storeId?: string;
  destination?: CrosspostDestination;
  /** crosspost_delivery_status の値。 */
  deliveryStatus?: string;
  /** 閉じた語彙の理由（失敗の理由・結果不明の理由・写真の拒否の理由・生成の失敗の種別）。 */
  reason?: string;
  /** 試行の回数。 */
  attempt?: number;
  /** 処理の段階（approve・publish・intake・generate・cleanup など閉じた語彙）。 */
  operation?: string;
  /** Error.name だけ。 */
  errorName?: string;
  /** HTTP ステータス（取得・置き場）。 */
  status?: number;
}

export interface CrosspostLogger {
  info(event: CrosspostLogEvent, meta?: CrosspostLogMeta): void;
  warn(event: CrosspostLogEvent, meta?: CrosspostLogMeta): void;
  error(event: CrosspostLogEvent, meta?: CrosspostLogMeta): void;
}

function write(level: 'info' | 'warn' | 'error', event: CrosspostLogEvent, meta?: CrosspostLogMeta): void {
  writeStructuredLog(level, event, {
    ...(meta?.ownerId !== undefined ? { ownerId: meta.ownerId } : {}),
    ...(meta?.storeId !== undefined ? { storeId: meta.storeId } : {}),
    ...(meta?.destination !== undefined ? { crosspostDestination: meta.destination } : {}),
    ...(meta?.deliveryStatus !== undefined ? { crosspostDeliveryStatus: meta.deliveryStatus } : {}),
    ...(meta?.reason !== undefined ? { reason: meta.reason } : {}),
    ...(meta?.attempt !== undefined ? { crosspostAttempt: meta.attempt } : {}),
    ...(meta?.operation !== undefined ? { crosspostOperation: meta.operation } : {}),
    ...(meta?.errorName !== undefined ? { errorKind: meta.errorName } : {}),
    ...(meta?.status !== undefined ? { status: meta.status } : {}),
  });
}

export function createDefaultCrosspostLogger(): CrosspostLogger {
  return {
    info: (event, meta) => write('info', event, meta),
    warn: (event, meta) => write('warn', event, meta),
    error: (event, meta) => write('error', event, meta),
  };
}

/** 例外から記録してよいのはコンストラクタ名だけ。 */
export function errorNameOf(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  return /^[A-Za-z0-9_.-]{1,64}$/.test(error.name) ? error.name : 'unredactable';
}

// sink の取り出しの漏れを型で検出する（gbp/logger.ts と同じ形）。
type EmittedField =
  | 'ownerId'
  | 'storeId'
  | 'destination'
  | 'deliveryStatus'
  | 'reason'
  | 'attempt'
  | 'operation'
  | 'errorName'
  | 'status';
type UnemittedField = Exclude<keyof NonNullable<Parameters<typeof write>[2]>, EmittedField>;
const _allFieldsEmitted: never = null as unknown as UnemittedField;
void _allFieldsEmitted;
