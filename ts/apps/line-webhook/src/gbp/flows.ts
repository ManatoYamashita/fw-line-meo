// GBP 会話フローの状態機械（design.md「GbpFlows」・spec task 3.3）。
// Requirements: 1.1（Place 確定済み店舗のみ誘導）, 1.2（連携開始→認可誘導）,
//   1.3（複数店舗は選択させてから誘導）, 2.4（連携解除 = revoke + 行削除 + 未連携案内）,
//   2.5（連携状態の確認）。
//
// 本タスクの範囲は **連携系（connect / status / disconnect）のみ**。投稿（機能2）・
// クチコミ返信（機能1-b）の stage は task 4.1 / 4.2 が本ファイルへ追加する
// （それまで当該 action は何も実行せず準備中案内へ倒す）。
//
// 設計上の不変条件:
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
  clearGbpSession,
  getActiveGbpSession,
  listConfirmedStoresByOwner,
  upsertGbpSession,
  deleteGbpLocation,
  type ConfirmedStoreSummary,
  type GbpLocationKey,
  type GbpSessionLookup,
  type GbpSessionRow,
  type Queryable,
  type Result,
  type UpsertGbpSessionInput,
} from '@fwlm/db';
import type { ConnectablePool, TransactionClient } from '../onboarding/store-identification.js';
import type { LineMessage, LineMessenger } from '../line/client.js';
import { CONNECT_SESSION_TTL_MS, type GbpOauthService } from './oauth.js';
import { decodeGbpPostback, type GbpPostbackAction } from './postback.js';
import type { StoreKey, TokenStoreService } from './token-store.js';
import {
  buildGbpAlreadyLinkedMessage,
  buildGbpAuthorizeMessage,
  buildGbpCancelledMessage,
  buildGbpConnectUnavailableMessage,
  buildGbpCurrentStateMessage,
  buildGbpDisconnectedMessage,
  buildGbpFlowNotAvailableMessage,
  buildGbpNoEligibleStoreMessage,
  buildGbpNotLinkedMessage,
  buildGbpSessionExpiredMessage,
  buildGbpStaleSelectionMessage,
  buildGbpStatusMessage,
  buildGbpStorePickerMessage,
  MAX_SELECTABLE_STORES,
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
  messenger: Pick<LineMessenger, 'reply'>;
  now(): Date;
}

export interface GbpFlowHandlers {
  handleGbpPostback(event: GbpPostbackEvent): Promise<void>;
  handleGbpText(event: GbpTextEvent): Promise<HandledResult>;
}

/** packages/db のアクセサをそのまま束ねた既定の配線（index.ts 用）。 */
export function createDefaultGbpFlowAccessors(): {
  sessions: GbpSessionsAccessor;
  locations: GbpLocationsAccessor;
  stores: GbpStoresAccessor;
} {
  return {
    sessions: { getActiveGbpSession, upsertGbpSession, clearGbpSession },
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
      // 選択中のセッションが残っていても意味を持たないので破棄する（owner キーで冪等）。
      await deps.sessions.clearGbpSession(deps.db, event.ownerId);
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
   * Req 1.3: 店舗選択。index → storeId はセッションのスナップショットで解決し、
   * その storeId が **現在の所有店舗一覧に存在すること** を必ず再確認してから認可へ進む
   * （スナップショット自体は過去の値であり、単独では所有の根拠にならない）。
   */
  async function handlePickStore(
    event: GbpPostbackEvent,
    session: GbpSessionRow,
    index: number,
  ): Promise<void> {
    const snapshot = readStoreIdSnapshot(session.payload);
    const pickedId = snapshot[index];
    if (pickedId === undefined) {
      await reply(event.replyToken, buildGbpStaleSelectionMessage());
      return;
    }

    const stores = await resolveEligibleStores(event.ownerId);
    const store = stores.find((candidate) => candidate.id === pickedId);
    if (store === undefined) {
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
      case 'g_cancel': {
        if (session !== null) await deps.sessions.clearGbpSession(deps.db, event.ownerId);
        return reply(event.replyToken, buildGbpCancelledMessage());
      }

      // --- stage を要求する遷移 ---
      case 'g_pick_store': {
        if (session === null || session.flow !== 'connect' || session.stage !== 'await_store') {
          return replyStaleOrCurrentState(event, session, expired);
        }
        return handlePickStore(event, session, action.index);
      }

      // --- 投稿（機能2）・返信（機能1-b）: task 4.1 / 4.2 で実装する ---
      // 実装時はここに各 stage の遷移を追加する（default を置かないことで、
      // action を増やした際に本 switch の更新漏れがコンパイルエラーになる）。
      case 'g_post':
      case 'g_reply':
      case 'g_pick_review':
      case 'g_approve':
      case 'g_regen':
      case 'g_revise':
      case 'g_overwrite':
        return reply(event.replyToken, buildGbpFlowNotAvailableMessage());
    }
  }

  return {
    async handleGbpPostback(event: GbpPostbackEvent): Promise<void> {
      const { session, expired } = await loadSession(event.ownerId);
      const action = decodeGbpPostback(event.data);

      if (action === null) {
        // 未知・破損した `g_*` data（自前ボタンからは到達しない）。何も実行せず案内のみ。
        await replyStaleOrCurrentState(event, session, expired);
        return;
      }

      await dispatchPostback(event, action, session, expired);
    },

    async handleGbpText(event: GbpTextEvent): Promise<HandledResult> {
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

      // 連携フロー（本タスクの範囲）にテキストを受理する stage は無い。
      // task 4.1 / 4.2 が await_input・await_revision の受理をここへ追加する。
      await reply(event.replyToken, buildGbpCurrentStateMessage(lookup.session));
      return 'handled';
    },
  };
}

/** payload に保存した提示順スナップショット。形式不正な要素は落とす（安全側）。 */
function readStoreIdSnapshot(payload: Record<string, unknown>): string[] {
  const value = payload['storeIds'];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}
