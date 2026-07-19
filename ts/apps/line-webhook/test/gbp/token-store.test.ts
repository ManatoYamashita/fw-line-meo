import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { OauthTokenRow, Queryable } from '@fwlm/db';
import {
  createGoogleRefreshGrantClient,
  createTokenStore,
  decryptToken,
  encryptToken,
  isInvalidGrantError,
  parseCipherKey,
  type RefreshGrantClient,
} from '../../src/gbp/token-store.js';

// --- fixtures（unit テスト・実 DB には触れない）---
const OWNER = 'fcd00000-0000-0000-0000-00000000000a';
const STORE = 'fcd00000-0000-0000-0000-0000000000a1';
const KEY_B64 = randomBytes(32).toString('base64');
const KEY = Buffer.from(KEY_B64, 'base64');
// 平文トークン（露出検査の照合対象。誤検知しにくい固有文字列にする）
const REFRESH_TOKEN = '1//refresh-secret-EXPOSURE-CANARY-0123456789';
const ACCESS_TOKEN = 'ya29.access-secret-EXPOSURE-CANARY';
const GBP_SCOPE = 'https://www.googleapis.com/auth/business.manage';

interface CapturedQuery {
  text: string;
  values: unknown[];
}

/** アクセサの SQL をそのまま受ける最小の偽 Queryable（応答は固定・呼び出しを記録）。 */
function fakeDb(
  rows: unknown[],
  rowCount?: number,
): { db: Queryable; calls: CapturedQuery[] } {
  const calls: CapturedQuery[] = [];
  const db = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values: values ?? [] });
      return { rows, rowCount: rowCount ?? rows.length };
    },
  } as unknown as Queryable;
  return { db, calls };
}

function tokenRow(tokenRef: string): OauthTokenRow {
  return {
    id: 'fcd00000-0000-0000-0000-0000000000d1',
    store_id: STORE,
    provider: 'google',
    token_ref: tokenRef,
    scopes: GBP_SCOPE,
    expires_at: null,
    created_at: new Date('2026-07-01T00:00:00Z'),
  };
}

function stubRefreshClient(
  impl: (refreshToken: string) => Promise<string>,
): RefreshGrantClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async fetchAccessToken(refreshToken: string): Promise<string> {
      calls.push(refreshToken);
      return impl(refreshToken);
    },
  };
}

/** google-auth-library(GaxiosError) 相当の形状を持つエラーを合成する。 */
function gaxiosLikeError(opts: {
  message: string;
  status?: number;
  dataError?: string;
  requestBody?: string;
}): Error {
  const err = new Error(opts.message);
  Object.assign(err, {
    response: {
      status: opts.status ?? 400,
      data: opts.dataError ? { error: opts.dataError, error_description: 'Token has been expired or revoked.' } : {},
    },
    config: { data: opts.requestBody },
  });
  return err;
}

/** message / 列挙プロパティ / stack を含めた露出検査用シリアライズ。 */
function serializeDeep(err: unknown): string {
  if (err instanceof Error) {
    return JSON.stringify(err, Object.getOwnPropertyNames(err)) + JSON.stringify({ ...err });
  }
  return JSON.stringify(err);
}

describe('parseCipherKey', () => {
  it('32 byte base64 の鍵を Buffer(32) にパースする', () => {
    const key = parseCipherKey(KEY_B64);
    expect(key.length).toBe(32);
    expect(key.equals(KEY)).toBe(true);
  });

  it('長さ不正（16 byte）は起動時 fail-fast で throw し、鍵素材をメッセージに含めない', () => {
    const shortKey = randomBytes(16).toString('base64');
    expect(() => parseCipherKey(shortKey)).toThrow(/GBP_TOKEN_CIPHER_KEY/);
    try {
      parseCipherKey(shortKey);
    } catch (err) {
      expect(serializeDeep(err)).not.toContain(shortKey);
    }
  });

  it('base64 として無効な文字列も throw する', () => {
    expect(() => parseCipherKey('!!!not-base64!!!')).toThrow(/GBP_TOKEN_CIPHER_KEY/);
  });
});

describe('encryptToken / decryptToken', () => {
  it('token_ref v1 形式（v1:<iv>:<authTag>:<ciphertext>・iv 12 byte・authTag 16 byte）で出力する', () => {
    const ref = encryptToken(REFRESH_TOKEN, KEY);
    const parts = ref.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    expect(Buffer.from(parts[1], 'base64').length).toBe(12);
    expect(Buffer.from(parts[2], 'base64').length).toBe(16);
    expect(Buffer.from(parts[3], 'base64').length).toBeGreaterThan(0);
    // 暗号化ペイロードに平文が現れない
    expect(ref).not.toContain(REFRESH_TOKEN);
  });

  it('暗号化→復号ラウンドトリップで平文が一致する', () => {
    const ref = encryptToken(REFRESH_TOKEN, KEY);
    expect(decryptToken(ref, KEY)).toBe(REFRESH_TOKEN);
  });

  it('同一平文でも iv がランダムなため毎回異なるペイロードになる', () => {
    expect(encryptToken(REFRESH_TOKEN, KEY)).not.toBe(encryptToken(REFRESH_TOKEN, KEY));
  });

  it('不正形式を拒否する（バージョン不一致・部品数不足・非 base64）', () => {
    const ref = encryptToken(REFRESH_TOKEN, KEY);
    const [, iv, tag, ct] = ref.split(':');
    expect(decryptToken(`v2:${iv}:${tag}:${ct}`, KEY)).toBeNull();
    expect(decryptToken(`v1:${iv}:${tag}`, KEY)).toBeNull();
    expect(decryptToken('', KEY)).toBeNull();
    expect(decryptToken('plaintext-token', KEY)).toBeNull();
    expect(decryptToken(`v1:!!:${tag}:${ct}`, KEY)).toBeNull();
  });

  it('authTag 検証: 暗号文・タグの改竄や鍵違いは null（復号失敗）', () => {
    const ref = encryptToken(REFRESH_TOKEN, KEY);
    const [, iv, tag, ct] = ref.split(':');
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] = flipped[0]! ^ 0xff;
    expect(decryptToken(`v1:${iv}:${tag}:${flipped.toString('base64')}`, KEY)).toBeNull();
    const badTag = Buffer.from(tag, 'base64');
    badTag[0] = badTag[0]! ^ 0xff;
    expect(decryptToken(`v1:${iv}:${badTag.toString('base64')}:${ct}`, KEY)).toBeNull();
    expect(decryptToken(ref, randomBytes(32))).toBeNull();
  });
});

describe('isInvalidGrantError', () => {
  it('response.data.error === invalid_grant を失効と判定する', () => {
    expect(
      isInvalidGrantError(gaxiosLikeError({ message: 'Token has been expired or revoked.', dataError: 'invalid_grant' })),
    ).toBe(true);
  });

  it('message === invalid_grant（data 欠落時のフォールバック）も失効と判定する', () => {
    expect(isInvalidGrantError(new Error('invalid_grant'))).toBe(true);
  });

  it('その他のエラーは失効と判定しない', () => {
    expect(isInvalidGrantError(gaxiosLikeError({ message: 'server error', status: 500, dataError: 'internal_failure' }))).toBe(false);
    expect(isInvalidGrantError(new Error('network down'))).toBe(false);
    expect(isInvalidGrantError(null)).toBe(false);
    expect(isInvalidGrantError('invalid_grant')).toBe(false);
  });
});

describe('createTokenStore', () => {
  const okClient = () => stubRefreshClient(async () => ACCESS_TOKEN);

  it('鍵の形式不正はファクトリ構築時に fail-fast する', () => {
    expect(() => createTokenStore({ cipherKeyBase64: 'short', refreshClient: okClient() })).toThrow(
      /GBP_TOKEN_CIPHER_KEY/,
    );
  });

  describe('saveToken', () => {
    it('平文を暗号化して upsert する（token_ref は v1 形式・復号すると元の平文・平文は DB に渡らない）', async () => {
      const stored = tokenRow(encryptToken(REFRESH_TOKEN, KEY));
      const { db, calls } = fakeDb([stored]);
      const store = createTokenStore({ cipherKeyBase64: KEY_B64, refreshClient: okClient() });

      const res = await store.saveToken(db, {
        ownerId: OWNER,
        storeId: STORE,
        refreshToken: REFRESH_TOKEN,
        scopes: GBP_SCOPE,
      });

      expect(res.ok).toBe(true);
      expect(calls).toHaveLength(1);
      const values = calls[0]!.values;
      // owner 所有検証つき upsert に ownerId / storeId / provider が透過されている
      expect(values).toContain(OWNER);
      expect(values).toContain(STORE);
      expect(values).toContain('google');
      // 渡った token_ref は v1 形式で、復号すると元の平文になる
      const tokenRef = values.find((v): v is string => typeof v === 'string' && v.startsWith('v1:'));
      expect(tokenRef).toBeDefined();
      expect(decryptToken(tokenRef!, KEY)).toBe(REFRESH_TOKEN);
      // 平文がそのまま DB パラメータに現れない
      expect(JSON.stringify(values)).not.toContain(REFRESH_TOKEN);
    });

    it('store が owner の所有でない場合は STORE_NOT_OWNED を返す', async () => {
      const { db } = fakeDb([]);
      const store = createTokenStore({ cipherKeyBase64: KEY_B64, refreshClient: okClient() });
      const res = await store.saveToken(db, {
        ownerId: OWNER,
        storeId: STORE,
        refreshToken: REFRESH_TOKEN,
        scopes: GBP_SCOPE,
      });
      expect(res).toEqual({ ok: false, error: 'STORE_NOT_OWNED' });
    });
  });

  describe('getAccessTokenForStore', () => {
    it('行が無ければ not_linked', async () => {
      const { db } = fakeDb([]);
      const store = createTokenStore({ cipherKeyBase64: KEY_B64, refreshClient: okClient() });
      const res = await store.getAccessTokenForStore(db, { ownerId: OWNER, storeId: STORE });
      expect(res).toEqual({ ok: false, error: { kind: 'not_linked' } });
    });

    it('復号した refresh token で refresh grant を実行しアクセストークンを返す', async () => {
      const client = okClient();
      const { db } = fakeDb([tokenRow(encryptToken(REFRESH_TOKEN, KEY))]);
      const store = createTokenStore({ cipherKeyBase64: KEY_B64, refreshClient: client });
      const res = await store.getAccessTokenForStore(db, { ownerId: OWNER, storeId: STORE });
      expect(res).toEqual({ ok: true, value: ACCESS_TOKEN });
      expect(client.calls).toEqual([REFRESH_TOKEN]);
    });

    it('token_ref が復号できなければ crypto_error（refresh grant は実行しない）', async () => {
      const client = okClient();
      const { db } = fakeDb([tokenRow('v1:garbage:garbage:garbage')]);
      const store = createTokenStore({ cipherKeyBase64: KEY_B64, refreshClient: client });
      const res = await store.getAccessTokenForStore(db, { ownerId: OWNER, storeId: STORE });
      expect(res).toEqual({ ok: false, error: { kind: 'crypto_error' } });
      expect(client.calls).toEqual([]);
    });

    it('invalid_grant 応答は失効（token_invalid）として分類する', async () => {
      const client = stubRefreshClient(async () => {
        throw gaxiosLikeError({
          message: 'Token has been expired or revoked.',
          dataError: 'invalid_grant',
          requestBody: `grant_type=refresh_token&refresh_token=${REFRESH_TOKEN}`,
        });
      });
      const { db } = fakeDb([tokenRow(encryptToken(REFRESH_TOKEN, KEY))]);
      const store = createTokenStore({ cipherKeyBase64: KEY_B64, refreshClient: client });
      const res = await store.getAccessTokenForStore(db, { ownerId: OWNER, storeId: STORE });
      expect(res).toEqual({ ok: false, error: { kind: 'token_invalid' } });
      // エラーオブジェクトに平文トークンが露出しない（Req 2.1）
      expect(serializeDeep(res)).not.toContain(REFRESH_TOKEN);
    });

    it('invalid_grant 以外の refresh 失敗はサニタイズ済みエラーで throw し平文トークンを露出しない', async () => {
      const client = stubRefreshClient(async () => {
        // 実際の GaxiosError と同様、request body（refresh_token 含む）やメッセージに秘匿情報が乗る最悪形を合成
        throw gaxiosLikeError({
          message: `request failed: refresh_token=${REFRESH_TOKEN}`,
          status: 500,
          dataError: 'internal_failure',
          requestBody: `grant_type=refresh_token&refresh_token=${REFRESH_TOKEN}`,
        });
      });
      const { db } = fakeDb([tokenRow(encryptToken(REFRESH_TOKEN, KEY))]);
      const store = createTokenStore({ cipherKeyBase64: KEY_B64, refreshClient: client });

      let thrown: unknown;
      try {
        await store.getAccessTokenForStore(db, { ownerId: OWNER, storeId: STORE });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      // token_invalid に誤分類しない（transient 失敗で再連携誘導を出さない）
      expect((thrown as Error).message).toContain('status=500');
      expect((thrown as Error).message).toContain('internal_failure');
      // message・stack・列挙プロパティのどこにも平文トークンが現れない
      expect(serializeDeep(thrown)).not.toContain(REFRESH_TOKEN);
      // 原エラー（config.data に平文を含む）を cause 等で持ち回らない
      expect((thrown as { cause?: unknown }).cause).toBeUndefined();
      expect((thrown as { config?: unknown }).config).toBeUndefined();
      expect((thrown as { response?: unknown }).response).toBeUndefined();
    });
  });

  describe('deleteToken', () => {
    it('行が消えたら true', async () => {
      const { db } = fakeDb([], 1);
      const store = createTokenStore({ cipherKeyBase64: KEY_B64, refreshClient: okClient() });
      await expect(store.deleteToken(db, { ownerId: OWNER, storeId: STORE })).resolves.toBe(true);
    });

    it('所有外・不在は false（冪等）', async () => {
      const { db } = fakeDb([], 0);
      const store = createTokenStore({ cipherKeyBase64: KEY_B64, refreshClient: okClient() });
      await expect(store.deleteToken(db, { ownerId: OWNER, storeId: STORE })).resolves.toBe(false);
    });
  });

  describe('isLinked', () => {
    it('行があれば true・無ければ false', async () => {
      const linked = fakeDb([tokenRow(encryptToken(REFRESH_TOKEN, KEY))]);
      const unlinked = fakeDb([]);
      const store = createTokenStore({ cipherKeyBase64: KEY_B64, refreshClient: okClient() });
      await expect(store.isLinked(linked.db, { ownerId: OWNER, storeId: STORE })).resolves.toBe(true);
      await expect(store.isLinked(unlinked.db, { ownerId: OWNER, storeId: STORE })).resolves.toBe(false);
    });
  });
});

describe('createGoogleRefreshGrantClient', () => {
  it('OAuth2Client ベースの既定実装を構築できる（ネットワークは叩かない）', () => {
    const client = createGoogleRefreshGrantClient({
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });
    expect(typeof client.fetchAccessToken).toBe('function');
  });
});
