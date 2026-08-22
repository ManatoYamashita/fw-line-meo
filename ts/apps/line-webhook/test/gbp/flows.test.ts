import { describe, it, expect, vi, type Mock } from 'vitest';
import type {
  ConfirmedStoreSummary,
  GbpSessionLookup,
  GbpSessionRow,
  Queryable,
  Result,
  TransactionClient,
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
  buildGbpConnectRequiredMessage,
  buildGbpCurrentStateMessage,
  buildGbpDisconnectedMessage,
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
  /** getActiveGbpSession が throw する経路（0006 未適用・GRANT 不足）の再現。 */
  sessionLookupThrows?: boolean;
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
  logger: { error: Mock; warn: Mock };
}

function createHarness(options: HarnessOptions = {}): Harness {
  const stores = options.stores ?? [confirmedStore(STORE_A, 'テスト食堂A')];
  const linked = new Set(options.linkedStoreIds ?? []);

  const logger = { error: vi.fn(), warn: vi.fn() };
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
      // pg の query は多重定義のため、フェイクは戻り値を never へ落として構造的に適合させる
      // （onboarding/conversation.test.ts の createFakePool と同一の規律）。
      connect: async (): Promise<TransactionClient> => ({
        async query(text: unknown) {
          if (typeof text === 'string') {
            txLog.push(text);
          }
          return { rows: [], rowCount: 0 } as never;
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
        // 実アクセサは oauth_tokens の行を消すので、以降の isLinked は false になる。
        // フェイクがこれを反映しないと、削除後に再認可へ進む経路（g_relink）を検証できない。
        linked.delete(key.storeId);
        return true;
      },
    },
    sessions: {
      async getActiveGbpSession() {
        // GBP サブシステムの障害（gbp_sessions 未作成・GRANT 不足など）の再現。
        if (options.sessionLookupThrows === true) {
          throw new Error('relation "gbp_sessions" does not exist');
        }
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
      async generateReplyDraft() {
        throw new Error('generateReplyDraft must not be called from connect flows');
      },
    },
    gbpClient: {
      async createLocalPost() {
        throw new Error('createLocalPost must not be called from connect flows');
      },
      async listReviews() {
        throw new Error('listReviews must not be called from connect flows');
      },
      async upsertReviewReply() {
        throw new Error('upsertReviewReply must not be called from connect flows');
      },
    },
    messenger: {
      async reply(_replyToken, messages) {
        replies.push([...messages]);
      },
    },
    logger,
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
    logger,
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
      // **セッションを破棄しない**（PR #121 レビュー指摘）。この分岐は startConnect を伴わない
      // ＝何も置き換えないので、破棄は純粋な副作用になる。失効時の失敗文面は「下書きは保存して
      // います」と案内するため、ここで clear すると温存したはずの draft_text が消える。
      expect(h.clearCalls).toEqual([]);
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

  // PR #121 レビュー指摘の是正。g_connect は isLinked（oauth_tokens 行の存在のみ）で短絡する
  // ため、refresh token が失効していても「すでに連携済み」しか返せず行き止まりだった。
  // g_relink は古い認可情報を消してから認可 URL の発行へ進む。
  describe('g_relink（失効した連携の張り直し・Req 2.3）', () => {
    it('連携済み店舗なら revoke → 行削除 → 認可 URL 発行まで進む', async () => {
      const h = createHarness({ linkedStoreIds: [STORE_A] });

      await h.handlers.handleGbpPostback(
        postback(encodeGbpPostback({ action: 'g_relink', storeId: STORE_A })),
      );

      expect(h.revoked).toEqual([`access-token-for-${STORE_A}`]);
      expect(h.deletedTokens).toEqual([{ ownerId: OWNER, storeId: STORE_A }]);
      expect(h.deletedLocations).toEqual([{ ownerId: OWNER, storeId: STORE_A }]);
      expect(h.txLog).toEqual(['BEGIN', 'COMMIT', 'RELEASE']);
      // 削除後は isLinked が false になるため startConnect が走る（＝行き止まりでない）。
      expect(h.startConnectCalls).toEqual([{ ownerId: OWNER, storeId: STORE_A }]);
    });

    it('未連携・他オーナーの storeId は同一文面へ倒し、何も削除しない', async () => {
      const h = createHarness({ linkedStoreIds: [] });

      await h.handlers.handleGbpPostback(
        postback(encodeGbpPostback({ action: 'g_relink', storeId: STORE_A })),
      );

      expect(h.deletedTokens).toEqual([]);
      expect(h.deletedLocations).toEqual([]);
      expect(h.startConnectCalls).toEqual([]);
      expect(h.replies).toEqual([[buildGbpNotLinkedMessage()]]);
    });

    it('復号不能でも revoke を諦めてローカルの認可情報は必ず消す', async () => {
      const h = createHarness({
        linkedStoreIds: [STORE_A],
        accessToken: { ok: false, error: { kind: 'crypto_error' } },
      });

      await h.handlers.handleGbpPostback(
        postback(encodeGbpPostback({ action: 'g_relink', storeId: STORE_A })),
      );

      expect(h.revoked).toEqual([]);
      expect(h.deletedTokens).toEqual([{ ownerId: OWNER, storeId: STORE_A }]);
      expect(h.startConnectCalls).toEqual([{ ownerId: OWNER, storeId: STORE_A }]);
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

    // task 4.2 でクチコミ返信（g_reply / g_pick_review / g_overwrite）も解禁された。
    // 返信フロー本体の検証は test/gbp/flows-reply.test.ts が所有する。ここでは連携系
    // ハーネス（未連携店舗）から返信を開始しても、状態機械に入らず連携誘導へ倒れること
    // だけを確認する（返信 API・下書き生成へ到達しないことは deps のスローで担保される）。
    it('未連携店舗での g_reply は返信 API へ到達せず連携誘導を返す（Req 4.8）', async () => {
      const h = createHarness();

      await h.handlers.handleGbpPostback(postback(encodeGbpPostback({ action: 'g_reply' })));

      expect(h.startConnectCalls).toEqual([]);
      expect(h.replies).toEqual([[buildGbpConnectRequiredMessage('テスト食堂A')]]);
    });

    it('アクティブセッションの無い g_overwrite は何も実行せず現在状態を案内する', async () => {
      const h = createHarness();

      await h.handlers.handleGbpPostback(postback(encodeGbpPostback({ action: 'g_overwrite' })));

      expect(h.replies).toEqual([[buildGbpCurrentStateMessage(null)]]);
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

  // PR #121 レビュー指摘の是正。handleGbpText / handleGbpPostback はどちらも分岐前に
  // gbp_sessions を無条件 SELECT する。0006 未適用や grants.sql 未再実行だと、**GBP を
  // 使っていない completed オーナーの通常テキストまで** Req 4.6 の固定案内でなく内部エラー
  // 案内へ退行していた（app.ts のイベント境界が捕まえて buildInternalErrorRetryMessage を返す）。
  describe('GBP サブシステムの障害を委譲元へ伝播させない', () => {
    it('テキスト委譲は例外を外へ出さず not_handled を返す（返信もしない）', async () => {
      const h = createHarness({ sessionLookupThrows: true });

      const result = await h.handlers.handleGbpText(text('こんにちは'));

      expect(result).toBe('not_handled');
      // 委譲元（onboarding）が固定案内を返すので、ここでは 1 通も送らない。
      expect(h.replies).toEqual([]);
    });

    it('postback 委譲も例外を外へ出さず not_handled を返す', async () => {
      const h = createHarness({ sessionLookupThrows: true });

      const result = await h.handlers.handleGbpPostback(
        postback(encodeGbpPostback({ action: 'g_status' })),
      );

      expect(result).toBe('not_handled');
      expect(h.replies).toEqual([]);
    });

    it('握った例外は errorName だけを記録する（message は載せない）', async () => {
      const h = createHarness({ sessionLookupThrows: true });

      await h.handlers.handleGbpText(text('こんにちは'));

      expect(h.logger.error).toHaveBeenCalledWith('gbp: handleGbpText failed', {
        ownerId: OWNER,
        errorName: 'Error',
      });
      // pg のエラー文には接続情報が載りうる。message は 1 度も現れてはならない。
      expect(JSON.stringify(h.logger.error.mock.calls)).not.toContain('gbp_sessions');
    });
  });
});
