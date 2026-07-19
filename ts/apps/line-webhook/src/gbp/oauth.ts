// Google 連携（OAuth）フローの中核（gbp-post-review-reply spec task 3.1・GbpOauth）。
// Requirements: 1.2（認可手続きへの誘導）, 1.4（認可完了で連携成立）, 1.5（拒否・中断の検知）,
// 1.6（管理権限なしなら不成立）, 1.8（最小スコープ）。
//
// 設計上の不変条件:
// - 要求スコープは `GBP_SCOPE` 単一（business.manage）。GBP の全 API がこの 1 スコープで動くため、
//   これが最小要求そのもの（Req 1.8）。スコープ配列を増やす変更は仕様違反。
// - `access_type=offline` + `prompt=consent` で refresh token を確実に取得する。
//   refresh token が得られなかった認可は成立させない（次回以降の投稿・返信が不可能なため）。
// - state は crypto random nonce を `gbp_sessions`（flow=connect・stage=await_callback）へ保存し、
//   callback で **照合したら必ず消費**する（ワンタイム。CSRF とリプレイを同時に防ぐ）。
//   期限切れは照合失敗として扱い、残存セッションを破棄する。
// - state の外形は `<ownerId>.<nonce>`。owner をセッション行の検索キーにするためであり、
//   認証強度はすべて 256bit の nonce が担う（ownerId は公開されても単独では何もできない）。
//   これにより「state で gbp_sessions を引く」ための新しい DB 索引・アクセサを増やさない。
// - **連携成立時のみ** `oauth_tokens` と `gbp_locations` を **同一トランザクション**で永続化する
//   （design Domain Model の不変条件「gbp_locations は oauth_tokens 行なしに存在しない」）。
//   突合不一致・列挙失敗・永続化失敗ではトークンを revoke（ベストエフォート）し、何も残さない。
// - **認可コード・クライアントシークレット・トークンを例外や戻り値に載せない**（Req 2.1）。
//   google-auth-library の `GaxiosError` は `config.data` にリクエストボディ（`code=...`・
//   `client_secret=...`）を保持するため、原エラーを cause・プロパティ・stack で持ち回らない。

import { OAuth2Client } from 'google-auth-library';
import {
  clearGbpSession,
  findStoreWithAgency,
  getActiveGbpSession,
  upsertGbpLocation,
  upsertGbpSession,
  type GbpLocationRow,
  type GbpSessionLookup,
  type GbpSessionRow,
  type Queryable,
  type Result,
  type UpsertGbpLocationInput,
  type UpsertGbpSessionInput,
} from '@fwlm/db';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { ConnectablePool, TransactionClient } from '../onboarding/store-identification.js';
import type { StoreKey, TokenStoreService } from './token-store.js';
import { findLocationForPlace, type LocationLookupClient } from './locations.js';

/** Req 1.8: GBP の投稿作成・クチコミ返信に必要な唯一のスコープ。ここを増やしてはならない。 */
export const GBP_SCOPE = 'https://www.googleapis.com/auth/business.manage';

/** 認可の往復に許す猶予（gbp_sessions の期限）。 */
export const CONNECT_SESSION_TTL_MS = 30 * 60 * 1000;

/** state nonce の乱数長（バイト）。 */
const STATE_NONCE_BYTES = 32;

/** state の owner 部（UUID）検証。DB へ問い合わせる前に形式で弾く。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** nonce 部に許す文字（base64url）。 */
const NONCE_PATTERN = /^[A-Za-z0-9_-]+$/;

/** code 交換の結果。refresh token は再認可なしの継続運用（Req 2.2）に必須。 */
export interface OauthTokenSet {
  refreshToken: string | null;
  accessToken: string | null;
  scopes: string;
}

/** Google の認可エンドポイントとのやり取り（テストでスタブ注入可能にする）。 */
export interface GoogleOauthCodeClient {
  buildAuthorizeUrl(input: { state: string }): string;
  /** 失敗時はサニタイズ済みの Error を throw する（認可コードを含めない）。 */
  exchangeCode(code: string): Promise<OauthTokenSet>;
  /** ベストエフォート。失敗しても throw しない。 */
  revokeToken(token: string): Promise<void>;
}

/** 対象店舗の突合材料（place_id）と通知用の店舗名を取る最小面。 */
export interface OauthStoreLookup {
  findStore(db: Queryable, key: StoreKey): Promise<{ name: string; placeId: string | null } | null>;
}

export interface GbpSessionsAccessor {
  getActiveGbpSession(db: Queryable, ownerId: string, now?: Date): Promise<GbpSessionLookup>;
  upsertGbpSession(
    db: Queryable,
    input: UpsertGbpSessionInput,
  ): Promise<Result<GbpSessionRow, 'STORE_NOT_OWNED'>>;
  clearGbpSession(db: Queryable, ownerId: string): Promise<boolean>;
}

export interface GbpLocationsAccessor {
  upsertGbpLocation(
    db: Queryable,
    input: UpsertGbpLocationInput,
  ): Promise<Result<GbpLocationRow, 'STORE_NOT_OWNED'>>;
}

export interface GbpOauthDeps {
  /** 非トランザクションの読み書き（state 照合・消費）。 */
  db: Queryable;
  /** 連携成立時の 2 テーブル同時書き込み用。 */
  pool: ConnectablePool;
  oauthClient: GoogleOauthCodeClient;
  gbpClient: LocationLookupClient;
  tokenStore: Pick<TokenStoreService, 'saveToken'>;
  sessions: GbpSessionsAccessor;
  locations: GbpLocationsAccessor;
  stores: OauthStoreLookup;
  now(): Date;
  /** テストで固定化するための注入点（既定は crypto random）。 */
  generateStateNonce?(): string;
}

/** 失敗理由。オーナー向け文面への変換は GbpFlows / CallbackRoute（task 3.2, 3.3）の責務。 */
export type OauthErrorReason =
  | 'missing_code'
  | 'store_unavailable'
  | 'token_exchange_failed'
  | 'no_refresh_token'
  | 'listing_incomplete'
  | 'listing_failed'
  | 'persist_failed';

/**
 * callback の結果（design の union に、通知先解決のための ownerId／storeId を追加）。
 * Push 通知（Req 1.4・1.5）は owner を特定できなければ送れないため、state から解決できた
 * 範囲を必ず添える。state が照合できない場合は null（通知先不明）。
 */
export type OauthCallbackResult =
  | { kind: 'linked'; ownerId: string; storeId: string; storeName: string }
  | { kind: 'denied'; ownerId: string | null; storeId: string | null }
  | { kind: 'state_mismatch' }
  | { kind: 'no_permission'; ownerId: string; storeId: string }
  | {
      kind: 'error';
      reason: OauthErrorReason;
      ownerId: string | null;
      storeId: string | null;
    };

export interface GbpOauthService {
  /**
   * 認可 URL を組む。storeId は state 経由で DB のセッションに束ねられており URL には載せない
   * （URL に載せると認可完了後の対象店舗を利用者側で差し替えられるため）。
   */
  buildAuthorizeUrl(input: { storeId: string; state: string }): string;
  /** connect セッション（state 発行）を作り、認可 URL を返す（Req 1.2）。 */
  startConnect(
    db: Queryable,
    key: StoreKey,
  ): Promise<Result<{ authorizeUrl: string; state: string }, 'STORE_NOT_OWNED'>>;
  handleOauthCallback(params: {
    code?: string | undefined;
    state?: string | undefined;
    error?: string | undefined;
  }): Promise<OauthCallbackResult>;
  /** 認可の取り消し（ベストエフォート・失敗は無視）。 */
  revokeToken(token: string): Promise<void>;
}

// =====================================================================
// Google クライアント（既定実装）
// =====================================================================

export interface GoogleOauthCodeClientOptions {
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
}

function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** ログ・例外メッセージに載せてよい短い識別子だけを通す（機微情報の混入を構造的に防ぐ）。 */
function safeErrorCode(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  return /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : 'unredactable';
}

function safeStatus(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : 'unknown';
}

/**
 * code 交換の失敗を、認可コード・クライアントシークレットを一切含まないエラーへ詰め替える。
 * token-store.ts の `sanitizeRefreshError` と同じ思想（原エラーを保持しない）。
 */
function sanitizeExchangeError(error: unknown): Error {
  const response = readProperty(error, 'response');
  const status = safeStatus(readProperty(response, 'status'));
  const code = safeErrorCode(readProperty(readProperty(response, 'data'), 'error'));
  return new Error(`google authorization code exchange failed (status=${status}, error=${code})`);
}

/**
 * google-auth-library による既定実装。呼び出しごとにクライアントを生成し、
 * 認可情報がインスタンスに残らないようにする（構築時にネットワークアクセスは発生しない）。
 */
export function createGoogleOauthCodeClient(
  options: GoogleOauthCodeClientOptions,
): GoogleOauthCodeClient {
  const newClient = (): OAuth2Client =>
    new OAuth2Client({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      redirectUri: options.redirectUrl,
    });

  return {
    buildAuthorizeUrl({ state }) {
      return newClient().generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        // Req 1.8: 単一スコープ。配列で渡しても要素は 1 個だけ。
        scope: [GBP_SCOPE],
        state,
        include_granted_scopes: false,
      });
    },

    async exchangeCode(code) {
      let tokens;
      try {
        ({ tokens } = await newClient().getToken(code));
      } catch (error) {
        // 原エラー（GaxiosError）は `config.data` に `code=...&client_secret=...` を保持する。
        throw sanitizeExchangeError(error);
      }
      return {
        refreshToken: tokens.refresh_token ?? null,
        accessToken: tokens.access_token ?? null,
        scopes: typeof tokens.scope === 'string' && tokens.scope !== '' ? tokens.scope : GBP_SCOPE,
      };
    },

    async revokeToken(token) {
      try {
        await newClient().revokeToken(token);
      } catch {
        // ベストエフォート。失敗しても呼び出し側の判断（連携不成立）は変わらない。
        // 原エラーはトークンを含みうるため保持もログもしない。
      }
    },
  };
}

/**
 * `stores` からの既定の突合材料取得。既存の所有者付きアクセサを使い、owner 不一致は
 * 「見つからない」として返す（他オーナーの店舗へは到達させない・Req 2.6）。
 */
export function createOauthStoreLookup(): OauthStoreLookup {
  return {
    async findStore(db, key) {
      const store = await findStoreWithAgency(db, key.storeId);
      if (store === null || store.ownerId !== key.ownerId) return null;
      return { name: store.name, placeId: store.placeId };
    },
  };
}

/** packages/db のアクセサをそのまま束ねた既定の配線。 */
export function createDefaultGbpOauthAccessors(): {
  sessions: GbpSessionsAccessor;
  locations: GbpLocationsAccessor;
  stores: OauthStoreLookup;
} {
  return {
    sessions: { getActiveGbpSession, upsertGbpSession, clearGbpSession },
    locations: { upsertGbpLocation },
    stores: createOauthStoreLookup(),
  };
}

// =====================================================================
// state（DB 裏付けのワンタイム値）
// =====================================================================

interface ParsedState {
  ownerId: string;
  nonce: string;
}

/** `<ownerId>.<nonce>` を分解する。形式不正は null（DB へ問い合わせない）。 */
export function parseState(state: string): ParsedState | null {
  const separator = state.indexOf('.');
  if (separator <= 0) return null;
  const ownerId = state.slice(0, separator);
  const nonce = state.slice(separator + 1);
  if (!UUID_PATTERN.test(ownerId)) return null;
  if (nonce === '' || !NONCE_PATTERN.test(nonce)) return null;
  return { ownerId, nonce };
}

/** 長さ差でも早期 return せず、比較自体を定数時間に寄せる。 */
function secretEquals(expected: unknown, actual: string): boolean {
  if (typeof expected !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// =====================================================================
// サービス本体
// =====================================================================

function errorResult(
  reason: OauthErrorReason,
  ownerId: string | null,
  storeId: string | null,
): OauthCallbackResult {
  return { kind: 'error', reason, ownerId, storeId };
}

export function createGbpOauthService(deps: GbpOauthDeps): GbpOauthService {
  const generateNonce =
    deps.generateStateNonce ?? (() => randomBytes(STATE_NONCE_BYTES).toString('base64url'));

  // `this` に依存しないよう関数として持つ（サービスのメソッドを分割代入されても壊れないため）。
  const buildUrl = (state: string): string => deps.oauthClient.buildAuthorizeUrl({ state });

  /** ベストエフォート revoke。null/空は何もしない。 */
  async function revoke(token: string | null): Promise<void> {
    if (token === null || token === '') return;
    try {
      await deps.oauthClient.revokeToken(token);
    } catch {
      // 既定実装は throw しないが、注入実装が throw しても連携不成立の判断は変えない。
    }
  }

  /**
   * state を照合して消費する。成功時はセッション行を返し、その行は既に削除済み（ワンタイム）。
   * 照合できない・期限切れ・別フローはすべて null（呼び出し側は state_mismatch へ倒す）。
   */
  async function consumeState(
    state: string | undefined,
  ): Promise<{ ownerId: string; storeId: string } | null> {
    if (state === undefined) return null;
    const parsed = parseState(state);
    if (parsed === null) return null;

    const lookup = await deps.sessions.getActiveGbpSession(deps.db, parsed.ownerId, deps.now());
    if (lookup.kind === 'none') return null;
    if (lookup.kind === 'expired') {
      // 期限切れは照合失敗。残骸を残さないよう破棄する。
      await deps.sessions.clearGbpSession(deps.db, parsed.ownerId);
      return null;
    }

    const session = lookup.session;
    if (session.flow !== 'connect' || session.stage !== 'await_callback') return null;
    // 保存値は発行時の state 全体（`<ownerId>.<nonce>`）。owner 部込みで一致を要求する。
    if (!secretEquals(session.payload['state'], state)) return null;

    const storeId = session.store_id ?? readPendingStoreId(session.payload);
    if (storeId === null) return null;

    // 照合できた時点で必ず消費する（後続がどう転んでも同じ state は二度と使えない）。
    await deps.sessions.clearGbpSession(deps.db, parsed.ownerId);
    return { ownerId: parsed.ownerId, storeId };
  }

  /** 連携成立時の 2 テーブル同時永続化（原子性は呼び出し側であるここが所有する）。 */
  async function persistLink(input: {
    ownerId: string;
    storeId: string;
    refreshToken: string;
    scopes: string;
    accountName: string;
    locationName: string;
    placeId: string;
    canOperateLocalPost: boolean;
  }): Promise<boolean> {
    const client: TransactionClient = await deps.pool.connect();
    try {
      await client.query('BEGIN');

      const saved = await deps.tokenStore.saveToken(client, {
        ownerId: input.ownerId,
        storeId: input.storeId,
        refreshToken: input.refreshToken,
        scopes: input.scopes,
      });
      if (!saved.ok) {
        await client.query('ROLLBACK');
        return false;
      }

      const located = await deps.locations.upsertGbpLocation(client, {
        ownerId: input.ownerId,
        storeId: input.storeId,
        accountName: input.accountName,
        locationName: input.locationName,
        placeId: input.placeId,
        canOperateLocalPost: input.canOperateLocalPost,
      });
      if (!located.ok) {
        await client.query('ROLLBACK');
        return false;
      }

      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    buildAuthorizeUrl(input) {
      return buildUrl(input.state);
    },

    async startConnect(db, key) {
      const state = `${key.ownerId}.${generateNonce()}`;
      const res = await deps.sessions.upsertGbpSession(db, {
        ownerId: key.ownerId,
        storeId: key.storeId,
        flow: 'connect',
        stage: 'await_callback',
        // pendingStoreId は store_id 列の冗長コピー（design の payload 定義）。
        payload: { state, pendingStoreId: key.storeId },
        draftText: null,
        expiresAt: new Date(deps.now().getTime() + CONNECT_SESSION_TTL_MS),
      });
      if (!res.ok) return { ok: false, error: res.error };

      return { ok: true, value: { authorizeUrl: buildUrl(state), state } };
    },

    async handleOauthCallback(params) {
      // Req 1.5: 認可拒否・中断。code 交換には進まないが、通知先を得るため state は消費する。
      if (params.error !== undefined && params.error !== '') {
        const denied = await consumeState(params.state);
        return {
          kind: 'denied',
          ownerId: denied?.ownerId ?? null,
          storeId: denied?.storeId ?? null,
        };
      }

      const consumed = await consumeState(params.state);
      if (consumed === null) return { kind: 'state_mismatch' };
      const { ownerId, storeId } = consumed;

      if (params.code === undefined || params.code === '') {
        return errorResult('missing_code', ownerId, storeId);
      }

      // 突合材料（place_id）を先に確定させる。無ければ code 交換に進まない
      // （交換すると revoke すべきトークンを無用に発行することになる）。
      const store = await deps.stores.findStore(deps.db, { ownerId, storeId });
      if (store === null || store.placeId === null || store.placeId === '') {
        return errorResult('store_unavailable', ownerId, storeId);
      }

      let tokens: OauthTokenSet;
      try {
        tokens = await deps.oauthClient.exchangeCode(params.code);
      } catch {
        // サニタイズ済みでも露出面を増やさないため、原因文字列は結果に載せない（Req 2.1）。
        return errorResult('token_exchange_failed', ownerId, storeId);
      }

      // Req 2.2: refresh token 無しでは以後の投稿・返信が継続できないため成立させない。
      if (tokens.refreshToken === null || tokens.refreshToken === '') {
        await revoke(tokens.accessToken);
        return errorResult('no_refresh_token', ownerId, storeId);
      }
      if (tokens.accessToken === null || tokens.accessToken === '') {
        // 列挙に使えるトークンが無い = 突合不能。権限なしと結論せず再試行導線へ倒す。
        await revoke(tokens.refreshToken);
        return errorResult('listing_failed', ownerId, storeId);
      }

      const match = await findLocationForPlace(deps.gbpClient, {
        accessToken: tokens.accessToken,
        placeId: store.placeId,
      });

      if (match.kind === 'error') {
        // 列挙の失敗・不完全は「管理権限なし」と結論しない（Req 1.6 の誤判定防止）。
        await revoke(tokens.refreshToken);
        const reason =
          match.reason === 'listing_incomplete'
            ? 'listing_incomplete'
            : match.reason === 'invalid_place_id'
              ? 'store_unavailable'
              : 'listing_failed';
        return errorResult(reason, ownerId, storeId);
      }

      if (match.kind === 'no_permission') {
        // Req 1.6: 連携を成立させず、預かった認可も手放す。何も永続化しない。
        await revoke(tokens.refreshToken);
        return { kind: 'no_permission', ownerId, storeId };
      }

      let persisted: boolean;
      try {
        persisted = await persistLink({
          ownerId,
          storeId,
          refreshToken: tokens.refreshToken,
          scopes: tokens.scopes,
          accountName: match.location.accountName,
          locationName: match.location.locationName,
          placeId: store.placeId,
          canOperateLocalPost: match.location.canOperateLocalPost,
        });
      } catch {
        // 接続取得失敗・pg クエリの reject（接続断・デッドロック・タイムアウト）。
        // ここで捕捉しないと Google 側の refresh token が孤児化し、さらに呼び出し側
        // （CallbackRoute）は OauthCallbackResult を受ける契約のため Req 1.5 の通知も出せない。
        // DB は persistLink 内で ROLLBACK 済み（connect 自体の失敗なら何も始まっていない）。
        // 原エラーは DB の接続文字列等を含みうるため結果にもログにも載せない（Req 2.1）。
        await revoke(tokens.refreshToken);
        return errorResult('persist_failed', ownerId, storeId);
      }
      if (!persisted) {
        // 片側だけ残る状態は存在しない（トランザクションで巻き戻し済み）。
        await revoke(tokens.refreshToken);
        return errorResult('persist_failed', ownerId, storeId);
      }

      return { kind: 'linked', ownerId, storeId, storeName: store.name };
    },

    async revokeToken(token) {
      await revoke(token);
    },
  };
}

/** payload の pendingStoreId（store_id 列が NULL の異常系の保険）。 */
function readPendingStoreId(payload: Record<string, unknown>): string | null {
  const value = payload['pendingStoreId'];
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null;
}
