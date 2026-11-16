// 投稿先アダプタの契約（line-crosspost design.md「DestinationAdapter」・Requirement 9）。
//
// 共通の処理（承認・実行権の獲得・状態の記録・通知）は publisher.ts が持ち、媒体固有の API 処理だけをアダプタが持つ。
// アダプタは flows・publisher・DB の状態を知らない。
//
// 結果の分類の規律（Req 6.2, 6.3）:
// - succeeded: 投稿されたことが確か
// - failed:    **投稿されていないことが確か**。retryable は「もう一度送ってよい」か（一時的な理由のときだけ真）
// - unknown:   投稿されたかどうか確かめられない。送信の後の通信断・時間切れ・判断のつかない応答はすべてここ。
//              送信の前か後か分からない失敗も unknown に倒す（再投稿で重複を作らない側へ倒す）
// アダプタは例外を投げない契約。投げても publisher が unknown（adapter_threw）に畳む。

import type { CrosspostDestination, CrosspostFailureReason, CrosspostUnknownReason } from '../domain.js';

/** 投稿する内容の形（availability の判定に使う。本文は含めない）。 */
export interface ContentShape {
  media: { width: number; height: number; byteSize: number } | null;
}

export type ContentIssue =
  /** この投稿先は写真が必要（Instagram）。 */
  | 'media_required'
  /** 写真の縦横比が投稿先の条件に合わない。 */
  | 'media_aspect_ratio'
  /** 写真が小さすぎる・大きすぎる。 */
  | 'media_size'
  /** 写真を投稿先へ渡す手段がまだ無い（取得用 URL の方式が未決定・tasks 6.2）。 */
  | 'media_not_deliverable'
  /** 連携はあるが、この店舗では投稿の権限が無い（GBP の canOperateLocalPost = false など）。 */
  | 'posting_not_permitted';

export type Availability =
  | { kind: 'available' }
  /** 未連携。連携の導線を出す。 */
  | { kind: 'needs_connection' }
  /** 連携の期限切れ・権限の喪失が分かっている。 */
  | { kind: 'needs_relink' }
  /** 本機能の側で未接続（API の承認待ち・アダプタ未実装・投稿先の有効化前）。 */
  | { kind: 'not_ready' }
  | { kind: 'unsupported_content'; issue: ContentIssue };

export interface PublishInput {
  ownerId: string;
  storeId: string;
  deliveryId: string;
  /** 承認の時点の本文の写し。 */
  bodyText: string;
  /** 写真（承認の時点で付けていたときだけ）。fetchUrl は投稿の実行中だけ有効。 */
  media: { fetchUrl: string; width: number; height: number; byteSize: number } | null;
  /** 前の試行で保存した途中の到達点（例: Instagram の公開前のコンテナ ID）。 */
  checkpoint: string | null;
  /** 時間制限。アダプタは外部の呼び出しへ渡す。 */
  signal: AbortSignal;
}

export type PublishOutcome =
  | { kind: 'succeeded'; externalId: string | null; externalUrl: string | null }
  | { kind: 'failed'; reason: CrosspostFailureReason; retryable: boolean }
  | { kind: 'unknown'; reason: CrosspostUnknownReason };

export interface ReconcileInput {
  ownerId: string;
  storeId: string;
  deliveryId: string;
  bodyText: string;
  checkpoint: string | null;
  /** 最後の試行を始めた時刻（照合の範囲を絞る）。 */
  attemptedAt: Date | null;
  signal: AbortSignal;
}

export type ReconcileOutcome =
  | { kind: 'posted'; externalId: string | null; externalUrl: string | null }
  | { kind: 'not_posted' }
  /** 照合しても分からなかった（店主による確認に倒す）。 */
  | { kind: 'still_unknown' };

export interface DestinationAdapter {
  readonly destination: CrosspostDestination;
  availability(ctx: { ownerId: string; storeId: string }, content: ContentShape): Promise<Availability>;
  /**
   * 投稿する。`saveCheckpoint` は DB に書いてから解決する。途中の到達点（公開前のコンテナなど）を作ったら、
   * 次の外部呼び出しの前に必ず await すること（Req 9.3）。
   */
  publish(input: PublishInput, saveCheckpoint: (checkpoint: string) => Promise<void>): Promise<PublishOutcome>;
  /** 結果不明の照合。照合の手段を持たない投稿先は省略する（店主による確認に倒す）。 */
  reconcile?(input: ReconcileInput): Promise<ReconcileOutcome>;
}
