// Instagram の投稿先アダプタ（line-crosspost design.md「Instagram の発信先アダプタ」）。
//
// **v1 は API を呼ばない。** Meta のログイン方式（Unified Login／Instagram Login）が決まるまで、API のホスト・
// 権限・トークンの種類が決まらないため（前提資料 §0.1-1・research.md Decision 4）。推測で実装を固定しない。
// availability は常に not_ready を返し、publisher はこの投稿先を承認させない。万一 publish が呼ばれても
// 何も送らずに failed（not_ready・再試行不可）を返す。
//
// 接続するときの契約（tasks 7.2）:
//   1. checkpoint が無ければコンテナを作り、ID を saveCheckpoint してから次へ進む
//   2. コンテナの状態が FINISHED になるまで時間制限の内で確かめる（ERROR は failed・時間切れは unknown）
//   3. 公開する。応答を失ったら unknown
//   4. 再試行・照合は checkpoint のコンテナの状態で判定する（PUBLISHED は succeeded、FINISHED は公開だけ、
//      EXPIRED は新しく作る）
//   写真の条件（JPEG・縦横比・幅・大きさ）は availability に置く。数値は実装の時点で公式文書を再確認して写す。

import type { CrosspostDestination } from '../domain.js';
import type { DestinationAdapter } from './types.js';

/**
 * API を呼ばない「準備中」の投稿先。Instagram（v1）と、有効化の前の Google に使う。
 * availability は常に not_ready なので承認されない。万一 publish が呼ばれても何も送らない。
 */
export function createNotReadyAdapter(destination: CrosspostDestination): DestinationAdapter {
  return {
    destination,
    async availability() {
      return { kind: 'not_ready' };
    },
    async publish() {
      return { kind: 'failed', reason: 'not_ready', retryable: false };
    },
  };
}

export function createInstagramAdapter(): DestinationAdapter {
  return createNotReadyAdapter('instagram');
}
