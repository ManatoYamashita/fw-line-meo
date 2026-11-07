// LINE 起点の一括発信（line-crosspost spec・Issue #494）の共通の型と定数。
// 状態の正典は DB（migration 0019）で、ここは DB の値をそのまま使う（@fwlm/db の型を再輸出する）。

import { CROSSPOST_MEDIA_RETENTION_MS } from '@fwlm/db';
import type {
  CrosspostDestination,
  CrosspostFailureReason,
  CrosspostUnknownReason,
} from '@fwlm/db';

export type { CrosspostDestination, CrosspostFailureReason, CrosspostUnknownReason };

/** 店主に見せる投稿先の名前。 */
export const DESTINATION_LABELS: Readonly<Record<CrosspostDestination, string>> = {
  instagram: 'Instagram',
  google: 'Google',
};

/** 投稿先の表示順（カルーセル・結果の並び）。 */
export const DESTINATION_ORDER: readonly CrosspostDestination[] = ['instagram', 'google'];

/** 作成中の下書きの期限（最後の操作から）。 */
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

/** 下書きの保存期間（作成から）。過ぎた行は line-webhook が削除する（design.md「Data Models」）。 */
export const DRAFT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 同じ投稿先への試行回数の上限（初回を含む・Req 6.8）。 */
export const MAX_DELIVERY_ATTEMPTS = 3;

/** 実行中のまま、これより古くなった投稿先は「結果不明」として扱う（Req 6.9）。 */
export const STALE_IN_PROGRESS_MS = 5 * 60 * 1000;

/** 1 回の操作のたびに消す、保存期間を過ぎた下書きの件数の上限。 */
export const PURGE_BATCH_SIZE = 20;

/**
 * 承認から、待ち（queued・一度も送っていない）の投稿先の再開を許す時間（Req 6.11）。過ぎたら送らずに取りやめる。
 * 店主が承認した時点の内容（「本日限定」など）を、時間が経ってから知らないうちに出さないため。
 */
export const QUEUED_RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 写真の保存期間（受け取りから・Req 8.3）。配信ジョブと共有する値（@fwlm/db）。 */
export const MEDIA_RETENTION_MS = CROSSPOST_MEDIA_RETENTION_MS;

/** 店舗を選ばせるときに出す件数の上限（Flex カルーセルの上限 12 未満・GBP の会話と同じ 10）。 */
export const MAX_SELECTABLE_STORES = 10;

/**
 * 生成の目安の字数（クリップボードの上限 1,000 字に収める・research.md Decision 1）。
 * 受理条件の上限（Instagram 2,200・Google 1,500）とは別に、生成した文と店主の書き直しに課す。
 */
export const TEXT_TARGET_MAX_CHARS: Readonly<Record<CrosspostDestination, number>> = {
  instagram: 600,
  google: 400,
};

/** 各媒体の受理条件の上限（migration 0019 の CHECK と同じ値）。 */
export const TEXT_HARD_MAX_CHARS: Readonly<Record<CrosspostDestination, number>> = {
  instagram: 2200,
  google: 1500,
};

/** クリップボードのアクションに載せられる字数の上限（LINE の仕様）。 */
export const CLIPBOARD_MAX_CHARS = 1000;

/** 店主の 1 通の文の扱える上限（素材の合計は 2,000 字・@fwlm/db の CROSSPOST_MATERIAL_MAX_CHARS）。 */
export const MESSAGE_MAX_CHARS = 2000;

/** 文字数（コードポイント数）。サロゲートペアを 1 字と数える。 */
export function charLength(text: string): number {
  return [...text].length;
}

/** 店主に見せる、失敗の平易な理由。 */
export const FAILURE_REASON_LABELS: Readonly<Record<CrosspostFailureReason, string>> = {
  not_ready: 'この投稿先はまだ準備中です。',
  not_linked: '連携されていません。',
  token_invalid: '連携の期限が切れています。もう一度連携してください。',
  permission_denied: 'この投稿先へ投稿する権限がありません。',
  rejected: '投稿先が内容を受け付けませんでした。',
  rate_limited: '短い時間に投稿が集中したため、受け付けられませんでした。',
  upstream_unavailable: '投稿先が一時的に使えませんでした。',
  media_unavailable: '写真を投稿先へ渡せませんでした。',
  unsupported_content: 'この写真・文はこの投稿先の条件に合いません。',
  owner_reported_not_posted: '投稿されていなかったことを確かめました。',
};
