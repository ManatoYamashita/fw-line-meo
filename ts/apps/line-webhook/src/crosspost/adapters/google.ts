// Google ビジネスプロフィールの投稿先アダプタ（line-crosspost design.md「Google の発信先アダプタ」・tasks 4.2）。
//
// 連携（OAuth）・トークン・ロケーションの身元は gbp-post-review-reply が所有し、ここは読むだけ。
// 投稿は gbp/client.ts の publishLocalPost（既存の createLocalPost は変えない）。
//
// **GBP API は未承認（GBP API の利用申請の Issue 146）で、この分類は実測していない。** 状態コードの意味は HTTP の一般的な意味に依る。
// 判断の規律: **作成済みの可能性を否定できない応答は「結果不明」**にし、自動でも店主の操作でも、確認なしには再送しない。
// 5xx はすべて結果不明（503 を含む）。503 は「処理していない」ことが多いが、Google が投稿を作った後に 503 を返さない
// という一次情報は無いので、「失敗（再送してよい）」に倒さない（PR #514 のレビュー指摘）。
//
// 結果の分類（design.md の表と 1:1）:
// | 状況 | 分類 | retryable |
// | 送信前の失敗: 未連携 | failed not_linked | false |
// | 送信前の失敗: 失効・復号不能 | failed token_invalid | false |
// | 送信前の失敗: 権限 | failed permission_denied | false |
// | 送信前の失敗: トークンの取得の一時的な失敗・429 | failed upstream_unavailable / rate_limited | true |
// | 401・403 | failed permission_denied | false |
// | 429 | failed rate_limited | true |
// | その他の 4xx | failed rejected | false |
// | 5xx（500・502・503・504 ほか） | unknown upstream_5xx | — |
// | 通信の例外 | unknown network（時間切れなら timeout） | — |
// | 2xx | succeeded | — |

import type { GbpLocationRow, Queryable } from '@fwlm/db';
import type { GbpApiError, GbpLocalPostPublisher, LocalPostPublishResult } from '../../gbp/client.js';
import type { Availability, ContentShape, DestinationAdapter, PublishOutcome } from './types.js';

/** Google の写真の条件（前提資料 §4.5: 短辺 250px 以上・10,240 バイト以上・5MB 以下）。 */
const GOOGLE_MIN_SHORT_EDGE = 250;
const GOOGLE_MIN_BYTES = 10_240;
const GOOGLE_MAX_BYTES = 5 * 1024 * 1024;

export interface GoogleAdapterDeps {
  db: Queryable;
  /** 投稿先ごとの有効化（CROSSPOST_GOOGLE_ENABLED）と GBP の連携の設定の両方が揃ったときだけ true。 */
  enabled: boolean;
  isLinked: (db: Queryable, key: { ownerId: string; storeId: string }) => Promise<boolean>;
  getLocation: (db: Queryable, key: { ownerId: string; storeId: string }) => Promise<GbpLocationRow | null>;
  client: GbpLocalPostPublisher;
}

export function classifyNotSent(error: GbpApiError): PublishOutcome {
  switch (error.kind) {
    case 'not_linked':
      return { kind: 'failed', reason: 'not_linked', retryable: false };
    case 'token_invalid':
    case 'crypto_error':
      return { kind: 'failed', reason: 'token_invalid', retryable: false };
    case 'permission_denied':
      return { kind: 'failed', reason: 'permission_denied', retryable: false };
    case 'rate_limited':
      return { kind: 'failed', reason: 'rate_limited', retryable: true };
    case 'incomplete_listing':
    case 'upstream_error':
      // トークンの取得（Google のトークンのエンドポイント）の一時的な失敗。投稿は送っていない。
      return { kind: 'failed', reason: 'upstream_unavailable', retryable: true };
  }
}

/**
 * 送信の後に受け取った HTTP の状態コードの分類。4xx は「Google が要求を受け付けなかった」（投稿は作られていない）、
 * 5xx は「作られたかどうか分からない」。429 は割り当ての超過による拒否で、処理の前に断られるものとして再送を許す
 * （GBP API での実測は無い・未確認）。
 */
export function classifyStatus(status: number): PublishOutcome {
  if (status === 401 || status === 403) return { kind: 'failed', reason: 'permission_denied', retryable: false };
  if (status === 429) return { kind: 'failed', reason: 'rate_limited', retryable: true };
  if (status >= 500) return { kind: 'unknown', reason: 'upstream_5xx' };
  return { kind: 'failed', reason: 'rejected', retryable: false };
}

export function classifyLocalPostResult(result: LocalPostPublishResult): PublishOutcome {
  switch (result.kind) {
    case 'created':
      return { kind: 'succeeded', externalId: result.postName, externalUrl: result.searchUrl };
    case 'not_sent':
      return classifyNotSent(result.error);
    case 'rejected':
      return classifyStatus(result.status);
    case 'indeterminate':
      return { kind: 'unknown', reason: result.aborted ? 'timeout' : 'network' };
  }
}

function mediaFits(content: ContentShape): boolean {
  const media = content.media;
  if (media === null) return true;
  return (
    Math.min(media.width, media.height) >= GOOGLE_MIN_SHORT_EDGE &&
    media.byteSize >= GOOGLE_MIN_BYTES &&
    media.byteSize <= GOOGLE_MAX_BYTES
  );
}

export function createGoogleAdapter(deps: GoogleAdapterDeps): DestinationAdapter {
  return {
    destination: 'google',

    async availability(ctx, content): Promise<Availability> {
      if (!deps.enabled) return { kind: 'not_ready' };
      if (!(await deps.isLinked(deps.db, ctx))) return { kind: 'needs_connection' };
      const location = await deps.getLocation(deps.db, ctx);
      // トークンはあるのにロケーションの身元が無い = 連携が壊れている。張り直してもらう。
      if (location === null) return { kind: 'needs_relink' };
      if (!location.can_operate_local_post) return { kind: 'unsupported_content', issue: 'posting_not_permitted' };
      if (!mediaFits(content)) return { kind: 'unsupported_content', issue: 'media_size' };
      return { kind: 'available' };
    },

    async publish(input): Promise<PublishOutcome> {
      if (!deps.enabled) return { kind: 'failed', reason: 'not_ready', retryable: false };
      const result = await deps.client.publishLocalPost(
        deps.db,
        {
          ownerId: input.ownerId,
          storeId: input.storeId,
          summary: input.bodyText,
          photoUrl: input.media?.fetchUrl ?? null,
        },
        { signal: input.signal },
      );
      return classifyLocalPostResult(result);
    },
  };
}
