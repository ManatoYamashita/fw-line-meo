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
  getCrosspostDelivery,
  getCrosspostDraft,
  getCrosspostMedia,
  getOpenCrosspostDraft,
  listCrosspostDeliveries,
  listCrosspostEligibleStores,
  listRecentCrosspostPosts,
  listUnnotifiedCrosspostResults,
  markCrosspostResultNotified,
  purgeCrosspostRetention,
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
  MEDIA_RETENTION_MS,
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
  buildPendingResultsIntroMessage,
  buildPhotoRejectedMessage,
  buildPhotoResendRequiredMessage,
  buildOlderPhotoIgnoredMessage,
  buildPhotoBeforeDraftMessage,
  buildTextBeforeDraftMessage,
  buildTextBeforeInputModeMessage,
  buildAmbiguousPhotoMessage,
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
  /**
   * LINE のイベントの時刻（Webhook の timestamp・UNIX ミリ秒）。下書きの開始・入力モードの切り替えの時刻として
   * 保存し、写真・文が「その後に送られたか」を同じ LINE の時計で比べる。無ければ null。
   */
  sentAt: number | null;
}

export interface CrosspostFlows {
  handlePostback(event: CrosspostEventBase & { data: string }): Promise<CrosspostHandled>;
  handleText(event: CrosspostEventBase & { text: string }): Promise<CrosspostHandled>;
  handleImage(event: CrosspostEventBase & { image: InboundImage }): Promise<CrosspostHandled>;
}

export interface CrosspostFlowDeps {
  db: Queryable;
  pool: TransactionCapable;
  messenger: Pick<LineMessenger, 'reply' | 'push' | 'replyChecked' | 'pushChecked'>;
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
/** 投稿の状況を見る合図として受け付ける店主の文。 */
const STATUS_KEYWORDS = new Set(['投稿の状況', '投稿の結果']);
/** 一度の返信で添える、届けていない結果の件数の上限（LINE の 1 回の返信は 5 通まで）。 */
const MAX_PENDING_RESULTS = 2;
const DEFAULT_REPLY_SAFE_MS = 20_000;

export function createCrosspostFlows(deps: CrosspostFlowDeps): CrosspostFlows {
  const now = deps.now ?? (() => new Date());
  const replySafeMs = deps.replySafeMs ?? DEFAULT_REPLY_SAFE_MS;
  const expiresAt = (): Date => new Date(now().getTime() + DRAFT_TTL_MS);


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
      const purged = await purgeCrosspostRetention(deps.db, {
        now: now(),
        mediaOlderThan: new Date(now().getTime() - MEDIA_RETENTION_MS),
        limit: PURGE_BATCH_SIZE,
      });
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
    // 店舗の所有・利用中に加えて、今も有効化の指定（CROSSPOST_PILOT_STORE_IDS）に含まれることを確かめる。
    // 指定から外した店舗の作成中の下書きは、ほかに有効な店舗を持つオーナーからも操作させずに閉じる。
    const serviceable = open.serviceable && deps.pilotStoreIds.includes(open.draft.store_id);
    if (!expired && serviceable) return { kind: 'open', open };
    const closed = await closeCrosspostDraft(deps.db, {
      ownerId,
      draftId: open.draft.id,
      ...(expired ? { onlyIfExpiredAt: now() } : {}),
    });
    if (closed !== null) await deleteMedia(closed.removedStorageKeys, ownerId);
    return { kind: 'closed', reason: expired ? 'expired' : 'unserviceable' };
  }

  /**
   * 最終確認で示す写真。写真が無ければ none、引用の手掛かり（quoteToken）が無ければ unverifiable
   * （確かめていない写真は公開しない・Req 5.9）。
   */
  async function confirmPhoto(
    ownerId: string,
    draftId: string,
  ): Promise<{ kind: 'none' } | { kind: 'unverifiable' } | { kind: 'quoted'; width: number; height: number; quoteToken: string }> {
    const media = await getCrosspostMedia(deps.db, { ownerId, draftId });
    if (media === null) return { kind: 'none' };
    if (media.line_quote_token === null) return { kind: 'unverifiable' };
    return { kind: 'quoted', width: media.width, height: media.height, quoteToken: media.line_quote_token };
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
        await say(event, await currentStateMessage(event.ownerId, state.open));
        return;
      }
      await say(
        event,
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
        await say(event, buildStaleMessage(null));
        return;
      }
      await say(event, buildStorePickerMessage(stores));
      return;
    }

    // 下書きを始めた操作の LINE の時刻。これより後に送られた写真・文だけをこの下書きの素材にする（Req 2.11）。
    // 時刻が分からなければ、別の下書きの写真・文と区別できないので始めない。
    if (event.sentAt === null) {
      await say(event, buildStaleMessage(null));
      return;
    }
    const created = await createCrosspostDraft(deps.db, {
      ownerId: event.ownerId,
      storeId: store.id,
      allowedStoreIds: deps.pilotStoreIds,
      expiresAt: expiresAt(),
      purgeAfter: new Date(now().getTime() + DRAFT_RETENTION_MS),
      lineStartedAt: new Date(event.sentAt),
    });
    if (!created.ok) {
      if (created.error === 'OPEN_DRAFT_EXISTS') {
        const state = await loadOpen(event.ownerId);
        if (state.kind === 'open') {
          await say(event, buildOpenDraftExistsMessage({ storeName: state.open.storeName, requestedStoreId: store.id }));
          return;
        }
      }
      await say(event, buildStaleMessage(null));
      return;
    }
    await say(event, await collectingMessage(event.ownerId, created.value, store.name));
  }

  // ===================================================================
  // 生成・修正
  // ===================================================================

  /** 作成中の下書きが、postback の指す下書きか（違えば古いボタン）。 */
  async function requireOpen(event: CrosspostEventBase, draftId: string): Promise<OpenCrosspostDraft | null> {
    const state = await loadOpen(event.ownerId);
    if (state.kind === 'closed') {
      await say(event, closedMessage(state.reason));
      return null;
    }
    if (state.kind === 'none' || state.open.draft.id !== draftId) {
      await say(event, state.kind === 'none' ? buildNoOpenDraftMessage() : buildStaleMessage(state.open.draft.id));
      return null;
    }
    return state.open;
  }

  async function generateDraft(event: CrosspostEventBase, draftId: string): Promise<void> {
    const open = await requireOpen(event, draftId);
    if (open === null) return;
    if (open.draft.status === 'reviewing') {
      await say(event, await reviewMessage(event.ownerId, open.draft, open.storeName));
      return;
    }
    const reviewing = await beginCrosspostReview(deps.db, { ownerId: event.ownerId, draftId, expiresAt: expiresAt() });
    if (reviewing === null) {
      await say(event, buildNeedMaterialMessage(draftId));
      return;
    }
    await generateAndSave(event, reviewing, open.storeName, [...DESTINATION_ORDER]);
  }

  async function generateAndSave(
    event: CrosspostEventBase,
    draft: CrosspostDraftRow,
    storeName: string,
    destinations: CrosspostDestination[],
    revision?: { destination: CrosspostDestination; instruction: string; inputSentAt: Date },
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
      await say(event, buildGenerationFailedMessage(draft.id));
      return;
    }
    const saved = await saveCrosspostTexts(deps.db, {
      ownerId: event.ownerId,
      draftId: draft.id,
      expectedRevision: draft.revision,
      texts: generated.value,
      ...(revision === undefined ? {} : { inputSentAt: revision.inputSentAt }),
      expiresAt: expiresAt(),
    });
    if (saved === null) {
      // 生成の間に、写真の差し替えなど別の変更が入った。古い前提で作った文は保存しない。
      await say(event, buildStaleMessage(draft.id));
      return;
    }
    await say(event, await reviewMessage(event.ownerId, saved, storeName));
  }

  async function requireReviewing(
    event: CrosspostEventBase,
    draftId: string,
    revision: number,
  ): Promise<OpenCrosspostDraft | null> {
    const open = await requireOpen(event, draftId);
    if (open === null) return null;
    if (open.draft.status !== 'reviewing' || open.draft.revision !== revision) {
      await say(event, buildStaleMessage(draftId));
      return null;
    }
    return open;
  }

  // ===================================================================
  // 承認と実行・結果
  // ===================================================================

  async function approve(event: CrosspostEventBase, postback: Extract<CrosspostPostback, { action: 'x_ok' }>): Promise<void> {
    // 同じ版の承認が既に通っている（二重タップ・応答が届かず押し直した・承認の後に処理が止まった）なら、新しく
    // 承認せず、待ち（一度も送っていない）の投稿先だけを再開する。送信済み・実行中の投稿先は送り直さない（Req 6.11）。
    const existing = await getCrosspostDraft(deps.db, { ownerId: event.ownerId, draftId: postback.draftId });
    if (existing !== null && existing.draft.status === 'approved') {
      if (existing.draft.approved_revision === postback.revision) {
        await runAndReport(event, existing.draft.id, existing.storeName, existing.draft.store_id);
        return;
      }
      await say(event, buildStaleMessage(null));
      return;
    }

    const open = await requireReviewing(event, postback.draftId, postback.revision);
    if (open === null) return;
    // 最終確認を出さない写真（引用できない）は、承認の側でも断る（古いボタン・偽造された postback への備え・Req 5.9）。
    if ((await confirmPhoto(event.ownerId, open.draft.id)).kind === 'unverifiable') {
      await say(event, buildPhotoResendRequiredMessage(open.draft.id));
      return;
    }
    const destinations = choiceToDestinations(postback.choice);
    const approved = await deps.publisher.approve({
      ownerId: event.ownerId,
      storeId: open.draft.store_id,
      draftId: open.draft.id,
      revision: postback.revision,
      destinations,
    });
    if (approved.kind !== 'approved') {
      // 並行した同じ承認が先に通った場合は、上と同じく再開の扱いにする（待ちが無ければ結果を示すだけ）。
      const raced = await getCrosspostDraft(deps.db, { ownerId: event.ownerId, draftId: open.draft.id });
      if (raced !== null && raced.draft.status === 'approved' && raced.draft.approved_revision === postback.revision) {
        await runAndReport(event, raced.draft.id, raced.storeName, raced.draft.store_id);
        return;
      }
      await say(event, buildStaleMessage(open.draft.id));
      return;
    }
    await runAndReport(event, open.draft.id, open.storeName, open.draft.store_id);
  }

  /** 待ちの投稿先を実行し、結果を届ける。承認の後なので投げない（投稿先の状態は DB にある）。 */
  async function runAndReport(event: CrosspostEventBase, draftId: string, storeName: string, storeId: string): Promise<void> {
    const startedAt = now().getTime();
    let message: LineMessage;
    let marks: ResultMark[] = [];
    try {
      const deliveries = await deps.publisher.runApproved(event.ownerId, draftId);
      marks = marksOf(deliveries.map((ctx) => ctx.delivery));
      message = buildResultMessage({ storeName, deliveries });
    } catch (error) {
      deps.logger.error('crosspost.operation_failed', {
        ownerId: event.ownerId,
        storeId,
        operation: 'run_approved',
        errorName: errorNameOf(error),
      });
      message = buildStatusMessage(await safeRecent(event.ownerId));
    }
    await sendResults(event, [message], marks, now().getTime() - startedAt);
  }

  /**
   * 「この下書きの結果を、この終了時刻のものまで届けた」の記録の単位。時刻は**示した投稿先の行の finished_at の最大**で、
   * アプリの時計を使わない（DB とアプリの時計のずれ・精度の違いで、届けていない結果を届けたことにしない）。
   */
  interface ResultMark {
    draftId: string;
    finishedUpTo: Date;
  }

  /** 示した投稿先の行から記録の単位を作る（終わった行が無ければ記録しない）。 */
  function marksOf(rows: ReadonlyArray<{ draft_id: string; finished_at: Date | null }>): ResultMark[] {
    const latest = new Map<string, Date>();
    for (const row of rows) {
      if (row.finished_at === null) continue;
      const prev = latest.get(row.draft_id);
      if (prev === undefined || row.finished_at.getTime() > prev.getTime()) latest.set(row.draft_id, row.finished_at);
    }
    return [...latest].map(([draftId, finishedUpTo]) => ({ draftId, finishedUpTo }));
  }

  async function recordMarks(ownerId: string, marks: readonly ResultMark[]): Promise<void> {
    for (const mark of marks) {
      try {
        await markCrosspostResultNotified(deps.db, { ownerId, draftIds: [mark.draftId], deliveredAt: mark.finishedUpTo });
      } catch (error) {
        // 記録できなくても結果は届いている。次の操作でもう一度示されるだけ（失う方向には倒れない）。
        deps.logger.warn('crosspost.operation_failed', { ownerId, operation: 'mark_notified', errorName: errorNameOf(error) });
      }
    }
  }

  // ===================================================================
  // 送信（すべての応答が通る 1 か所・Req 7.1, 7.2）
  // ===================================================================
  //
  // 規律:
  // 1. まだ届けていない投稿の結果があれば、応答の**前に**添える（最後のメッセージのクイックリプライは応答のまま）。
  //    1 回の返信は 5 通まで（LINE の上限）。入りきらない結果は添えず、次の応答に持ち越す。応答そのものは削らない
  // 2. Reply が受け付けられなければ（非 2xx・通信の失敗・時間切れ）Push で同じ内容を送る。時間がかかった応答
  //    （Reply トークンの期限が近い）は最初から Push
  // 3. Reply か Push が受け付けられたときだけ、示した結果を「届けた」と記録する（記録の時刻は示した行の finished_at）
  // 4. どちらも受け付けられなければ記録しない（結果は次の応答で必ずもう一度示す）。応答の操作そのもの（下書きの更新・
  //    投稿の実行）は送信の前に終わっており、送信の失敗で巻き戻らない
  //
  // 重複のリスク: Reply が実際には LINE に届いていたのに時間切れで「受け付けられなかった」と判定した場合、Push で
  // もう一度届く（同じ内容が 2 回見える）。結果を失うよりも重複を選ぶ。結果の記録は冪等（GREATEST）なので、
  // 二重に記録しても壊れない。並行した 2 つの応答が同じ未通知の結果を添えた場合も、同じ結果が 2 回見えるだけである。

  /** LINE の 1 回の返信に入るメッセージの数の上限。 */
  const MAX_MESSAGES_PER_SEND = 5;

  interface RespondOptions {
    /** この応答が示す投稿の結果（届いたら「届けた」と記録する）。 */
    marks?: readonly ResultMark[];
    /** 未通知の結果を添えるか（既定 true）。「投稿の状況」のように結果をすべて示す応答では添えない。 */
    includePending?: boolean;
    /** Reply を使わず最初から Push で送る（Reply トークンの期限が近い）。 */
    preferPush?: boolean;
  }

  async function respond(
    event: CrosspostEventBase,
    messages: readonly LineMessage[],
    options: RespondOptions = {},
  ): Promise<boolean> {
    const marks = [...(options.marks ?? [])];
    const room = MAX_MESSAGES_PER_SEND - messages.length;
    const pending =
      options.includePending === false || room < 1
        ? NO_PENDING
        : await pendingResults(event, room, new Set(marks.map((mark) => mark.draftId)));
    const all = [...pending.messages, ...messages];
    if (all.length === 0) return true;

    let delivered = false;
    if (!options.preferPush) delivered = await replyChecked(event.replyToken, all);
    if (!delivered) delivered = await pushChecked(event.lineUserId, all);
    if (!delivered) {
      deps.logger.warn('crosspost.notify_failed', { ownerId: event.ownerId });
      return false;
    }
    await recordMarks(event.ownerId, [...marks, ...pending.marks]);
    return true;
  }

  /** 応答（下書きの操作・案内など）を送る。未通知の結果を添え、Reply が届かなければ Push する。 */
  const say = async (event: CrosspostEventBase, ...messages: LineMessage[]): Promise<void> => {
    await respond(event, messages);
  };

  /** 投稿の結果を送る。時間がかかった（Reply トークンの期限が近い）ときは最初から Push。 */
  async function sendResults(
    event: CrosspostEventBase,
    messages: readonly LineMessage[],
    marks: readonly ResultMark[],
    elapsedMs: number,
  ): Promise<boolean> {
    return respond(event, messages, { marks, preferPush: elapsedMs >= replySafeMs });
  }

  /** 例外を投げない Reply（受け付けられたか）。 */
  async function replyChecked(token: string, messages: readonly LineMessage[]): Promise<boolean> {
    try {
      if (deps.messenger.replyChecked) return await deps.messenger.replyChecked(token, messages);
      await deps.messenger.reply(token, messages);
      return true;
    } catch (error) {
      deps.logger.warn('crosspost.operation_failed', { operation: 'notify', errorName: errorNameOf(error) });
      return false;
    }
  }

  /** 例外を投げない Push（受け付けられたか）。 */
  async function pushChecked(lineUserId: string, messages: readonly LineMessage[]): Promise<boolean> {
    try {
      if (deps.messenger.pushChecked) return await deps.messenger.pushChecked(lineUserId, messages);
      await deps.messenger.push(lineUserId, messages);
      return true;
    } catch (error) {
      deps.logger.warn('crosspost.operation_failed', { operation: 'notify', errorName: errorNameOf(error) });
      return false;
    }
  }

  interface PendingResults {
    messages: LineMessage[];
    marks: ResultMark[];
  }
  const NO_PENDING: PendingResults = { messages: [], marks: [] };

  /**
   * 届けていない結果（新しい順）を、`room` 通に入る分だけ作る。`exclude` の下書き（この応答がすでに示す結果）は
   * 添えない。読み出しに失敗しても応答は止めない。
   */
  async function pendingResults(event: CrosspostEventBase, room: number, exclude: ReadonlySet<string>): Promise<PendingResults> {
    try {
      const found = (
        await listUnnotifiedCrosspostResults(deps.db, { ownerId: event.ownerId, limit: MAX_PENDING_RESULTS + exclude.size })
      ).filter((item) => !exclude.has(item.draftId));
      if (found.length === 0) return NO_PENDING;
      // 案内の文を付ける余裕がある（結果の数 + 1 通が入る）ときだけ付ける。結果は入る分だけ（残りは次へ）。
      const take = Math.min(found.length, MAX_PENDING_RESULTS, room);
      const withIntro = take + 1 <= room;
      const messages: LineMessage[] = withIntro ? [buildPendingResultsIntroMessage()] : [];
      const marks: ResultMark[] = [];
      for (const item of found.slice(0, take)) {
        const result = await resultForDraft(event, item.draftId, item.storeName);
        messages.push(result.message);
        marks.push(...result.marks);
      }
      return { messages, marks };
    } catch (error) {
      deps.logger.warn('crosspost.operation_failed', { ownerId: event.ownerId, operation: 'pending_results', errorName: errorNameOf(error) });
      return NO_PENDING;
    }
  }

  /** 届けていない結果だけを送る（ほかに応答が無いとき）。送ったら true。 */
  async function respondPendingOnly(event: CrosspostEventBase): Promise<boolean> {
    const pending = await pendingResults(event, MAX_MESSAGES_PER_SEND, new Set());
    if (pending.messages.length === 0) return false;
    let delivered = await replyChecked(event.replyToken, pending.messages);
    if (!delivered) delivered = await pushChecked(event.lineUserId, pending.messages);
    if (delivered) await recordMarks(event.ownerId, pending.marks);
    else deps.logger.warn('crosspost.notify_failed', { ownerId: event.ownerId });
    return true;
  }

  async function safeRecent(ownerId: string): Promise<Awaited<ReturnType<typeof listRecentCrosspostPosts>>> {
    try {
      return await listRecentCrosspostPosts(deps.db, { ownerId, limit: 5 });
    } catch {
      // swallowed-exception: intentional — 結果の表示の代替の読み出しに失敗しても、承認の後は投げない（上の方針）。
      return [];
    }
  }

  async function resultForDraft(
    event: CrosspostEventBase,
    draftId: string,
    storeName: string,
  ): Promise<{ message: LineMessage; marks: ResultMark[] }> {
    const deliveries = await listCrosspostDeliveries(deps.db, { ownerId: event.ownerId, draftId });
    return { message: buildResultMessage({ storeName, deliveries }), marks: marksOf(deliveries.map((ctx) => ctx.delivery)) };
  }

  async function sendResultForDraft(event: CrosspostEventBase, draftId: string, storeName: string, elapsedMs: number): Promise<void> {
    const result = await resultForDraft(event, draftId, storeName);
    await sendResults(event, [result.message], result.marks, elapsedMs);
  }

  /** 直近の投稿の状況（Req 7.3）。示した下書きの結果は届いたと記録する。 */
  async function showStatus(event: CrosspostEventBase): Promise<void> {
    await deps.publisher.reapStale(event.ownerId);
    const posts = await listRecentCrosspostPosts(deps.db, { ownerId: event.ownerId, limit: 5 });
    await respond(event, [buildStatusMessage(posts)], {
      marks: marksOf(posts.flatMap((post) => post.deliveries)),
      includePending: false,
    });
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
          await say(event, closedMessage(state.reason));
          return;
        }
        if (state.kind === 'none') {
          await say(event, buildNoOpenDraftMessage());
          return;
        }
        await say(event, await currentStateMessage(event.ownerId, state.open));
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
          lineEventAt: event.sentAt === null ? null : new Date(event.sentAt),
          expiresAt: expiresAt(),
        });
        if (updated === null) {
          await say(event, buildStaleMessage(postback.draftId));
          return;
        }
        await say(
          event,
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
                lineEventAt: null,
                expiresAt: expiresAt(),
              })) ?? draft;
          }
          await say(event, await currentStateMessage(event.ownerId, { ...state.open, draft }));
          return;
        }
        // 作成中でなければ、承認済みの下書きの結果を出す（他のオーナーの下書きは読めない）。
        const past = await getCrosspostDraft(deps.db, { ownerId: event.ownerId, draftId: postback.draftId });
        if (past !== null && past.draft.status === 'approved') {
          await sendResultForDraft(event, past.draft.id, past.storeName, 0);
          return;
        }
        await say(event, state.kind === 'closed' ? closedMessage(state.reason) : buildNoOpenDraftMessage());
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
          await say(event, buildStaleMessage(open.draft.id));
          return;
        }
        const photo = await confirmPhoto(event.ownerId, open.draft.id);
        if (photo.kind === 'unverifiable') {
          await say(event, buildPhotoResendRequiredMessage(open.draft.id));
          return;
        }
        await say(
          event,
          ...buildConfirmMessage({
            draft: open.draft,
            storeName: open.storeName,
            choice: postback.choice,
            photo: photo.kind === 'none' ? null : photo,
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
          await say(event, buildNoOpenDraftMessage());
          return;
        }
        await deleteMedia(closed.removedStorageKeys, event.ownerId);
        await say(event, buildCanceledMessage());
        return;
      }

      case 'x_status':
        await showStatus(event);
        return;

      case 'x_retry': {
        const startedAt = now().getTime();
        const result = await deps.publisher.retry(event.ownerId, postback.deliveryId);
        if (result.kind !== 'ran') {
          await say(event, buildNotRetryableMessage());
          return;
        }
        const draftId = result.delivery.delivery.draft_id;
        await sendResultForDraft(event, draftId, result.delivery.storeName, now().getTime() - startedAt);
        return;
      }

      case 'x_run': {
        // 待ち（一度も送っていない）の投稿先の再開（Req 6.11）。下書きの待ちをまとめて実行する（CAS で重複しない）。
        await deps.publisher.reapStale(event.ownerId);
        const ctx = await getCrosspostDelivery(deps.db, { ownerId: event.ownerId, deliveryId: postback.deliveryId });
        if (ctx === null || ctx.delivery.status !== 'queued') {
          await say(event, buildNotRetryableMessage());
          return;
        }
        await runAndReport(event, ctx.delivery.draft_id, ctx.storeName, ctx.storeId);
        return;
      }

      case 'x_drop': {
        const canceled = await deps.publisher.cancelQueued(event.ownerId, postback.deliveryId);
        if (canceled === null) {
          await say(event, buildNotRetryableMessage());
          return;
        }
        const draftId = canceled.delivery.draft_id;
        await sendResultForDraft(event, draftId, canceled.storeName, 0);
        return;
      }

      case 'x_check': {
        const result = await deps.publisher.reconcile(event.ownerId, postback.deliveryId);
        if (result.delivery === null) {
          await say(event, buildNotRetryableMessage());
          return;
        }
        const draftId = result.delivery.delivery.draft_id;
        await sendResultForDraft(event, draftId, result.delivery.storeName, 0);
        return;
      }

      case 'x_seen': {
        const updated = await deps.publisher.markObserved(event.ownerId, postback.deliveryId, postback.posted);
        if (updated === null) {
          await say(event, buildNotRetryableMessage());
          return;
        }
        const draftId = updated.delivery.draft_id;
        await sendResultForDraft(event, draftId, updated.storeName, 0);
        return;
      }
    }
  }

  // ===================================================================
  // テキスト・画像
  // ===================================================================

  async function handleOpenText(event: CrosspostEventBase & { text: string }, open: OpenCrosspostDraft): Promise<void> {
    // 応答は say() が未通知の結果を前に添えて送る（下書きの操作は妨げない・Req 7.2）。
    const replyDraft = (...messages: LineMessage[]): Promise<void> => say(event, ...messages);
    const draft = open.draft;
    const value = event.text.trim();

    if (draft.status === 'collecting') {
      if (value.length === 0) {
        await replyDraft(buildNeedMaterialMessage(draft.id));
        return;
      }
      const appended = await appendCrosspostMaterial(deps.db, {
        ownerId: event.ownerId,
        draftId: draft.id,
        text: value,
        sentAt: event.sentAt === null ? null : new Date(event.sentAt),
        expiresAt: expiresAt(),
      });
      if (!appended.ok) {
        await replyDraft(
          appended.error === 'TOO_LONG'
            ? buildMaterialTooLongMessage(draft.id)
            : appended.error === 'NOT_AFTER_START'
              ? buildTextBeforeDraftMessage(draft.id)
              : buildMaterialAfterGenerationMessage(draft.id),
        );
        return;
      }
      await replyDraft(
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
      await replyDraft(buildReviewHintMessage(draft.id));
      return;
    }
    // 「自分で書き直す」「AI に直してもらう」を押した後に送られた文だけを、その入力として扱う。押す前に送った文が
    // 遅れて届いた（または時刻が分からない）なら、書き直し・修正指示にしない（Req 4.7）。
    const setAt = draft.input_mode_set_at;
    if (event.sentAt === null || setAt === null || event.sentAt <= setAt.getTime()) {
      await replyDraft(buildTextBeforeInputModeMessage(draft.id));
      return;
    }
    const inputSentAt = new Date(event.sentAt);

    if (draft.input_mode === 'manual') {
      const issue = validateManualText(destination, value);
      if (issue !== null) {
        await replyDraft(buildManualTextRejectedMessage({ draftId: draft.id, destination, issue }));
        return;
      }
      const saved = await saveCrosspostTexts(deps.db, {
        ownerId: event.ownerId,
        draftId: draft.id,
        expectedRevision: draft.revision,
        texts: { [destination]: value },
        inputSentAt,
        expiresAt: expiresAt(),
      });
      if (saved === null) {
        await replyDraft(buildStaleMessage(draft.id));
        return;
      }
      await replyDraft(await reviewMessage(event.ownerId, saved, open.storeName));
      return;
    }

    // AI への修正指示（Req 4.3）。指示は、その生成の照合の素材に加える。
    if (value.length === 0) {
      await replyDraft(buildInputModeMessage({ draftId: draft.id, destination, mode: 'ai_revision' }));
      return;
    }
    await generateAndSave(event, draft, open.storeName, [destination], { destination, instruction: value, inputSentAt });
  }

  async function handleOpenImage(event: CrosspostEventBase & { image: InboundImage }, open: OpenCrosspostDraft): Promise<void> {
    const replyDraft = (...messages: LineMessage[]): Promise<void> => say(event, ...messages);
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
      quoteToken: event.image.quoteToken,
      sentAt: event.image.sentAt,
    });
    switch (result.kind) {
      case 'rejected':
        await replyDraft(buildPhotoRejectedMessage({ draftId: open.draft.id, reason: result.reason }));
        return;
      case 'not_open':
        await replyDraft(buildNoOpenDraftMessage());
        return;
      case 'duplicate':
        await replyDraft(await currentStateMessage(event.ownerId, open));
        return;
      case 'before_draft':
        // 下書きを始める前（別の下書き・取り消した下書き）に送った写真が遅れて届いた。この下書きには付けない（Req 2.11）。
        await replyDraft(buildPhotoBeforeDraftMessage(open.draft.id));
        return;
      case 'older':
        // 処理が遅れて後から届いた、前に送った写真。店主が最後に送った写真を保つ（Req 2.5）。
        await replyDraft(buildOlderPhotoIgnoredMessage(open.draft.id), await currentStateMessage(event.ownerId, open));
        return;
      case 'ambiguous':
        // 同じ時刻に送られた別の写真。どちらが後かを推測で決めない。使いたい写真を送り直してもらう。
        await replyDraft(buildAmbiguousPhotoMessage(open.draft.id));
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
        await replyDraft(...notices);
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
        await say(event, buildStaleMessage(null));
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
        await say(event, closedMessage(state.reason));
        return 'handled';
      }
      // 「投稿の状況」は、下書きの作成中・確認中でも命令として扱う（素材・修正指示・書き直しの文にしない・Req 7.3）。
      // 下書きは変えない（受け取った素材・文は失われない）。
      if (STATUS_KEYWORDS.has(event.text.trim())) {
        await showStatus(event);
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
      // 届けられなかった投稿の結果があれば、どの文への返信でも先に届ける（結果を失わない・Req 7.2）。
      if (await respondPendingOnly(event)) return 'handled';
      return 'not_handled';
    },

    async handleImage(event) {
      const stores = await eligibleStores(event.ownerId);
      if (stores.length === 0) return 'not_handled';
      const state = await loadOpen(event.ownerId);
      if (state.kind === 'closed') {
        await say(event, closedMessage(state.reason));
        return 'handled';
      }
      if (state.kind === 'none') return 'not_handled';
      await handleOpenImage(event, state.open);
      return 'handled';
    },
  };
}
