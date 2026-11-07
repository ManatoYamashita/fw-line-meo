// 投稿の共通処理（line-crosspost design.md「publisher」・Requirement 5.4〜5.7, 6, 9）。
//
// - 承認: 投稿先ごとに availability を確かめ、1 つでも使えなければ承認しない。承認と投稿先の行の作成は
//   @fwlm/db の approveCrosspostDraft が 1 トランザクションで行う（版の一致を条件にした CAS）。
// - 実行: 投稿先ごとに実行権を獲得（CAS）してから、時間制限つきでアダプタを呼ぶ。投稿先どうしは並行で、
//   ある投稿先の失敗はほかを止めない（Req 6.1）。
// - 結果の記録は獲得した試行の回数を条件にする（遅れて戻った古い試行が上書きしない）。
// - アダプタの例外・時間切れは unknown に畳む（送ったかどうか分からないものは再投稿しない側へ倒す・Req 6.3）。
//   時間切れは AbortSignal で知らせたうえで、アダプタが従わなくても一定時間で打ち切る。

import type {
  CrosspostDeliveryContext,
  CrosspostDeliveryRow,
  CrosspostOutcomeRecord,
  Queryable,
  TransactionCapable,
} from '@fwlm/db';
import {
  approveCrosspostDraft,
  claimCrosspostDelivery,
  getCrosspostDelivery,
  getCrosspostMedia,
  listCrosspostDeliveries,
  markStaleCrosspostDeliveries,
  recordCrosspostOutcome,
  releaseSettledCrosspostMedia,
  resolveUnknownCrosspostDelivery,
  saveCrosspostCheckpoint,
} from '@fwlm/db';
import type { Availability, ContentShape, DestinationAdapter, PublishOutcome } from './adapters/types.js';
import {
  DESTINATION_ORDER,
  MAX_DELIVERY_ATTEMPTS,
  STALE_IN_PROGRESS_MS,
  type CrosspostDestination,
} from './domain.js';
import { errorNameOf, type CrosspostLogger } from './logger.js';
import type { MediaStore } from './media.js';

/** 投稿先ごとの時間制限（アダプタの 1 回の試行の全体）。 */
export const DEFAULT_PUBLISH_TIMEOUT_MS: Readonly<Record<CrosspostDestination, number>> = {
  instagram: 45_000,
  google: 15_000,
};
/** 照合の時間制限。 */
const RECONCILE_TIMEOUT_MS = 15_000;
/** 投稿先へ渡す取得用 URL の寿命。投稿の実行の間だけ使えればよい。 */
const FETCH_URL_TTL_SECONDS = 10 * 60;
/** AbortSignal に従わないアダプタを打ち切るまでの猶予。 */
const ABORT_GRACE_MS = 2_000;

export type AvailabilityMap = Readonly<Record<CrosspostDestination, Availability>>;

export type ApproveResult =
  | { kind: 'approved'; deliveries: CrosspostDeliveryRow[] }
  /** 版の不一致・二重の承認・確認中でない（何も変えていない）。 */
  | { kind: 'stale' }
  /** 選んだ投稿先のどれかが使えない（何も変えていない）。 */
  | { kind: 'unavailable'; availability: AvailabilityMap };

export type RetryResult =
  | { kind: 'ran'; delivery: CrosspostDeliveryContext }
  /** 再試行できない（成功済み・結果不明・上限・他のオーナー）。 */
  | { kind: 'not_retryable'; delivery: CrosspostDeliveryContext | null };

export type ReconcileResult =
  | { kind: 'resolved'; delivery: CrosspostDeliveryContext }
  /** 照合の手段が無い・照合しても分からない。店主による確認に倒す。 */
  | { kind: 'needs_owner'; delivery: CrosspostDeliveryContext }
  | { kind: 'not_unknown'; delivery: CrosspostDeliveryContext | null };

export interface CrosspostPublisher {
  availability(ctx: { ownerId: string; storeId: string; draftId: string }): Promise<AvailabilityMap>;
  approve(input: {
    ownerId: string;
    storeId: string;
    draftId: string;
    revision: number;
    destinations: readonly CrosspostDestination[];
  }): Promise<ApproveResult>;
  /** 承認の直後に、待ち（queued）の投稿先をすべて実行する。結果の行（表示順）を返す。 */
  runApproved(ownerId: string, draftId: string): Promise<CrosspostDeliveryContext[]>;
  retry(ownerId: string, deliveryId: string): Promise<RetryResult>;
  reconcile(ownerId: string, deliveryId: string): Promise<ReconcileResult>;
  /** 店主による確認（posted = 投稿されていた）。結果不明でなければ null。 */
  markObserved(ownerId: string, deliveryId: string, posted: boolean): Promise<CrosspostDeliveryContext | null>;
  /** 実行中のまま古くなった行を結果不明へ移す（状況の表示・再試行・確認の前に呼ぶ）。 */
  reapStale(ownerId: string): Promise<void>;
}

export interface PublisherDeps {
  db: Queryable;
  pool: TransactionCapable;
  adapters: Readonly<Record<CrosspostDestination, DestinationAdapter>>;
  mediaStore: MediaStore;
  logger: CrosspostLogger;
  now?: () => Date;
  timeoutsMs?: Readonly<Record<CrosspostDestination, number>>;
}

export function createCrosspostPublisher(deps: PublisherDeps): CrosspostPublisher {
  const now = deps.now ?? (() => new Date());
  const timeouts = deps.timeoutsMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;

  async function availabilityFor(
    ownerId: string,
    storeId: string,
    content: ContentShape,
  ): Promise<AvailabilityMap> {
    const entries = await Promise.all(
      DESTINATION_ORDER.map(async (destination): Promise<[CrosspostDestination, Availability]> => {
        try {
          let result = await deps.adapters[destination].availability({ ownerId, storeId }, content);
          // 写真付きで、投稿先へ写真を渡す手段がまだ無いなら使えない（写真を黙って落とさない）。
          if (result.kind === 'available' && content.media !== null && !deps.mediaStore.canIssueFetchUrl) {
            result = { kind: 'unsupported_content', issue: 'media_not_deliverable' };
          }
          return [destination, result];
        } catch (error) {
          deps.logger.warn('crosspost.operation_failed', {
            ownerId,
            storeId,
            destination,
            operation: 'availability',
            errorName: errorNameOf(error),
          });
          return [destination, { kind: 'not_ready' }];
        }
      }),
    );
    return Object.fromEntries(entries) as Record<CrosspostDestination, Availability>;
  }

  async function contentOf(ownerId: string, draftId: string): Promise<ContentShape> {
    const media = await getCrosspostMedia(deps.db, { ownerId, draftId });
    return { media: media === null ? null : { width: media.width, height: media.height, byteSize: media.byte_size } };
  }

  async function record(
    claimed: CrosspostDeliveryRow,
    outcome: CrosspostOutcomeRecord,
    meta: { ownerId: string; storeId: string },
  ): Promise<void> {
    const written = await recordCrosspostOutcome(deps.db, {
      deliveryId: claimed.id,
      attempt: claimed.attempt_count,
      outcome,
    });
    deps.logger.info('crosspost.delivery_finished', {
      ownerId: meta.ownerId,
      storeId: meta.storeId,
      destination: claimed.destination,
      deliveryStatus: written === null ? 'superseded' : written.status,
      ...(outcome.kind === 'failed' ? { reason: outcome.reason } : {}),
      ...(outcome.kind === 'unknown' ? { reason: outcome.reason } : {}),
      attempt: claimed.attempt_count,
    });
  }

  /** 実行権を獲得済みの 1 行を実行し、結果を記録する。例外を投げない（記録の失敗だけは投げる）。 */
  async function execute(ctx: CrosspostDeliveryContext, claimed: CrosspostDeliveryRow): Promise<void> {
    const meta = { ownerId: ctx.ownerId, storeId: ctx.storeId };

    let media: { fetchUrl: string; width: number; height: number; byteSize: number } | null = null;
    if (claimed.with_media) {
      if (ctx.media === null) {
        // 写真付きで承認したが、写真の行がもう無い（保存期間・取り消し）。写真を落として投稿しない。
        await record(claimed, { kind: 'failed', reason: 'media_unavailable', retryable: false }, meta);
        return;
      }
      let fetchUrl: string | null = null;
      try {
        fetchUrl = await deps.mediaStore.issueFetchUrl(ctx.media.storage_key, FETCH_URL_TTL_SECONDS);
      } catch (error) {
        deps.logger.warn('crosspost.operation_failed', { ...meta, operation: 'issue_fetch_url', errorName: errorNameOf(error) });
      }
      if (fetchUrl === null) {
        // まだ何も送っていないので、投稿されていないことは確か。URL の発行は一時的に失敗しうるので再試行を許す。
        await record(claimed, { kind: 'failed', reason: 'media_unavailable', retryable: deps.mediaStore.canIssueFetchUrl }, meta);
        return;
      }
      media = { fetchUrl, width: ctx.media.width, height: ctx.media.height, byteSize: ctx.media.byte_size };
    }

    const adapter = deps.adapters[claimed.destination];
    const controller = new AbortController();
    const timeoutMs = timeouts[claimed.destination];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<PublishOutcome>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        setTimeout(() => resolve({ kind: 'unknown', reason: 'timeout' }), ABORT_GRACE_MS).unref?.();
      }, timeoutMs);
      timer.unref?.();
    });

    let outcome: PublishOutcome;
    try {
      outcome = await Promise.race([
        adapter.publish(
          {
            ownerId: ctx.ownerId,
            storeId: ctx.storeId,
            deliveryId: claimed.id,
            bodyText: claimed.body_text,
            media,
            checkpoint: claimed.checkpoint,
            signal: controller.signal,
          },
          async (checkpoint) => {
            const saved = await saveCrosspostCheckpoint(deps.db, {
              deliveryId: claimed.id,
              attempt: claimed.attempt_count,
              checkpoint,
            });
            // 保存できない = この試行はもう古い（期限切れで結果不明へ移された）。続けさせない。
            if (!saved) throw new Error('checkpoint superseded');
          },
        ),
        timedOut,
      ]);
    } catch (error) {
      deps.logger.warn('crosspost.operation_failed', {
        ...meta,
        destination: claimed.destination,
        operation: 'publish',
        errorName: errorNameOf(error),
      });
      outcome = { kind: 'unknown', reason: 'adapter_threw' };
    } finally {
      clearTimeout(timer);
    }
    await record(claimed, outcome, meta);
  }

  async function reload(ownerId: string, deliveryId: string): Promise<CrosspostDeliveryContext | null> {
    return getCrosspostDelivery(deps.db, { ownerId, deliveryId });
  }

  /** 投稿が終わった下書きの写真を消す（失敗しても置き場の寿命の規則が消す）。 */
  async function cleanupMedia(ownerId: string, draftId: string): Promise<void> {
    let keys: string[] = [];
    try {
      keys = await releaseSettledCrosspostMedia(deps.db, { ownerId, draftId, maxAttempts: MAX_DELIVERY_ATTEMPTS });
    } catch (error) {
      deps.logger.warn('crosspost.media_cleanup_failed', { ownerId, operation: 'release', errorName: errorNameOf(error) });
      return;
    }
    for (const key of keys) {
      try {
        await deps.mediaStore.delete(key);
      } catch (error) {
        deps.logger.warn('crosspost.media_cleanup_failed', { ownerId, operation: 'delete', errorName: errorNameOf(error) });
      }
    }
  }

  async function reapStale(ownerId: string): Promise<void> {
    await markStaleCrosspostDeliveries(deps.db, {
      ownerId,
      olderThan: new Date(now().getTime() - STALE_IN_PROGRESS_MS),
    });
  }

  async function runClaimed(ctxs: CrosspostDeliveryContext[], mode: 'first' | 'retry'): Promise<void> {
    await Promise.all(
      ctxs.map(async (ctx) => {
        const claimed = await claimCrosspostDelivery(deps.db, {
          ownerId: ctx.ownerId,
          deliveryId: ctx.delivery.id,
          mode,
          maxAttempts: MAX_DELIVERY_ATTEMPTS,
        });
        if (claimed === null) return; // 他のリクエストが獲得した・状態が変わった
        await execute(ctx, claimed);
      }),
    );
  }

  return {
    async availability({ ownerId, storeId, draftId }) {
      return availabilityFor(ownerId, storeId, await contentOf(ownerId, draftId));
    },

    async approve({ ownerId, storeId, draftId, revision, destinations }) {
      const availability = await availabilityFor(ownerId, storeId, await contentOf(ownerId, draftId));
      if (destinations.length === 0 || destinations.some((d) => availability[d].kind !== 'available')) {
        return { kind: 'unavailable', availability };
      }
      const approved = await approveCrosspostDraft(deps.pool, {
        ownerId,
        draftId,
        expectedRevision: revision,
        destinations,
      });
      if (approved.kind === 'stale') return { kind: 'stale' };
      return { kind: 'approved', deliveries: approved.deliveries };
    },

    async runApproved(ownerId, draftId) {
      const queued = (await listCrosspostDeliveries(deps.db, { ownerId, draftId })).filter(
        (ctx) => ctx.delivery.status === 'queued',
      );
      await runClaimed(queued, 'first');
      await cleanupMedia(ownerId, draftId);
      const after = await listCrosspostDeliveries(deps.db, { ownerId, draftId });
      return DESTINATION_ORDER.flatMap((d) => after.filter((ctx) => ctx.delivery.destination === d));
    },

    async retry(ownerId, deliveryId) {
      await reapStale(ownerId);
      const ctx = await reload(ownerId, deliveryId);
      if (ctx === null || ctx.delivery.status !== 'failed' || !ctx.delivery.retryable) {
        return { kind: 'not_retryable', delivery: ctx };
      }
      // 再試行の前に、今もこの投稿先を使えるかを確かめる（連携の解除・期限切れの後に送らない）。
      const content: ContentShape = {
        media:
          ctx.delivery.with_media && ctx.media !== null
            ? { width: ctx.media.width, height: ctx.media.height, byteSize: ctx.media.byte_size }
            : null,
      };
      const availability = await availabilityFor(ownerId, ctx.storeId, content);
      if (availability[ctx.delivery.destination].kind !== 'available') {
        return { kind: 'not_retryable', delivery: ctx };
      }
      const claimed = await claimCrosspostDelivery(deps.db, {
        ownerId,
        deliveryId,
        mode: 'retry',
        maxAttempts: MAX_DELIVERY_ATTEMPTS,
      });
      if (claimed === null) return { kind: 'not_retryable', delivery: await reload(ownerId, deliveryId) };
      await execute(ctx, claimed);
      await cleanupMedia(ownerId, ctx.delivery.draft_id);
      const after = await reload(ownerId, deliveryId);
      return after === null ? { kind: 'not_retryable', delivery: null } : { kind: 'ran', delivery: after };
    },

    async reconcile(ownerId, deliveryId) {
      await reapStale(ownerId);
      const ctx = await reload(ownerId, deliveryId);
      if (ctx === null || ctx.delivery.status !== 'unknown') return { kind: 'not_unknown', delivery: ctx };
      const adapter = deps.adapters[ctx.delivery.destination];
      if (adapter.reconcile === undefined) return { kind: 'needs_owner', delivery: ctx };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RECONCILE_TIMEOUT_MS);
      try {
        const outcome = await adapter.reconcile({
          ownerId,
          storeId: ctx.storeId,
          deliveryId,
          bodyText: ctx.delivery.body_text,
          checkpoint: ctx.delivery.checkpoint,
          attemptedAt: ctx.delivery.last_attempt_at,
          signal: controller.signal,
        });
        if (outcome.kind === 'still_unknown') return { kind: 'needs_owner', delivery: ctx };
        await resolveUnknownCrosspostDelivery(deps.db, {
          ownerId,
          deliveryId,
          posted: outcome.kind === 'posted',
          ...(outcome.kind === 'posted' ? { externalId: outcome.externalId, externalUrl: outcome.externalUrl } : {}),
        });
      } catch (error) {
        deps.logger.warn('crosspost.operation_failed', {
          ownerId,
          destination: ctx.delivery.destination,
          operation: 'reconcile',
          errorName: errorNameOf(error),
        });
        return { kind: 'needs_owner', delivery: ctx };
      } finally {
        clearTimeout(timer);
      }
      await cleanupMedia(ownerId, ctx.delivery.draft_id);
      const after = await reload(ownerId, deliveryId);
      return after === null ? { kind: 'not_unknown', delivery: null } : { kind: 'resolved', delivery: after };
    },

    async markObserved(ownerId, deliveryId, posted) {
      const updated = await resolveUnknownCrosspostDelivery(deps.db, { ownerId, deliveryId, posted });
      if (updated === null) return null;
      await cleanupMedia(ownerId, updated.draft_id);
      return reload(ownerId, deliveryId);
    },

    reapStale,
  };
}
