import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  getPool,
  closePool,
  getOauthToken,
  getGbpLocation,
  getActiveGbpSession,
  upsertGbpSession,
  findOwnerById,
} from '@fwlm/db';
import { createApp, type AppDeps } from '../../src/app.js';
import type { SignatureVerifier } from '../../src/webhook/signature.js';
import type { ConversationHandlers } from '../../src/onboarding/conversation.js';
import type { LineMessage } from '../../src/line/client.js';
import { createGbpClient } from '../../src/gbp/client.js';
import { createTokenStore } from '../../src/gbp/token-store.js';
import {
  createDefaultGbpOauthAccessors,
  createGbpOauthService,
  GBP_SCOPE,
  type GoogleOauthCodeClient,
  type OauthTokenSet,
} from '../../src/gbp/oauth.js';
import {
  buildGbpLinkCompletedMessage,
  buildGbpLinkDeniedMessage,
  buildGbpLinkNoPermissionMessage,
  createGbpOauthCallbackRoute,
} from '../../src/gbp/callback.js';

// gbp-post-review-reply spec task 3.2 の integration テスト。
// Requirements: 1.4（連携成立と通知）, 1.5（拒否・中断）, 1.6（管理権限なし）。
//
// 実 postgres（ts-test-db）＋実 HTTP（app.request）＋実 GbpOauthService／実 TokenStore（実暗号）を
// 貫通させ、Google のエンドポイントのみをモックする（実ネットワークは一切使わない）:
// - 認可コード交換（token endpoint）= GoogleOauthCodeClient のスタブ
// - アカウント/ロケーション列挙 = createGbpClient に注入する偽 fetch
//
// 専用 UUID プレフィックス `fc`（ts/ ワークスペース全体で一意）。DATABASE_URL 無しは skip。
const OP = 'fce00000-0000-0000-0000-000000000001';
const AG = 'fce00000-0000-0000-0000-000000000002';
const OWNER = 'fce10000-0000-0000-0000-00000000000a';
const STORE = 'fce50000-0000-0000-0000-000000000001';
const LINE_USER_ID = 'Ufce-callback-owner';
const PLACE_ID = 'ChIJ_fce_callback_store';
const STORE_NAME = 'コールバック検証食堂';

const ACCOUNT_NAME = 'accounts/7001';
const LOCATION_NAME = 'locations/8002';

// 露出検査用の固有文字列（DB・HTML・Push のいずれにも平文で現れてはならない）。
const REFRESH_TOKEN = '1//fce-refresh-EXPOSURE-CANARY';
const ACCESS_TOKEN = 'ya29.fce-access-EXPOSURE-CANARY';
const AUTH_CODE = '4/fce-authorization-code-EXPOSURE-CANARY';

const CIPHER_KEY = Buffer.alloc(32, 0x5c).toString('base64');
const NONCE = 'fce-fixed-state-nonce-0123456789';
const STATE = `${OWNER}.${NONCE}`;

interface PushRecord {
  lineUserId: string;
  messages: readonly LineMessage[];
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** GBP の accounts / locations 列挙だけに応答する偽 fetch（他 URL は明示的に失敗させる）。 */
function createGbpListingFetch(placeIdOnLocation: string): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('mybusinessaccountmanagement.googleapis.com/v1/accounts')) {
      return jsonResponse({ accounts: [{ name: ACCOUNT_NAME }] });
    }
    if (url.includes('mybusinessbusinessinformation.googleapis.com/v1/accounts/7001/locations')) {
      return jsonResponse({
        locations: [
          {
            name: LOCATION_NAME,
            title: 'GBP 上の店舗名',
            metadata: { placeId: placeIdOnLocation, canOperateLocalPost: true },
          },
        ],
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
}

interface Harness {
  app: ReturnType<typeof createApp>;
  pushes: PushRecord[];
  revoked: string[];
  exchangeCalls: string[];
}

interface HarnessOptions {
  /** location 側の placeId。store の place_id と異なれば「管理権限なし」経路になる。 */
  locationPlaceId?: string;
  tokens?: Partial<OauthTokenSet>;
}

async function buildHarness(options: HarnessOptions = {}): Promise<Harness> {
  const pool = await getPool();
  const pushes: PushRecord[] = [];
  const revoked: string[] = [];
  const exchangeCalls: string[] = [];

  const oauthClient: GoogleOauthCodeClient = {
    buildAuthorizeUrl: ({ state }) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
    exchangeCode: async (code) => {
      exchangeCalls.push(code);
      return {
        refreshToken: REFRESH_TOKEN,
        accessToken: ACCESS_TOKEN,
        scopes: GBP_SCOPE,
        ...options.tokens,
      };
    },
    revokeToken: async (token) => {
      revoked.push(token);
    },
  };

  const tokenStore = createTokenStore({
    cipherKeyBase64: CIPHER_KEY,
    // callback 経路では refresh grant を行わないため、呼ばれたら失敗させて検知する。
    refreshClient: {
      fetchAccessToken: async () => {
        throw new Error('refresh grant must not be used in the callback path');
      },
    },
  });

  const gbpClient = createGbpClient({
    tokenStore,
    fetch: createGbpListingFetch(options.locationPlaceId ?? PLACE_ID),
    backoff: async () => {},
  });

  const oauth = createGbpOauthService({
    db: pool,
    pool,
    oauthClient,
    gbpClient,
    tokenStore,
    ...createDefaultGbpOauthAccessors(),
    now: () => new Date(),
  });

  const gbpOauthCallback = createGbpOauthCallbackRoute({
    db: pool,
    oauth,
    messenger: {
      push: async (lineUserId, messages) => {
        pushes.push({ lineUserId, messages });
      },
    },
    owners: { findOwnerById },
    logger: { error: () => {}, warn: () => {} },
  });

  const appDeps: AppDeps = {
    signatureVerifier: { verify: () => false } as SignatureVerifier,
    recordWebhookEventOnce: async () => true,
    conversationHandlers: { handleEvent: async () => {} } as ConversationHandlers,
    messenger: { reply: async () => {} },
    logger: { error: () => {} },
    gbpOauthCallback,
  };

  return { app: createApp(appDeps), pushes, revoked, exchangeCalls };
}

/** connect フローの待ち受けセッション（state 発行済み）を用意する。 */
async function seedConnectSession(): Promise<void> {
  const pool = await getPool();
  const res = await upsertGbpSession(pool, {
    ownerId: OWNER,
    storeId: STORE,
    flow: 'connect',
    stage: 'await_callback',
    payload: { state: STATE, pendingStoreId: STORE },
    draftText: null,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });
  if (!res.ok) throw new Error(`seedConnectSession failed: ${res.error}`);
}

async function cleanupLinkState(): Promise<void> {
  const pool = await getPool();
  await pool.query('DELETE FROM gbp_sessions WHERE owner_id = $1', [OWNER]);
  await pool.query('DELETE FROM gbp_locations WHERE store_id = $1', [STORE]);
  await pool.query('DELETE FROM oauth_tokens WHERE store_id = $1', [STORE]);
}

function callbackUrl(query: Record<string, string>): string {
  const search = new URLSearchParams(query);
  return `/gbp/oauth/callback?${search.toString()}`;
}

describe.skipIf(!process.env.DATABASE_URL)('GET /gbp/oauth/callback（DB 貫通・4 経路）', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, 'callback運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      AG,
      OP,
      'callback代理店',
    ]);
    await pool.query(
      `INSERT INTO owners (id, agency_id, line_user_id, onboarding_status)
       VALUES ($1, $2, $3, 'active')`,
      [OWNER, AG, LINE_USER_ID],
    );
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_id, place_status)
       VALUES ($1, $2, $3, $4, 'confirmed')`,
      [STORE, OWNER, STORE_NAME, PLACE_ID],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await cleanupLinkState();
  });

  it('linked: 認可完了で oauth_tokens・gbp_locations が作られ、完了 Push が届く（Req 1.4）', async () => {
    const pool = await getPool();
    const harness = await buildHarness();
    await seedConnectSession();

    const res = await harness.app.request(callbackUrl({ code: AUTH_CODE, state: STATE }));
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('連携が完了しました');
    expect(html).toContain(STORE_NAME);
    // 認可コード・state・トークンは HTML に一切載せない（Req 2.1）。
    expect(html).not.toContain(AUTH_CODE);
    expect(html).not.toContain(STATE);
    expect(html).not.toContain(REFRESH_TOKEN);

    // DB 状態: 認可情報は暗号化されて保存され、平文の refresh token は残らない。
    const token = await getOauthToken(pool, { ownerId: OWNER, storeId: STORE, provider: 'google' });
    expect(token).not.toBeNull();
    expect(token?.token_ref.startsWith('v1:')).toBe(true);
    expect(token?.token_ref).not.toContain(REFRESH_TOKEN);
    expect(token?.scopes).toBe(GBP_SCOPE);

    const location = await getGbpLocation(pool, { ownerId: OWNER, storeId: STORE });
    expect(location).not.toBeNull();
    expect(location?.account_name).toBe(ACCOUNT_NAME);
    expect(location?.location_name).toBe(LOCATION_NAME);
    expect(location?.place_id).toBe(PLACE_ID);

    // state はワンタイム消費済み。
    expect((await getActiveGbpSession(pool, OWNER)).kind).toBe('none');

    // Push 内容（Req 1.4）。
    expect(harness.pushes).toEqual([
      { lineUserId: LINE_USER_ID, messages: [buildGbpLinkCompletedMessage(STORE_NAME)] },
    ]);
    expect(JSON.stringify(harness.pushes)).not.toContain(REFRESH_TOKEN);
    expect(harness.revoked).toEqual([]);
    expect(harness.exchangeCalls).toEqual([AUTH_CODE]);
  });

  it('denied: 認可拒否では何も永続化されず、再試行案内が Push される（Req 1.5）', async () => {
    const pool = await getPool();
    const harness = await buildHarness();
    await seedConnectSession();

    const res = await harness.app.request(
      callbackUrl({ state: STATE, error: 'access_denied' }),
    );
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('連携は完了していません');

    expect(await getOauthToken(pool, { ownerId: OWNER, storeId: STORE, provider: 'google' })).toBeNull();
    expect(await getGbpLocation(pool, { ownerId: OWNER, storeId: STORE })).toBeNull();
    // 拒否でも state は消費する（同じ state を再利用させない）。
    expect((await getActiveGbpSession(pool, OWNER)).kind).toBe('none');

    expect(harness.pushes).toEqual([
      { lineUserId: LINE_USER_ID, messages: [buildGbpLinkDeniedMessage()] },
    ]);
    // 認可コード交換には進まない。
    expect(harness.exchangeCalls).toEqual([]);
  });

  it('state_mismatch: 照合できない state は 400 で何も永続化せず Push もしない', async () => {
    const pool = await getPool();
    const harness = await buildHarness();
    await seedConnectSession();

    const res = await harness.app.request(
      callbackUrl({ code: AUTH_CODE, state: `${OWNER}.tampered-nonce-000000000000000` }),
    );
    const html = await res.text();

    expect(res.status).toBe(400);
    expect(html).toContain('最初からやり直してください');
    expect(html).not.toContain(AUTH_CODE);

    expect(await getOauthToken(pool, { ownerId: OWNER, storeId: STORE, provider: 'google' })).toBeNull();
    expect(await getGbpLocation(pool, { ownerId: OWNER, storeId: STORE })).toBeNull();
    // 不一致では正規のセッションを消費しない（正しい state での再試行を潰さない）。
    expect((await getActiveGbpSession(pool, OWNER)).kind).toBe('active');

    expect(harness.pushes).toEqual([]);
    expect(harness.exchangeCalls).toEqual([]);
  });

  it('no_permission: placeId 不一致では連携を成立させず、トークンを revoke して案内を Push する（Req 1.6）', async () => {
    const pool = await getPool();
    const harness = await buildHarness({ locationPlaceId: 'ChIJ_fce_someone_else_store' });
    await seedConnectSession();

    const res = await harness.app.request(callbackUrl({ code: AUTH_CODE, state: STATE }));
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('管理権限');

    expect(await getOauthToken(pool, { ownerId: OWNER, storeId: STORE, provider: 'google' })).toBeNull();
    expect(await getGbpLocation(pool, { ownerId: OWNER, storeId: STORE })).toBeNull();
    expect((await getActiveGbpSession(pool, OWNER)).kind).toBe('none');

    // 預かった認可は手放す（Req 1.6）。
    expect(harness.revoked).toEqual([REFRESH_TOKEN]);
    expect(harness.pushes).toEqual([
      { lineUserId: LINE_USER_ID, messages: [buildGbpLinkNoPermissionMessage()] },
    ]);
  });
});
