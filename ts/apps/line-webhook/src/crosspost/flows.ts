// 一括発信の会話（line-crosspost design.md「flows」「System Flows」・Requirement 1〜8）。
//
// 店舗特定済みオーナーの振り分け口（owner/router.ts）から呼ばれ、引き受けたら 'handled'、引き受けなければ
// 'not_handled' を返す（既存の分岐へ落ちる）。引き受ける条件:
//   - `a=x_*` の postback（本機能の有効な店舗を持つオーナーだけ）
//   - 作成中の下書きがあるときのテキスト・画像
//   - 本機能の有効な店舗を持つオーナーの「投稿」「投稿する」「投稿を作る」
// 本機能の有効な店舗を持たないオーナーには、何も引き受けない（案内・ボタンを一切出さない・Req 1.4, 10.3）。
//
// 承認（`x_ok`）だけが投稿の実行へ到達する（Req 5.4）。投稿先の選択（`x_conf`）は最終確認を出すだけである。
// 例外は Reply を送る前なら投げる（エラー境界が再試行の案内を 1 回だけ返す）。承認の後は投げない（投稿先の状態は
// DB に残っているので、店主は「投稿の状況」で確かめられる）。

import type { CrosspostDraftRow, Queryable, TransactionCapable } from '@fwlm/db';
import {
  appendCrosspostMaterial,
  beginCrosspostReview,
  closeCrosspostDraft,
  createCrosspostDraft,
  getCrosspostDraft,
  getCrosspostMedia,
  getOpenCrosspostDraft,
  listCrosspostDeliveries,
  listCrosspostEligibleStores,
  listRecentCrosspostPosts,
  purgeExpiredCrosspostDrafts,
  saveCrosspostTexts,
  setCrosspostInputMode,
  type CrosspostStoreSummary,
  type OpenCrosspostDraft,
} from '@fwlm/db';
import type { LineMessage, LineMessenger } from '../line/client.js';
import type { InboundImage } from '../webhook/dispatch.js';
import {
  DESTINATION_ORDER,
  DRAFT_RETENTION_MS,
  DRAFT_TTL_MS,
  MAX_SELECTABLE_STORES,
  PURGE_BATCH_SIZE,
  type CrosspostDestination,
} from './domain.js';
import type { PhotoIntake } from './intake.js';
import { errorNameOf, type CrosspostLogger } from './logger.js';
import type { MediaStore } from './media.js';
import {
  buildCanceledMessage,
  buildConfirmMessage,
  buildExpiredMessage,
  buildGenerationFailedMessage,
  buildInputModeMessage,
  buildManualTextRejectedMessage,
  buildMaterialAfterGenerationMessage,
  buildMaterialTooLongMessage,
  buildNeedMaterialMessage,
  buildNoOpenDraftMessage,
  buildNotRetryableMessage,
  buildOpenDraftExistsMessage,
  buildPhotoRejectedMessage,
  buildPhotoSetNoticeMessage,
  buildReceivedMessage,
  buildResultMessage,
  buildReviewHintMessage,
  buildReviewMessage,
  buildStaleMessage,
  buildStartMessage,
  buildStatusMessage,
  buildStorePickerMessage,
  availableChoices,
} from './messages.js';
import { choiceToDestinations, decodeCrosspostPostback, isCrosspostPostbackData, type CrosspostPostback } from './postback.js';
import { validateManualText, type CrosspostPrompts } from './prompts.js';
import type { CrosspostPublisher } from './publisher.js';

export type CrosspostHandled = 'handled' | 'not_handled';

export interface CrosspostEventBase {
  ownerId: string;
  lineUserId: string;
  replyToken: string;
}

export interface CrosspostFlows {
  handlePostback(event: CrosspostEventBase & { data: string }): Promise<CrosspostHandled>;
  handleText(event: CrosspostEventBase & { text: string }): Promise<CrosspostHandled>;
  handleImage(event: CrosspostEventBase & { image: InboundImage }): Promise<CrosspostHandled>;
}

export interface CrosspostFlowDeps {
  db: Queryable;
  pool: TransactionCapable;
  messenger: Pick<LineMessenger, 'reply' | 'push'>;
  prompts: CrosspostPrompts;
  publisher: CrosspostPublisher;
  intake: PhotoIntake;
  mediaStore: MediaStore;
  logger: CrosspostLogger;
  /** 本機能を見せる店舗（CROSSPOST_PILOT_STORE_IDS）。 */
  pilotStoreIds: readonly string[];
  /** Google の連携の入口（GBP の会話の g_connect）が使えるか。 */
  googleConnectAvailable: boolean;
  now?: () => Date;
  /** この時間を過ぎて投稿が終わったら、Reply ではなく Push で結果を送る（Reply トークンの期限への備え）。 */
  replySafeMs?: number;
}

/** 開始の合図として受け付ける店主の文（前後の空白は無視）。 */
const START_KEYWORDS = new Set(['投稿', '投稿する', '投稿を作る']);
const DEFAULT_REPLY_SAFE_MS = 20_000;

export function createCrosspostFlows(deps: CrosspostFlowDeps): CrosspostFlows {
  const now = deps.now ?? (() => new Date());
  const replySafeMs = deps.replySafeMs ?? DEFAULT_REPLY_SAFE_MS;
  const expiresAt = (): Date => new Date(now().getTime() + DRAFT_TTL_MS);

  const reply = (token: string, ...messages: LineMessage[]): Promise<void> => deps.messenger.reply(token, messages);

  async function eligibleStores(ownerId: string): Promise<CrosspostStoreSummary[]> {
    const stores = await listCrosspostEligibleStores(deps.db, ownerId, deps.pilotStoreIds);
    return stores.slice(0, MAX_SELECTABLE_STORES);
  }

  async function deleteMedia(keys: readonly string[], ownerId: string): Promise<void> {
    for (const key of keys) {
      try {
        await deps.mediaStore.delete(key);
      } catch (error) {
        deps.logger.warn('crosspost.media_cleanup_failed', { ownerId, operation: 'delete', errorName: errorNameOf(error) });
      }
    }
  }

  /** 保存期間を過ぎた下書きを少しずつ消す（開始の操作のついで）。失敗しても利用者の操作は止めない。 */
  async function purgeQuietly(ownerId: string): Promise<void> {
    try {
      const purged = await purgeExpiredCrosspostDrafts(deps.db, { now: now(), limit: PURGE_BATCH_SIZE });
      await deleteMedia(purged.removedStorageKeys, ownerId);
    } catch (error) {
      deps.logger.warn('crosspost.operation_failed', { ownerId, operation: 'purge', errorName: errorNameOf(error) });
    }
  }

  type OpenState =
    | { kind: 'none' }
    | { kind: 'open'; open: OpenCrosspostDraft }
    /** 期限切れ・店舗を操作できなくなった（今の操作で閉じた）。 */
    | { kind: 'closed'; reason: 'expired' | 'unserviceable' };

  /** 作成中の下書きを読み、期限切れ・操作できない店舗のものは閉じる（写真も消す）。 */
  async function loadOpen(ownerId: string): Promise<OpenState> {
    const open = await getOpenCrosspostDraft(deps.db, ownerId);
    if (open === null) return { kind: 'none' };
    const expired = open.draft.expires_at.getTime() <= now().getTime();
    if (!expired && open.serviceable) return { kind: 'open', open };
    const closed = await closeCrosspostDraft(deps.db, {
      ownerId,
      draftId: open.draft.id,
      ...(expired ? { onlyIfExpiredAt: now() } : {}),
    });
    if (closed !== null) await deleteMedia(closed.removedStorageKeys, ownerId);
    return { kind: 'closed', reason: expired ? 'expired' : 'unserviceable' };
  }

  async function hasPhoto(ownerId: string, draftId: string): Promise<boolean> {
    return (await getCrosspostMedia(deps.db, { ownerId, draftId })) !== null;
  }

  async function reviewMessage(ownerId: string, draft: CrosspostDraftRow, storeName: string): Promise<LineMessage> {
    const availability = await deps.publisher.availability({ ownerId, storeId: draft.store_id, draftId: draft.id });
    return buildReviewMessage({
      draft,
      storeName,
      availability,
      hasPhoto: await hasPhoto(ownerId, draft.id),
      googleConnectAvailable: deps.googleConnectAvailable,
    });
  }

  async function collectingMessage(ownerId: string, draft: CrosspostDraftRow, storeName: string): Promise<LineMessage> {
    const availability = await deps.publisher.availability({ ownerId, storeId: draft.store_id, draftId: draft.id });
    return buildStartMessage({ draftId: draft.id, storeName, availability });
  }

  /** 作成中の下書きの、いまの状態に合うメッセージ。 */
  async function currentStateMessage(ownerId: string, open: OpenCrosspostDraft): Promise<LineMessage> {
    return open.draft.status === 'collecting'
      ? collectingMessage(ownerId, open.draft, open.storeName)
      : reviewMessage(ownerId, open.draft, open.storeName);
  }

  function closedMessage(reason: 'expired' | 'unserviceable'): LineMessage {
    return reason === 'expired' ? buildExpiredMessage() : buildStaleMessage(null);
  }

  // ===================================================================
  // 開始
  // ===================================================================

  async function start(
    event: CrosspostEventBase,
    stores: readonly CrosspostStoreSummary[],
    requestedStoreId: string | null,
  ): Promise<void> {
    await purgeQuietly(event.ownerId);
    const state = await loadOpen(event.ownerId);
    if (state.kind === 'open') {
      // 同じ店舗を選び直しただけなら、そのまま続ける。違う店舗・指定なしは、続けるか新しく作るかを選ばせる（Req 1.5）。
      if (requestedStoreId !== null && requestedStoreId === state.open.draft.store_id) {
        await reply(event.replyToken, await currentStateMessage(event.ownerId, state.open));
        return;
      }
      await reply(
        event.replyToken,
        buildOpenDraftExistsMessage({ storeName: state.open.storeName, requestedStoreId }),
      );
      return;
    }
    await createAndStart(event, stores, requestedStoreId);
  }

  async function createAndStart(
    event: CrosspostEventBase,
    stores: readonly CrosspostStoreSummary[],
    requestedStoreId: string | null,
  ): Promise<void> {
    const store =
      requestedStoreId !== null
        ? stores.find((candidate) => candidate.id === requestedStoreId)
        : stores.length === 1
          ? stores[0]
          : undefined;
    if (store === undefined) {
      if (requestedStoreId !== null) {
        await reply(event.replyToken, buildStaleMessage(null));
        return;
      }
      await reply(event.replyToken, buildStorePickerMessage(stores));
      return;
    }

    const created = await createCrosspostDraft(deps.db, {
      ownerId: event.ownerId,
      storeId: store.id,
      allowedStoreIds: deps.pilotStoreIds,
      expiresAt: expiresAt(),
      purgeAfter: new Date(now().getTime() + DRAFT_RETENTION_MS),
    });
    if (!created.ok) {
      if (created.error === 'OPEN_DRAFT_EXISTS') {
        const state = await loadOpen(event.ownerId);
        if (state.kind === 'open') {
          await reply(event.replyToken, buildOpenDraftExistsMessage({ storeName: state.open.storeName, requestedStoreId: store.id }));
          return;
        }
      }
      await reply(event.replyToken, buildStaleMessage(null));
      return;
    }
    await reply(event.replyToken, await collectingMessage(event.ownerId, created.value, store.name));
  }

  // ===================================================================
  // 生成・修正
  // ===================================================================

  /** 作成中の下書きが、postback の指す下書きか（違えば古いボタン）。 */
  async function requireOpen(event: CrosspostEventBase, draftId: string): Promise<OpenCrosspostDraft | null> {
    const state = await loadOpen(event.ownerId);
    if (state.kind === 'closed') {
      await reply(event.replyToken, closedMessage(state.reason));
      return null;
    }
    if (state.kind === 'none' || state.open.draft.id !== draftId) {
      await reply(event.replyToken, state.kind === 'none' ? buildNoOpenDraftMessage() : buildStaleMessage(state.open.draft.id));
      return null;
    }
    return state.open;
  }

  async function generateDraft(event: CrosspostEventBase, draftId: string): Promise<void> {
    const open = await requireOpen(event, draftId);
    if (open === null) return;
    if (open.draft.status === 'reviewing') {
      await reply(event.replyToken, await reviewMessage(event.ownerId, open.draft, open.storeName));
      return;
    }
    const reviewing = await beginCrosspostReview(deps.db, { ownerId: event.ownerId, draftId, expiresAt: expiresAt() });
    if (reviewing === null) {
      await reply(event.replyToken, buildNeedMaterialMessage(draftId));
      return;
    }
    await generateAndSave(event, reviewing, open.storeName, [...DESTINATION_ORDER]);
  }

  async function generateAndSave(
    event: CrosspostEventBase,
    draft: CrosspostDraftRow,
    storeName: string,
    destinations: CrosspostDestination[],
    revision?: { destination: CrosspostDestination; instruction: string },
  ): Promise<void> {
    const generated = await deps.prompts.generate({
      material: { storeName, materialText: draft.material_text },
      destinations,
      ...(revision === undefined
        ? {}
        : {
            revision: {
              destination: revision.destination,
              instruction: revision.instruction,
              previousText:
                (revision.destination === 'instagram' ? draft.instagram_text : draft.google_text) ?? '',
            },
          }),
    });
    if (!generated.ok) {
      deps.logger.warn('crosspost.generation_failed', { ownerId: event.ownerId, reason: generated.error.kind });
      await reply(event.replyToken, buildGenerationFailedMessage(draft.id));
      return;
    }
    const saved = await saveCrosspostTexts(deps.db, {
      ownerId: event.ownerId,
      draftId: draft.id,
      expectedRevision: draft.revision,
      texts: generated.value,
      expiresAt: expiresAt(),
    });
    if (saved === null) {
      // 生成の間に、写真の差し替えなど別の変更が入った。古い前提で作った文は保存しない。
      await reply(event.replyToken, buildStaleMessage(draft.id));
      return;
    }
    await reply(event.replyToken, await reviewMessage(event.ownerId, saved, storeName));
  }

  async function requireReviewing(
    event: CrosspostEventBase,
    draftId: string,
    revision: number,
  ): Promise<OpenCrosspostDraft | null> {
    const open = await requireOpen(event, draftId);
    if (open === null) return null;
    if (open.draft.status !== 'reviewing' || open.draft.revision !== revision) {
      await reply(event.replyToken, buildStaleMessage(draftId));
      return null;
    }
    return open;
  }

  // ===================================================================
  // 承認と実行・結果
  // ===================================================================

  async function approve(event: CrosspostEventBase, postback: Extract<CrosspostPostback, { action: 'x_ok' }>): Promise<void> {
    const open = await requireReviewing(event, postback.draftId, postback.revision);
    if (open === null) return;
    const destinations = choiceToDestinations(postback.choice);
    const approved = await deps.publisher.approve({
      ownerId: event.ownerId,
      storeId: open.draft.store_id,
      draftId: open.draft.id,
      revision: postback.revision,
      destinations,
    });
    if (approved.kind !== 'approved') {
      await reply(event.replyToken, buildStaleMessage(open.draft.id));
      return;
    }

    // ここから先は投げない（承認は確定し、投稿先の状態は DB にある）。
    const startedAt = now().getTime();
    let message: LineMessage;
    try {
      const deliveries = await deps.publisher.runApproved(event.ownerId, open.draft.id);
      message = buildResultMessage({ storeName: open.storeName, deliveries });
    } catch (error) {
      deps.logger.error('crosspost.operation_failed', {
        ownerId: event.ownerId,
        storeId: open.draft.store_id,
        operation: 'run_approved',
        errorName: errorNameOf(error),
      });
      message = buildStatusMessage(await safeRecent(event.ownerId));
    }
    await deliver(event, message, now().getTime() - startedAt);
  }

  /** 結果を知らせる。時間がかかった（Reply トークンの期限が近い）ときは Push で送る（Req 7.2）。投げない。 */
  async function deliver(event: CrosspostEventBase, message: LineMessage, elapsedMs: number): Promise<void> {
    try {
      if (elapsedMs < replySafeMs) {
        await deps.messenger.reply(event.replyToken, [message]);
      } else {
        await deps.messenger.push(event.lineUserId, [message]);
      }
    } catch (error) {
      deps.logger.warn('crosspost.operation_failed', { ownerId: event.ownerId, operation: 'notify', errorName: errorNameOf(error) });
    }
  }

  async function safeRecent(ownerId: string): Promise<Awaited<ReturnType<typeof listRecentCrosspostPosts>>> {
    try {
      return await listRecentCrosspostPosts(deps.db, { ownerId, limit: 5 });
    } catch {
      // swallowed-exception: intentional — 結果の表示の代替の読み出しに失敗しても、承認の後は投げない（上の方針）。
      return [];
    }
  }

  async function resultForDraft(event: CrosspostEventBase, draftId: string, storeName: string): Promise<LineMessage> {
    const deliveries = await listCrosspostDeliveries(deps.db, { ownerId: event.ownerId, draftId });
    return buildResultMessage({ storeName, deliveries });
  }

  // ===================================================================
  // postback
  // ===================================================================

  async function handlePostback(
    event: CrosspostEventBase,
    postback: CrosspostPostback,
    stores: readonly CrosspostStoreSummary[],
  ): Promise<void> {
    switch (postback.action) {
      case 'x_start':
        await start(event, stores, postback.storeId);
        return;

      case 'x_resume': {
        const state = await loadOpen(event.ownerId);
        if (state.kind === 'closed') {
          await reply(event.replyToken, closedMessage(state.reason));
          return;
        }
        if (state.kind === 'none') {
          await reply(event.replyToken, buildNoOpenDraftMessage());
          return;
        }
        await reply(event.replyToken, await currentStateMessage(event.ownerId, state.open));
        return;
      }

      case 'x_new': {
        const state = await loadOpen(event.ownerId);
        if (state.kind === 'open') {
          const closed = await closeCrosspostDraft(deps.db, { ownerId: event.ownerId, draftId: state.open.draft.id });
          if (closed !== null) await deleteMedia(closed.removedStorageKeys, event.ownerId);
        }
        await createAndStart(event, stores, postback.storeId);
        return;
      }

      case 'x_gen':
        await generateDraft(event, postback.draftId);
        return;

      case 'x_regen': {
        const open = await requireReviewing(event, postback.draftId, postback.revision);
        if (open === null) return;
        await generateAndSave(event, open.draft, open.storeName, [postback.destination]);
        return;
      }

      case 'x_ai':
      case 'x_edit': {
        const open = await requireReviewing(event, postback.draftId, postback.revision);
        if (open === null) return;
        const updated = await setCrosspostInputMode(deps.db, {
          ownerId: event.ownerId,
          draftId: postback.draftId,
          expectedRevision: postback.revision,
          mode: postback.action === 'x_ai' ? 'ai_revision' : 'manual',
          destination: postback.destination,
          expiresAt: expiresAt(),
        });
        if (updated === null) {
          await reply(event.replyToken, buildStaleMessage(postback.draftId));
          return;
        }
        await reply(
          event.replyToken,
          buildInputModeMessage({
            draftId: updated.id,
            destination: postback.destination,
            mode: postback.action === 'x_ai' ? 'ai_revision' : 'manual',
          }),
        );
        return;
      }

      case 'x_view': {
        const state = await loadOpen(event.ownerId);
        if (state.kind === 'open' && state.open.draft.id === postback.draftId) {
          let draft = state.open.draft;
          if (draft.status === 'reviewing' && draft.input_mode !== 'none') {
            // 「直すのをやめる」: 入力モードを戻す（版は変わらない）。
            draft =
              (await setCrosspostInputMode(deps.db, {
                ownerId: event.ownerId,
                draftId: draft.id,
                expectedRevision: draft.revision,
                mode: 'none',
                destination: null,
                expiresAt: expiresAt(),
              })) ?? draft;
          }
          await reply(event.replyToken, await currentStateMessage(event.ownerId, { ...state.open, draft }));
          return;
        }
        // 作成中でなければ、承認済みの下書きの結果を出す（他のオーナーの下書きは読めない）。
        const past = await getCrosspostDraft(deps.db, { ownerId: event.ownerId, draftId: postback.draftId });
        if (past !== null && past.draft.status === 'approved') {
          await reply(event.replyToken, await resultForDraft(event, past.draft.id, past.storeName));
          return;
        }
        await reply(event.replyToken, state.kind === 'closed' ? closedMessage(state.reason) : buildNoOpenDraftMessage());
        return;
      }

      case 'x_conf': {
        const open = await requireReviewing(event, postback.draftId, postback.revision);
        if (open === null) return;
        const availability = await deps.publisher.availability({
          ownerId: event.ownerId,
          storeId: open.draft.store_id,
          draftId: open.draft.id,
        });
        if (!availableChoices(open.draft, availability).includes(postback.choice)) {
          await reply(event.replyToken, buildStaleMessage(open.draft.id));
          return;
        }
        await reply(
          event.replyToken,
          buildConfirmMessage({
            draft: open.draft,
            storeName: open.storeName,
            choice: postback.choice,
            hasPhoto: await hasPhoto(event.ownerId, open.draft.id),
          }),
        );
        return;
      }

      case 'x_ok':
        await approve(event, postback);
        return;

      case 'x_cancel': {
        const closed = await closeCrosspostDraft(deps.db, { ownerId: event.ownerId, draftId: postback.draftId });
        if (closed === null) {
          await reply(event.replyToken, buildNoOpenDraftMessage());
          return;
        }
        await deleteMedia(closed.removedStorageKeys, event.ownerId);
        await reply(event.replyToken, buildCanceledMessage());
        return;
      }

      case 'x_status': {
        await deps.publisher.reapStale(event.ownerId);
        await reply(event.replyToken, buildStatusMessage(await listRecentCrosspostPosts(deps.db, { ownerId: event.ownerId, limit: 5 })));
        return;
      }

      case 'x_retry': {
        const startedAt = now().getTime();
        const result = await deps.publisher.retry(event.ownerId, postback.deliveryId);
        if (result.kind !== 'ran') {
          await reply(event.replyToken, buildNotRetryableMessage());
          return;
        }
        await deliver(
          event,
          await resultForDraft(event, result.delivery.delivery.draft_id, result.delivery.storeName),
          now().getTime() - startedAt,
        );
        return;
      }

      case 'x_check': {
        const result = await deps.publisher.reconcile(event.ownerId, postback.deliveryId);
        if (result.delivery === null) {
          await reply(event.replyToken, buildNotRetryableMessage());
          return;
        }
        await reply(event.replyToken, await resultForDraft(event, result.delivery.delivery.draft_id, result.delivery.storeName));
        return;
      }

      case 'x_seen': {
        const updated = await deps.publisher.markObserved(event.ownerId, postback.deliveryId, postback.posted);
        if (updated === null) {
          await reply(event.replyToken, buildNotRetryableMessage());
          return;
        }
        await reply(event.replyToken, await resultForDraft(event, updated.delivery.draft_id, updated.storeName));
        return;
      }
    }
  }

  // ===================================================================
  // テキスト・画像
  // ===================================================================

  async function handleOpenText(event: CrosspostEventBase & { text: string }, open: OpenCrosspostDraft): Promise<void> {
    const draft = open.draft;
    const value = event.text.trim();

    if (draft.status === 'collecting') {
      if (value.length === 0) {
        await reply(event.replyToken, buildNeedMaterialMessage(draft.id));
        return;
      }
      const appended = await appendCrosspostMaterial(deps.db, {
        ownerId: event.ownerId,
        draftId: draft.id,
        text: value,
        expiresAt: expiresAt(),
      });
      if (!appended.ok) {
        await reply(
          event.replyToken,
          appended.error === 'TOO_LONG' ? buildMaterialTooLongMessage(draft.id) : buildMaterialAfterGenerationMessage(draft.id),
        );
        return;
      }
      await reply(
        event.replyToken,
        buildReceivedMessage({
          draftId: draft.id,
          kind: 'text',
          hasPhoto: await hasPhoto(event.ownerId, draft.id),
          hasText: true,
        }),
      );
      return;
    }

    const destination = draft.input_destination;
    if (draft.input_mode === 'none' || destination === null) {
      await reply(event.replyToken, buildReviewHintMessage(draft.id));
      return;
    }

    if (draft.input_mode === 'manual') {
      const issue = validateManualText(destination, value);
      if (issue !== null) {
        await reply(event.replyToken, buildManualTextRejectedMessage({ draftId: draft.id, destination, issue }));
        return;
      }
      const saved = await saveCrosspostTexts(deps.db, {
        ownerId: event.ownerId,
        draftId: draft.id,
        expectedRevision: draft.revision,
        texts: { [destination]: value },
        expiresAt: expiresAt(),
      });
      if (saved === null) {
        await reply(event.replyToken, buildStaleMessage(draft.id));
        return;
      }
      await reply(event.replyToken, await reviewMessage(event.ownerId, saved, open.storeName));
      return;
    }

    // AI への修正指示（Req 4.3）。指示は、その生成の照合の素材に加える。
    if (value.length === 0) {
      await reply(event.replyToken, buildInputModeMessage({ draftId: draft.id, destination, mode: 'ai_revision' }));
      return;
    }
    await generateAndSave(event, draft, open.storeName, [destination], { destination, instruction: value });
  }

  async function handleOpenImage(event: CrosspostEventBase & { image: InboundImage }, open: OpenCrosspostDraft): Promise<void> {
    const set = event.image.imageSet;
    if (set !== null && set.index !== 1) {
      // まとめて送られた 2 枚目以降は使わない（1 枚目の受け取りで伝える・Req 2.4）。返信もしない（通知が重ならない）。
      return;
    }
    const result = await deps.intake.receive({
      ownerId: event.ownerId,
      draftId: open.draft.id,
      messageId: event.image.messageId,
      contentProvider: event.image.contentProvider,
    });
    switch (result.kind) {
      case 'rejected':
        await reply(event.replyToken, buildPhotoRejectedMessage({ draftId: open.draft.id, reason: result.reason }));
        return;
      case 'not_open':
        await reply(event.replyToken, buildNoOpenDraftMessage());
        return;
      case 'duplicate':
        await reply(event.replyToken, await currentStateMessage(event.ownerId, open));
        return;
      case 'attached': {
        const notices: LineMessage[] = [];
        if (set !== null && set.total > 1) notices.push(buildPhotoSetNoticeMessage({ draftId: open.draft.id, total: set.total }));
        if (result.draft.status === 'reviewing') {
          // 確認中の差し替え。文はそのまま（写真を生成に使わない・research.md Decision 2）。版が進んだので出し直す。
          notices.push(await reviewMessage(event.ownerId, result.draft, open.storeName));
        } else {
          notices.push(
            buildReceivedMessage({
              draftId: open.draft.id,
              kind: result.replaced ? 'photo_replaced' : 'photo',
              hasPhoto: true,
              hasText: result.draft.material_text.trim().length > 0,
            }),
          );
        }
        await reply(event.replyToken, ...notices);
        return;
      }
    }
  }

  return {
    async handlePostback(event) {
      if (!isCrosspostPostbackData(event.data)) return 'not_handled';
      const stores = await eligibleStores(event.ownerId);
      if (stores.length === 0) return 'not_handled';
      const postback = decodeCrosspostPostback(event.data);
      if (postback === null) {
        await reply(event.replyToken, buildStaleMessage(null));
        return 'handled';
      }
      await handlePostback(event, postback, stores);
      return 'handled';
    },

    async handleText(event) {
      const stores = await eligibleStores(event.ownerId);
      if (stores.length === 0) return 'not_handled';
      const state = await loadOpen(event.ownerId);
      if (state.kind === 'closed') {
        await reply(event.replyToken, closedMessage(state.reason));
        return 'handled';
      }
      if (state.kind === 'open') {
        await handleOpenText(event, state.open);
        return 'handled';
      }
      if (START_KEYWORDS.has(event.text.trim())) {
        await start(event, stores, null);
        return 'handled';
      }
      return 'not_handled';
    },

    async handleImage(event) {
      const stores = await eligibleStores(event.ownerId);
      if (stores.length === 0) return 'not_handled';
      const state = await loadOpen(event.ownerId);
      if (state.kind === 'closed') {
        await reply(event.replyToken, closedMessage(state.reason));
        return 'handled';
      }
      if (state.kind === 'none') return 'not_handled';
      await handleOpenImage(event, state.open);
      return 'handled';
    },
  };
}
