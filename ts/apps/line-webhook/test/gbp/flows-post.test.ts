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
  buildGbpConnectRequiredMessage,
  buildGbpCancelledMessage,
  buildGbpCurrentStateMessage,
  buildGbpGenerationFailedMessage,
  buildGbpNoEligibleStoreMessage,
  buildGbpPostDraftMessages,
  buildGbpPostFailedMessage,
  buildGbpPostInputPromptMessage,
  buildGbpPostStorePickerMessage,
  buildGbpPostSucceededMessage,
  buildGbpRevisionPromptMessage,
  buildGbpStaleSelectionMessage,
} from '../../src/gbp/messages.js';
import { encodeGbpPostback } from '../../src/gbp/postback.js';
import type { GbpApiError } from '../../src/gbp/client.js';
import type { PostDraftMaterial, RevisionContext } from '../../src/gbp/prompts.js';
import type { GenerationError } from '@fwlm/gemini';
import type { LineMessage } from '../../src/line/client.js';

// gbp-post-review-reply spec task 4.1（Google 投稿作成フロー）のモック deps テスト。
// Requirements: 2.3（失効時は実行せず再連携誘導）, 3.1（要点入力受付）, 3.2（下書き生成と全文提示）,
//   3.3（承認/再生成/修正指示の 3 択）, 3.4（修正反映の再提示）, 3.5（投稿実行と結果通知）,
//   3.6（承認なしに投稿しない）, 3.7（失敗時は下書きを失わせない）, 3.9（未連携は連携誘導）,
//   6.6（生成失敗の案内と再試行）。
// Design: 「GbpFlows」（承認ゲートの構造的保証・State Management の CAS ガード）・
//   「System Flows > 下書き承認フロー」の状態機械図・「Error Handling」。

const OWNER = '22222222-2222-2222-2222-222222222222';
const STORE_A = 'dddddddd-0000-0000-0000-000000000001';
const STORE_B = 'dddddddd-0000-0000-0000-000000000002';
const LINE_USER_ID = 'Uflows-post-owner';
const NOW = new Date('2026-07-19T00:00:00.000Z');
const REPLY_TOKEN = 'reply-token-post';
const TTL_MS = 30 * 60 * 1000;

function confirmedStore(id: string, name: string): ConfirmedStoreSummary {
  return { id, name, placeId: `ChIJ-${id}` };
}

function sessionRow(overrides: Partial<GbpSessionRow> = {}): GbpSessionRow {
  return {
    id: 'session-post-1',
    owner_id: OWNER,
    store_id: STORE_A,
    flow: 'post',
    stage: 'await_decision',
    payload: { material: { ownerInput: '本日から新メニュー' } },
    draft_text: '本日から新メニューを始めました。',
    expires_at: new Date(NOW.getTime() + TTL_MS),
    updated_at: NOW,
    ...overrides,
  };
}

interface GenerateCall {
  material: PostDraftMaterial;
  revision: RevisionContext | undefined;
}

interface HarnessOptions {
  stores?: readonly ConfirmedStoreSummary[];
  linkedStoreIds?: readonly string[];
  /**
   * 初期セッション。**省略時は post/await_decision の下書き提示済みセッション**
   * （承認まわりの検証が主題のため）。無セッションを試すときは明示的に null を渡す。
   * ハーネス内部で可変な実体として保持され、CAS の意味論を DB と同じ条件で再現する。
   */
  session?: GbpSessionRow | null;
  /** generatePostDraft の応答（呼び出し順に消費。尽きたら最後の値を再利用）。 */
  drafts?: readonly Result<string, GenerationError>[];
  /** createLocalPost の応答。 */
  postResult?: Result<{ postName: string }, GbpApiError>;
  /** createLocalPost が例外を投げる経路の再現。 */
  postThrows?: boolean;
  upsertFails?: boolean;
}

interface Harness {
  handlers: GbpFlowHandlers;
  replies: LineMessage[][];
  upsertCalls: UpsertGbpSessionInput[];
  clearCalls: string[];
  generateCalls: GenerateCall[];
  postCalls: { ownerId: string; storeId: string; summary: string }[];
  casCalls: string[];
  completeCalls: string[];
  revertCalls: string[];
  currentSession(): GbpSessionRow | null;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const stores = options.stores ?? [confirmedStore(STORE_A, 'テスト食堂A')];
  const linked = new Set(options.linkedStoreIds ?? [STORE_A]);

  const replies: LineMessage[][] = [];
  const upsertCalls: UpsertGbpSessionInput[] = [];
  const clearCalls: string[] = [];
  const generateCalls: GenerateCall[] = [];
  const postCalls: { ownerId: string; storeId: string; summary: string }[] = [];
  const casCalls: string[] = [];
  const completeCalls: string[] = [];
  const revertCalls: string[] = [];

  // セッションは実体として保持し、CAS の意味論（await_decision のときだけ executing を
  // 獲得できる）を DB と同じ条件で再現する。二重タップの排他はここで検証される。
  let session: GbpSessionRow | null = 'session' in options ? options.session ?? null : sessionRow();
  let draftIndex = 0;

  const deps: GbpFlowDeps = {
    db: {} as Queryable,
    pool: {
      connect: async () => ({
        query: async () => ({ rows: [], rowCount: 0 }),
        release: () => undefined,
      }),
    },
    oauth: {
      async startConnect(_db, key) {
        return {
          ok: true,
          value: {
            authorizeUrl: `https://accounts.google.com/authorize?store=${key.storeId}`,
            state: `${key.ownerId}.nonce`,
          },
        };
      },
      async revokeToken() {
        // 投稿フローでは使用しない。
      },
    },
    tokenStore: {
      async isLinked(_db, key) {
        return linked.has(key.storeId) && stores.some((s) => s.id === key.storeId);
      },
      async getAccessTokenForStore(_db, key) {
        return { ok: true as const, value: `access-token-for-${key.storeId}` };
      },
      async deleteToken() {
        return true;
      },
    },
    sessions: {
      async getActiveGbpSession(): Promise<GbpSessionLookup> {
        if (session === null) return { kind: 'none' };
        if (session.expires_at.getTime() <= NOW.getTime()) return { kind: 'expired', session };
        return { kind: 'active', session };
      },
      async upsertGbpSession(_db, input) {
        upsertCalls.push(input);
        if (options.upsertFails) return { ok: false, error: 'STORE_NOT_OWNED' };
        session = sessionRow({
          store_id: input.storeId,
          flow: input.flow,
          stage: input.stage,
          payload: input.payload,
          draft_text: input.draftText,
          expires_at: input.expiresAt,
        });
        return { ok: true, value: session };
      },
      async clearGbpSession(_db, ownerId) {
        clearCalls.push(ownerId);
        const existed = session !== null;
        session = null;
        return existed;
      },
      // DB の CAS と同じ意味論: owner + flow + stage が一致したときのみ獲得できる
      // （flow 条件は task 4.2 で追加。投稿承認は flow='post' でしか実行権を得られない）。
      async beginGbpSessionExecution(_db, ownerId, flow) {
        casCalls.push(ownerId);
        if (session === null || session.flow !== flow || session.stage !== 'await_decision') {
          return null;
        }
        session = { ...session, stage: 'executing' };
        return session;
      },
      async completeGbpSessionExecution(_db, ownerId, flow) {
        completeCalls.push(ownerId);
        if (session === null || session.flow !== flow || session.stage !== 'executing') return false;
        session = null;
        return true;
      },
      async revertGbpSessionExecution(_db, ownerId, flow, expiresAt) {
        revertCalls.push(ownerId);
        if (session === null || session.flow !== flow || session.stage !== 'executing') return null;
        session = { ...session, stage: 'await_decision', expires_at: expiresAt };
        return session;
      },
    },
    locations: {
      async deleteGbpLocation() {
        return true;
      },
    },
    stores: {
      async listConfirmedStoresByOwner() {
        return stores;
      },
    },
    prompts: {
      async generatePostDraft(material, _seed, revision) {
        generateCalls.push({ material, revision });
        const configured = options.drafts;
        if (configured === undefined || configured.length === 0) {
          return { ok: true, value: '生成された下書き' };
        }
        const value = configured[Math.min(draftIndex, configured.length - 1)];
        draftIndex += 1;
        return value ?? { ok: true, value: '生成された下書き' };
      },
      // 返信下書きは投稿フローからは到達しないが、GbpFlowDeps の契約を満たすため配線する。
      async generateReplyDraft() {
        return { ok: true, value: '返信の下書き' };
      },
    },
    gbpClient: {
      async createLocalPost(_db, input) {
        postCalls.push({
          ownerId: input.ownerId,
          storeId: input.storeId,
          summary: input.summary,
        });
        if (options.postThrows) throw new Error('network down');
        return options.postResult ?? { ok: true, value: { postName: 'localPosts/1' } };
      },
      // 返信系は投稿フローの主題ではない（承認ゲート検証で g_reply を回すため空一覧を返す）。
      async listReviews() {
        return { ok: true, value: [] };
      },
      async upsertReviewReply() {
        return { ok: true, value: undefined };
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
    upsertCalls,
    clearCalls,
    generateCalls,
    postCalls,
    casCalls,
    completeCalls,
    revertCalls,
    currentSession: () => session,
  };
}

function postback(data: string): {
  ownerId: string;
  lineUserId: string;
  replyToken: string;
  data: string;
} {
  return { ownerId: OWNER, lineUserId: LINE_USER_ID, replyToken: REPLY_TOKEN, data };
}

function text(value: string): {
  ownerId: string;
  lineUserId: string;
  replyToken: string;
  text: string;
} {
  return { ownerId: OWNER, lineUserId: LINE_USER_ID, replyToken: REPLY_TOKEN, text: value };
}

const G_POST = encodeGbpPostback({ action: 'g_post' });
const G_APPROVE = encodeGbpPostback({ action: 'g_approve' });
const G_REGEN = encodeGbpPostback({ action: 'g_regen' });
const G_REVISE = encodeGbpPostback({ action: 'g_revise' });
const G_CANCEL = encodeGbpPostback({ action: 'g_cancel' });

describe('createGbpFlowHandlers（投稿フロー・task 4.1）', () => {
  describe('g_post の開始（Req 3.1, 3.9）', () => {
    it('未連携店舗では状態機械に入らず連携誘導を返す（Req 3.9）', async () => {
      const h = createHarness({ linkedStoreIds: [] });

      await h.handlers.handleGbpPostback(postback(G_POST));

      expect(h.upsertCalls).toEqual([]);
      expect(h.generateCalls).toEqual([]);
      expect(h.postCalls).toEqual([]);
      expect(h.replies).toEqual([[buildGbpConnectRequiredMessage('テスト食堂A')]]);
    });

    it('Place 確定済み店舗が 0 件なら投稿フローに入らない（Req 1.1）', async () => {
      const h = createHarness({ stores: [] });

      await h.handlers.handleGbpPostback(postback(G_POST));

      expect(h.upsertCalls).toEqual([]);
      expect(h.replies).toEqual([[buildGbpNoEligibleStoreMessage()]]);
    });

    it('連携済みの単一店舗なら await_input で要点入力を受け付ける（Req 3.1）', async () => {
      const h = createHarness();

      await h.handlers.handleGbpPostback(postback(G_POST));

      expect(h.upsertCalls).toEqual([
        {
          ownerId: OWNER,
          storeId: STORE_A,
          flow: 'post',
          stage: 'await_input',
          payload: {},
          draftText: null,
          expiresAt: new Date(NOW.getTime() + TTL_MS),
        },
      ]);
      expect(h.replies).toEqual([[buildGbpPostInputPromptMessage('テスト食堂A')]]);
    });

    it('複数店舗なら投稿用の店舗選択を挟む（await_store）', async () => {
      const stores = [confirmedStore(STORE_A, 'テスト食堂A'), confirmedStore(STORE_B, 'テスト食堂B')];
      const h = createHarness({ stores, linkedStoreIds: [STORE_A, STORE_B] });

      await h.handlers.handleGbpPostback(postback(G_POST));

      expect(h.upsertCalls[0]).toMatchObject({
        ownerId: OWNER,
        storeId: null,
        flow: 'post',
        stage: 'await_store',
        payload: { storeIds: [STORE_A, STORE_B] },
      });
      expect(h.replies).toEqual([[buildGbpPostStorePickerMessage(stores)]]);
    });

    it('投稿用 await_store からの選択で await_input に進む', async () => {
      const stores = [confirmedStore(STORE_A, 'テスト食堂A'), confirmedStore(STORE_B, 'テスト食堂B')];
      const h = createHarness({
        stores,
        linkedStoreIds: [STORE_A, STORE_B],
        session: sessionRow({
          store_id: null,
          flow: 'post',
          stage: 'await_store',
          payload: { storeIds: [STORE_A, STORE_B] },
          draft_text: null,
        }),
      });

      await h.handlers.handleGbpPostback(
        postback(encodeGbpPostback({ action: 'g_pick_store', index: 1 })),
      );

      expect(h.upsertCalls[0]).toMatchObject({ storeId: STORE_B, flow: 'post', stage: 'await_input' });
      expect(h.replies).toEqual([[buildGbpPostInputPromptMessage('テスト食堂B')]]);
    });

    it('投稿用 await_store で未連携店舗を選んだら連携誘導へ倒す（Req 3.9）', async () => {
      const stores = [confirmedStore(STORE_A, 'テスト食堂A'), confirmedStore(STORE_B, 'テスト食堂B')];
      const h = createHarness({
        stores,
        linkedStoreIds: [STORE_A],
        session: sessionRow({
          store_id: null,
          flow: 'post',
          stage: 'await_store',
          payload: { storeIds: [STORE_A, STORE_B] },
          draft_text: null,
        }),
      });

      await h.handlers.handleGbpPostback(
        postback(encodeGbpPostback({ action: 'g_pick_store', index: 1 })),
      );

      expect(h.upsertCalls).toEqual([]);
      expect(h.replies).toEqual([[buildGbpConnectRequiredMessage('テスト食堂B')]]);
    });

    it('投稿用 await_store の範囲外 index は何も実行せず選び直しを案内する', async () => {
      const h = createHarness({
        session: sessionRow({
          store_id: null,
          flow: 'post',
          stage: 'await_store',
          payload: { storeIds: [STORE_A] },
          draft_text: null,
        }),
      });

      await h.handlers.handleGbpPostback(
        postback(encodeGbpPostback({ action: 'g_pick_store', index: 9 })),
      );

      expect(h.upsertCalls).toEqual([]);
      expect(h.replies).toEqual([[buildGbpStaleSelectionMessage()]]);
    });
  });

  describe('要点入力と下書き生成（Req 3.2, 3.3, 6.6）', () => {
    function awaitInputHarness(options: HarnessOptions = {}): Harness {
      return createHarness({
        ...options,
        session: sessionRow({
          stage: 'await_input',
          payload: {},
          draft_text: null,
        }),
      });
    }

    it('要点テキストを素材として下書きを生成し、全文と 3 択を提示する', async () => {
      const h = awaitInputHarness({ drafts: [{ ok: true, value: '新メニューのお知らせです。' }] });

      const result = await h.handlers.handleGbpText(text('今日から新メニュー始めました'));

      expect(result).toBe('handled');
      expect(h.generateCalls).toEqual([
        {
          material: { storeName: 'テスト食堂A', ownerInput: '今日から新メニュー始めました' },
          revision: undefined,
        },
      ]);
      expect(h.upsertCalls[0]).toMatchObject({
        storeId: STORE_A,
        flow: 'post',
        stage: 'await_decision',
        draftText: '新メニューのお知らせです。',
        payload: { material: { ownerInput: '今日から新メニュー始めました' } },
      });
      expect(h.replies).toEqual([
        buildGbpPostDraftMessages({ storeName: 'テスト食堂A', draft: '新メニューのお知らせです。' }),
      ]);
      // 生成しただけでは投稿しない（Req 3.6）。
      expect(h.postCalls).toEqual([]);
    });

    it('提示メッセージには下書きの全文が含まれる（Req 3.2）', async () => {
      const draft = 'あ'.repeat(800);
      const h = awaitInputHarness({ drafts: [{ ok: true, value: draft }] });

      await h.handlers.handleGbpText(text('要点'));

      expect(JSON.stringify(h.replies)).toContain(draft);
    });

    it('生成失敗なら stage を進めず再試行を案内する（Req 6.6）', async () => {
      const h = awaitInputHarness({ drafts: [{ ok: false, error: { kind: 'API_ERROR' } }] });

      await h.handlers.handleGbpText(text('要点'));

      expect(h.upsertCalls).toEqual([]);
      expect(h.currentSession()?.stage).toBe('await_input');
      expect(h.replies).toEqual([[buildGbpGenerationFailedMessage()]]);
    });

    it('空白のみの入力は生成せず入力を促し直す', async () => {
      const h = awaitInputHarness();

      await h.handlers.handleGbpText(text('   '));

      expect(h.generateCalls).toEqual([]);
      expect(h.replies).toEqual([[buildGbpPostInputPromptMessage('テスト食堂A')]]);
    });

    it('セッションの店舗が対象外になっていたら生成しない', async () => {
      const h = createHarness({
        stores: [confirmedStore(STORE_B, 'テスト食堂B')],
        linkedStoreIds: [STORE_B],
        session: sessionRow({ stage: 'await_input', payload: {}, draft_text: null }),
      });

      await h.handlers.handleGbpText(text('要点'));

      expect(h.generateCalls).toEqual([]);
      expect(h.replies).toEqual([[buildGbpStaleSelectionMessage()]]);
    });
  });

  describe('再生成・修正指示（Req 3.3, 3.4）', () => {
    it('g_regen は素材から再生成し、投稿はしない', async () => {
      const h = createHarness({ drafts: [{ ok: true, value: '再生成された下書き' }] });

      await h.handlers.handleGbpPostback(postback(G_REGEN));

      expect(h.generateCalls).toEqual([
        {
          material: { storeName: 'テスト食堂A', ownerInput: '本日から新メニュー' },
          revision: undefined,
        },
      ]);
      expect(h.upsertCalls[0]).toMatchObject({
        stage: 'await_decision',
        draftText: '再生成された下書き',
      });
      expect(h.postCalls).toEqual([]);
      expect(h.replies).toEqual([
        buildGbpPostDraftMessages({ storeName: 'テスト食堂A', draft: '再生成された下書き' }),
      ]);
    });

    it('g_revise は await_revision へ遷移し、下書きを温存したまま指示を待つ', async () => {
      const h = createHarness();

      await h.handlers.handleGbpPostback(postback(G_REVISE));

      expect(h.upsertCalls[0]).toMatchObject({
        stage: 'await_revision',
        draftText: '本日から新メニューを始めました。',
        payload: { material: { ownerInput: '本日から新メニュー' } },
      });
      expect(h.replies).toEqual([[buildGbpRevisionPromptMessage()]]);
    });

    it('修正指示テキストは前回下書きとともに反映され再提示される（Req 3.4）', async () => {
      const h = createHarness({
        session: sessionRow({ stage: 'await_revision' }),
        drafts: [{ ok: true, value: '修正後の下書き' }],
      });

      const result = await h.handlers.handleGbpText(text('もっと短く'));

      expect(result).toBe('handled');
      expect(h.generateCalls).toEqual([
        {
          material: { storeName: 'テスト食堂A', ownerInput: '本日から新メニュー' },
          revision: {
            instruction: 'もっと短く',
            previousDraft: '本日から新メニューを始めました。',
          },
        },
      ]);
      expect(h.upsertCalls[0]).toMatchObject({
        stage: 'await_decision',
        draftText: '修正後の下書き',
      });
      expect(h.replies).toEqual([
        buildGbpPostDraftMessages({ storeName: 'テスト食堂A', draft: '修正後の下書き' }),
      ]);
      expect(h.postCalls).toEqual([]);
    });

    it('修正指示の生成失敗は await_revision のまま再試行を案内する（Req 6.6）', async () => {
      const h = createHarness({
        session: sessionRow({ stage: 'await_revision' }),
        drafts: [{ ok: false, error: { kind: 'SAFETY_BLOCKED' } }],
      });

      await h.handlers.handleGbpText(text('もっと短く'));

      expect(h.upsertCalls).toEqual([]);
      expect(h.currentSession()?.stage).toBe('await_revision');
      expect(h.replies).toEqual([[buildGbpGenerationFailedMessage()]]);
    });
  });

  describe('承認と実行（Req 3.5, 3.6, 3.7・CAS ガード）', () => {
    it('承認で CAS 獲得 → 投稿 1 回 → セッション削除 → 成功通知（Req 3.5）', async () => {
      const h = createHarness();

      await h.handlers.handleGbpPostback(postback(G_APPROVE));

      expect(h.casCalls).toEqual([OWNER]);
      expect(h.postCalls).toEqual([
        { ownerId: OWNER, storeId: STORE_A, summary: '本日から新メニューを始めました。' },
      ]);
      expect(h.completeCalls).toEqual([OWNER]);
      expect(h.revertCalls).toEqual([]);
      expect(h.currentSession()).toBeNull();
      expect(h.replies).toEqual([[buildGbpPostSucceededMessage('テスト食堂A')]]);
    });

    it('二重タップ（逐次）でも投稿は高々 1 回', async () => {
      const h = createHarness();

      await h.handlers.handleGbpPostback(postback(G_APPROVE));
      await h.handlers.handleGbpPostback(postback(G_APPROVE));

      expect(h.postCalls).toHaveLength(1);
    });

    it('並行リクエストでも投稿は高々 1 回（CAS の排他）', async () => {
      const h = createHarness();

      await Promise.all([
        h.handlers.handleGbpPostback(postback(G_APPROVE)),
        h.handlers.handleGbpPostback(postback(G_APPROVE)),
      ]);

      expect(h.postCalls).toHaveLength(1);
      expect(h.completeCalls).toHaveLength(1);
    });

    it('executing 中の承認は実行せず現在状態を案内する', async () => {
      const h = createHarness({ session: sessionRow({ stage: 'executing' }) });

      await h.handlers.handleGbpPostback(postback(G_APPROVE));

      expect(h.casCalls).toEqual([]);
      expect(h.postCalls).toEqual([]);
      expect(h.replies).toEqual([
        [buildGbpCurrentStateMessage(sessionRow({ stage: 'executing' }))],
      ]);
    });

    it('await_decision 以外からの承認は CAS も投稿も行わない（Req 3.6）', async () => {
      const h = createHarness({ session: sessionRow({ stage: 'await_input', draft_text: null }) });

      await h.handlers.handleGbpPostback(postback(G_APPROVE));

      expect(h.casCalls).toEqual([]);
      expect(h.postCalls).toEqual([]);
    });

    it('セッションが無い状態の承認は投稿しない（Req 3.6）', async () => {
      const h = createHarness({ session: null });

      await h.handlers.handleGbpPostback(postback(G_APPROVE));

      expect(h.casCalls).toEqual([]);
      expect(h.postCalls).toEqual([]);
      expect(h.replies).toEqual([[buildGbpCurrentStateMessage(null)]]);
    });

    it('トークン失効時は下書きを温存して再連携へ誘導する（Req 2.3, 3.7）', async () => {
      const h = createHarness({ postResult: { ok: false, error: { kind: 'token_invalid' } } });

      await h.handlers.handleGbpPostback(postback(G_APPROVE));

      expect(h.revertCalls).toEqual([OWNER]);
      expect(h.completeCalls).toEqual([]);
      expect(h.currentSession()).toMatchObject({
        stage: 'await_decision',
        draft_text: '本日から新メニューを始めました。',
      });
      expect(h.replies).toEqual([[buildGbpPostFailedMessage('reauth')]]);
    });

    it('未連携エラーも再連携誘導へ倒す', async () => {
      const h = createHarness({ postResult: { ok: false, error: { kind: 'not_linked' } } });

      await h.handlers.handleGbpPostback(postback(G_APPROVE));

      expect(h.replies).toEqual([[buildGbpPostFailedMessage('reauth')]]);
    });

    it('crypto_error は再連携を促さず一過性障害として案内する', async () => {
      const h = createHarness({ postResult: { ok: false, error: { kind: 'crypto_error' } } });

      await h.handlers.handleGbpPostback(postback(G_APPROVE));

      expect(h.replies).toEqual([[buildGbpPostFailedMessage('transient')]]);
      expect(JSON.stringify(h.replies)).not.toContain('再連携');
      expect(JSON.stringify(h.replies)).not.toContain(
        encodeGbpPostback({ action: 'g_connect' }),
      );
    });

    it('一過性の API 失敗は下書きを温存し再試行導線を返す（Req 3.7）', async () => {
      const h = createHarness({
        postResult: { ok: false, error: { kind: 'upstream_error', status: 503 } },
      });

      await h.handlers.handleGbpPostback(postback(G_APPROVE));

      expect(h.revertCalls).toEqual([OWNER]);
      expect(h.currentSession()?.draft_text).toBe('本日から新メニューを始めました。');
      expect(h.replies).toEqual([[buildGbpPostFailedMessage('transient')]]);
      // 再試行導線（g_approve）を含む。
      expect(JSON.stringify(h.replies)).toContain(G_APPROVE);
    });

    it('権限不足は専用の案内へ倒す', async () => {
      const h = createHarness({ postResult: { ok: false, error: { kind: 'permission_denied' } } });

      await h.handlers.handleGbpPostback(postback(G_APPROVE));

      expect(h.replies).toEqual([[buildGbpPostFailedMessage('permission')]]);
    });

    it('投稿実行が例外を投げても executing に取り残さない（下書き温存）', async () => {
      const h = createHarness({ postThrows: true });

      await h.handlers.handleGbpPostback(postback(G_APPROVE));

      expect(h.revertCalls).toEqual([OWNER]);
      expect(h.currentSession()?.stage).toBe('await_decision');
      expect(h.replies).toEqual([[buildGbpPostFailedMessage('transient')]]);
    });

    it('失敗後に再承認すると再び投稿を試行できる（再試行導線の実効性）', async () => {
      const h = createHarness({
        postResult: { ok: false, error: { kind: 'upstream_error', status: 500 } },
      });

      await h.handlers.handleGbpPostback(postback(G_APPROVE));
      await h.handlers.handleGbpPostback(postback(G_APPROVE));

      expect(h.postCalls).toHaveLength(2);
    });
  });

  describe('承認ゲートの構造的保証（Req 3.6）', () => {
    it('g_approve 以外のすべての経路で createLocalPost が呼ばれない', async () => {
      const actions = [
        G_POST,
        G_REGEN,
        G_REVISE,
        G_CANCEL,
        encodeGbpPostback({ action: 'g_connect' }),
        encodeGbpPostback({ action: 'g_status' }),
        encodeGbpPostback({ action: 'g_reply' }),
        encodeGbpPostback({ action: 'g_pick_review', index: 0 }),
        encodeGbpPostback({ action: 'g_pick_store', index: 0 }),
        encodeGbpPostback({ action: 'g_overwrite' }),
        'a=g_unknown',
        'not-a-postback',
      ];

      for (const stage of ['await_input', 'await_decision', 'await_revision'] as const) {
        for (const data of actions) {
          const h = createHarness({ session: sessionRow({ stage }) });
          await h.handlers.handleGbpPostback(postback(data));
          expect(h.postCalls, `${stage} / ${data}`).toEqual([]);
        }
        const textHarness = createHarness({ session: sessionRow({ stage }) });
        await textHarness.handlers.handleGbpText(text('任意のテキスト'));
        expect(textHarness.postCalls, `${stage} / text`).toEqual([]);
      }
    });
  });

  describe('キャンセルと想定外入力', () => {
    it('g_cancel は下書きごとセッションを破棄する', async () => {
      const h = createHarness();

      await h.handlers.handleGbpPostback(postback(G_CANCEL));

      expect(h.clearCalls).toEqual([OWNER]);
      expect(h.currentSession()).toBeNull();
      expect(h.replies).toEqual([[buildGbpCancelledMessage()]]);
    });

    it('await_decision でのテキストは生成せず現在状態を案内する', async () => {
      const h = createHarness();

      const result = await h.handlers.handleGbpText(text('よろしく'));

      expect(result).toBe('handled');
      expect(h.generateCalls).toEqual([]);
      expect(h.replies).toEqual([[buildGbpCurrentStateMessage(sessionRow())]]);
    });
  });
});
