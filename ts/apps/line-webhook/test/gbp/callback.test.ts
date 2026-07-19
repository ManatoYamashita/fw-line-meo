import { describe, it, expect } from 'vitest';
import type { Queryable } from '@fwlm/db';
import type { LineMessage } from '../../src/line/client.js';
import type { OauthCallbackResult } from '../../src/gbp/oauth.js';
import {
  buildGbpLinkCompletedMessage,
  buildGbpLinkDeniedMessage,
  buildGbpLinkErrorMessage,
  buildGbpLinkNoPermissionMessage,
  createGbpOauthCallbackRoute,
  type GbpOauthCallbackDeps,
} from '../../src/gbp/callback.js';

// gbp-post-review-reply spec task 3.2（CallbackRoute）の unit テスト。
// Requirements: 1.4（認可完了の通知）, 1.5（拒否・中断の案内）, 1.6（管理権限なしの案内）。
// 実ネットワーク・実 DB には触れない（GbpOauthService・LINE Push・owners 参照をすべてスタブ注入）。

// --- fixtures（gbp 系の専用 UUID プレフィックス `fc`）---
const OWNER = 'fcd00000-0000-0000-0000-00000000032a';
const STORE = 'fcd00000-0000-0000-0000-0000000003b1';
const LINE_USER_ID = 'Ufc32-owner-line-user';
const STORE_NAME = 'テスト居酒屋 3.2';

// HTML・ログに漏れてはならない値（誤検知しにくい固有文字列）。
const AUTH_CODE = '4/authorization-code-EXPOSURE-CANARY';
const STATE = `${OWNER}.state-nonce-EXPOSURE-CANARY`;

interface Harness {
  deps: GbpOauthCallbackDeps;
  pushes: { lineUserId: string; messages: readonly LineMessage[] }[];
  ownerLookups: string[];
  callbackParams: { code?: string | undefined; state?: string | undefined; error?: string | undefined }[];
  errorLogs: { message: string; meta?: Record<string, unknown> }[];
  warnLogs: { message: string; meta?: Record<string, unknown> }[];
}

interface HarnessOptions {
  result?: OauthCallbackResult;
  /** handleOauthCallback 自体が throw する（想定外の内部障害）。 */
  callbackError?: Error;
  /** owners 参照の結果（既定は LINE_USER_ID を返す）。 */
  owner?: { line_user_id: string } | null;
  /** push が失敗する（LINE 側障害・ブロック等）。 */
  pushError?: Error;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const pushes: Harness['pushes'] = [];
  const ownerLookups: string[] = [];
  const callbackParams: Harness['callbackParams'] = [];
  const errorLogs: Harness['errorLogs'] = [];
  const warnLogs: Harness['warnLogs'] = [];

  const deps: GbpOauthCallbackDeps = {
    db: { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Queryable,
    oauth: {
      handleOauthCallback: async (params) => {
        callbackParams.push(params);
        if (options.callbackError !== undefined) throw options.callbackError;
        return options.result ?? { kind: 'state_mismatch' };
      },
    },
    messenger: {
      push: async (lineUserId, messages) => {
        pushes.push({ lineUserId, messages });
        if (options.pushError !== undefined) throw options.pushError;
      },
    },
    owners: {
      findOwnerById: async (_db, ownerId) => {
        ownerLookups.push(ownerId);
        return options.owner === undefined ? { line_user_id: LINE_USER_ID } : options.owner;
      },
    },
    logger: {
      error: (message, meta) => {
        errorLogs.push({ message, ...(meta === undefined ? {} : { meta }) });
      },
      warn: (message, meta) => {
        warnLogs.push({ message, ...(meta === undefined ? {} : { meta }) });
      },
    },
  };

  return { deps, pushes, ownerLookups, callbackParams, errorLogs, warnLogs };
}

function allLogText(harness: Harness): string {
  return JSON.stringify([harness.errorLogs, harness.warnLogs]);
}

describe('createGbpOauthCallbackRoute — 結果別の HTML とステータス', () => {
  it('linked: 200 と連携完了 HTML を返し、オーナーへ完了 Push を送る（Req 1.4）', async () => {
    const harness = createHarness({
      result: { kind: 'linked', ownerId: OWNER, storeId: STORE, storeName: STORE_NAME },
    });
    const route = createGbpOauthCallbackRoute(harness.deps);

    const res = await route({ code: AUTH_CODE, state: STATE });

    expect(res.status).toBe(200);
    expect(res.html).toContain('連携が完了しました');
    expect(res.html).toContain(STORE_NAME);
    expect(res.html).toContain('LINE');

    expect(harness.ownerLookups).toEqual([OWNER]);
    expect(harness.pushes).toEqual([
      { lineUserId: LINE_USER_ID, messages: [buildGbpLinkCompletedMessage(STORE_NAME)] },
    ]);
  });

  it('denied: 200 と未完了 HTML を返し、再試行導線つきの Push を送る（Req 1.5）', async () => {
    const harness = createHarness({
      result: { kind: 'denied', ownerId: OWNER, storeId: STORE },
    });
    const route = createGbpOauthCallbackRoute(harness.deps);

    const res = await route({ state: STATE, error: 'access_denied' });

    expect(res.status).toBe(200);
    expect(res.html).toContain('連携は完了していません');
    expect(harness.pushes).toEqual([
      { lineUserId: LINE_USER_ID, messages: [buildGbpLinkDeniedMessage()] },
    ]);
  });

  it('state_mismatch: 400 とやり直し案内 HTML を返し、通知先不明のため Push しない', async () => {
    const harness = createHarness({ result: { kind: 'state_mismatch' } });
    const route = createGbpOauthCallbackRoute(harness.deps);

    const res = await route({ code: AUTH_CODE, state: STATE });

    expect(res.status).toBe(400);
    expect(res.html).toContain('最初からやり直してください');
    expect(harness.pushes).toEqual([]);
    expect(harness.ownerLookups).toEqual([]);
  });

  it('no_permission: 200 と権限不足 HTML を返し、権限のあるアカウントでの再連携を Push する（Req 1.6）', async () => {
    const harness = createHarness({
      result: { kind: 'no_permission', ownerId: OWNER, storeId: STORE },
    });
    const route = createGbpOauthCallbackRoute(harness.deps);

    const res = await route({ code: AUTH_CODE, state: STATE });

    expect(res.status).toBe(200);
    expect(res.html).toContain('管理権限');
    expect(harness.pushes).toEqual([
      { lineUserId: LINE_USER_ID, messages: [buildGbpLinkNoPermissionMessage()] },
    ]);
  });

  it('error: 500 と一時的な失敗の HTML を返し、再試行導線つきの Push を送る', async () => {
    const harness = createHarness({
      result: { kind: 'error', reason: 'persist_failed', ownerId: OWNER, storeId: STORE },
    });
    const route = createGbpOauthCallbackRoute(harness.deps);

    const res = await route({ code: AUTH_CODE, state: STATE });

    expect(res.status).toBe(500);
    expect(res.html).toContain('連携を完了できませんでした');
    expect(harness.pushes).toEqual([
      { lineUserId: LINE_USER_ID, messages: [buildGbpLinkErrorMessage()] },
    ]);
  });

  it('クエリの code / state / error をそのまま GbpOauthService へ委譲する', async () => {
    const harness = createHarness({ result: { kind: 'state_mismatch' } });
    const route = createGbpOauthCallbackRoute(harness.deps);

    await route({ code: AUTH_CODE, state: STATE, error: 'access_denied' });

    expect(harness.callbackParams).toEqual([
      { code: AUTH_CODE, state: STATE, error: 'access_denied' },
    ]);
  });
});

describe('createGbpOauthCallbackRoute — 機微情報の非露出（Req 2.1）', () => {
  it('認可コード・state を HTML にもログにも出さない', async () => {
    const harness = createHarness({
      result: { kind: 'error', reason: 'token_exchange_failed', ownerId: OWNER, storeId: STORE },
    });
    const route = createGbpOauthCallbackRoute(harness.deps);

    const res = await route({ code: AUTH_CODE, state: STATE });

    expect(res.html).not.toContain(AUTH_CODE);
    expect(res.html).not.toContain(STATE);
    expect(allLogText(harness)).not.toContain(AUTH_CODE);
    expect(allLogText(harness)).not.toContain(STATE);
  });

  it('HTML に埋め込む店舗名をエスケープする（XSS を作らない）', async () => {
    const evilName = '<script>alert("xss")</script>&"\'';
    const harness = createHarness({
      result: { kind: 'linked', ownerId: OWNER, storeId: STORE, storeName: evilName },
    });
    const route = createGbpOauthCallbackRoute(harness.deps);

    const res = await route({ code: AUTH_CODE, state: STATE });

    expect(res.html).not.toContain('<script>');
    expect(res.html).toContain('&lt;script&gt;');
    expect(res.html).toContain('&amp;');
    expect(res.html).toContain('&quot;');
    expect(res.html).toContain('&#39;');
  });
});

describe('createGbpOauthCallbackRoute — Push はベストエフォート', () => {
  it('通知先 owner が解決できない場合も HTML は返す（Push はしない）', async () => {
    const harness = createHarness({
      result: { kind: 'linked', ownerId: OWNER, storeId: STORE, storeName: STORE_NAME },
      owner: null,
    });
    const route = createGbpOauthCallbackRoute(harness.deps);

    const res = await route({ code: AUTH_CODE, state: STATE });

    expect(res.status).toBe(200);
    expect(harness.pushes).toEqual([]);
    expect(harness.warnLogs.length).toBe(1);
  });

  it('state が解決できず ownerId が null の denied では Push せず HTML のみ返す（Req 1.5）', async () => {
    const harness = createHarness({
      result: { kind: 'denied', ownerId: null, storeId: null },
    });
    const route = createGbpOauthCallbackRoute(harness.deps);

    const res = await route({ state: STATE, error: 'access_denied' });

    expect(res.status).toBe(200);
    expect(res.html).toContain('連携は完了していません');
    // HTML が唯一の伝達手段になるため、再試行手段を必ず案内に含める（Req 1.5）。
    expect(res.html).toContain('LINE');
    expect(harness.ownerLookups).toEqual([]);
    expect(harness.pushes).toEqual([]);
    expect(harness.warnLogs.length).toBe(1);
  });

  it('Push が失敗しても callback は落とさず HTML を返す', async () => {
    const harness = createHarness({
      result: { kind: 'linked', ownerId: OWNER, storeId: STORE, storeName: STORE_NAME },
      pushError: new Error('line push failed'),
    });
    const route = createGbpOauthCallbackRoute(harness.deps);

    const res = await route({ code: AUTH_CODE, state: STATE });

    expect(res.status).toBe(200);
    expect(res.html).toContain('連携が完了しました');
    expect(harness.warnLogs.length).toBe(1);
  });

  it('owners 参照が失敗しても callback は落とさず HTML を返す', async () => {
    const harness = createHarness({
      result: { kind: 'linked', ownerId: OWNER, storeId: STORE, storeName: STORE_NAME },
    });
    harness.deps.owners.findOwnerById = async () => {
      throw new Error('db lookup failed');
    };
    const route = createGbpOauthCallbackRoute(harness.deps);

    const res = await route({ code: AUTH_CODE, state: STATE });

    expect(res.status).toBe(200);
    expect(harness.pushes).toEqual([]);
    expect(harness.warnLogs.length).toBe(1);
  });
});

describe('createGbpOauthCallbackRoute — 内部障害', () => {
  it('handleOauthCallback が throw しても 500 HTML を返し、原因を露出しない', async () => {
    const harness = createHarness({ callbackError: new Error(`boom ${AUTH_CODE}`) });
    const route = createGbpOauthCallbackRoute(harness.deps);

    const res = await route({ code: AUTH_CODE, state: STATE });

    expect(res.status).toBe(500);
    expect(res.html).toContain('連携を完了できませんでした');
    expect(res.html).not.toContain(AUTH_CODE);
    expect(allLogText(harness)).not.toContain(AUTH_CODE);
    expect(harness.errorLogs.length).toBe(1);
    expect(harness.pushes).toEqual([]);
  });
});

describe('通知メッセージ（表示専用ビルダー）', () => {
  it('完了通知は店舗名を含み、投稿・返信が使えることを伝える（Req 1.4）', () => {
    const message = buildGbpLinkCompletedMessage(STORE_NAME);
    expect(JSON.stringify(message)).toContain(STORE_NAME);
    expect(JSON.stringify(message)).toContain('Google 投稿');
  });

  it('拒否・中断と権限なしの通知は再連携用の postback（g_connect）を持つ（Req 1.5, 1.6）', () => {
    for (const message of [buildGbpLinkDeniedMessage(), buildGbpLinkNoPermissionMessage(), buildGbpLinkErrorMessage()]) {
      expect(JSON.stringify(message)).toContain('a=g_connect');
    }
  });

  it('権限なしの通知は「管理権限のあるアカウントでの再連携」を案内する（Req 1.6）', () => {
    expect(JSON.stringify(buildGbpLinkNoPermissionMessage())).toContain('管理権限');
  });
});
