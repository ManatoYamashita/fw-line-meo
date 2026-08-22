// GBP 会話フローの状態機械（design.md「GbpFlows」・spec task 3.3 / 4.1）。
// Requirements: 1.1（Place 確定済み店舗のみ誘導）, 1.2（連携開始→認可誘導）,
//   1.3（複数店舗は選択させてから誘導）, 2.3（失効時は実行せず再連携誘導）,
//   2.4（連携解除 = revoke + 行削除 + 未連携案内）, 2.5（連携状態の確認）,
//   3.1–3.7・3.9（投稿の要点入力→下書き生成→承認→実行）, 6.6（生成失敗の案内）。
//
// 実装済みの範囲は **連携系（connect / status / disconnect）・投稿（機能2）・
// クチコミ返信（機能1-b）** の全フロー。
//
// 設計上の不変条件:
// - **GBP への書込（createLocalPost / upsertReviewReply）は `g_approve` ハンドラからのみ
//   到達できる**（Req 3.6・4.5 の構造的保証）。生成直後・提示中に投稿・返信する経路を
//   作ってはならない。投稿と返信は別ハンドラで、各々が自フローの CAS だけを打つ。
// - 承認の実行は `executing` への **条件付き更新（CAS）** で排他する。獲得できなかった
//   リクエストは何も実行せず現在状態を案内する（二重タップでも書込は高々 1 回）。
//   CAS は **flow 条件付き**（TOCTOU 対策）: セッション読み取りと CAS の間に別フローの
//   セッションへ置換されても、返信の下書きが投稿として送信されることはない。
// - 返信対象の候補は **星評価で選別・並べ替えしない**（Req 4.9・レビューゲーティング禁止）。
//   並び順は「未返信優先 → 新着順」のみ。
// - 実行失敗時はセッション（`draft_text` 含む）を温存して `await_decision` へ戻す
//   （Req 3.7: 承認済みの下書きを失わせない）。成功時のみセッションを削除する。
// - **postback data の storeId・index は信用しない**。対象店舗は必ず
//   `listConfirmedStoresByOwner`（owner_id を WHERE に持つ所有検証込みクエリ）の結果集合との
//   突合で解決する。突合できない storeId は「存在しない」と同じ扱いに倒す（Req 2.6・fail-closed）。
// - セッションは owner 単位に高々 1 つ（gbp_sessions の owner_id 一意）。期限切れは
//   検出した時点で必ず行を削除し、案内のみを返す（残骸を残さない）。
// - stage と action が噛み合わない stale postback は **何も実行せず**現在状態を案内する
//   （design「State Management」: 旧 postback は stage 不一致で安全に無視する）。
// - `crypto_error`（token_ref の復号不能）でオーナーへ「再連携してください」と案内しない
//   （鍵事故はオーナーの操作で解決しない。tasks.md Implementation Notes 2.2 の申し送り）。
//
// conversation.ts との関係（design の Service Interface からの適応）:
// design のスケッチは `handleGbpPostback(deps, event, action)` のように deps と decode 済み
// action を毎回引数で渡す形だが、本実装は onboarding の `createConversationHandlers(deps)` と
// 同じファクトリ（deps をクロージャに束ねる）形にし、decode も本モジュール内で行う。
// 後者は postback.ts の責任分界（「未知 action の案内フォールバックは GbpFlows 側が担う」）に
// 従うためで、conversation.ts 側は `isGbpPostbackData` による委譲判定のみを持てばよくなる。

import {
  beginGbpSessionExecution,
  clearGbpSession,
  completeGbpSessionExecution,
  getActiveGbpSession,
  listConfirmedStoresByOwner,
  revertGbpSessionExecution,
  upsertGbpSession,
  deleteGbpLocation,
  type ConfirmedStoreSummary,
  type GbpFlow,
  type GbpLocationKey,
  type GbpSessionLookup,
  type GbpSessionRow,
  type Queryable,
  type Result,
  type UpsertGbpSessionInput,
} from '@fwlm/db';
import type { ConnectablePool, TransactionClient } from '@fwlm/store-identification';
import type { LineMessage, LineMessenger } from '../line/client.js';
import { CONNECT_SESSION_TTL_MS, type GbpOauthService } from './oauth.js';
import { decodeGbpPostback, type GbpPostbackAction } from './postback.js';
import type { StoreKey, TokenStoreService } from './token-store.js';
import type { GbpApiError, GbpClientService, GbpReview } from './client.js';
import { errorNameOf, type GbpLogger } from './logger.js';
import {
  pickPostVariation,
  pickReplyVariation,
  type GbpPromptsService,
  type PostDraftMaterial,
  type ReplyDraftMaterial,
  type RevisionContext,
} from './prompts.js';
import {
  buildGbpAlreadyLinkedMessage,
  buildGbpAuthorizeMessage,
  buildGbpCancelledMessage,
  buildGbpConnectRequiredMessage,
  buildGbpConnectUnavailableMessage,
  buildGbpCurrentStateMessage,
  buildGbpDisconnectedMessage,
  buildGbpGenerationFailedMessage,
  buildGbpNoEligibleStoreMessage,
  buildGbpNoReviewsMessage,
  buildGbpNotLinkedMessage,
  buildGbpOverwriteConfirmMessages,
  buildGbpPostDraftMessages,
  buildGbpPostFailedMessage,
  buildGbpPostInputPromptMessage,
  buildGbpPostStorePickerMessage,
  buildGbpPostSucceededMessage,
  buildGbpReplyDraftMessages,
  buildGbpReplyFailedMessage,
  buildGbpReplyStorePickerMessage,
  buildGbpReplySucceededMessage,
  buildGbpReviewListFailedMessage,
  buildGbpReviewPickerMessage,
  buildGbpRevisionPromptMessage,
  buildGbpSessionExpiredMessage,
  buildGbpStaleSelectionMessage,
  buildGbpStatusMessage,
  buildGbpStorePickerMessage,
  MAX_REVIEW_CANDIDATES,
  MAX_SELECTABLE_STORES,
  type GbpPostFailureReason,
  type GbpReviewSummary,
} from './messages.js';

// =====================================================================
// 契約
// =====================================================================

/** conversation.ts が委譲する postback（ownerId は委譲側が解決済み）。 */
export interface GbpPostbackEvent {
  ownerId: string;
  lineUserId: string;
  replyToken: string;
  data: string;
}

/** conversation.ts が委譲する text（ownerId は委譲側が解決済み）。 */
export interface GbpTextEvent {
  ownerId: string;
  lineUserId: string;
  replyToken: string;
  text: string;
}

/**
 * text の引き受け結果。`not_handled` は「GBP のアクティブなセッションが無いため
 * このテキストは GBP の入力ではない」を意味し、委譲元（onboarding）の既存案内へ戻す。
 */
export type HandledResult = 'handled' | 'not_handled';

export interface GbpSessionsAccessor {
  getActiveGbpSession(db: Queryable, ownerId: string, now?: Date): Promise<GbpSessionLookup>;
  upsertGbpSession(
    db: Queryable,
    input: UpsertGbpSessionInput,
  ): Promise<Result<GbpSessionRow, 'STORE_NOT_OWNED'>>;
  clearGbpSession(db: Queryable, ownerId: string): Promise<boolean>;
  /**
   * 承認実行の CAS 獲得（`flow` × await_decision → executing）。null なら実行してはならない。
   * **flow を必ず渡す**: 読み取りと CAS の間に別フローのセッションへ置換されうるため、
   * flow 条件が無いと返信の下書きを投稿ハンドラが獲得しうる（TOCTOU・task 4.2）。
   */
  beginGbpSessionExecution(
    db: Queryable,
    ownerId: string,
    flow: GbpFlow,
  ): Promise<GbpSessionRow | null>;
  /** 実行成功の後始末（獲得したフローの executing 行のみ削除）。 */
  completeGbpSessionExecution(db: Queryable, ownerId: string, flow: GbpFlow): Promise<boolean>;
  /** 実行失敗の巻き戻し（executing → await_decision・draft 温存）。 */
  revertGbpSessionExecution(
    db: Queryable,
    ownerId: string,
    flow: GbpFlow,
    expiresAt: Date,
  ): Promise<GbpSessionRow | null>;
}

export interface GbpLocationsAccessor {
  deleteGbpLocation(db: Queryable, key: GbpLocationKey): Promise<boolean>;
}

/** 連携対象になり得る店舗（Place 確定済み）の列挙。所有検証はアクセサ側のクエリ形状が担う。 */
export interface GbpStoresAccessor {
  listConfirmedStoresByOwner(
    db: Queryable,
    ownerId: string,
  ): Promise<readonly ConfirmedStoreSummary[]>;
}

export interface GbpFlowDeps {
  db: Queryable;
  /** 連携解除の 2 テーブル同時削除用（oauth.ts の persistLink と対になる境界）。 */
  pool: ConnectablePool;
  oauth: Pick<GbpOauthService, 'startConnect' | 'revokeToken'>;
  tokenStore: Pick<TokenStoreService, 'isLinked' | 'getAccessTokenForStore' | 'deleteToken'>;
  sessions: GbpSessionsAccessor;
  locations: GbpLocationsAccessor;
  stores: GbpStoresAccessor;
  /** 下書き生成（機能2 = 投稿・機能1-b = 返信）。 */
  prompts: Pick<GbpPromptsService, 'generatePostDraft' | 'generateReplyDraft'>;
  /**
   * GBP への読み書き。**書込（`createLocalPost` / `upsertReviewReply`）は `g_approve`
   * ハンドラ以外から呼んではならない**（Req 3.6・4.5）。`listReviews` は読み取りのみで、
   * 返信フローの候補提示（Req 4.1）に使う。
   */
  gbpClient: Pick<GbpClientService, 'createLocalPost' | 'listReviews' | 'upsertReviewReply'>;
  messenger: Pick<LineMessenger, 'reply'>;
  /**
   * 失敗の記録先（design.md「Monitoring」）。**本文・下書き・トークンは載せられない**
   * （GbpLogMeta が allowlist）。これが無いと、利用審査未承認によるクォータ 0 のような
   * 最有力の本番障害が、オーナーからの問い合わせ以外に観測できない。
   */
  logger: GbpLogger;
  now(): Date;
}

export interface GbpFlowHandlers {
  /**
   * `not_handled` は「GBP 側で引き受けられなかった」を意味し、委譲元（onboarding）の
   * 既存案内へ戻す。GBP サブシステムの障害（例: gbp_sessions が未作成・権限不足）で
   * 例外が出た場合もこれを返す（Req 4.6 の既存挙動を巻き込まないため）。
   */
  handleGbpPostback(event: GbpPostbackEvent): Promise<HandledResult>;
  handleGbpText(event: GbpTextEvent): Promise<HandledResult>;
}

/** packages/db のアクセサをそのまま束ねた既定の配線（index.ts 用）。 */
export function createDefaultGbpFlowAccessors(): {
  sessions: GbpSessionsAccessor;
  locations: GbpLocationsAccessor;
  stores: GbpStoresAccessor;
} {
  return {
    sessions: {
      getActiveGbpSession,
      upsertGbpSession,
      clearGbpSession,
      beginGbpSessionExecution,
      completeGbpSessionExecution,
      revertGbpSessionExecution,
    },
    locations: { deleteGbpLocation },
    stores: { listConfirmedStoresByOwner },
  };
}

// =====================================================================
// 実装
// =====================================================================

export function createGbpFlowHandlers(deps: GbpFlowDeps): GbpFlowHandlers {
  const reply = (replyToken: string, message: LineMessage): Promise<void> =>
    deps.messenger.reply(replyToken, [message]);

  /**
   * GBP 呼び出しの失敗を 1 行だけ記録する。`toGbpFailureReason` は 7 種の kind を
   * 3 つの文面へ畳むため、**畳む前にここで kind と status を残す**。これが無いと
   * 「利用審査未承認（permission_denied）」と「一過性障害」が本番で区別できない。
   */
  const logFailure = (
    flow: GbpFlow,
    ownerId: string,
    storeId: string | null,
    error: GbpApiError,
  ): void => {
    deps.logger.warn('gbp: operation failed', {
      flow,
      ownerId,
      ...(storeId !== null ? { storeId } : {}),
      errorKind: error.kind,
      ...(error.kind === 'upstream_error' ? { status: error.status } : {}),
    });
  };

  /**
   * Req 1.1: 連携誘導・状態確認の対象は Place 確定済み店舗のみ。
   * 提示件数は Flex カルーセルの契約（10 件）に丸める。丸めた結果がそのまま
   * セッションへ保存されるスナップショットになるため、index の意味が提示内容と常に一致する。
   */
  async function resolveEligibleStores(ownerId: string): Promise<ConfirmedStoreSummary[]> {
    const stores = await deps.stores.listConfirmedStoresByOwner(deps.db, ownerId);
    return stores.slice(0, MAX_SELECTABLE_STORES);
  }

  /** 対象店舗が確定した後の共通処理（連携済み判定 → 認可 URL の発行・提示）。 */
  async function beginConnect(
    event: GbpPostbackEvent,
    store: ConfirmedStoreSummary,
  ): Promise<void> {
    const key: StoreKey = { ownerId: event.ownerId, storeId: store.id };

    if (await deps.tokenStore.isLinked(deps.db, key)) {
      // 連携済みの店舗を再認可しても得るものがないため、状態と解除導線のみを案内する。
      //
      // **ここでセッションを破棄してはならない**（PR #121 レビュー指摘）。この分岐は
      // startConnect を伴わない＝何も置き換えないので、破棄は純粋な副作用になる。
      // 失効時の失敗文面は「下書きは保存しています」と案内したうえで再連携導線を出すため、
      // ここで clear すると、その導線を踏んだ瞬間に温存したはずの draft_text が消える
      // （Req 3.7 / 4.7 に反する）。失効した連携の張り直しは g_relink が担う。
      await reply(event.replyToken, buildGbpAlreadyLinkedMessage(store.id, store.name));
      return;
    }

    // Req 1.2: state 発行（gbp_sessions を connect/await_callback へ置換）と認可 URL 生成。
    // storeId の所有検証は upsertGbpSession のクエリ内でも再度行われる（二重の防御）。
    const started = await deps.oauth.startConnect(deps.db, key);
    if (!started.ok) {
      await reply(event.replyToken, buildGbpConnectUnavailableMessage());
      return;
    }

    await reply(
      event.replyToken,
      buildGbpAuthorizeMessage({
        storeName: store.name,
        authorizeUrl: started.value.authorizeUrl,
      }),
    );
  }

  /** Req 1.1, 1.2, 1.3: 連携開始。単一店舗は即認可誘導、複数店舗は選択を挟む。 */
  async function handleConnect(event: GbpPostbackEvent): Promise<void> {
    const stores = await resolveEligibleStores(event.ownerId);

    if (stores.length === 0) {
      await reply(event.replyToken, buildGbpNoEligibleStoreMessage());
      return;
    }

    const single = stores.length === 1 ? stores[0] : undefined;
    if (single !== undefined) {
      await beginConnect(event, single);
      return;
    }

    // Req 1.3: 提示した並び順を payload に固定し、g_pick_store の index と対応づける。
    const upserted = await deps.sessions.upsertGbpSession(deps.db, {
      ownerId: event.ownerId,
      storeId: null,
      flow: 'connect',
      stage: 'await_store',
      payload: { storeIds: stores.map((store) => store.id) },
      draftText: null,
      expiresAt: new Date(deps.now().getTime() + CONNECT_SESSION_TTL_MS),
    });
    if (!upserted.ok) {
      await reply(event.replyToken, buildGbpConnectUnavailableMessage());
      return;
    }

    await reply(event.replyToken, buildGbpStorePickerMessage(stores));
  }

  /**
   * index → storeId をセッションのスナップショットで解決し、その storeId が
   * **現在の所有店舗一覧に存在すること** を必ず再確認する（スナップショット自体は
   * 過去の値であり、単独では所有の根拠にならない）。解決できなければ null。
   */
  async function resolvePickedStore(
    ownerId: string,
    session: GbpSessionRow,
    index: number,
  ): Promise<ConfirmedStoreSummary | null> {
    const snapshot = readStoreIdSnapshot(session.payload);
    const pickedId = snapshot[index];
    if (pickedId === undefined) return null;

    // 所有検証は「委譲側が解決した ownerId」を根拠にする（セッション行の値ではない）。
    const stores = await resolveEligibleStores(ownerId);
    return stores.find((candidate) => candidate.id === pickedId) ?? null;
  }

  /** Req 1.3: 連携フローの店舗選択。 */
  async function handlePickStore(
    event: GbpPostbackEvent,
    session: GbpSessionRow,
    index: number,
  ): Promise<void> {
    const store = await resolvePickedStore(event.ownerId, session, index);
    if (store === null) {
      await reply(event.replyToken, buildGbpStaleSelectionMessage());
      return;
    }

    await beginConnect(event, store);
  }

  /** Req 2.5: 店舗ごとの連携有無と操作ボタンを提示する。 */
  async function handleStatus(event: GbpPostbackEvent): Promise<void> {
    const stores = await resolveEligibleStores(event.ownerId);
    if (stores.length === 0) {
      await reply(event.replyToken, buildGbpNoEligibleStoreMessage());
      return;
    }

    const entries = await Promise.all(
      stores.map(async (store) => ({
        storeId: store.id,
        name: store.name,
        linked: await deps.tokenStore.isLinked(deps.db, {
          ownerId: event.ownerId,
          storeId: store.id,
        }),
      })),
    );

    await reply(event.replyToken, buildGbpStatusMessage(entries));
  }

  /**
   * Req 2.4: 連携解除。postback の storeId は形式検証しか通っていないため、
   * `isLinked`（owner_id 突合込みのクエリ）で所有と連携の両方を同時に検証し、
   * 満たさない場合は他オーナーの店舗の存在を推測させない同一文面へ倒す。
   */
  async function handleDisconnect(
    event: GbpPostbackEvent,
    session: GbpSessionRow | null,
    storeId: string,
  ): Promise<void> {
    const key: StoreKey = { ownerId: event.ownerId, storeId };

    if (!(await deps.tokenStore.isLinked(deps.db, key))) {
      await reply(event.replyToken, buildGbpNotLinkedMessage());
      return;
    }

    const stores = await resolveEligibleStores(event.ownerId);
    const storeName = stores.find((store) => store.id === storeId)?.name ?? null;

    // Google 側の認可を手放す（ベストエフォート）。アクセストークンの revoke は
    // 同一 grant の refresh token も無効化する。取得できない場合（失効済み・復号不能・
    // 一過性障害）は revoke を諦め、ローカルの認可情報の削除だけは必ず行う
    // （削除を止めると「解除したのに残る」という利用者にとって最悪の結果になるため）。
    await revokeBestEffort(key);

    // oauth_tokens と gbp_locations は同時に消す（gbp_locations は oauth_tokens 行なしに
    // 存在しないという Domain Model の不変条件を、削除側でも同一トランザクションで守る）。
    await deleteLinkRows(key);

    if (session !== null && session.store_id === storeId) {
      // 解除した店舗に紐づく進行中の手続きは意味を失うため破棄する。
      await deps.sessions.clearGbpSession(deps.db, event.ownerId);
    }

    await reply(event.replyToken, buildGbpDisconnectedMessage(storeName));
  }

  /**
   * Req 2.3: 失効した連携の張り直し（PR #121 レビュー指摘の是正）。
   *
   * `g_connect` は `isLinked`（oauth_tokens 行の存在のみ）で短絡するため、refresh token が
   * 失効していても「すでに連携済み」しか返せず、案内どおり操作しても復旧できない行き止まりに
   * なっていた。本ハンドラは解除と同じ所有検証を通したうえで古い認可情報を消し、そのまま
   * 認可 URL の発行（beginConnect）へ進む。この時点で isLinked は false なので startConnect が走る。
   *
   * 下書きは残らない（gbp_sessions は owner 単位で 1 行しか持てず、startConnect の upsert と
   * callback の消費で必ず置換される）。失敗文面側でその旨を明示している。
   */
  async function handleRelink(event: GbpPostbackEvent, storeId: string): Promise<void> {
    const key: StoreKey = { ownerId: event.ownerId, storeId };

    // 所有と連携の両方を同時に検証する（g_disconnect と同一の規律）。満たさない場合は
    // 他オーナーの店舗の存在を推測させない同一文面へ倒す。
    if (!(await deps.tokenStore.isLinked(deps.db, key))) {
      await reply(event.replyToken, buildGbpNotLinkedMessage());
      return;
    }

    const stores = await resolveEligibleStores(event.ownerId);
    const store = stores.find((candidate) => candidate.id === storeId);
    if (store === undefined) {
      await reply(event.replyToken, buildGbpStaleSelectionMessage());
      return;
    }

    // Google 側の認可を手放してからローカルを消す（解除と同じ順序・同じヘルパー）。
    await revokeBestEffort(key);
    await deleteLinkRows(key);

    await beginConnect(event, store);
  }

  async function revokeBestEffort(key: StoreKey): Promise<void> {
    let accessToken: string | null = null;
    try {
      const result = await deps.tokenStore.getAccessTokenForStore(deps.db, key);
      // not_linked / token_invalid / crypto_error はいずれも revoke 不能。
      // crypto_error でも再連携を促す文面は出さない（本モジュールの不変条件）。
      accessToken = result.ok ? result.value : null;
    } catch {
      // 一過性障害（ネットワーク・5xx）。エラーは平文トークンを含みうるため保持もログもしない。
      accessToken = null;
    }
    if (accessToken === null) return;

    try {
      await deps.oauth.revokeToken(accessToken);
    } catch {
      // 既定実装は throw しないが、注入実装が throw しても解除の結論は変えない。
    }
  }

  async function deleteLinkRows(key: StoreKey): Promise<void> {
    const client: TransactionClient = await deps.pool.connect();
    try {
      await client.query('BEGIN');
      await deps.tokenStore.deleteToken(client, key);
      await deps.locations.deleteGbpLocation(client, key);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // ===================================================================
  // 投稿フロー（機能2・spec task 4.1）
  //
  // 状態機械（design「System Flows > 下書き承認フロー」）:
  //   [*] → await_input（単一店舗）/ await_store（複数店舗）
  //   await_store → await_input（g_pick_store）
  //   await_input → await_decision（要点テキスト受領・下書き生成）
  //   await_decision → await_decision（g_regen）/ await_revision（g_revise）
  //   await_revision → await_decision（修正指示テキスト受領・反映再提示）
  //   await_decision → [*]（g_approve = 実行 / g_cancel）
  //
  // **承認ゲートの構造的保証（Req 3.6）**: `deps.gbpClient.createLocalPost` の呼び出しは
  // `handleApprove` の 1 箇所のみ。生成直後・提示中に投稿する経路は存在しない。
  // ===================================================================

  /** セッション期限は 30 分（design）。連携フローと同一の値を単一所有する。 */
  const sessionExpiry = (): Date => new Date(deps.now().getTime() + CONNECT_SESSION_TTL_MS);

  /** Req 3.1, 3.9: 投稿フローの開始。未連携なら状態機械に入らず連携誘導へ倒す。 */
  async function handlePostStart(event: GbpPostbackEvent): Promise<void> {
    const stores = await resolveEligibleStores(event.ownerId);

    if (stores.length === 0) {
      await reply(event.replyToken, buildGbpNoEligibleStoreMessage());
      return;
    }

    const single = stores.length === 1 ? stores[0] : undefined;
    if (single !== undefined) {
      await beginPostForStore(event, single);
      return;
    }

    // 複数店舗は対象を選ばせてから連携判定を行う（提示順を payload に固定する）。
    const upserted = await deps.sessions.upsertGbpSession(deps.db, {
      ownerId: event.ownerId,
      storeId: null,
      flow: 'post',
      stage: 'await_store',
      payload: { storeIds: stores.map((store) => store.id) },
      draftText: null,
      expiresAt: sessionExpiry(),
    });
    if (!upserted.ok) {
      await reply(event.replyToken, buildGbpStaleSelectionMessage());
      return;
    }

    await reply(event.replyToken, buildGbpPostStorePickerMessage(stores));
  }

  /**
   * Req 3.9: 対象店舗が確定した後の入口。未連携なら **セッションを作らず** 連携誘導を返す
   * （既存の進行中セッションには触れない。連携開始側の upsert が置換するため）。
   */
  async function beginPostForStore(
    event: GbpPostbackEvent,
    store: ConfirmedStoreSummary,
  ): Promise<void> {
    const linked = await deps.tokenStore.isLinked(deps.db, {
      ownerId: event.ownerId,
      storeId: store.id,
    });
    if (!linked) {
      await reply(event.replyToken, buildGbpConnectRequiredMessage(store.name));
      return;
    }

    const upserted = await deps.sessions.upsertGbpSession(deps.db, {
      ownerId: event.ownerId,
      storeId: store.id,
      flow: 'post',
      stage: 'await_input',
      payload: {},
      draftText: null,
      expiresAt: sessionExpiry(),
    });
    if (!upserted.ok) {
      await reply(event.replyToken, buildGbpStaleSelectionMessage());
      return;
    }

    await reply(event.replyToken, buildGbpPostInputPromptMessage(store.name));
  }

  /** 投稿フローの店舗選択（await_store）。 */
  async function handlePostPickStore(
    event: GbpPostbackEvent,
    session: GbpSessionRow,
    index: number,
  ): Promise<void> {
    const store = await resolvePickedStore(event.ownerId, session, index);
    if (store === null) {
      await reply(event.replyToken, buildGbpStaleSelectionMessage());
      return;
    }
    await beginPostForStore(event, store);
  }

  /**
   * セッションの store_id を **現在の所有・Place 確定済み一覧** と突合して解決する。
   * 突合できない（削除・place_status 変化・他オーナー化）場合は null を返し、
   * 呼び出し側は何も実行せずやり直しを案内する（fail-closed）。
   */
  async function resolveSessionStore(
    ownerId: string,
    session: GbpSessionRow,
  ): Promise<ConfirmedStoreSummary | null> {
    const storeId = session.store_id;
    if (storeId === null) return null;
    const stores = await resolveEligibleStores(ownerId);
    return stores.find((store) => store.id === storeId) ?? null;
  }

  /**
   * 下書きを生成し、成功時のみ await_decision へ遷移させて全文と 3 択を提示する
   * （Req 3.2・3.3・3.4）。生成失敗時は stage を進めず案内のみ返す（Req 6.6）。
   */
  async function generateAndPresentPostDraft(
    event: { ownerId: string; replyToken: string },
    store: ConfirmedStoreSummary,
    ownerInput: string,
    revision?: RevisionContext,
  ): Promise<void> {
    const material: PostDraftMaterial = { storeName: store.name, ownerInput };
    const generated = await deps.prompts.generatePostDraft(
      material,
      pickPostVariation(),
      revision,
    );

    if (!generated.ok) {
      await reply(event.replyToken, buildGbpGenerationFailedMessage());
      return;
    }

    const upserted = await deps.sessions.upsertGbpSession(deps.db, {
      ownerId: event.ownerId,
      storeId: store.id,
      flow: 'post',
      stage: 'await_decision',
      // 素材は再生成・修正反映のために保持する（オーナーが伝えた要点のみ・Req 6.1）。
      payload: { material: { ownerInput } },
      draftText: generated.value,
      expiresAt: sessionExpiry(),
    });
    if (!upserted.ok) {
      await reply(event.replyToken, buildGbpStaleSelectionMessage());
      return;
    }

    await deps.messenger.reply(
      event.replyToken,
      buildGbpPostDraftMessages({ storeName: store.name, draft: generated.value }),
    );
  }

  /** Req 3.1, 3.2: await_input でのテキスト受領 = 投稿の素材。 */
  async function handlePostInput(event: GbpTextEvent, session: GbpSessionRow): Promise<void> {
    const store = await resolveSessionStore(event.ownerId, session);
    if (store === null) {
      await reply(event.replyToken, buildGbpStaleSelectionMessage());
      return;
    }

    const ownerInput = event.text.trim();
    if (ownerInput.length === 0) {
      await reply(event.replyToken, buildGbpPostInputPromptMessage(store.name));
      return;
    }

    await generateAndPresentPostDraft(event, store, ownerInput);
  }

  /** Req 3.3: 再生成。素材は変えず、生成のたびに新しい variation seed を引く（Req 6.5）。 */
  async function handlePostRegenerate(
    event: GbpPostbackEvent,
    session: GbpSessionRow,
  ): Promise<void> {
    const store = await resolveSessionStore(event.ownerId, session);
    const ownerInput = readPostOwnerInput(session.payload);
    if (store === null || ownerInput === null) {
      await reply(event.replyToken, buildGbpStaleSelectionMessage());
      return;
    }

    await generateAndPresentPostDraft(event, store, ownerInput);
  }

  /** Req 3.4: 修正指示の受付開始（下書き・素材は温存したまま stage のみ進める）。 */
  async function handlePostReviseRequest(
    event: GbpPostbackEvent,
    session: GbpSessionRow,
  ): Promise<void> {
    const store = await resolveSessionStore(event.ownerId, session);
    if (store === null) {
      await reply(event.replyToken, buildGbpStaleSelectionMessage());
      return;
    }

    const upserted = await deps.sessions.upsertGbpSession(deps.db, {
      ownerId: event.ownerId,
      storeId: store.id,
      flow: 'post',
      stage: 'await_revision',
      payload: session.payload,
      draftText: session.draft_text,
      expiresAt: sessionExpiry(),
    });
    if (!upserted.ok) {
      await reply(event.replyToken, buildGbpStaleSelectionMessage());
      return;
    }

    await reply(event.replyToken, buildGbpRevisionPromptMessage());
  }

  /** Req 3.4: await_revision でのテキスト受領 = 修正指示。前回下書きとともに反映する。 */
  async function handlePostRevision(event: GbpTextEvent, session: GbpSessionRow): Promise<void> {
    const store = await resolveSessionStore(event.ownerId, session);
    const ownerInput = readPostOwnerInput(session.payload);
    const previousDraft = session.draft_text;
    if (store === null || ownerInput === null || previousDraft === null) {
      await reply(event.replyToken, buildGbpStaleSelectionMessage());
      return;
    }

    const instruction = event.text.trim();
    if (instruction.length === 0) {
      await reply(event.replyToken, buildGbpRevisionPromptMessage());
      return;
    }

    await generateAndPresentPostDraft(event, store, ownerInput, { instruction, previousDraft });
  }

  /**
   * Req 3.5, 3.6, 3.7: 承認。**GBP への書込を行う唯一のハンドラ**。
   *
   * 実行順は design「State Management」の規定どおり:
   *   1. `executing` への条件付き更新（CAS）で実行権を獲得する。獲得できなければ
   *      **何も実行せず** 現在状態を案内する（二重タップ・並行リクエストの排他）。
   *   2. CAS が返した行（＝獲得の瞬間のスナップショット）だけを実行の入力にする。
   *   3. 成功なら executing の行のみ削除、失敗なら await_decision へ戻す（draft 温存）。
   */
  async function handlePostApprove(event: GbpPostbackEvent): Promise<void> {
    const claimed = await deps.sessions.beginGbpSessionExecution(deps.db, event.ownerId, 'post');
    if (claimed === null) {
      // 実行中（他リクエストが獲得済み）または承認待ちではない。現在状態を読み直して案内する。
      const current = await loadSession(event.ownerId);
      await replyStaleOrCurrentState(event, current.session, current.expired);
      return;
    }

    const storeId = claimed.store_id;
    const draft = claimed.draft_text;
    if (storeId === null || draft === null) {
      // 承認待ちであれば必ず両方が埋まっている。到達したら状態が壊れているので実行しない。
      await deps.sessions.completeGbpSessionExecution(deps.db, event.ownerId, 'post');
      await reply(event.replyToken, buildGbpCurrentStateMessage(null));
      return;
    }

    const result = await executeLocalPost(event.ownerId, storeId, draft);
    const stores = await resolveEligibleStores(event.ownerId);
    const storeName = stores.find((store) => store.id === storeId)?.name ?? null;

    if (result.ok) {
      await deps.sessions.completeGbpSessionExecution(deps.db, event.ownerId, 'post');
      await reply(event.replyToken, buildGbpPostSucceededMessage(storeName));
      return;
    }

    // Req 3.7: 下書き（draft_text）を温存したまま承認待ちへ戻し、再試行導線を返す。
    logFailure('post', event.ownerId, storeId, result.error);
    await deps.sessions.revertGbpSessionExecution(
      deps.db,
      event.ownerId,
      'post',
      sessionExpiry(),
    );
    await reply(
      event.replyToken,
      buildGbpPostFailedMessage(toGbpFailureReason(result.error), storeId),
    );
  }

  /**
   * 投稿の実行。クライアントは Result を返す契約だが、注入実装や想定外の例外で
   * `executing` に取り残される（期限切れまで操作不能になる）ことを防ぐため、
   * 例外は一過性障害として Result へ畳む。
   */
  async function executeLocalPost(
    ownerId: string,
    storeId: string,
    summary: string,
  ): Promise<Result<{ postName: string }, GbpApiError>> {
    try {
      return await deps.gbpClient.createLocalPost(deps.db, { ownerId, storeId, summary });
    } catch (err) {
      // 例外にはトークン・本文が含まれうるため保持しない（Req 2.1）。記録するのは名前だけ。
      deps.logger.error('gbp: createLocalPost threw', {
        flow: 'post',
        ownerId,
        storeId,
        errorName: errorNameOf(err),
      });
      return { ok: false, error: { kind: 'upstream_error', status: 0 } };
    }
  }

  // ===================================================================
  // クチコミ返信フロー（機能1-b・spec task 4.2）
  //
  // 状態機械（design「System Flows > 下書き承認フロー」）:
  //   [*] → await_review_pick（単一店舗）/ await_store（複数店舗）
  //   await_store → await_review_pick（g_pick_store）
  //   await_review_pick → await_decision（未返信を選択・下書き生成）
  //   await_review_pick → await_overwrite_ok（既返信を選択・Req 4.6）
  //   await_overwrite_ok → await_decision（g_overwrite・下書き生成）
  //   await_decision → await_decision（g_regen）/ await_revision（g_revise）
  //   await_revision → await_decision（修正指示テキスト受領・反映再提示）
  //   await_decision → [*]（g_approve = 実行 / g_cancel）
  //
  // **承認ゲートの構造的保証（Req 4.5）**: `deps.gbpClient.upsertReviewReply` の呼び出しは
  // `handleReplyApprove` の 1 箇所のみ。候補提示・生成・上書き確認のいずれからも
  // GBP への書込には到達しない。
  //
  // **レビューゲーティングの禁止（Req 4.9）**: 候補の取捨選択・並び替えに星評価を用いない。
  // 並び順は「未返信優先 → 新着順」のみで、低評価のクチコミも同一の導線で提示する。
  // ===================================================================

  /**
   * 候補として取得するクチコミの件数。GBP は orderBy を受け付けず返却順が未保証のため、
   * 提示上限（5 件）より広く取得してから本モジュールで整列し、上位のみを提示する。
   */
  const REVIEW_FETCH_LIMIT = 20;

  /** Req 4.1, 4.8: 返信フローの開始。未連携なら状態機械に入らず連携誘導へ倒す。 */
  async function handleReplyStart(event: GbpPostbackEvent): Promise<void> {
    const stores = await resolveEligibleStores(event.ownerId);

    if (stores.length === 0) {
      await reply(event.replyToken, buildGbpNoEligibleStoreMessage());
      return;
    }

    const single = stores.length === 1 ? stores[0] : undefined;
    if (single !== undefined) {
      await beginReplyForStore(event, single);
      return;
    }

    const upserted = await deps.sessions.upsertGbpSession(deps.db, {
      ownerId: event.ownerId,
      storeId: null,
      flow: 'reply',
      stage: 'await_store',
      payload: { storeIds: stores.map((store) => store.id) },
      draftText: null,
      expiresAt: sessionExpiry(),
    });
    if (!upserted.ok) {
      await reply(event.replyToken, buildGbpStaleSelectionMessage());
      return;
    }

    await reply(event.replyToken, buildGbpReplyStorePickerMessage(stores));
  }

  /**
   * Req 4.1, 4.8: 対象店舗が確定した後の入口。未連携なら **クチコミを取得せず**
   * 連携誘導を返す（連携前に外部 API を叩かない）。
   */
  async function beginReplyForStore(
    event: GbpPostbackEvent,
    store: ConfirmedStoreSummary,
  ): Promise<void> {
    const linked = await deps.tokenStore.isLinked(deps.db, {
      ownerId: event.ownerId,
      storeId: store.id,
    });
    if (!linked) {
      await reply(event.replyToken, buildGbpConnectRequiredMessage(store.name));
      return;
    }

    const listed = await listReviewsSafely(event.ownerId, store.id);
    if (!listed.ok) {
      logFailure('reply', event.ownerId, store.id, listed.error);
      // セッションは作らない（状態機械に入る前の失敗のため、やり直しは開始から）。
      await reply(
        event.replyToken,
        buildGbpReviewListFailedMessage(toGbpFailureReason(listed.error), store.id),
      );
      return;
    }

    const candidates = selectReviewCandidates(listed.value);
    if (candidates.length === 0) {
      await reply(event.replyToken, buildGbpNoReviewsMessage(store.name));
      return;
    }

    // 提示した並び順を payload に固定し、g_pick_review の index と対応づける
    // （postback の index はスナップショット経由でのみ意味を持つ）。
    const upserted = await deps.sessions.upsertGbpSession(deps.db, {
      ownerId: event.ownerId,
      storeId: store.id,
      flow: 'reply',
      stage: 'await_review_pick',
      payload: { reviews: candidates },
      draftText: null,
      expiresAt: sessionExpiry(),
    });
    if (!upserted.ok) {
      await reply(event.replyToken, buildGbpStaleSelectionMessage());
      return;
    }

    await reply(
      event.replyToken,
      buildGbpReviewPickerMessage({ storeName: store.name, reviews: candidates }),
    );
  }

  /**
   * クチコミの取得。クライアントは Result を返す契約だが、注入実装や想定外の例外で
   * フローが落ちないよう、例外は一過性障害として Result へ畳む。
   */
  async function listReviewsSafely(
    ownerId: string,
    storeId: string,
  ): Promise<Result<GbpReview[], GbpApiError>> {
    try {
      return await deps.gbpClient.listReviews(deps.db, {
        ownerId,
        storeId,
        limit: REVIEW_FETCH_LIMIT,
      });
    } catch (err) {
      deps.logger.error('gbp: listReviews threw', {
        flow: 'reply',
        ownerId,
        storeId,
        errorName: errorNameOf(err),
      });
      return { ok: false, error: { kind: 'upstream_error', status: 0 } };
    }
  }

  /** 返信フローの店舗選択（await_store）。 */
  async function handleReplyPickStore(
    event: GbpPostbackEvent,
    session: GbpSessionRow,
    index: number,
  ): Promise<void> {
    const store = await resolvePickedStore(event.ownerId, session, index);
    if (store === null) {
      await reply(event.replyToken, buildGbpStaleSelectionMessage());
      return;
    }
    await beginReplyForStore(event, store);
  }

  /** Req 4.2, 4.6: 返信対象の選択。既返信は上書き確認を必ず挟む。 */
  async function handlePickReview(
    event: GbpPostbackEvent,
    session: GbpSessionRow,
    index: number,
  ): Promise<void> {
    const store = await resolveSessionStore(event.ownerId, session);
    const snapshot = readReviewSnapshot(session.payload);
    const picked = snapshot[index];
    if (store === null || picked === undefined) {
      await reply(event.replyToken, buildGbpStaleSelectionMessage());
      return;
    }

    if (picked.hasReply) {
      // Req 4.6: 既存の返信を提示し、上書きの確認を得るまで下書き生成へ進まない。
      const upserted = await deps.sessions.upsertGbpSession(deps.db, {
        ownerId: event.ownerId,
        storeId: store.id,
        flow: 'reply',
        stage: 'await_overwrite_ok',
        payload: { review: picked },
        draftText: null,
        expiresAt: sessionExpiry(),
      });
      if (!upserted.ok) {
        await reply(event.replyToken, buildGbpStaleSelectionMessage());
        return;
      }

      await deps.messenger.reply(
        event.replyToken,
        buildGbpOverwriteConfirmMessages({ storeName: store.name, review: picked }),
      );
      return;
    }

    await generateAndPresentReplyDraft(event, store, picked);
  }

  /** Req 4.6: 上書きの同意を得たので下書き生成へ進む。 */
  async function handleOverwriteConfirmed(
    event: GbpPostbackEvent,
    session: GbpSessionRow,
  ): Promise<void> {
    const store = await resolveSessionStore(event.ownerId, session);
    const picked = readPickedReview(session.payload);
    if (store === null || picked === null) {
      await reply(event.replyToken, buildGbpStaleSelectionMessage());
      return;
    }

    await generateAndPresentReplyDraft(event, store, picked);
  }

  /**
   * 返信の下書きを生成し、成功時のみ await_decision へ遷移させて全文と 3 択を提示する
   * （Req 4.2・4.3）。生成失敗時は stage を進めず案内のみ返す（Req 6.6）。
   */
  async function generateAndPresentReplyDraft(
    event: { ownerId: string; replyToken: string },
    store: ConfirmedStoreSummary,
    picked: GbpReviewSummary,
    revision?: RevisionContext,
  ): Promise<void> {
    const material: ReplyDraftMaterial = {
      storeName: store.name,
      // Req 6.1: プロンプトへ渡すのは選択されたクチコミの内容と店名のみ。
      rating: normalizeRating(picked.rating),
      reviewComment: picked.comment,
      authorName: picked.authorName,
    };
    const generated = await deps.prompts.generateReplyDraft(
      material,
      pickReplyVariation(),
      revision,
    );

    if (!generated.ok) {
      await reply(event.replyToken, buildGbpGenerationFailedMessage());
      return;
    }

    const upserted = await deps.sessions.upsertGbpSession(deps.db, {
      ownerId: event.ownerId,
      storeId: store.id,
      flow: 'reply',
      stage: 'await_decision',
      // 返信先（reviewName）と素材は再生成・修正反映・実行のために保持する。
      payload: { review: picked },
      draftText: generated.value,
      expiresAt: sessionExpiry(),
    });
    if (!upserted.ok) {
      await reply(event.replyToken, buildGbpStaleSelectionMessage());
      return;
    }

    await deps.messenger.reply(
      event.replyToken,
      buildGbpReplyDraftMessages({ storeName: store.name, draft: generated.value }),
    );
  }

  /** Req 4.3: 再生成。素材は変えず、生成のたびに新しい variation seed を引く（Req 6.5）。 */
  async function handleReplyRegenerate(
    event: GbpPostbackEvent,
    session: GbpSessionRow,
  ): Promise<void> {
    const store = await resolveSessionStore(event.ownerId, session);
    const picked = readPickedReview(session.payload);
    if (store === null || picked === null) {
      await reply(event.replyToken, buildGbpStaleSelectionMessage());
      return;
    }

    await generateAndPresentReplyDraft(event, store, picked);
  }

  /** Req 4.3: 修正指示の受付開始（下書き・素材は温存したまま stage のみ進める）。 */
  async function handleReplyReviseRequest(
    event: GbpPostbackEvent,
    session: GbpSessionRow,
  ): Promise<void> {
    const store = await resolveSessionStore(event.ownerId, session);
    if (store === null) {
      await reply(event.replyToken, buildGbpStaleSelectionMessage());
      return;
    }

    const upserted = await deps.sessions.upsertGbpSession(deps.db, {
      ownerId: event.ownerId,
      storeId: store.id,
      flow: 'reply',
      stage: 'await_revision',
      payload: session.payload,
      draftText: session.draft_text,
      expiresAt: sessionExpiry(),
    });
    if (!upserted.ok) {
      await reply(event.replyToken, buildGbpStaleSelectionMessage());
      return;
    }

    await reply(event.replyToken, buildGbpRevisionPromptMessage());
  }

  /** Req 4.3: await_revision でのテキスト受領 = 修正指示。前回下書きとともに反映する。 */
  async function handleReplyRevision(
    event: GbpTextEvent,
    session: GbpSessionRow,
  ): Promise<void> {
    const store = await resolveSessionStore(event.ownerId, session);
    const picked = readPickedReview(session.payload);
    const previousDraft = session.draft_text;
    if (store === null || picked === null || previousDraft === null) {
      await reply(event.replyToken, buildGbpStaleSelectionMessage());
      return;
    }

    const instruction = event.text.trim();
    if (instruction.length === 0) {
      await reply(event.replyToken, buildGbpRevisionPromptMessage());
      return;
    }

    await generateAndPresentReplyDraft(event, store, picked, { instruction, previousDraft });
  }

  /**
   * Req 4.4, 4.5, 4.7: 返信の承認。**GBP へ返信を書き込む唯一のハンドラ**。
   * 実行順・CAS の使い方は投稿フロー（handlePostApprove）と同一で、flow だけが異なる。
   */
  async function handleReplyApprove(event: GbpPostbackEvent): Promise<void> {
    const claimed = await deps.sessions.beginGbpSessionExecution(deps.db, event.ownerId, 'reply');
    if (claimed === null) {
      const current = await loadSession(event.ownerId);
      await replyStaleOrCurrentState(event, current.session, current.expired);
      return;
    }

    const storeId = claimed.store_id;
    const draft = claimed.draft_text;
    // 返信先は **CAS が返した行の payload** から取る（postback 由来の値は使わない）。
    const picked = readPickedReview(claimed.payload);
    if (storeId === null || draft === null || picked === null) {
      await deps.sessions.completeGbpSessionExecution(deps.db, event.ownerId, 'reply');
      await reply(event.replyToken, buildGbpCurrentStateMessage(null));
      return;
    }

    const result = await executeReviewReply(event.ownerId, storeId, picked.reviewName, draft);
    const stores = await resolveEligibleStores(event.ownerId);
    const storeName = stores.find((store) => store.id === storeId)?.name ?? null;

    if (result.ok) {
      await deps.sessions.completeGbpSessionExecution(deps.db, event.ownerId, 'reply');
      await reply(event.replyToken, buildGbpReplySucceededMessage(storeName));
      return;
    }

    // Req 4.7: 下書きを温存したまま承認待ちへ戻し、再試行導線を返す。
    logFailure('reply', event.ownerId, storeId, result.error);
    await deps.sessions.revertGbpSessionExecution(
      deps.db,
      event.ownerId,
      'reply',
      sessionExpiry(),
    );
    await reply(
      event.replyToken,
      buildGbpReplyFailedMessage(toGbpFailureReason(result.error), storeId),
    );
  }

  /** 返信の実行。例外は一過性障害として Result へ畳む（executing に取り残さない）。 */
  async function executeReviewReply(
    ownerId: string,
    storeId: string,
    reviewName: string,
    comment: string,
  ): Promise<Result<void, GbpApiError>> {
    try {
      return await deps.gbpClient.upsertReviewReply(deps.db, {
        ownerId,
        storeId,
        reviewName,
        comment,
      });
    } catch (err) {
      deps.logger.error('gbp: upsertReviewReply threw', {
        flow: 'reply',
        ownerId,
        storeId,
        errorName: errorNameOf(err),
      });
      return { ok: false, error: { kind: 'upstream_error', status: 0 } };
    }
  }

  /**
   * セッションを読み、期限切れなら行を破棄する（design エラー戦略）。
   * 戻り値の `session` は active のときのみ非 null。
   */
  async function loadSession(
    ownerId: string,
  ): Promise<{ session: GbpSessionRow | null; expired: boolean }> {
    const lookup = await deps.sessions.getActiveGbpSession(deps.db, ownerId, deps.now());
    if (lookup.kind === 'active') return { session: lookup.session, expired: false };
    if (lookup.kind === 'expired') {
      await deps.sessions.clearGbpSession(deps.db, ownerId);
      return { session: null, expired: true };
    }
    return { session: null, expired: false };
  }

  /** stage を要求する action が噛み合わなかったときの安全側応答（何も実行しない）。 */
  async function replyStaleOrCurrentState(
    event: GbpPostbackEvent,
    session: GbpSessionRow | null,
    expired: boolean,
  ): Promise<void> {
    await reply(
      event.replyToken,
      expired ? buildGbpSessionExpiredMessage() : buildGbpCurrentStateMessage(session),
    );
  }

  async function dispatchPostback(
    event: GbpPostbackEvent,
    action: GbpPostbackAction,
    session: GbpSessionRow | null,
    expired: boolean,
  ): Promise<void> {
    switch (action.action) {
      // --- セッション不要の入口（いつでも受理する） ---
      case 'g_connect':
        return handleConnect(event);
      case 'g_status':
        return handleStatus(event);
      case 'g_disconnect':
        return handleDisconnect(event, session, action.storeId);
      case 'g_relink':
        return handleRelink(event, action.storeId);
      case 'g_cancel': {
        if (session !== null) await deps.sessions.clearGbpSession(deps.db, event.ownerId);
        return reply(event.replyToken, buildGbpCancelledMessage());
      }

      // --- セッション不要の入口（投稿・返信フローの開始・Req 3.1, 3.9, 4.1, 4.8） ---
      case 'g_post':
        return handlePostStart(event);
      case 'g_reply':
        return handleReplyStart(event);

      // --- stage を要求する遷移 ---
      case 'g_pick_store': {
        if (session === null || session.stage !== 'await_store') {
          return replyStaleOrCurrentState(event, session, expired);
        }
        if (session.flow === 'connect') return handlePickStore(event, session, action.index);
        if (session.flow === 'post') return handlePostPickStore(event, session, action.index);
        if (session.flow === 'reply') return handleReplyPickStore(event, session, action.index);
        return replyStaleOrCurrentState(event, session, expired);
      }

      case 'g_pick_review': {
        if (!isReplyStage(session, 'await_review_pick')) {
          return replyStaleOrCurrentState(event, session, expired);
        }
        return handlePickReview(event, session, action.index);
      }

      case 'g_overwrite': {
        // Req 4.6: 上書きの同意はこの stage でしか受け付けない。
        if (!isReplyStage(session, 'await_overwrite_ok')) {
          return replyStaleOrCurrentState(event, session, expired);
        }
        return handleOverwriteConfirmed(event, session);
      }

      case 'g_regen': {
        if (isPostStage(session, 'await_decision')) return handlePostRegenerate(event, session);
        if (isReplyStage(session, 'await_decision')) return handleReplyRegenerate(event, session);
        return replyStaleOrCurrentState(event, session, expired);
      }

      case 'g_revise': {
        if (isPostStage(session, 'await_decision')) {
          return handlePostReviseRequest(event, session);
        }
        if (isReplyStage(session, 'await_decision')) {
          return handleReplyReviseRequest(event, session);
        }
        return replyStaleOrCurrentState(event, session, expired);
      }

      case 'g_approve': {
        // Req 3.6・4.5: ここが GBP 書込に到達しうる唯一の分岐。flow ごとに別ハンドラへ
        // 分け、各ハンドラは自フローの CAS（flow 条件付き）でしか実行権を得られない。
        // stage が承認待ちでなければ CAS すら行わず案内のみ返す
        // （executing 中の 2 打目もここで止まる）。
        if (isPostStage(session, 'await_decision')) return handlePostApprove(event);
        if (isReplyStage(session, 'await_decision')) return handleReplyApprove(event);
        return replyStaleOrCurrentState(event, session, expired);
      }
    }
  }

  /**
   * GBP 側の想定外の例外を委譲元へ伝播させない（PR #121 レビュー指摘）。
   *
   * `handleGbpText` / `handleGbpPostback` はどちらも分岐前に `gbp_sessions` を無条件で
   * SELECT する。0006 未適用や grants.sql 未再実行だと、**GBP を使っていない completed
   * オーナーの通常テキストまで** Req 4.6 の固定案内でなく内部エラー案内に化ける。
   * ここで握って `not_handled` へ倒せば、GBP サブシステムの不調が onboarding の既存応答を
   * 巻き込まない。
   *
   * 既知の縁: GBP 側が reply を送った後に例外が出た場合、委譲元のフォールバックは使用済みの
   * replyToken で 2 度目の reply を試みる。`LineMessenger.reply` は非 2xx をログのみに留めて
   * throw しないため会話は壊れない（重複案内が 1 通出る可能性だけが残る）。
   */
  async function guard(
    what: string,
    ownerId: string,
    run: () => Promise<HandledResult>,
  ): Promise<HandledResult> {
    try {
      return await run();
    } catch (err) {
      deps.logger.error(`gbp: ${what} failed`, { ownerId, errorName: errorNameOf(err) });
      return 'not_handled';
    }
  }

  return {
    async handleGbpPostback(event: GbpPostbackEvent): Promise<HandledResult> {
      return guard('handleGbpPostback', event.ownerId, async () => {
        const { session, expired } = await loadSession(event.ownerId);
        const action = decodeGbpPostback(event.data);

        if (action === null) {
          // 未知・破損した `g_*` data（自前ボタンからは到達しない）。何も実行せず案内のみ。
          await replyStaleOrCurrentState(event, session, expired);
          return 'handled';
        }

        await dispatchPostback(event, action, session, expired);
        return 'handled';
      });
    },

    async handleGbpText(event: GbpTextEvent): Promise<HandledResult> {
      return guard('handleGbpText', event.ownerId, async () => {
      const lookup = await deps.sessions.getActiveGbpSession(
        deps.db,
        event.ownerId,
        deps.now(),
      );

      if (lookup.kind === 'none') {
        // GBP の手続きは進行していない。委譲元（onboarding）の既存案内へ戻す。
        return 'not_handled';
      }

      if (lookup.kind === 'expired') {
        await deps.sessions.clearGbpSession(deps.db, event.ownerId);
        await reply(event.replyToken, buildGbpSessionExpiredMessage());
        return 'handled';
      }

      // テキストを受理するのは投稿の await_input（要点）と、投稿・返信の
      // await_revision（修正指示）のみ。それ以外はいかなる遷移も起こさず案内のみ返す
      // （返信フローの候補選択・上書き確認はボタン専用で、テキストでは進まない）。
      const session = lookup.session;
      if (isPostStage(session, 'await_input')) {
        await handlePostInput(event, session);
        return 'handled';
      }
      if (isPostStage(session, 'await_revision')) {
        await handlePostRevision(event, session);
        return 'handled';
      }
      if (isReplyStage(session, 'await_revision')) {
        await handleReplyRevision(event, session);
        return 'handled';
      }

      await reply(event.replyToken, buildGbpCurrentStateMessage(session));
      return 'handled';
      });
    },
  };
}

/** payload に保存した提示順スナップショット。形式不正な要素は落とす（安全側）。 */
function readStoreIdSnapshot(payload: Record<string, unknown>): string[] {
  const value = payload['storeIds'];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * 投稿フローの指定 stage かどうか（型の絞り込み込み）。
 * flow と stage の両方を要求することで、返信フロー（4.2）の同名 stage が
 * 投稿フローの遷移に流れ込まないことを構造的に保証する。
 */
function isPostStage(
  session: GbpSessionRow | null,
  stage: GbpSessionRow['stage'],
): session is GbpSessionRow {
  return session !== null && session.flow === 'post' && session.stage === stage;
}

/**
 * 返信フローの指定 stage かどうか（型の絞り込み込み）。`isPostStage` と対になり、
 * 同名 stage（await_decision / await_revision）が相手のフローの遷移へ流れ込まないことを
 * 構造的に保証する。**GBP への返信書込に至る分岐は必ずこの述語を通す**（Req 4.5）。
 */
function isReplyStage(
  session: GbpSessionRow | null,
  stage: GbpSessionRow['stage'],
): session is GbpSessionRow {
  return session !== null && session.flow === 'reply' && session.stage === stage;
}

/**
 * 星評価の正規化（tasks.md Implementation Notes 2.4 の申し送り: 呼出側ガード）。
 * GBP の enum が未知値・非数値の場合に生成側へ不定値を渡さないため、
 * 1–5 の整数以外はすべて 0（評価不明）へ倒す。GbpPrompts は 0 を低評価トーンの
 * fail-safe として扱う。**この値を候補の選別・並び順に使ってはならない（Req 4.9）**。
 */
function normalizeRating(rating: unknown): number {
  if (typeof rating !== 'number' || !Number.isInteger(rating)) return 0;
  return rating >= 1 && rating <= 5 ? rating : 0;
}

/**
 * 取得したクチコミを提示順（未返信優先 → 新着順）に整列し、上限件数へ丸める（Req 4.1）。
 *
 * GBP の `reviews.list` は orderBy を受け付けず返却順が未保証のため、整列は本モジュールの
 * 責務（tasks.md Implementation Notes 2.2 の申し送り）。**星評価は比較に一切用いない**
 * （Req 4.9・レビューゲーティング禁止。低評価を後ろへ回すことも隠すことも行わない）。
 */
function selectReviewCandidates(reviews: readonly GbpReview[]): GbpReviewSummary[] {
  const sorted = [...reviews].sort((a, b) => {
    if (a.hasReply !== b.hasReply) return a.hasReply ? 1 : -1;
    return parseCreateTime(b.createTime) - parseCreateTime(a.createTime);
  });

  return sorted.slice(0, MAX_REVIEW_CANDIDATES).map(
    (item): GbpReviewSummary => ({
      reviewName: item.reviewName,
      rating: normalizeRating(item.rating),
      authorName: item.authorName,
      comment: item.comment,
      createTime: item.createTime,
      hasReply: item.hasReply,
      replyComment: item.replyComment,
    }),
  );
}

/** 解釈できない createTime は最古として扱う（並び順のためだけに使う・例外を投げない）。 */
function parseCreateTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * payload に保存したクチコミ候補のスナップショット（await_review_pick）。
 * 形式不正な要素は落とす（安全側。index の意味が提示内容とずれるより空にする）。
 */
function readReviewSnapshot(payload: Record<string, unknown>): GbpReviewSummary[] {
  const value = payload['reviews'];
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => toReviewSummary(item))
    .filter((item): item is GbpReviewSummary => item !== null);
}

/** payload に保存した選択済みクチコミ（await_overwrite_ok 以降）。不正・欠落は null。 */
function readPickedReview(payload: Record<string, unknown>): GbpReviewSummary | null {
  return toReviewSummary(payload['review']);
}

/**
 * jsonb から読み戻した値を GbpReviewSummary へ検証変換する。
 * **reviewName は返信の宛先そのもの**であるため、欠落・非文字列・空文字は null に倒す
 * （不正な宛先で GBP を呼ばない。実際の自店突合は GbpClient が fail-closed で行う）。
 */
function toReviewSummary(value: unknown): GbpReviewSummary | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  const reviewName = record['reviewName'];
  if (typeof reviewName !== 'string' || reviewName.trim().length === 0) return null;

  const replyComment = record['replyComment'];
  return {
    reviewName,
    rating: normalizeRating(record['rating']),
    authorName: typeof record['authorName'] === 'string' ? record['authorName'] : '',
    comment: typeof record['comment'] === 'string' ? record['comment'] : '',
    createTime: typeof record['createTime'] === 'string' ? record['createTime'] : '',
    hasReply: record['hasReply'] === true,
    replyComment: typeof replyComment === 'string' ? replyComment : null,
  };
}

/**
 * payload に保存した投稿素材（オーナーが伝えた要点）。
 * 形式不正・欠落は null（＝再生成・修正反映を実行せずやり直しへ倒す）。
 */
function readPostOwnerInput(payload: Record<string, unknown>): string | null {
  const material = payload['material'];
  if (typeof material !== 'object' || material === null) return null;
  const ownerInput = (material as Record<string, unknown>)['ownerInput'];
  if (typeof ownerInput !== 'string' || ownerInput.trim().length === 0) return null;
  return ownerInput;
}

/**
 * GBP API のエラー分類 → オーナー向け案内の分類（design「Error Handling」）。
 *
 * **`crypto_error` を `reauth` に含めてはならない**。復号不能は運用側の鍵事故であり、
 * オーナーの再連携では解決せず、誤鍵下で保存された新トークンが鍵復旧後に連鎖破損する
 * （tasks.md Implementation Notes 2.2 の申し送り）。一過性障害と同じ文面で扱う。
 * `incomplete_listing` も「管理権限なし」と結論させず再試行導線へ倒す。
 */
function toGbpFailureReason(error: GbpApiError): GbpPostFailureReason {
  switch (error.kind) {
    case 'token_invalid':
    case 'not_linked':
      return 'reauth';
    case 'permission_denied':
      return 'permission';
    case 'crypto_error':
    case 'rate_limited':
    case 'incomplete_listing':
    case 'upstream_error':
      return 'transient';
  }
}
