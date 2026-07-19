import { describe, it, expect } from 'vitest';
import type {
  ConfirmedStoreSummary,
  GbpSessionLookup,
  GbpSessionRow,
  Queryable,
  Result,
  UpsertGbpSessionInput,
} from '@fwlm/db';
import {
  createGbpFlowHandlers,
  type GbpFlowDeps,
  type GbpFlowHandlers,
} from '../../src/gbp/flows.js';
import {
  buildGbpAlreadyLinkedMessage,
  buildGbpAuthorizeMessage,
  buildGbpCancelledMessage,
  buildGbpCurrentStateMessage,
  buildGbpDisconnectedMessage,
  buildGbpFlowNotAvailableMessage,
  buildGbpNoEligibleStoreMessage,
  buildGbpNotLinkedMessage,
  buildGbpSessionExpiredMessage,
  buildGbpStaleSelectionMessage,
  buildGbpStatusMessage,
  buildGbpStorePickerMessage,
} from '../../src/gbp/messages.js';
import { encodeGbpPostback } from '../../src/gbp/postback.js';
import type { LineMessage } from '../../src/line/client.js';
import type { TokenStoreError } from '../../src/gbp/token-store.js';

// gbp-post-review-reply spec task 3.3（GbpFlows・連携系）のモック deps テスト。
// Requirements: 1.1（Place 確定済み店舗のみ誘導）, 1.2（認可誘導）, 1.3（複数店舗の選択）,
//   2.4（連携解除 = revoke + 行削除 + 未連携案内）, 2.5（連携状態確認）。
// Design: 「GbpFlows」（Responsibilities・State Management）・状態機械図・「GbpMessages」。

const OWNER = '11111111-1111-1111-1111-111111111111';
const STORE_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const STORE_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const FOREIGN_STORE = 'cccccccc-0000-0000-0000-000000000003';
const LINE_USER_ID = 'Uflows-owner';
const NOW = new Date('2026-07-19T00:00:00.000Z');
const REPLY_TOKEN = 'reply-token-1';

function confirmedStore(id: string, name: string): ConfirmedStoreSummary {
  return { id, name, placeId: `ChIJ-${id}` };
}

function sessionRow(overrides: Partial<GbpSessionRow> = {}): GbpSessionRow {
  return {
    id: 'session-1',
    owner_id: OWNER,
    store_id: null,
    flow: 'connect',
    stage: 'await_store',
    payload: {},
    draft_text: null,
    expires_at: new Date(NOW.getTime() + 60_000),
    updated_at: NOW,
    ...overrides,
  };
}

interface HarnessOptions {
  stores?: readonly ConfirmedStoreSummary[];
  linkedStoreIds?: readonly string[];
  session?: GbpSessionLookup;
  accessToken?: Result<string, TokenStoreError>;
  /** getAccessTokenForStore が一過性障害で throw する経路の再現。 */
  accessTokenThrows?: boolean;
  startConnectFails?: boolean;
}

interface Harness {
  handlers: GbpFlowHandlers;
  replies: LineMessage[][];
  startConnectCalls: { ownerId: string; storeId: string }[];
  upsertCalls: UpsertGbpSessionInput[];
  clearCalls: string[];
  revoked: string[];
  deletedTokens: { ownerId: string; storeId: string }[];
  deletedLocations: { ownerId: string; storeId: string }[];
  txLog: string[];
}

function createHarness(options: HarnessOptions = {}): Harness {
  const stores = options.stores ?? [confirmedStore(STORE_A, 'テスト食堂A')];
  const linked = new Set(options.linkedStoreIds ?? []);

  const replies: LineMessage[][] = [];
  const startConnectCalls: { ownerId: string; storeId: string }[] = [];
  const upsertCalls: UpsertGbpSessionInput[] = [];
  const clearCalls: string[] = [];
  const revoked: string[] = [];
  const deletedTokens: { ownerId: string; storeId: string }[] = [];
  const deletedLocations: { ownerId: string; storeId: string }[] = [];
  const txLog: string[] = [];

  const deps: GbpFlowDeps = {
    db: {} as Queryable,
    pool: {
      connect: async () => ({
        query: async (text: string) => {
          txLog.push(text);
          return { rows: [], rowCount: 0 };
        },
        release: () => {
          txLog.push('RELEASE');
        },
      }),
    },
    oauth: {
      async startConnect(_db, key) {
        startConnectCalls.push({ ownerId: key.ownerId, storeId: key.storeId });
        if (options.startConnectFails) return { ok: false, error: 'STORE_NOT_OWNED' };
        return {
          ok: true,
          value: {
            authorizeUrl: `https://accounts.google.com/authorize?store=${key.storeId}`,
            state: `${key.ownerId}.nonce`,
          },
        };
      },
      async revokeToken(token) {
        revoked.push(token);
      },
    },
    tokenStore: {
      async isLinked(_db, key) {
        return linked.has(key.storeId) && stores.some((s) => s.id === key.storeId);
      },
      async getAccessTokenForStore(_db, key) {
        if (options.accessTokenThrows) throw new Error('transient refresh failure');
        return (
          options.accessToken ?? {
            ok: true as const,
            value: `access-token-for-${key.storeId}`,
          }
        );
      },
      async deleteToken(_db, key) {
        deletedTokens.push({ ownerId: key.ownerId, storeId: key.storeId });
        return true;
      },
    },
    sessions: {
      async getActiveGbpSession() {
        return options.session ?? { kind: 'none' };
      },
      async upsertGbpSession(_db, input) {
        upsertCalls.push(input);
        return { ok: true, value: sessionRow({ store_id: input.storeId, stage: input.stage }) };
      },
      async clearGbpSession(_db, ownerId) {
        clearCalls.push(ownerId);
        return true;
      },
      // 承認実行の CAS（task 4.1）。連携系フローからは到達しないため、呼ばれたら失敗させる。
      // 投稿フローの検証は test/gbp/flows-post.test.ts が所有する。
      async beginGbpSessionExecution() {
        throw new Error('beginGbpSessionExecution must not be called from connect flows');
      },
      async completeGbpSessionExecution() {
        throw new Error('completeGbpSessionExecution must not be called from connect flows');
      },
      async revertGbpSessionExecution() {
        throw new Error('revertGbpSessionExecution must not be called from connect flows');
      },
    },
    locations: {
      async deleteGbpLocation(_db, key) {
        deletedLocations.push({ ownerId: key.ownerId, storeId: key.storeId });
        return true;
      },
    },
    stores: {
      async listConfirmedStoresByOwner() {
        return stores;
      },
    },
    // 下書き生成と GBP 書込（task 4.1）は連携系フローからは到達しない（Req 3.6 の
    // 承認ゲート）。到達したら即座に失敗させ、経路の混入を検知できるようにする。
    prompts: {
      async generatePostDraft() {
        throw new Error('generatePostDraft must not be called from connect flows');
      },
    },
    gbpClient: {
      async createLocalPost() {
        throw new Error('createLocalPost must not be called from connect flows');
      },
    },
    messenger: {
      async reply(_replyToken, messages) {
        replies.push([...messages]);
      },
    },
    now: () => NOW,
  };

  return {
    handlers: createGbpFlowHandlers(deps),
    replies,
    startConnectCalls,
    upsertCalls,
    clearCalls,
    revoked,
    deletedTokens,
    deletedLocations,
    txLog,
  };
}

function postback(data: string): { ownerId: string; lineUserId: string; replyToken: string; data: string } {
  return { ownerId: OWNER, lineUserId: LINE_USER_ID, replyToken: REPLY_TOKEN, data };
}

function text(value: string): { ownerId: string; lineUserId: string; replyToken: string; text: string } {
  return { ownerId: OWNER, lineUserId: LINE_USER_ID, replyToken: REPLY_TOKEN, text: value };
}

describe('createGbpFlowHandlers（連携系フロー・task 3.3）', () => {
  describe('g_connect（Req 1.1, 1.2, 1.3）', () => {
    it('Place 確定済み店舗が 1 件・未連携なら認可 URL を提示する', async () => {
      const h = createHarness({ stores: [confirmedStore(STORE_A, 'テスト食堂A')] });

      await h.handlers.handleGbpPostback(postback(encodeGbpPostback({ action: 'g_connect' })));

      expect(h.startConnectCalls).toEqual([{ ownerId: OWNER, storeId: STORE_A }]);
      expect(h.replies).toEqual([
        [
          buildGbpAuthorizeMessage({
            storeName: 'テスト食堂A',
            authorizeUrl: `https://accounts.google.com/authorize?store=${STORE_A}`,
          }),
        ],
      ]);
    });

    it('Place 確定済み店舗が 0 件なら誘導せず案内のみ返す（Req 1.1）', async () => {
      const h = createHarness({ stores: [] });

      await h.handlers.handleGbpPostback(postback(encodeGbpPostback({ action: 'g_connect' })));

      expect(h.startConnectCalls).toEqual([]);
      expect(h.upsertCalls).toEqual([]);
      expect(h.replies).toEqual([[buildGbpNoEligibleStoreMessage()]]);
    });

    it('複数店舗なら選択を求め、認可はまだ開始しない（Req 1.3）', async () => {
      const stores = [confirmedStore(STORE_A, 'テスト食堂A'), confirmedStore(STORE_B, 'テスト食堂B')];
      const h = createHarness({ stores });

      await h.handlers.handleGbpPostback(postback(encodeGbpPostback({ action: 'g_connect' })));

      expect(h.startConnectCalls).toEqual([]);
      expect(h.upsertCalls).toHaveLength(1);
      expect(h.upsertCalls[0]).toMatchObject({
        ownerId: OWNER,
        storeId: null,
        flow: 'connect',
        stage: 'await_store',
        payload: { storeIds: [STORE_A, STORE_B] },
      });
      expect(h.replies).toEqual([[buildGbpStorePickerMessage(stores)]]);
    });

    it('既に連携済みの店舗では認可を開始せず、状態と解除導線を案内する', async () => {
      const h = createHarness({ linkedStoreIds: [STORE_A] });

      await h.handlers.handleGbpPostback(postback(encodeGbpPostback({ action: 'g_connect' })));

      expect(h.startConnectCalls).toEqual([]);
      expect(h.replies).toEqual([[buildGbpAlreadyLinkedMessage(STORE_A, 'テスト食堂A')]]);
    });

    it('startConnect が所有検証で失敗したら案内のみ返す', async () => {
      const h = createHarness({ startConnectFails: true });

      await h.handlers.handleGbpPostback(postback(encodeGbpPostback({ action: 'g_connect' })));

      expect(h.replies[0]?.[0]).not.toEqual(
        buildGbpAuthorizeMessage({ storeName: 'テスト食堂A', authorizeUrl: 'x' }),
      );
    });
  });

  describe('g_pick_store（Req 1.3・所有検証）', () => {
    const pickSession = (storeIds: readonly string[]): GbpSessionLookup => ({
      kind: 'active',
      session: sessionRow({ stage: 'await_store', payload: { storeIds: [...storeIds] } }),
    });

    it('選択された店舗で認可を開始する', async () => {
      const h = createHarness({
        stores: [confirmedStore(STORE_A, 'テスト食堂A'), confirmedStore(STORE_B, 'テスト食堂B')],
        session: pickSession([STORE_A, STORE_B]),
      });

      await h.handlers.handleGbpPostback(
        postback(encodeGbpPostback({ action: 'g_pick_store', index: 1 })),
      );

      expect(h.startConnectCalls).toEqual([{ ownerId: OWNER, storeId: STORE_B }]);
    });

    it('スナップショットの店舗が現在の所有店舗一覧に無ければ認可を開始しない（所有検証）', async () => {
      const h = createHarness({
        stores: [confirmedStore(STORE_A, 'テスト食堂A')],
        session: pickSession([FOREIGN_STORE]),
      });

      await h.handlers.handleGbpPostback(
        postback(encodeGbpPostback({ action: 'g_pick_store', index: 0 })),
      );

      expect(h.startConnectCalls).toEqual([]);
      expect(h.replies).toEqual([[buildGbpStaleSelectionMessage()]]);
    });

    it('範囲外 index は認可を開始しない', async () => {
      const h = createHarness({ session: pickSession([STORE_A]) });

      await h.handlers.handleGbpPostback(
        postback(encodeGbpPostback({ action: 'g_pick_store', index: 7 })),
      );

      expect(h.startConnectCalls).toEqual([]);
      expect(h.replies).toEqual([[buildGbpStaleSelectionMessage()]]);
    });

    it('セッション期限切れなら行を削除して期限切れを案内する', async () => {
      const h = createHarness({
        session: { kind: 'expired', session: sessionRow({ expires_at: new Date(NOW.getTime() - 1) }) },
      });

      await h.handlers.handleGbpPostback(
        postback(encodeGbpPostback({ action: 'g_pick_store', index: 0 })),
      );

      expect(h.clearCalls).toEqual([OWNER]);
      expect(h.startConnectCalls).toEqual([]);
      expect(h.replies).toEqual([[buildGbpSessionExpiredMessage()]]);
    });

    it('stage 不一致の stale postback は無視して現在状態を案内する', async () => {
      const session = sessionRow({ stage: 'await_callback', store_id: STORE_A });
      const h = createHarness({ session: { kind: 'active', session } });

      await h.handlers.handleGbpPostback(
        postback(encodeGbpPostback({ action: 'g_pick_store', index: 0 })),
      );

      expect(h.startConnectCalls).toEqual([]);
      expect(h.clearCalls).toEqual([]);
      expect(h.replies).toEqual([[buildGbpCurrentStateMessage(session)]]);
    });
  });

  describe('g_status（Req 2.5）', () => {
    it('連携済み店舗は連携済みとして解除導線付きで提示する', async () => {
      const h = createHarness({ linkedStoreIds: [STORE_A] });

      await h.handlers.handleGbpPostback(postback(encodeGbpPostback({ action: 'g_status' })));

      expect(h.replies).toEqual([
        [buildGbpStatusMessage([{ storeId: STORE_A, name: 'テスト食堂A', linked: true }])],
      ]);
      expect(JSON.stringify(h.replies)).toContain(
        encodeGbpPostback({ action: 'g_disconnect', storeId: STORE_A }),
      );
    });

    it('未連携店舗は未連携として連携導線付きで提示する', async () => {
      const h = createHarness({
        stores: [confirmedStore(STORE_A, 'テスト食堂A'), confirmedStore(STORE_B, 'テスト食堂B')],
        linkedStoreIds: [STORE_B],
      });

      await h.handlers.handleGbpPostback(postback(encodeGbpPostback({ action: 'g_status' })));

      expect(h.replies).toEqual([
        [
          buildGbpStatusMessage([
            { storeId: STORE_A, name: 'テスト食堂A', linked: false },
            { storeId: STORE_B, name: 'テスト食堂B', linked: true },
          ]),
        ],
      ]);
      expect(JSON.stringify(h.replies)).toContain(encodeGbpPostback({ action: 'g_connect' }));
    });

    it('Place 確定済み店舗が無ければ状態確認も誘導なし案内になる（Req 1.1）', async () => {
      const h = createHarness({ stores: [] });

      await h.handlers.handleGbpPostback(postback(encodeGbpPostback({ action: 'g_status' })));

      expect(h.replies).toEqual([[buildGbpNoEligibleStoreMessage()]]);
    });
  });

  describe('g_disconnect（Req 2.4）', () => {
    it('revoke → oauth_tokens 削除 → gbp_locations 削除を行い未連携案内を返す', async () => {
      const h = createHarness({ linkedStoreIds: [STORE_A] });

      await h.handlers.handleGbpPostback(
        postback(encodeGbpPostback({ action: 'g_disconnect', storeId: STORE_A })),
      );

      expect(h.revoked).toEqual([`access-token-for-${STORE_A}`]);
      expect(h.deletedTokens).toEqual([{ ownerId: OWNER, storeId: STORE_A }]);
      expect(h.deletedLocations).toEqual([{ ownerId: OWNER, storeId: STORE_A }]);
      expect(h.txLog).toEqual(['BEGIN', 'COMMIT', 'RELEASE']);
      expect(h.replies).toEqual([[buildGbpDisconnectedMessage('テスト食堂A')]]);
    });

    it('他オーナーの storeId は所有検証で弾き、revoke も削除も行わない（Req 2.6）', async () => {
      const h = createHarness({ linkedStoreIds: [STORE_A] });

      await h.handlers.handleGbpPostback(
        postback(encodeGbpPostback({ action: 'g_disconnect', storeId: FOREIGN_STORE })),
      );

      expect(h.revoked).toEqual([]);
      expect(h.deletedTokens).toEqual([]);
      expect(h.deletedLocations).toEqual([]);
      expect(h.replies).toEqual([[buildGbpNotLinkedMessage()]]);
    });

    it('復号不能（crypto_error）でも削除は完了し、再連携を促さない', async () => {
      const h = createHarness({
        linkedStoreIds: [STORE_A],
        accessToken: { ok: false, error: { kind: 'crypto_error' } },
      });

      await h.handlers.handleGbpPostback(
        postback(encodeGbpPostback({ action: 'g_disconnect', storeId: STORE_A })),
      );

      expect(h.revoked).toEqual([]);
      expect(h.deletedTokens).toEqual([{ ownerId: OWNER, storeId: STORE_A }]);
      expect(h.deletedLocations).toEqual([{ ownerId: OWNER, storeId: STORE_A }]);
      expect(JSON.stringify(h.replies)).not.toContain('再連携');
    });

    it('アクセストークン取得が一過性障害で失敗しても削除は完了する', async () => {
      const h = createHarness({ linkedStoreIds: [STORE_A], accessTokenThrows: true });

      await h.handlers.handleGbpPostback(
        postback(encodeGbpPostback({ action: 'g_disconnect', storeId: STORE_A })),
      );

      expect(h.revoked).toEqual([]);
      expect(h.deletedTokens).toEqual([{ ownerId: OWNER, storeId: STORE_A }]);
      expect(h.replies).toEqual([[buildGbpDisconnectedMessage('テスト食堂A')]]);
    });
  });

  describe('その他の postback', () => {
    it('g_cancel はセッションを破棄して案内を返す', async () => {
      const h = createHarness({ session: { kind: 'active', session: sessionRow() } });

      await h.handlers.handleGbpPostback(postback(encodeGbpPostback({ action: 'g_cancel' })));

      expect(h.clearCalls).toEqual([OWNER]);
      expect(h.replies).toEqual([[buildGbpCancelledMessage()]]);
    });

    // task 4.1 で投稿（g_post / g_approve / g_regen / g_revise）が解禁されたため、
    // 準備中案内が残るのはクチコミ返信（機能1-b・task 4.2）の action のみ。
    // 投稿フローの検証は test/gbp/flows-post.test.ts が所有する。
    it('返信の action は task 4.2 の範囲として準備中案内を返す', async () => {
      for (const action of ['g_reply', 'g_overwrite'] as const) {
        const h = createHarness();
        await h.handlers.handleGbpPostback(postback(encodeGbpPostback({ action })));
        expect(h.replies).toEqual([[buildGbpFlowNotAvailableMessage()]]);
        expect(h.startConnectCalls).toEqual([]);
      }
    });

    it('復号できない data でも例外を投げず現在状態を案内する', async () => {
      const h = createHarness();

      await h.handlers.handleGbpPostback(postback('a=g_unknown_action'));

      expect(h.replies).toEqual([[buildGbpCurrentStateMessage(null)]]);
    });
  });

  describe('handleGbpText（アクティブセッション時のみ引き受ける）', () => {
    it('セッションが無ければ not_handled を返し、返信しない', async () => {
      const h = createHarness();

      const result = await h.handlers.handleGbpText(text('こんにちは'));

      expect(result).toBe('not_handled');
      expect(h.replies).toEqual([]);
    });

    it('期限切れセッションは破棄して案内し handled を返す', async () => {
      const h = createHarness({
        session: { kind: 'expired', session: sessionRow({ expires_at: new Date(NOW.getTime() - 1) }) },
      });

      const result = await h.handlers.handleGbpText(text('こんにちは'));

      expect(result).toBe('handled');
      expect(h.clearCalls).toEqual([OWNER]);
      expect(h.replies).toEqual([[buildGbpSessionExpiredMessage()]]);
    });

    it('連携フローの進行中テキストは現在状態を案内し handled を返す', async () => {
      const session = sessionRow({ stage: 'await_callback', store_id: STORE_A });
      const h = createHarness({ session: { kind: 'active', session } });

      const result = await h.handlers.handleGbpText(text('まだですか'));

      expect(result).toBe('handled');
      expect(h.replies).toEqual([[buildGbpCurrentStateMessage(session)]]);
    });
  });
});
