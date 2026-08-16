import { describe, it, expect } from 'vitest';
import type {
  ConfirmedStoreSummary,
  GbpFlow,
  GbpSessionLookup,
  GbpSessionRow,
  OnboardingSessionRow,
  Queryable,
  Result,
  UpsertGbpSessionInput,
} from '@fwlm/db';
import {
  createConversationHandlers,
  type ConversationDeps,
} from '../../src/onboarding/conversation.js';
import type { InboundEvent } from '../../src/webhook/dispatch.js';
import type { LineMessage, LineMessenger } from '../../src/line/client.js';
import type { ConnectablePool, StoreIdentificationService } from '@fwlm/store-identification';
import { createGbpFlowHandlers, type GbpFlowDeps } from '../../src/gbp/flows.js';
import { decodeGbpPostback, encodeGbpPostback, isGbpPostbackData } from '../../src/gbp/postback.js';
import type { GbpApiError, GbpReview } from '../../src/gbp/client.js';
import type { GenerationError } from '@fwlm/gemini';
import { buildCompletedRichMenu } from '../../scripts/setup-rich-menus.js';
import { buildAlreadyCompletedMessage } from '../../src/line/messages.js';
import {
  buildGbpConnectRequiredMessage,
  buildGbpNoEligibleStoreMessage,
  buildGbpPostInputPromptMessage,
  buildGbpStatusMessage,
} from '../../src/gbp/messages.js';

// gbp-post-review-reply spec task 5.3: 導線からの分岐を統合検証する。
//
// 何を検証するか（既存テストとの差分＝本タスクの価値）:
//   - postback.test.ts は encode/decode 対称性を、flex.test.ts（delivery-job）は
//     サマリー footer の `a=g_reply`/`a=g_post` 出力を、setup-rich-menus.test.ts は
//     完了後リッチメニューの `a=g_post`/`a=g_reply`/`a=g_status` 出力を、それぞれ
//     **単体で** 検証している。conversation-gbp-dispatch.test.ts は conversation.ts の
//     委譲を **モックの GbpFlowHandlers** で、flows-post/reply.test.ts は GbpFlows を
//     **conversation.ts を通さず直接** 検証している。
//   - どのテストも「webhook（conversation.ts・実物）→ isGbpPostbackData 委譲判定 →
//     GbpFlows（実物）→ decodeGbpPostback → isLinked 分岐」の **一気通貫** を、
//     **導線（サマリー Flex・リッチメニュー）が実際に送る data 文字列** で検証していない。
//     本テストがその統合点を埋める（サイレント故障＝導線の data が webhook で無言で
//     onboarding 固定案内に吸われる事故の検出）。
//
// Requirements: 3.9（未連携で投稿開始→誘導）, 4.8（未連携で返信開始→誘導）,
//   5.2（未連携でサマリーアクション→誘導）。
// Design: 「GbpFlows」・「Requirements Traceability」3.9/4.8/5.2・
//   「System Flows > 下書き承認フロー」の未連携注記。

const OWNER = '55555555-5555-5555-5555-555555555553';
const STORE_A = 'ffffffff-0000-0000-0000-000000000051';
const STORE_B = 'ffffffff-0000-0000-0000-000000000052';
const LINE_USER_ID = 'U-entry-branch';
const REPLY_TOKEN = 'reply-token-entry';
const NOW = new Date('2026-07-19T00:00:00.000Z');
const TTL_MS = 30 * 60 * 1000;

// --- 導線が実際に送る postback data 文字列 -----------------------------------------

// サマリー Flex（delivery-job/src/flex.ts）が footer に無条件付与するボタンの data。
// delivery-job は line-webhook を import できないためリテラルをハードコードしており
// （REPLY_POSTBACK_DATA / POST_POSTBACK_DATA）、その値がここと一致することは
// delivery-job 側の flex.test.ts（`/^a=g_(reply|post)$/` と decode 往復）で機械検証済み。
// 本テストはその **リテラルが webhook 側で正しく分岐する** ことを担保する。
const SUMMARY_REPLY_DATA = 'a=g_reply';
const SUMMARY_POST_DATA = 'a=g_post';

// 完了後リッチメニュー（本パッケージ内 scripts/setup-rich-menus.ts）が実際に生成する
// postback 領域の data を抽出する（リテラルではなく実物の出力を駆動する＝サイレント故障に強い）。
const RICH_MENU_DATA: Partial<Record<string, string>> = (() => {
  const menu = buildCompletedRichMenu();
  const map: Record<string, string> = {};
  for (const area of menu.areas) {
    const action = area.action;
    if (action.type === 'postback' && typeof action.data === 'string') {
      const decoded = decodeGbpPostback(action.data);
      if (decoded !== null) map[decoded.action] = action.data;
    }
  }
  return map;
})();

function richMenuData(action: 'g_post' | 'g_reply' | 'g_status'): string {
  const data = RICH_MENU_DATA[action];
  if (data === undefined) {
    throw new Error(`rich menu does not emit a ${action} postback`);
  }
  return data;
}

// --- ハーネス（conversation.ts 実物 ⇄ GbpFlows 実物 の一気通貫配線） ----------------

function confirmedStore(id: string, name: string): ConfirmedStoreSummary {
  return { id, name, placeId: `ChIJ-${id}` };
}

function completedSession(overrides: Partial<OnboardingSessionRow> = {}): OnboardingSessionRow {
  return {
    line_user_id: LINE_USER_ID,
    stage: 'completed',
    owner_id: OWNER,
    candidates: null,
    selected_index: null,
    invite_failures: 0,
    locked_until: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function review(overrides: Partial<GbpReview> = {}): GbpReview {
  return {
    reviewName: 'accounts/1/locations/2/reviews/r1',
    rating: 5,
    authorName: '山田',
    comment: 'とても美味しかったです。',
    createTime: '2026-07-18T10:00:00Z',
    hasReply: false,
    replyComment: null,
    ...overrides,
  };
}

interface HarnessOptions {
  /** onboarding セッションの段階（既定 = completed。委譲ゲートの検証で差し替える）。 */
  onboardingSession?: OnboardingSessionRow;
  stores?: readonly ConfirmedStoreSummary[];
  linkedStoreIds?: readonly string[];
  reviews?: readonly GbpReview[];
}

interface Harness {
  handleEvent(event: InboundEvent): Promise<void>;
  replies: LineMessage[][];
  upsertCalls: UpsertGbpSessionInput[];
  clearCalls: string[];
  listReviewsCalls: { ownerId: string; storeId: string }[];
  postCalls: { ownerId: string; storeId: string }[];
  replyWriteCalls: { ownerId: string; storeId: string; reviewName: string }[];
  onboardingUpdateCalls: number;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const stores = options.stores ?? [confirmedStore(STORE_A, 'テスト食堂A')];
  const linked = new Set(options.linkedStoreIds ?? []);

  const replies: LineMessage[][] = [];
  const upsertCalls: UpsertGbpSessionInput[] = [];
  const clearCalls: string[] = [];
  const listReviewsCalls: { ownerId: string; storeId: string }[] = [];
  const postCalls: { ownerId: string; storeId: string }[] = [];
  const replyWriteCalls: { ownerId: string; storeId: string; reviewName: string }[] = [];
  let onboardingUpdateCalls = 0;

  // GBP セッションは可変実体として保持する（DB と同じく owner 単位に高々 1 つ）。
  // 導線からの新規開始のみを扱うため既定は無セッション。
  let gbpSession: GbpSessionRow | null = null;

  // conversation.ts と GbpFlows で **同一の messenger** を共有し、両者の reply を
  // 単一の replies 配列で観測する（委譲の前後どちらの応答も取りこぼさない）。
  const messenger: LineMessenger = {
    async reply(_token, messages) {
      replies.push([...messages]);
    },
    async push() {},
    async getProfile() {
      return null;
    },
    async linkRichMenu() {},
  };

  const pool: ConnectablePool = {
    // pg の query は多重定義のため、フェイクは戻り値を never へ落として構造的に適合させる
    // （onboarding/conversation.test.ts の createFakePool と同一の規律）。
    connect: async () => ({
      async query() {
        return { rows: [], rowCount: 0 } as never;
      },
      release: () => undefined,
    }),
  };

  const gbpDeps: GbpFlowDeps = {
    db: {} as Queryable,
    pool,
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
      async revokeToken() {},
    },
    tokenStore: {
      async isLinked(_db, key) {
        return linked.has(key.storeId) && stores.some((s) => s.id === key.storeId);
      },
      async getAccessTokenForStore(_db, key) {
        return { ok: true as const, value: `access-token-${key.storeId}` };
      },
      async deleteToken() {
        return true;
      },
    },
    sessions: {
      async getActiveGbpSession(): Promise<GbpSessionLookup> {
        if (gbpSession === null) return { kind: 'none' };
        if (gbpSession.expires_at.getTime() <= NOW.getTime()) {
          return { kind: 'expired', session: gbpSession };
        }
        return { kind: 'active', session: gbpSession };
      },
      async upsertGbpSession(_db, input) {
        upsertCalls.push(input);
        gbpSession = {
          id: 'gbp-session-1',
          owner_id: input.ownerId,
          store_id: input.storeId,
          flow: input.flow,
          stage: input.stage,
          payload: input.payload,
          draft_text: input.draftText,
          expires_at: input.expiresAt,
          updated_at: NOW,
        };
        return { ok: true, value: gbpSession };
      },
      async clearGbpSession(_db, ownerId) {
        clearCalls.push(ownerId);
        const existed = gbpSession !== null;
        gbpSession = null;
        return existed;
      },
      async beginGbpSessionExecution(_db, _ownerId, flow: GbpFlow) {
        if (gbpSession === null || gbpSession.flow !== flow || gbpSession.stage !== 'await_decision') {
          return null;
        }
        gbpSession = { ...gbpSession, stage: 'executing' };
        return gbpSession;
      },
      async completeGbpSessionExecution(_db, _ownerId, flow: GbpFlow) {
        if (gbpSession === null || gbpSession.flow !== flow || gbpSession.stage !== 'executing') {
          return false;
        }
        gbpSession = null;
        return true;
      },
      async revertGbpSessionExecution(_db, _ownerId, flow: GbpFlow, expiresAt) {
        if (gbpSession === null || gbpSession.flow !== flow || gbpSession.stage !== 'executing') {
          return null;
        }
        gbpSession = { ...gbpSession, stage: 'await_decision', expires_at: expiresAt };
        return gbpSession;
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
      async generatePostDraft(): Promise<Result<string, GenerationError>> {
        return { ok: true, value: '投稿の下書き' };
      },
      async generateReplyDraft(): Promise<Result<string, GenerationError>> {
        return { ok: true, value: '返信の下書き' };
      },
    },
    gbpClient: {
      async createLocalPost(_db, input) {
        postCalls.push({ ownerId: input.ownerId, storeId: input.storeId });
        return { ok: true, value: { postName: 'localPosts/1' } };
      },
      async listReviews(_db, input): Promise<Result<GbpReview[], GbpApiError>> {
        listReviewsCalls.push({ ownerId: input.ownerId, storeId: input.storeId });
        return { ok: true, value: [...(options.reviews ?? [review()])] };
      },
      async upsertReviewReply(_db, input) {
        replyWriteCalls.push({
          ownerId: input.ownerId,
          storeId: input.storeId,
          reviewName: input.reviewName,
        });
        return { ok: true, value: undefined };
      },
    },
    messenger,
    now: () => NOW,
  };

  const deps: ConversationDeps = {
    db: {} as Queryable,
    pool,
    sessions: {
      async getOrCreateSession() {
        return options.onboardingSession ?? completedSession();
      },
      async updateSession() {
        // completed 段階からの GBP 委譲では onboarding セッションを更新しない。
        // 呼ばれたら委譲ではなく既存経路に流れた証拠なので記録して検出する。
        onboardingUpdateCalls += 1;
      },
    },
    owners: {
      async findOwnerByLineUserId() {
        return null;
      },
      async createOwner() {
        throw new Error('createOwner must not be called');
      },
    },
    inviteCodes: {
      async findActiveInviteCode() {
        return null;
      },
    },
    identification: {
      async searchCandidates() {
        throw new Error('searchCandidates must not be called');
      },
      async confirmStore() {
        throw new Error('confirmStore must not be called');
      },
    } as unknown as StoreIdentificationService,
    messenger,
    now: () => NOW,
    lineRichMenuCompletedId: 'richmenu-completed',
    liffStoreDetailUrl: 'https://liff.line.me/test',
    gbp: createGbpFlowHandlers(gbpDeps),
  };

  const handlers = createConversationHandlers(deps);

  return {
    handleEvent: (event) => handlers.handleEvent(event),
    replies,
    upsertCalls,
    clearCalls,
    listReviewsCalls,
    postCalls,
    replyWriteCalls,
    get onboardingUpdateCalls() {
      return onboardingUpdateCalls;
    },
  };
}

function postbackEvent(data: string): InboundEvent {
  return { kind: 'postback', lineUserId: LINE_USER_ID, replyToken: REPLY_TOKEN, data };
}

// 全入口の data 文字列（サマリー Flex・リッチメニュー・encode 出力）を 1 箇所に集める。
// encode 出力も含めるのは、導線リテラルと encodeGbpPostback の等価性を跨いで固定するため。
const POST_ENTRIES: readonly { label: string; data: string }[] = [
  { label: 'サマリー(g_post)', data: SUMMARY_POST_DATA },
  { label: 'リッチメニュー(g_post)', data: richMenuData('g_post') },
  { label: 'encode(g_post)', data: encodeGbpPostback({ action: 'g_post' }) },
];
const REPLY_ENTRIES: readonly { label: string; data: string }[] = [
  { label: 'サマリー(g_reply)', data: SUMMARY_REPLY_DATA },
  { label: 'リッチメニュー(g_reply)', data: richMenuData('g_reply') },
  { label: 'encode(g_reply)', data: encodeGbpPostback({ action: 'g_reply' }) },
];

describe('導線からの分岐の統合検証（task 5.3）', () => {
  // 前提の固定: すべての入口 data が「webhook が GBP へ委譲する形式」であること。
  // これが崩れると（例: 導線リテラルの綴り違い）postback が onboarding 側へ無言で吸われる。
  describe('導線 data が webhook の委譲判定・復号を通る（サイレント故障の防止）', () => {
    it('サマリー・リッチメニューの全 data で isGbpPostbackData=true かつ decode が期待 action', () => {
      const cases: { data: string; action: string }[] = [
        { data: SUMMARY_POST_DATA, action: 'g_post' },
        { data: SUMMARY_REPLY_DATA, action: 'g_reply' },
        { data: richMenuData('g_post'), action: 'g_post' },
        { data: richMenuData('g_reply'), action: 'g_reply' },
        { data: richMenuData('g_status'), action: 'g_status' },
      ];
      for (const c of cases) {
        expect(isGbpPostbackData(c.data), c.data).toBe(true);
        expect(decodeGbpPostback(c.data), c.data).toEqual({ action: c.action });
      }
    });

    it('サマリー・リッチメニューのリテラルは encodeGbpPostback の出力と一致する', () => {
      expect(SUMMARY_POST_DATA).toBe(encodeGbpPostback({ action: 'g_post' }));
      expect(SUMMARY_REPLY_DATA).toBe(encodeGbpPostback({ action: 'g_reply' }));
      expect(richMenuData('g_post')).toBe(encodeGbpPostback({ action: 'g_post' }));
      expect(richMenuData('g_reply')).toBe(encodeGbpPostback({ action: 'g_reply' }));
      expect(richMenuData('g_status')).toBe(encodeGbpPostback({ action: 'g_status' }));
    });
  });

  describe('連携済み店舗はフローが開始する（Req 3.1, 4.1）', () => {
    it('g_post → 要点入力受付（await_input）に入り、投稿 API は呼ばない', async () => {
      for (const entry of POST_ENTRIES) {
        const h = createHarness({ linkedStoreIds: [STORE_A] });

        await h.handleEvent(postbackEvent(entry.data));

        expect(h.replies, entry.label).toEqual([
          [buildGbpPostInputPromptMessage('テスト食堂A')],
        ]);
        expect(h.upsertCalls, entry.label).toHaveLength(1);
        expect(h.upsertCalls[0], entry.label).toMatchObject({
          ownerId: OWNER,
          storeId: STORE_A,
          flow: 'post',
          stage: 'await_input',
          expiresAt: new Date(NOW.getTime() + TTL_MS),
        });
        // 承認前は GBP へ書き込まない・onboarding 固定案内へも吸われない。
        expect(h.postCalls, entry.label).toEqual([]);
        expect(h.onboardingUpdateCalls, entry.label).toBe(0);
      }
    });

    it('g_reply → クチコミを取得し候補提示（await_review_pick）に入り、返信 API は呼ばない', async () => {
      for (const entry of REPLY_ENTRIES) {
        const h = createHarness({ linkedStoreIds: [STORE_A] });

        await h.handleEvent(postbackEvent(entry.data));

        expect(h.listReviewsCalls, entry.label).toEqual([{ ownerId: OWNER, storeId: STORE_A }]);
        expect(h.upsertCalls, entry.label).toHaveLength(1);
        expect(h.upsertCalls[0], entry.label).toMatchObject({
          ownerId: OWNER,
          storeId: STORE_A,
          flow: 'reply',
          stage: 'await_review_pick',
        });
        expect(h.replyWriteCalls, entry.label).toEqual([]);
        // 連携誘導・onboarding 固定案内のいずれでもないこと。
        expect(h.replies.flat(), entry.label).not.toContainEqual(
          buildGbpConnectRequiredMessage('テスト食堂A'),
        );
        expect(h.replies.flat(), entry.label).not.toContainEqual(buildAlreadyCompletedMessage());
      }
    });
  });

  describe('未連携店舗の全入口で連携誘導が返る（Req 3.9, 4.8, 5.2）', () => {
    it('g_post の全入口（サマリー・リッチメニュー・encode）で連携誘導・フロー未開始', async () => {
      for (const entry of POST_ENTRIES) {
        const h = createHarness({ linkedStoreIds: [] });

        await h.handleEvent(postbackEvent(entry.data));

        expect(h.replies, entry.label).toEqual([
          [buildGbpConnectRequiredMessage('テスト食堂A')],
        ]);
        // 状態機械に入らない（セッションを作らない・外部 API を叩かない）。
        expect(h.upsertCalls, entry.label).toEqual([]);
        expect(h.listReviewsCalls, entry.label).toEqual([]);
        expect(h.postCalls, entry.label).toEqual([]);
        // onboarding 固定案内へ無言で吸われていないこと（サイレント故障の否定）。
        expect(h.onboardingUpdateCalls, entry.label).toBe(0);
      }
    });

    it('g_reply の全入口（サマリー・リッチメニュー・encode）で連携誘導・クチコミ取得なし', async () => {
      for (const entry of REPLY_ENTRIES) {
        const h = createHarness({ linkedStoreIds: [] });

        await h.handleEvent(postbackEvent(entry.data));

        expect(h.replies, entry.label).toEqual([
          [buildGbpConnectRequiredMessage('テスト食堂A')],
        ]);
        expect(h.upsertCalls, entry.label).toEqual([]);
        // 連携前に外部 API（クチコミ取得）を叩かない（Req 4.8 の設計注記）。
        expect(h.listReviewsCalls, entry.label).toEqual([]);
        expect(h.replyWriteCalls, entry.label).toEqual([]);
      }
    });

    it('サマリーボタン（a=g_post / a=g_reply）そのものが未連携で連携誘導になる（Req 5.2）', async () => {
      for (const data of [SUMMARY_POST_DATA, SUMMARY_REPLY_DATA]) {
        const h = createHarness({ linkedStoreIds: [] });

        await h.handleEvent(postbackEvent(data));

        expect(h.replies, data).toEqual([[buildGbpConnectRequiredMessage('テスト食堂A')]]);
      }
    });
  });

  describe('複数店舗オーナーは店舗選択を挟んでから分岐する（Req 1.3）', () => {
    it('未連携の選択店舗では、店舗選択後に連携誘導になる（g_post・サマリー入口）', async () => {
      const stores = [confirmedStore(STORE_A, 'テスト食堂A'), confirmedStore(STORE_B, 'テスト食堂B')];
      const h = createHarness({ stores, linkedStoreIds: [] });

      // 入口: 複数店舗のため await_store（店舗選択カルーセル）に入る。
      await h.handleEvent(postbackEvent(SUMMARY_POST_DATA));
      expect(h.upsertCalls[0]).toMatchObject({ flow: 'post', stage: 'await_store', storeId: null });

      // 店舗選択（STORE_B・未連携）→ 連携誘導。状態機械には進めない。
      await h.handleEvent(postbackEvent(encodeGbpPostback({ action: 'g_pick_store', index: 1 })));
      expect(h.replies.at(-1)).toEqual([buildGbpConnectRequiredMessage('テスト食堂B')]);
      // await_input への upsert は起きない（連携誘導で止まる）。
      expect(h.upsertCalls.some((c) => c.stage === 'await_input')).toBe(false);
    });

    it('連携済みの選択店舗では、店舗選択後にフローが開始する（g_post・リッチメニュー入口）', async () => {
      const stores = [confirmedStore(STORE_A, 'テスト食堂A'), confirmedStore(STORE_B, 'テスト食堂B')];
      const h = createHarness({ stores, linkedStoreIds: [STORE_B] });

      await h.handleEvent(postbackEvent(richMenuData('g_post')));
      await h.handleEvent(postbackEvent(encodeGbpPostback({ action: 'g_pick_store', index: 1 })));

      expect(h.replies.at(-1)).toEqual([buildGbpPostInputPromptMessage('テスト食堂B')]);
      expect(h.upsertCalls.at(-1)).toMatchObject({
        storeId: STORE_B,
        flow: 'post',
        stage: 'await_input',
      });
    });
  });

  describe('g_status は連携状態を返す（3.3 で実装済みの導線・リッチメニュー右下）', () => {
    it('連携済みなら「連携済み」の状態を返す', async () => {
      const h = createHarness({ linkedStoreIds: [STORE_A] });

      await h.handleEvent(postbackEvent(richMenuData('g_status')));

      expect(h.replies).toEqual([
        [buildGbpStatusMessage([{ storeId: STORE_A, name: 'テスト食堂A', linked: true }])],
      ]);
    });

    it('未連携なら「未連携」の状態を返す', async () => {
      const h = createHarness({ linkedStoreIds: [] });

      await h.handleEvent(postbackEvent(richMenuData('g_status')));

      expect(h.replies).toEqual([
        [buildGbpStatusMessage([{ storeId: STORE_A, name: 'テスト食堂A', linked: false }])],
      ]);
    });
  });

  describe('Place 未確定・委譲ゲートの回帰（既存挙動を変えない）', () => {
    it('Place 確定済み店舗が 0 件なら、どの入口でも状態機械に入らず店舗登録を促す（Req 1.1）', async () => {
      for (const entry of [...POST_ENTRIES, ...REPLY_ENTRIES]) {
        const h = createHarness({ stores: [], linkedStoreIds: [] });

        await h.handleEvent(postbackEvent(entry.data));

        expect(h.replies, entry.label).toEqual([[buildGbpNoEligibleStoreMessage()]]);
        expect(h.upsertCalls, entry.label).toEqual([]);
        expect(h.listReviewsCalls, entry.label).toEqual([]);
      }
    });

    it('completed 以外の段階では導線 postback を GBP へ委譲しない（回帰ゼロ）', async () => {
      // await_store_name のオーナーがサマリー/リッチメニューの g_post を押しても、
      // onboarding のデコーダは `a=g_post` を解さず（null）現在段階の案内へ倒れる。
      const h = createHarness({
        onboardingSession: completedSession({ stage: 'await_store_name' }),
        linkedStoreIds: [STORE_A],
      });

      await h.handleEvent(postbackEvent(SUMMARY_POST_DATA));

      // GBP 側は一切動かない（フロー開始・連携誘導のいずれも起きない）。
      expect(h.upsertCalls).toEqual([]);
      expect(h.listReviewsCalls).toEqual([]);
      expect(h.postCalls).toEqual([]);
      // 連携誘導文面は返らない（＝GBP へ委譲されていない証拠）。
      expect(h.replies.flat()).not.toContainEqual(buildGbpConnectRequiredMessage('テスト食堂A'));
      expect(h.replies).toHaveLength(1);
    });
  });
});
