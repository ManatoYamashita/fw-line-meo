import { describe, it, expect } from 'vitest';
import type {
  GbpLocationRow,
  GbpSessionRow,
  Queryable,
  Result,
  TransactionClient,
  UpsertGbpLocationInput,
  UpsertGbpSessionInput,
} from '@fwlm/db';
import type { GbpAccountLocation } from '../../src/gbp/client.js';
import type { SaveTokenInput } from '../../src/gbp/token-store.js';
import {
  GBP_SCOPE,
  createGbpOauthService,
  type GbpOauthDeps,
  type GoogleOauthCodeClient,
  type OauthTokenSet,
} from '../../src/gbp/oauth.js';

// gbp-post-review-reply spec task 3.1（GbpOauth）の unit テスト。
// Requirements: 1.2（認可手続きへの誘導）, 1.4（認可完了→連携成立）, 1.5（拒否・中断）,
// 1.6（管理権限なし→不成立）, 1.8（最小スコープ）。
// 実ネットワーク・実 DB には一切触れない（Google クライアント・アクセサをすべてスタブ注入する）。

// --- fixtures（gbp 系の専用 UUID プレフィックス `fc`）---
const OWNER = 'fcd00000-0000-0000-0000-00000000030a';
const STORE = 'fcd00000-0000-0000-0000-0000000003a1';
const OTHER_STORE = 'fcd00000-0000-0000-0000-0000000003a2';
const PLACE_ID = 'ChIJfc3100000000000000000000';
const STORE_NAME = 'テスト居酒屋 3.1';
const NOW = new Date('2026-07-19T00:00:00.000Z');

const CLIENT_ID = 'fc-client-id.apps.googleusercontent.com';
const CLIENT_SECRET = 'fc-client-secret-EXPOSURE-CANARY';
const REDIRECT_URL = 'https://webhook.example.com/gbp/oauth/callback';

// 露出検査の照合対象（誤検知しにくい固有文字列）。
const AUTH_CODE = '4/authorization-code-EXPOSURE-CANARY';
const REFRESH_TOKEN = '1//refresh-EXPOSURE-CANARY';
const ACCESS_TOKEN = 'ya29.access-EXPOSURE-CANARY';

const NONCE = 'fixed-state-nonce-0123456789abcdef';

// 永続化層の例外に混ぜる目印。結果へ原エラーが載っていないことの検査に使う。
const DB_ERROR_CANARY = 'db-failure-EXPOSURE-CANARY';

function accountLocation(overrides: Partial<GbpAccountLocation> = {}): GbpAccountLocation {
  return {
    accountName: 'accounts/9911',
    locationName: 'locations/8822',
    title: 'GBP 上の店舗名',
    placeId: PLACE_ID,
    canOperateLocalPost: true,
    ...overrides,
  };
}

function tokenSet(overrides: Partial<OauthTokenSet> = {}): OauthTokenSet {
  return {
    refreshToken: REFRESH_TOKEN,
    accessToken: ACCESS_TOKEN,
    scopes: GBP_SCOPE,
    ...overrides,
  };
}

/**
 * google-auth-library の GaxiosError を模した例外。`config.data` に認可コードを含む
 * リクエストボディを保持する（実物と同じ危険な形）。
 */
function gaxiosLikeError(): Error {
  const error = new Error('Bad Request') as Error & {
    config: { data: string };
    response: { status: number; data: { error: string } };
  };
  error.config = { data: `code=${AUTH_CODE}&client_secret=${CLIENT_SECRET}` };
  error.response = { status: 400, data: { error: 'invalid_grant' } };
  return error;
}

interface Harness {
  deps: GbpOauthDeps;
  journal: string[];
  sessionRows: Map<string, GbpSessionRow>;
  savedTokens: SaveTokenInput[];
  savedLocations: UpsertGbpLocationInput[];
  revoked: string[];
  exchangeCalls: string[];
  listCalls: string[];
}

interface HarnessOptions {
  exchange?: (code: string) => Promise<OauthTokenSet>;
  locations?:
    | { ok: true; value: GbpAccountLocation[] }
    | { ok: false; error: { kind: 'incomplete_listing' } | { kind: 'rate_limited' } };
  store?: { name: string; placeId: string | null } | null;
  saveTokenResult?: Result<void, 'STORE_NOT_OWNED'>;
  upsertLocationResult?: 'STORE_NOT_OWNED' | undefined;
  /** pool.connect() が reject する（接続枯渇・接続断）。 */
  connectError?: Error | undefined;
  /** saveToken が reject する（pg クエリのデッドロック・タイムアウト等）。 */
  saveTokenError?: Error | undefined;
  /** upsertGbpLocation が reject する（同上）。 */
  upsertLocationError?: Error | undefined;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const journal: string[] = [];
  const sessionRows = new Map<string, GbpSessionRow>();
  const savedTokens: SaveTokenInput[] = [];
  const savedLocations: UpsertGbpLocationInput[] = [];
  const revoked: string[] = [];
  const exchangeCalls: string[] = [];
  const listCalls: string[] = [];

  const rootDb = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Queryable;
  // pg の query は多重定義のため、フェイクは戻り値を never へ落として構造的に適合させる
  // （onboarding/conversation.test.ts の createFakePool と同一の規律）。
  const txClient: TransactionClient = {
    async query(text: unknown) {
      if (typeof text === 'string') {
        journal.push(text);
      }
      return { rows: [], rowCount: 0 } as never;
    },
    release() {
      journal.push('RELEASE');
    },
  };
  const txDb = txClient as unknown as Queryable;

  const oauthClient: GoogleOauthCodeClient = {
    buildAuthorizeUrl({ state }) {
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URL,
        response_type: 'code',
        scope: GBP_SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        state,
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    },
    async exchangeCode(code) {
      exchangeCalls.push(code);
      if (options.exchange) return options.exchange(code);
      return tokenSet();
    },
    async revokeToken(token) {
      revoked.push(token);
    },
  };

  const deps: GbpOauthDeps = {
    db: rootDb,
    pool: {
      async connect() {
        journal.push('CONNECT');
        if (options.connectError) throw options.connectError;
        return txClient;
      },
    },
    oauthClient,
    gbpClient: {
      async listAccountsAndLocations(accessToken: string) {
        listCalls.push(accessToken);
        return options.locations ?? { ok: true, value: [accountLocation()] };
      },
    },
    tokenStore: {
      async saveToken(db, input) {
        journal.push('saveToken');
        expect(db).toBe(txDb);
        if (options.saveTokenError) throw options.saveTokenError;
        const result = options.saveTokenResult ?? { ok: true, value: undefined };
        if (result.ok) savedTokens.push(input);
        return result;
      },
    },
    sessions: {
      async getActiveGbpSession(_db, ownerId, now = NOW) {
        const row = sessionRows.get(ownerId);
        if (!row) return { kind: 'none' };
        if (row.expires_at.getTime() <= now.getTime()) return { kind: 'expired', session: row };
        return { kind: 'active', session: row };
      },
      async upsertGbpSession(_db, input: UpsertGbpSessionInput) {
        if (input.storeId === OTHER_STORE) return { ok: false, error: 'STORE_NOT_OWNED' };
        const row: GbpSessionRow = {
          id: 'fcd00000-0000-0000-0000-0000000003f1',
          owner_id: input.ownerId,
          store_id: input.storeId,
          flow: input.flow,
          stage: input.stage,
          payload: input.payload,
          draft_text: input.draftText,
          expires_at: input.expiresAt,
          updated_at: NOW,
        };
        sessionRows.set(input.ownerId, row);
        return { ok: true, value: row };
      },
      async clearGbpSession(_db, ownerId) {
        journal.push('clearSession');
        return sessionRows.delete(ownerId);
      },
    },
    locations: {
      async upsertGbpLocation(db, input) {
        journal.push('upsertGbpLocation');
        expect(db).toBe(txDb);
        if (options.upsertLocationError) throw options.upsertLocationError;
        if (options.upsertLocationResult === 'STORE_NOT_OWNED') {
          return { ok: false, error: 'STORE_NOT_OWNED' };
        }
        savedLocations.push(input);
        const row: GbpLocationRow = {
          id: 'fcd00000-0000-0000-0000-0000000003e1',
          store_id: input.storeId,
          account_name: input.accountName,
          location_name: input.locationName,
          place_id: input.placeId,
          can_operate_local_post: input.canOperateLocalPost,
          linked_at: NOW,
        };
        return { ok: true, value: row };
      },
    },
    stores: {
      async findStore() {
        return options.store === undefined
          ? { name: STORE_NAME, placeId: PLACE_ID }
          : options.store;
      },
    },
    now: () => NOW,
    generateStateNonce: () => NONCE,
  };

  return { deps, journal, sessionRows, savedTokens, savedLocations, revoked, exchangeCalls, listCalls };
}

/** startConnect でセッションを作り、callback へ渡す state を得る。 */
async function startConnect(harness: Harness, storeId = STORE): Promise<string> {
  const service = createGbpOauthService(harness.deps);
  const res = await service.startConnect(harness.deps.db, { ownerId: OWNER, storeId });
  if (!res.ok) throw new Error(`startConnect failed: ${res.error}`);
  return res.value.state;
}

describe('buildAuthorizeUrl / startConnect（Req 1.2, 1.8）', () => {
  it('認可 URL は business.manage 単一スコープ・offline・consent・state を持つ', async () => {
    const harness = createHarness();
    const service = createGbpOauthService(harness.deps);
    const url = new URL(service.buildAuthorizeUrl({ storeId: STORE, state: 'state-xyz' }));

    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('state-xyz');
    expect(url.searchParams.get('response_type')).toBe('code');
    // Req 1.8: 要求スコープは 1 個だけ。
    const scope = url.searchParams.get('scope') ?? '';
    expect(scope.split(/\s+/).filter((s) => s !== '')).toEqual([GBP_SCOPE]);
  });

  it('GBP_SCOPE は business.manage 単一の定数', () => {
    expect(GBP_SCOPE).toBe('https://www.googleapis.com/auth/business.manage');
  });

  it('startConnect は connect セッション（state・pendingStoreId・30 分期限）を永続化する', async () => {
    const harness = createHarness();
    const service = createGbpOauthService(harness.deps);
    const res = await service.startConnect(harness.deps.db, { ownerId: OWNER, storeId: STORE });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const session = harness.sessionRows.get(OWNER);
    expect(session?.flow).toBe('connect');
    expect(session?.stage).toBe('await_callback');
    expect(session?.store_id).toBe(STORE);
    expect(session?.payload).toMatchObject({ state: res.value.state, pendingStoreId: STORE });
    expect(session?.expires_at.getTime()).toBe(NOW.getTime() + 30 * 60 * 1000);
    expect(new URL(res.value.authorizeUrl).searchParams.get('state')).toBe(res.value.state);
  });

  it('startConnect は所有外の店舗を拒否する（Req 2.6）', async () => {
    const harness = createHarness();
    const service = createGbpOauthService(harness.deps);
    const res = await service.startConnect(harness.deps.db, {
      ownerId: OWNER,
      storeId: OTHER_STORE,
    });
    expect(res).toEqual({ ok: false, error: 'STORE_NOT_OWNED' });
    expect(harness.sessionRows.size).toBe(0);
  });
});

describe('handleOauthCallback — 連携成立（Req 1.4）', () => {
  it('placeId 一致時に oauth_tokens と gbp_locations を同一トランザクションで永続化する', async () => {
    const harness = createHarness();
    const state = await startConnect(harness);
    const service = createGbpOauthService(harness.deps);

    const result = await service.handleOauthCallback({ code: AUTH_CODE, state });

    expect(result).toEqual({
      kind: 'linked',
      ownerId: OWNER,
      storeId: STORE,
      storeName: STORE_NAME,
    });
    expect(harness.exchangeCalls).toEqual([AUTH_CODE]);
    expect(harness.listCalls).toEqual([ACCESS_TOKEN]);
    expect(harness.savedTokens).toEqual([
      { ownerId: OWNER, storeId: STORE, refreshToken: REFRESH_TOKEN, scopes: GBP_SCOPE },
    ]);
    expect(harness.savedLocations).toEqual([
      {
        ownerId: OWNER,
        storeId: STORE,
        accountName: 'accounts/9911',
        locationName: 'locations/8822',
        placeId: PLACE_ID,
        canOperateLocalPost: true,
      },
    ]);
    // 2 テーブルの書き込みが BEGIN...COMMIT の内側に閉じている。
    const begin = harness.journal.indexOf('BEGIN');
    const commit = harness.journal.indexOf('COMMIT');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(harness.journal.indexOf('saveToken')).toBeGreaterThan(begin);
    expect(harness.journal.indexOf('upsertGbpLocation')).toBeGreaterThan(begin);
    expect(commit).toBeGreaterThan(harness.journal.indexOf('upsertGbpLocation'));
    expect(harness.journal).not.toContain('ROLLBACK');
    expect(harness.journal).toContain('RELEASE');
    // 成立時に revoke はしない。
    expect(harness.revoked).toEqual([]);
  });

  it('state は 1 度で消費され、同じ state の再送は state_mismatch になる（リプレイ防止）', async () => {
    const harness = createHarness();
    const state = await startConnect(harness);
    const service = createGbpOauthService(harness.deps);

    const first = await service.handleOauthCallback({ code: AUTH_CODE, state });
    expect(first.kind).toBe('linked');
    expect(harness.sessionRows.size).toBe(0);

    const second = await service.handleOauthCallback({ code: AUTH_CODE, state });
    expect(second).toEqual({ kind: 'state_mismatch' });
    // 2 回目は code 交換すら行わない。
    expect(harness.exchangeCalls).toEqual([AUTH_CODE]);
  });
});

describe('handleOauthCallback — state 検証（Req 1.4 の前提・CSRF/リプレイ防止）', () => {
  it('state 欠落は state_mismatch', async () => {
    const harness = createHarness();
    await startConnect(harness);
    const service = createGbpOauthService(harness.deps);
    expect(await service.handleOauthCallback({ code: AUTH_CODE })).toEqual({
      kind: 'state_mismatch',
    });
    expect(harness.exchangeCalls).toEqual([]);
  });

  it('形式不正な state は state_mismatch（DB へ問い合わせない）', async () => {
    const harness = createHarness();
    await startConnect(harness);
    const service = createGbpOauthService(harness.deps);
    for (const state of ['', 'no-separator', 'not-a-uuid.nonce', `${OWNER}.`]) {
      expect(await service.handleOauthCallback({ code: AUTH_CODE, state })).toEqual({
        kind: 'state_mismatch',
      });
    }
    expect(harness.sessionRows.size).toBe(1);
  });

  it('nonce 不一致は state_mismatch（セッションは消費しない）', async () => {
    const harness = createHarness();
    await startConnect(harness);
    const service = createGbpOauthService(harness.deps);
    const forged = `${OWNER}.${'x'.repeat(NONCE.length)}`;
    expect(await service.handleOauthCallback({ code: AUTH_CODE, state: forged })).toEqual({
      kind: 'state_mismatch',
    });
    expect(harness.exchangeCalls).toEqual([]);
    expect(harness.sessionRows.size).toBe(1);
  });

  it('期限切れ state は state_mismatch とし、残存セッションを破棄する', async () => {
    const harness = createHarness();
    const state = await startConnect(harness);
    const expired = harness.sessionRows.get(OWNER);
    if (!expired) throw new Error('session missing');
    harness.sessionRows.set(OWNER, {
      ...expired,
      expires_at: new Date(NOW.getTime() - 1000),
    });

    const service = createGbpOauthService(harness.deps);
    expect(await service.handleOauthCallback({ code: AUTH_CODE, state })).toEqual({
      kind: 'state_mismatch',
    });
    expect(harness.exchangeCalls).toEqual([]);
    expect(harness.sessionRows.size).toBe(0);
  });

  it('connect 以外のフローのセッションでは照合しない', async () => {
    const harness = createHarness();
    const state = await startConnect(harness);
    const session = harness.sessionRows.get(OWNER);
    if (!session) throw new Error('session missing');
    harness.sessionRows.set(OWNER, { ...session, flow: 'post', stage: 'await_input' });

    const service = createGbpOauthService(harness.deps);
    expect(await service.handleOauthCallback({ code: AUTH_CODE, state })).toEqual({
      kind: 'state_mismatch',
    });
    expect(harness.exchangeCalls).toEqual([]);
  });
});

describe('handleOauthCallback — 拒否・中断（Req 1.5）', () => {
  it('error パラメータ受領時は denied を返し、code 交換を行わずセッションを消費する', async () => {
    const harness = createHarness();
    const state = await startConnect(harness);
    const service = createGbpOauthService(harness.deps);

    const result = await service.handleOauthCallback({ error: 'access_denied', state });

    expect(result).toEqual({ kind: 'denied', ownerId: OWNER, storeId: STORE });
    expect(harness.exchangeCalls).toEqual([]);
    expect(harness.savedTokens).toEqual([]);
    expect(harness.savedLocations).toEqual([]);
    expect(harness.sessionRows.size).toBe(0);
  });

  it('state が不明な拒否でも denied を返す（通知先は解決できない）', async () => {
    const harness = createHarness();
    const service = createGbpOauthService(harness.deps);
    expect(await service.handleOauthCallback({ error: 'access_denied' })).toEqual({
      kind: 'denied',
      ownerId: null,
      storeId: null,
    });
  });

  it('state は有効だが code が無い場合は error（セッションは消費する）', async () => {
    const harness = createHarness();
    const state = await startConnect(harness);
    const service = createGbpOauthService(harness.deps);

    const result = await service.handleOauthCallback({ state });
    expect(result).toEqual({ kind: 'error', reason: 'missing_code', ownerId: OWNER, storeId: STORE });
    expect(harness.sessionRows.size).toBe(0);
  });
});

describe('handleOauthCallback — 管理権限なし（Req 1.6）', () => {
  it('placeId 一致 location が無ければ revoke し、何も永続化しない', async () => {
    const harness = createHarness({
      locations: { ok: true, value: [accountLocation({ placeId: 'ChIJ-other-place' })] },
    });
    const state = await startConnect(harness);
    const service = createGbpOauthService(harness.deps);

    const result = await service.handleOauthCallback({ code: AUTH_CODE, state });

    expect(result).toEqual({ kind: 'no_permission', ownerId: OWNER, storeId: STORE });
    expect(harness.revoked).toEqual([REFRESH_TOKEN]);
    expect(harness.savedTokens).toEqual([]);
    expect(harness.savedLocations).toEqual([]);
    expect(harness.journal).not.toContain('BEGIN');
    expect(harness.journal).not.toContain('COMMIT');
  });

  it('incomplete_listing は no_permission にせず error にする（1.6 の誤判定防止）', async () => {
    const harness = createHarness({ locations: { ok: false, error: { kind: 'incomplete_listing' } } });
    const state = await startConnect(harness);
    const service = createGbpOauthService(harness.deps);

    const result = await service.handleOauthCallback({ code: AUTH_CODE, state });

    expect(result).toEqual({
      kind: 'error',
      reason: 'listing_incomplete',
      ownerId: OWNER,
      storeId: STORE,
    });
    expect(harness.revoked).toEqual([REFRESH_TOKEN]);
    expect(harness.savedTokens).toEqual([]);
    expect(harness.savedLocations).toEqual([]);
  });

  it('列挙の一過性失敗も error（再試行導線）', async () => {
    const harness = createHarness({ locations: { ok: false, error: { kind: 'rate_limited' } } });
    const state = await startConnect(harness);
    const service = createGbpOauthService(harness.deps);

    const result = await service.handleOauthCallback({ code: AUTH_CODE, state });
    expect(result).toMatchObject({ kind: 'error', reason: 'listing_failed' });
    expect(harness.savedTokens).toEqual([]);
  });
});

describe('handleOauthCallback — 失敗経路の安全性', () => {
  it('code 交換の失敗で認可コード・クライアントシークレットが結果へ漏れない', async () => {
    const harness = createHarness({
      exchange: async () => {
        throw gaxiosLikeError();
      },
    });
    const state = await startConnect(harness);
    const service = createGbpOauthService(harness.deps);

    const result = await service.handleOauthCallback({ code: AUTH_CODE, state });

    expect(result).toMatchObject({ kind: 'error', reason: 'token_exchange_failed' });
    const serialized = JSON.stringify(result, Object.getOwnPropertyNames(result));
    expect(serialized).not.toContain(AUTH_CODE);
    expect(serialized).not.toContain(CLIENT_SECRET);
    expect(serialized).not.toContain('code=');
    expect(harness.savedTokens).toEqual([]);
    expect(harness.savedLocations).toEqual([]);
  });

  it('refresh token が得られない場合は連携を成立させずアクセストークンを revoke する', async () => {
    const harness = createHarness({ exchange: async () => tokenSet({ refreshToken: null }) });
    const state = await startConnect(harness);
    const service = createGbpOauthService(harness.deps);

    const result = await service.handleOauthCallback({ code: AUTH_CODE, state });

    expect(result).toMatchObject({ kind: 'error', reason: 'no_refresh_token' });
    expect(harness.revoked).toEqual([ACCESS_TOKEN]);
    expect(harness.savedTokens).toEqual([]);
  });

  it('店舗の place_id 未確定では code 交換に進まない（Req 1.1 の前提）', async () => {
    const harness = createHarness({ store: { name: STORE_NAME, placeId: null } });
    const state = await startConnect(harness);
    const service = createGbpOauthService(harness.deps);

    const result = await service.handleOauthCallback({ code: AUTH_CODE, state });
    expect(result).toMatchObject({ kind: 'error', reason: 'store_unavailable' });
    expect(harness.exchangeCalls).toEqual([]);
  });

  it('永続化が所有検証で弾かれたら ROLLBACK し、何も残さず revoke する', async () => {
    const harness = createHarness({ saveTokenResult: { ok: false, error: 'STORE_NOT_OWNED' } });
    const state = await startConnect(harness);
    const service = createGbpOauthService(harness.deps);

    const result = await service.handleOauthCallback({ code: AUTH_CODE, state });

    expect(result).toMatchObject({ kind: 'error', reason: 'persist_failed' });
    expect(harness.journal).toContain('ROLLBACK');
    expect(harness.journal).not.toContain('COMMIT');
    expect(harness.savedTokens).toEqual([]);
    expect(harness.savedLocations).toEqual([]);
    expect(harness.revoked).toEqual([REFRESH_TOKEN]);
  });

  it('gbp_locations 側の失敗でも ROLLBACK して何も残さない', async () => {
    const harness = createHarness({ upsertLocationResult: 'STORE_NOT_OWNED' });
    const state = await startConnect(harness);
    const service = createGbpOauthService(harness.deps);

    const result = await service.handleOauthCallback({ code: AUTH_CODE, state });

    expect(result).toMatchObject({ kind: 'error', reason: 'persist_failed' });
    expect(harness.journal).toContain('ROLLBACK');
    expect(harness.journal).not.toContain('COMMIT');
    expect(harness.savedLocations).toEqual([]);
  });

  // 永続化層の「例外」経路（Result の !ok ではなく throw）。ここを取りこぼすと
  // Google 側の refresh token が孤児化し、さらに CallbackRoute（task 3.2）は
  // OauthCallbackResult を受ける契約のため Req 1.5 の LINE 通知も出せなくなる。
  it('pool.connect() の失敗でも throw せず persist_failed を返し revoke する', async () => {
    const harness = createHarness({ connectError: new Error(DB_ERROR_CANARY) });
    const state = await startConnect(harness);
    const service = createGbpOauthService(harness.deps);

    const result = await service.handleOauthCallback({ code: AUTH_CODE, state });

    expect(result).toEqual({
      kind: 'error',
      reason: 'persist_failed',
      ownerId: OWNER,
      storeId: STORE,
    });
    expect(harness.revoked).toEqual([REFRESH_TOKEN]);
    expect(harness.savedTokens).toEqual([]);
    expect(harness.savedLocations).toEqual([]);
    // 原エラーの文字列を結果に載せない（Req 2.1 の平文非露出規律）。
    expect(JSON.stringify(result, Object.getOwnPropertyNames(result))).not.toContain(
      DB_ERROR_CANARY,
    );
  });

  it('saveToken が reject しても throw せず persist_failed を返し ROLLBACK・revoke する', async () => {
    const harness = createHarness({ saveTokenError: new Error(DB_ERROR_CANARY) });
    const state = await startConnect(harness);
    const service = createGbpOauthService(harness.deps);

    const result = await service.handleOauthCallback({ code: AUTH_CODE, state });

    expect(result).toEqual({
      kind: 'error',
      reason: 'persist_failed',
      ownerId: OWNER,
      storeId: STORE,
    });
    expect(harness.revoked).toEqual([REFRESH_TOKEN]);
    expect(harness.journal).toContain('ROLLBACK');
    expect(harness.journal).not.toContain('COMMIT');
    expect(harness.journal).toContain('RELEASE');
    expect(harness.savedTokens).toEqual([]);
    expect(harness.savedLocations).toEqual([]);
    expect(JSON.stringify(result, Object.getOwnPropertyNames(result))).not.toContain(
      DB_ERROR_CANARY,
    );
  });

  it('upsertGbpLocation が reject しても throw せず persist_failed を返し ROLLBACK・revoke する', async () => {
    const harness = createHarness({ upsertLocationError: new Error(DB_ERROR_CANARY) });
    const state = await startConnect(harness);
    const service = createGbpOauthService(harness.deps);

    const result = await service.handleOauthCallback({ code: AUTH_CODE, state });

    expect(result).toEqual({
      kind: 'error',
      reason: 'persist_failed',
      ownerId: OWNER,
      storeId: STORE,
    });
    expect(harness.revoked).toEqual([REFRESH_TOKEN]);
    expect(harness.journal).toContain('ROLLBACK');
    expect(harness.journal).not.toContain('COMMIT');
    expect(harness.journal).toContain('RELEASE');
    expect(harness.savedLocations).toEqual([]);
    expect(JSON.stringify(result, Object.getOwnPropertyNames(result))).not.toContain(
      DB_ERROR_CANARY,
    );
  });

  it('revokeToken は失敗しても例外を伝播しない（ベストエフォート）', async () => {
    const harness = createHarness();
    harness.deps.oauthClient.revokeToken = async () => {
      throw new Error(`revoke failed with ${REFRESH_TOKEN}`);
    };
    const service = createGbpOauthService(harness.deps);
    await expect(service.revokeToken(REFRESH_TOKEN)).resolves.toBeUndefined();
  });
});
