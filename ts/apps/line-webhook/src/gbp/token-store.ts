// GBP 認可情報（Google refresh token）の暗号化保管層（gbp-post-review-reply spec task 2.1）。
// Requirements: 1.7（店舗単位の独立）, 2.1（平文を永続化せずログ・エラーにも露出させない）,
// 2.2（再認可なしで投稿・返信を継続）, 2.3（失効時は実行せず再連携誘導）。
//
// 設計上の不変条件:
// - 永続化されるのは AES-256-GCM の暗号化ペイロード（`token_ref` v1 形式）のみ。
// - 平文の refresh token / アクセストークンは呼び出しスコープのメモリ上にのみ存在し、
//   ログ・例外メッセージ・エラーオブジェクトのいずれにも載せない（下記 sanitize を参照）。
// - アクセストークンは操作ごとに refresh grant で取得し、永続キャッシュしない
//   （Cloud Run のステートレス性に合わせる）。
// - store に到達する全操作は ownerId を必須とし、packages/db のアクセサへ透過する
//   （storeId 単独で他店舗に到達できる経路を作らない・Req 2.6）。

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { safeErrorCode, safeStatus } from './logger.js';
import {
  deleteOauthToken,
  getOauthToken,
  upsertOauthToken,
  type Queryable,
  type Result,
} from '@fwlm/db';

/** token_ref のバージョン識別子。鍵ローテーション時はここを版上げして再暗号化する。 */
const TOKEN_REF_VERSION = 'v1';
const CIPHER_ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
/** 本モジュールが扱う oauth_tokens の provider（現状 Google のみ）。 */
const PROVIDER = 'google' as const;

/** store に到達する操作の共通キー。ownerId は所有検証のため常に必須（Req 2.6）。 */
export interface StoreKey {
  ownerId: string;
  storeId: string;
}

/** 失効・未連携・復号失敗の 3 分類。トークンや認可コードは一切保持しない（Req 2.1）。 */
export type TokenStoreError =
  | { kind: 'not_linked' }
  | { kind: 'token_invalid' }
  | { kind: 'crypto_error' };

export interface SaveTokenInput extends StoreKey {
  /** 平文の refresh token。保存前に必ず暗号化され、平文のまま DB へ渡らない。 */
  refreshToken: string;
  scopes: string;
}

/**
 * refresh grant の実行主体。実装を差し替え可能にして、テストで実ネットワークを
 * 叩かずに失効分類・エラーサニタイズを検証できるようにする。
 */
export interface RefreshGrantClient {
  /** refresh token からアクセストークンを取得する。失敗時は throw する。 */
  fetchAccessToken(refreshToken: string): Promise<string>;
}

export interface TokenStoreService {
  saveToken(db: Queryable, input: SaveTokenInput): Promise<Result<void, 'STORE_NOT_OWNED'>>;
  getAccessTokenForStore(db: Queryable, key: StoreKey): Promise<Result<string, TokenStoreError>>;
  deleteToken(db: Queryable, key: StoreKey): Promise<boolean>;
  isLinked(db: Queryable, key: StoreKey): Promise<boolean>;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeBase64Strict(value: string, expectedBytes?: number): Buffer | null {
  if (!BASE64_PATTERN.test(value)) return null;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, 'base64');
  } catch {
    return null;
  }
  // Node の base64 デコードは不正文字を黙って捨てるため、再エンコードで往復一致を確認する。
  if (decoded.toString('base64') !== value) return null;
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) return null;
  return decoded;
}

/**
 * env `GBP_TOKEN_CIPHER_KEY`（32 byte base64）を鍵 Buffer にパースする。
 * 形式・長さ不正は起動時 fail-fast。エラーメッセージに鍵素材を含めない（Req 2.1）。
 */
export function parseCipherKey(cipherKeyBase64: string): Buffer {
  const key = decodeBase64Strict(cipherKeyBase64.trim(), KEY_BYTES);
  if (!key) {
    throw new Error(
      `GBP_TOKEN_CIPHER_KEY must be ${KEY_BYTES}-byte base64 (invalid format or length)`,
    );
  }
  return key;
}

/**
 * 平文トークンを AES-256-GCM で暗号化し `v1:<base64(iv)>:<base64(authTag)>:<base64(ciphertext)>`
 * を返す。iv は毎回ランダムで、同一平文でもペイロードは一致しない。
 */
export function encryptToken(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    TOKEN_REF_VERSION,
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/**
 * token_ref を復号する。バージョン不一致・部品数不正・非 base64・長さ不正・authTag 検証失敗
 * （改竄・鍵違い）はいずれも `null` を返す（例外に平文や鍵素材を載せないため）。
 */
export function decryptToken(tokenRef: string, key: Buffer): string | null {
  const parts = tokenRef.split(':');
  if (parts.length !== 4) return null;
  const [version, ivB64, authTagB64, ciphertextB64] = parts;
  if (version !== TOKEN_REF_VERSION) return null;
  if (ivB64 === undefined || authTagB64 === undefined || ciphertextB64 === undefined) return null;

  const iv = decodeBase64Strict(ivB64, IV_BYTES);
  const authTag = decodeBase64Strict(authTagB64, AUTH_TAG_BYTES);
  const ciphertext = decodeBase64Strict(ciphertextB64);
  if (!iv || !authTag || !ciphertext) return null;

  try {
    const decipher = createDecipheriv(CIPHER_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    // authTag 不一致（改竄・鍵違い）を含む復号失敗。詳細は呼び出し側に渡さない。
    return null;
  }
}

function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

/**
 * refresh grant の失敗が「認可の失効・取り消し」かを判定する（Req 2.3 の判定点）。
 * 一次情報は OAuth のエラーレスポンス `error: "invalid_grant"`。取得できない場合のみ
 * メッセージ側にフォールバックする。判定できないものは失効扱いにしない
 * （transient 障害で誤って再連携誘導を出さないため）。
 */
export function isInvalidGrantError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const data = readProperty(readProperty(error, 'response'), 'data');
  const oauthError = readProperty(data, 'error');
  if (typeof oauthError === 'string') return oauthError === 'invalid_grant';
  return /\binvalid_grant\b/.test(error.message);
}

/**
 * refresh grant の失敗を、平文トークンを一切含まないエラーへ詰め替える（Req 2.1）。
 * google-auth-library の GaxiosError は `config.data` にリクエストボディ（refresh_token 込み）を
 * 保持するため、原エラーを cause / プロパティとして持ち回ってはならない。
 */
function sanitizeRefreshError(error: unknown): Error {
  const response = readProperty(error, 'response');
  const status = safeStatus(readProperty(response, 'status'));
  const code = safeErrorCode(readProperty(readProperty(response, 'data'), 'error'));
  return new Error(`google refresh grant failed (status=${status}, error=${code})`);
}

export interface GoogleRefreshGrantClientOptions {
  clientId: string;
  clientSecret: string;
}

/**
 * google-auth-library の `OAuth2Client` による既定の refresh grant 実装。
 * 呼び出しごとにクライアントを生成し、認可情報がインスタンスに残らないようにする。
 * 構築時にネットワークアクセスは発生しない。
 */
export function createGoogleRefreshGrantClient(
  options: GoogleRefreshGrantClientOptions,
): RefreshGrantClient {
  return {
    async fetchAccessToken(refreshToken: string): Promise<string> {
      const client = new OAuth2Client({
        clientId: options.clientId,
        clientSecret: options.clientSecret,
      });
      client.setCredentials({ refresh_token: refreshToken });
      const { token } = await client.getAccessToken();
      if (!token) {
        throw new Error('google refresh grant failed (status=unknown, error=no_access_token)');
      }
      return token;
    },
  };
}

export interface CreateTokenStoreOptions {
  /** env `GBP_TOKEN_CIPHER_KEY`（32 byte base64）。形式不正は構築時に throw する。 */
  cipherKeyBase64: string;
  refreshClient: RefreshGrantClient;
}

/**
 * TokenStore を構築する。鍵は構築時に検証し（fail-fast）、以降は Buffer としてのみ保持する。
 */
export function createTokenStore(options: CreateTokenStoreOptions): TokenStoreService {
  const cipherKey = parseCipherKey(options.cipherKeyBase64);
  const { refreshClient } = options;

  return {
    async saveToken(db, input) {
      const tokenRef = encryptToken(input.refreshToken, cipherKey);
      const res = await upsertOauthToken(db, {
        ownerId: input.ownerId,
        storeId: input.storeId,
        provider: PROVIDER,
        tokenRef,
        scopes: input.scopes,
        // refresh token に固定の有効期限はないため NULL 運用（design: Data Models）。
        expiresAt: null,
      });
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, value: undefined };
    },

    async getAccessTokenForStore(db, key) {
      const row = await getOauthToken(db, {
        ownerId: key.ownerId,
        storeId: key.storeId,
        provider: PROVIDER,
      });
      if (!row) return { ok: false, error: { kind: 'not_linked' } };

      const refreshToken = decryptToken(row.token_ref, cipherKey);
      if (refreshToken === null) return { ok: false, error: { kind: 'crypto_error' } };

      try {
        const accessToken = await refreshClient.fetchAccessToken(refreshToken);
        return { ok: true, value: accessToken };
      } catch (error) {
        // 失効（Req 2.3）は型付きエラーで返し、GbpFlows が再連携誘導へ変換する。
        if (isInvalidGrantError(error)) return { ok: false, error: { kind: 'token_invalid' } };
        // それ以外（ネットワーク・5xx 等）は一過性の障害であり失効と混同しない。
        // 原エラーは平文トークンを含みうるため、サニタイズ済みエラーに詰め替えて送出する。
        throw sanitizeRefreshError(error);
      }
    },

    async deleteToken(db, key) {
      return deleteOauthToken(db, {
        ownerId: key.ownerId,
        storeId: key.storeId,
        provider: PROVIDER,
      });
    },

    async isLinked(db, key) {
      const row = await getOauthToken(db, {
        ownerId: key.ownerId,
        storeId: key.storeId,
        provider: PROVIDER,
      });
      return row !== null;
    },
  };
}
