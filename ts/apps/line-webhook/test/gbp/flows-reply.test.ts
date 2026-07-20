import { describe, it, expect } from 'vitest';
import type {
  ConfirmedStoreSummary,
  GbpFlow,
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
  buildGbpNoReviewsMessage,
  buildGbpOverwriteConfirmMessages,
  buildGbpReplyDraftMessages,
  buildGbpReplyFailedMessage,
  buildGbpReplyStorePickerMessage,
  buildGbpReplySucceededMessage,
  buildGbpReviewListFailedMessage,
  buildGbpReviewPickerMessage,
  buildGbpStaleSelectionMessage,
  MAX_REVIEW_CANDIDATES,
  type GbpReviewSummary,
} from '../../src/gbp/messages.js';
import { encodeGbpPostback } from '../../src/gbp/postback.js';
import type { GbpApiError, GbpReview, ListReviewsInput } from '../../src/gbp/client.js';
import type { ReplyDraftMaterial, RevisionContext } from '../../src/gbp/prompts.js';
import type { GenerationError } from '@fwlm/gemini';
import type { LineMessage } from '../../src/line/client.js';

// gbp-post-review-reply spec task 4.2（クチコミ返信フロー・機能1-b）のモック deps テスト。
// Requirements: 4.1（返信対象の提示・新着/未返信優先・最大 5 件）, 4.2（下書き生成と全文提示）,
//   4.3（承認/再生成/修正指示の 3 択）, 4.4（返信の実行と結果通知）, 4.5（承認なしに返信しない）,
//   4.6（既返信は上書き確認を挟む）, 4.7（失敗時は下書きを失わせない）, 4.8（未連携は連携誘導）,
//   4.9（星評価で選別しない）, 5.3（新着クチコミを候補に含める）。
// Design: 「GbpFlows」（承認ゲートの構造的保証・State Management の CAS ガード）・
//   「System Flows > 下書き承認フロー」の状態機械図（await_review_pick / await_overwrite_ok）。

const OWNER = '33333333-3333-3333-3333-333333333333';
const STORE_A = 'eeeeeeee-0000-0000-0000-000000000001';
const STORE_B = 'eeeeeeee-0000-0000-0000-000000000002';
const LINE_USER_ID = 'Uflows-reply-owner';
const NOW = new Date('2026-07-19T00:00:00.000Z');
const REPLY_TOKEN = 'reply-token-reply';
const TTL_MS = 30 * 60 * 1000;

function confirmedStore(id: string, name: string): ConfirmedStoreSummary {
  return { id, name, placeId: `ChIJ-${id}` };
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

const PICKED_REVIEW: GbpReviewSummary = review();

function replySession(overrides: Partial<GbpSessionRow> = {}): GbpSessionRow {
  return {
    id: 'session-reply-1',
    owner_id: OWNER,
    store_id: STORE_A,
    flow: 'reply',
    stage: 'await_decision',
    payload: { review: PICKED_REVIEW },
    draft_text: 'ご来店ありがとうございました。',
    expires_at: new Date(NOW.getTime() + TTL_MS),
    updated_at: NOW,
    ...overrides,
  };
}

interface GenerateCall {
  material: ReplyDraftMaterial;
  revision: RevisionContext | undefined;
}

interface CasCall {
  ownerId: string;
  flow: GbpFlow;
}

interface HarnessOptions {
  stores?: readonly ConfirmedStoreSummary[];
  linkedStoreIds?: readonly string[];
  /** 省略時は reply/await_decision（下書き提示済み）のセッション。 */
  session?: GbpSessionRow | null;
  reviews?: readonly GbpReview[];
  listReviewsResult?: Result<GbpReview[], GbpApiError>;
  drafts?: readonly Result<string, GenerationError>[];
  replyResult?: Result<void, GbpApiError>;
  replyThrows?: boolean;
  postResult?: Result<{ postName: string }, GbpApiError>;
  upsertFails?: boolean;
  /** CAS 獲得の直前にセッションを差し替える（TOCTOU の再現）。 */
  mutateBeforeCas?: (current: GbpSessionRow | null) => GbpSessionRow | null;
}

interface Harness {
  handlers: GbpFlowHandlers;
  replies: LineMessage[][];
  upsertCalls: UpsertGbpSessionInput[];
  clearCalls: string[];
  generateCalls: GenerateCall[];
  listReviewsCalls: ListReviewsInput[];
  replyCalls: { ownerId: string; storeId: string; reviewName: string; comment: string }[];
  postCalls: { ownerId: string; storeId: string; summary: string }[];
  casCalls: CasCall[];
  completeCalls: CasCall[];
  revertCalls: CasCall[];
  currentSession(): GbpSessionRow | null;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const stores = options.stores ?? [confirmedStore(STORE_A, 'テスト食堂A')];
  const linked = new Set(options.linkedStoreIds ?? [STORE_A]);

  const replies: LineMessage[][] = [];
  const upsertCalls: UpsertGbpSessionInput[] = [];
  const clearCalls: string[] = [];
  const generateCalls: GenerateCall[] = [];
  const listReviewsCalls: ListReviewsInput[] = [];
  const replyCalls: {
    ownerId: string;
    storeId: string;
    reviewName: string;
    comment: string;
  }[] = [];
  const postCalls: { ownerId: string; storeId: string; summary: string }[] = [];
  const casCalls: CasCall[] = [];
  const completeCalls: CasCall[] = [];
  const revertCalls: CasCall[] = [];

  let session: GbpSessionRow | null =
    'session' in options ? options.session ?? null : replySession();
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
        // 返信フローでは使用しない。
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
        session = replySession({
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
      // DB の CAS と同じ意味論: owner + flow + stage が一致したときのみ獲得できる。
      async beginGbpSessionExecution(_db, ownerId, flow) {
        if (options.mutateBeforeCas !== undefined) {
          session = options.mutateBeforeCas(session);
        }
        casCalls.push({ ownerId, flow });
        if (session === null || session.flow !== flow || session.stage !== 'await_decision') {
          return null;
        }
        session = { ...session, stage: 'executing' };
        return session;
      },
      async completeGbpSessionExecution(_db, ownerId, flow) {
        completeCalls.push({ ownerId, flow });
        if (session === null || session.flow !== flow || session.stage !== 'executing') {
          return false;
        }
        session = null;
        return true;
      },
      async revertGbpSessionExecution(_db, ownerId, flow, expiresAt) {
        revertCalls.push({ ownerId, flow });
        if (session === null || session.flow !== flow || session.stage !== 'executing') {
          return null;
        }
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
      async generatePostDraft() {
        return { ok: true, value: '投稿の下書き' };
      },
      async generateReplyDraft(material, _seed, revision) {
        generateCalls.push({ material, revision });
        const configured = options.drafts;
        if (configured === undefined || configured.length === 0) {
          return { ok: true, value: '生成された返信の下書き' };
        }
        const value = configured[Math.min(draftIndex, configured.length - 1)];
        draftIndex += 1;
        return value ?? { ok: true, value: '生成された返信の下書き' };
      },
    },
    gbpClient: {
      async createLocalPost(_db, input) {
        postCalls.push({
          ownerId: input.ownerId,
          storeId: input.storeId,
          summary: input.summary,
        });
        return options.postResult ?? { ok: true, value: { postName: 'localPosts/1' } };
      },
      async listReviews(_db, input) {
        listReviewsCalls.push(input);
        if (options.listReviewsResult !== undefined) return options.listReviewsResult;
        return { ok: true, value: [...(options.reviews ?? [review()])] };
      },
      async upsertReviewReply(_db, input) {
        replyCalls.push({
          ownerId: input.ownerId,
          storeId: input.storeId,
          reviewName: input.reviewName,
          comment: input.comment,
        });
        if (options.replyThrows) throw new Error('network down');
        return options.replyResult ?? { ok: true, value: undefined };
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
    listReviewsCalls,
    replyCalls,
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

const G_REPLY = encodeGbpPostback({ action: 'g_reply' });
const G_OVERWRITE = encodeGbpPostback({ action: 'g_overwrite' });
const G_APPROVE = encodeGbpPostback({ action: 'g_approve' });
const G_REGEN = encodeGbpPostback({ action: 'g_regen' });
const G_REVISE = encodeGbpPostback({ action: 'g_revise' });
const G_CANCEL = encodeGbpPostback({ action: 'g_cancel' });
const pickReview = (index: number): string =>
  encodeGbpPostback({ action: 'g_pick_review', index });

describe('createGbpFlowHandlers（クチコミ返信フロー・task 4.2）', () => {
  describe('g_reply の開始（Req 4.1, 4.8）', () => {
    it('未連携店舗ではクチコミを取得せず連携誘導を返す（Req 4.8）', async () => {
      const h = createHarness({ linkedStoreIds: [], session: null });

      await h.handlers.handleGbpPostback(postback(G_REPLY));

      expect(h.listReviewsCalls).toEqual([]);
      expect(h.upsertCalls).toEqual([]);
      expect(h.replies).toEqual([[buildGbpConnectRequiredMessage('テスト食堂A')]]);
    });

    it('Place 確定済み店舗が 0 件なら返信フローに入らない（Req 1.1）', async () => {
      const h = createHarness({ stores: [], session: null });

      await h.handlers.handleGbpPostback(postback(G_REPLY));

      expect(h.listReviewsCalls).toEqual([]);
      expect(h.replies).toEqual([[buildGbpNoEligibleStoreMessage()]]);
    });

    it('連携済み単一店舗ならクチコミを取得し await_review_pick で候補を提示する', async () => {
      const reviews = [review({ reviewName: 'accounts/1/locations/2/reviews/r1' })];
      const h = createHarness({ reviews, session: null });

      await h.handlers.handleGbpPostback(postback(G_REPLY));

      expect(h.listReviewsCalls).toHaveLength(1);
      expect(h.listReviewsCalls[0]).toMatchObject({ ownerId: OWNER, storeId: STORE_A });
      expect(h.upsertCalls).toHaveLength(1);
      expect(h.upsertCalls[0]).toMatchObject({
        ownerId: OWNER,
        storeId: STORE_A,
        flow: 'reply',
        stage: 'await_review_pick',
        draftText: null,
        expiresAt: new Date(NOW.getTime() + TTL_MS),
      });
      expect(h.replies).toEqual([
        [buildGbpReviewPickerMessage({ storeName: 'テスト食堂A', reviews })],
      ]);
    });

    it('クチコミが 0 件なら候補提示に進まない', async () => {
      const h = createHarness({ reviews: [], session: null });

      await h.handlers.handleGbpPostback(postback(G_REPLY));

      expect(h.upsertCalls).toEqual([]);
      expect(h.replies).toEqual([[buildGbpNoReviewsMessage('テスト食堂A')]]);
    });

    it('クチコミ取得に失敗したらセッションを作らず案内のみ返す', async () => {
      const h = createHarness({
        listReviewsResult: { ok: false, error: { kind: 'upstream_error', status: 500 } },
        session: null,
      });

      await h.handlers.handleGbpPostback(postback(G_REPLY));

      expect(h.upsertCalls).toEqual([]);
      expect(h.replies).toEqual([[buildGbpReviewListFailedMessage('transient')]]);
    });

    it('復号不能（crypto_error）でも再連携を促さず一過性障害として扱う', async () => {
      const h = createHarness({
        listReviewsResult: { ok: false, error: { kind: 'crypto_error' } },
        session: null,
      });

      await h.handlers.handleGbpPostback(postback(G_REPLY));

      expect(h.replies).toEqual([[buildGbpReviewListFailedMessage('transient')]]);
    });

    it('複数店舗なら返信用の店舗選択を挟み、選択後にクチコミを提示する', async () => {
      const stores = [
        confirmedStore(STORE_A, 'テスト食堂A'),
        confirmedStore(STORE_B, 'テスト食堂B'),
      ];
      const h = createHarness({
        stores,
        linkedStoreIds: [STORE_A, STORE_B],
        session: null,
      });

      await h.handlers.handleGbpPostback(postback(G_REPLY));

      expect(h.upsertCalls[0]).toMatchObject({
        ownerId: OWNER,
        storeId: null,
        flow: 'reply',
        stage: 'await_store',
        payload: { storeIds: [STORE_A, STORE_B] },
      });
      expect(h.replies).toEqual([[buildGbpReplyStorePickerMessage(stores)]]);

      await h.handlers.handleGbpPostback(
        postback(encodeGbpPostback({ action: 'g_pick_store', index: 1 })),
      );

      expect(h.listReviewsCalls[0]).toMatchObject({ storeId: STORE_B });
      expect(h.upsertCalls[1]).toMatchObject({
        storeId: STORE_B,
        flow: 'reply',
        stage: 'await_review_pick',
      });
    });
  });

  describe('候補の並び順（Req 4.1, 4.9, 5.3）', () => {
    const older = review({
      reviewName: 'r-old',
      createTime: '2026-07-01T00:00:00Z',
      rating: 5,
      hasReply: false,
    });
    const newest = review({
      reviewName: 'r-new',
      createTime: '2026-07-18T00:00:00Z',
      rating: 1,
      comment: '味が薄い',
      hasReply: false,
    });
    const repliedNewest = review({
      reviewName: 'r-replied',
      createTime: '2026-07-19T00:00:00Z',
      rating: 5,
      hasReply: true,
      replyComment: 'ありがとうございます',
    });

    it('未返信を優先し、その中では新着順に並べる（星評価は順序に影響しない）', async () => {
      const h = createHarness({
        reviews: [older, repliedNewest, newest],
        session: null,
      });

      await h.handlers.handleGbpPostback(postback(G_REPLY));

      const payload = h.upsertCalls[0]?.payload as { reviews: GbpReviewSummary[] };
      expect(payload.reviews.map((r) => r.reviewName)).toEqual([
        'r-new',
        'r-old',
        'r-replied',
      ]);
    });

    it('低評価のクチコミを除外しない（Req 4.9・レビューゲーティング禁止）', async () => {
      const lowRatings = [1, 2, 3, 4, 5].map((rating, i) =>
        review({
          reviewName: `r-${rating}`,
          rating,
          createTime: `2026-07-1${i}T00:00:00Z`,
          hasReply: false,
        }),
      );
      const h = createHarness({ reviews: lowRatings, session: null });

      await h.handlers.handleGbpPostback(postback(G_REPLY));

      const payload = h.upsertCalls[0]?.payload as { reviews: GbpReviewSummary[] };
      expect(payload.reviews.map((r) => r.rating).sort()).toEqual([1, 2, 3, 4, 5]);
    });

    it('提示は最大 5 件に丸める（Req 4.1）', async () => {
      const many = Array.from({ length: 12 }, (_, i) =>
        review({ reviewName: `r-${i}`, createTime: `2026-07-${String(i + 1).padStart(2, '0')}T00:00:00Z` }),
      );
      const h = createHarness({ reviews: many, session: null });

      await h.handlers.handleGbpPostback(postback(G_REPLY));

      const payload = h.upsertCalls[0]?.payload as { reviews: GbpReviewSummary[] };
      expect(payload.reviews).toHaveLength(MAX_REVIEW_CANDIDATES);
      // 新着順の上位 5 件（r-11 が最新）。
      expect(payload.reviews[0]?.reviewName).toBe('r-11');
    });
  });

  describe('g_pick_review（Req 4.2, 4.6）', () => {
    const snapshot: GbpReviewSummary[] = [
      review({ reviewName: 'r-unreplied', rating: 2, comment: '待ち時間が長い', hasReply: false }),
      review({
        reviewName: 'r-replied',
        rating: 5,
        comment: '最高',
        hasReply: true,
        replyComment: '既存の返信本文です。',
      }),
    ];

    function pickHarness(options: HarnessOptions = {}): Harness {
      return createHarness({
        session: replySession({
          stage: 'await_review_pick',
          payload: { reviews: snapshot },
          draft_text: null,
        }),
        ...options,
      });
    }

    it('未返信のクチコミを選ぶと下書きを生成して await_decision へ進む', async () => {
      const h = pickHarness();

      await h.handlers.handleGbpPostback(postback(pickReview(0)));

      expect(h.generateCalls).toHaveLength(1);
      expect(h.generateCalls[0]?.material).toEqual({
        storeName: 'テスト食堂A',
        rating: 2,
        reviewComment: '待ち時間が長い',
        authorName: '山田',
      });
      expect(h.upsertCalls[0]).toMatchObject({
        storeId: STORE_A,
        flow: 'reply',
        stage: 'await_decision',
        draftText: '生成された返信の下書き',
      });
      expect(h.replies).toEqual([
        buildGbpReplyDraftMessages({
          storeName: 'テスト食堂A',
          draft: '生成された返信の下書き',
        }),
      ]);
      expect(h.replyCalls).toEqual([]);
    });

    it('既に返信があるクチコミは上書き確認を挟み、下書きを生成しない（Req 4.6）', async () => {
      const h = pickHarness();

      await h.handlers.handleGbpPostback(postback(pickReview(1)));

      expect(h.generateCalls).toEqual([]);
      expect(h.upsertCalls[0]).toMatchObject({
        flow: 'reply',
        stage: 'await_overwrite_ok',
      });
      const picked = snapshot[1] as GbpReviewSummary;
      expect(h.replies).toEqual([
        buildGbpOverwriteConfirmMessages({ storeName: 'テスト食堂A', review: picked }),
      ]);
    });

    it('上書き確認後（g_overwrite）に下書きを生成する', async () => {
      const picked = snapshot[1] as GbpReviewSummary;
      const h = createHarness({
        session: replySession({
          stage: 'await_overwrite_ok',
          payload: { review: picked },
          draft_text: null,
        }),
      });

      await h.handlers.handleGbpPostback(postback(G_OVERWRITE));

      expect(h.generateCalls[0]?.material).toMatchObject({ rating: 5, reviewComment: '最高' });
      expect(h.upsertCalls[0]).toMatchObject({ flow: 'reply', stage: 'await_decision' });
      expect(h.replyCalls).toEqual([]);
    });

    it('await_review_pick 以外での g_pick_review は何も実行しない（stale postback）', async () => {
      const h = createHarness();

      await h.handlers.handleGbpPostback(postback(pickReview(0)));

      expect(h.generateCalls).toEqual([]);
      expect(h.upsertCalls).toEqual([]);
      expect(h.replies).toEqual([[buildGbpCurrentStateMessage(replySession())]]);
    });

    it('スナップショットに無い index は何も実行せず選び直しを案内する', async () => {
      const h = pickHarness();

      await h.handlers.handleGbpPostback(postback(pickReview(9)));

      expect(h.generateCalls).toEqual([]);
      expect(h.replies).toEqual([[buildGbpStaleSelectionMessage()]]);
    });

    it('範囲外の rating は呼び出し側で 0（評価不明）へ正規化して渡す', async () => {
      const h = createHarness({
        session: replySession({
          stage: 'await_review_pick',
          payload: { reviews: [review({ rating: 7 })] },
          draft_text: null,
        }),
      });

      await h.handlers.handleGbpPostback(postback(pickReview(0)));

      expect(h.generateCalls[0]?.material.rating).toBe(0);
    });

    it('非整数・非有限の rating も 0（評価不明）へ倒す（2.4 申し送りの呼出側ガード）', async () => {
      for (const bad of [4.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const h = createHarness({
          session: replySession({
            stage: 'await_review_pick',
            payload: { reviews: [review({ rating: bad })] },
            draft_text: null,
          }),
        });

        await h.handlers.handleGbpPostback(postback(pickReview(0)));

        expect(h.generateCalls[0]?.material.rating, `rating=${bad}`).toBe(0);
      }
    });

    it('生成に失敗したら stage を進めず案内のみ返す（Req 6.6）', async () => {
      const h = pickHarness({ drafts: [{ ok: false, error: { kind: 'API_ERROR' } }] });

      await h.handlers.handleGbpPostback(postback(pickReview(0)));

      expect(h.upsertCalls).toEqual([]);
      expect(h.replies).toEqual([[buildGbpGenerationFailedMessage()]]);
    });
  });

  describe('再生成・修正指示（Req 4.3）', () => {
    it('g_regen は同じクチコミ素材で再生成し、返信は実行しない', async () => {
      const h = createHarness();

      await h.handlers.handleGbpPostback(postback(G_REGEN));

      expect(h.generateCalls).toHaveLength(1);
      expect(h.generateCalls[0]?.revision).toBeUndefined();
      expect(h.replyCalls).toEqual([]);
      expect(h.upsertCalls[0]).toMatchObject({ flow: 'reply', stage: 'await_decision' });
    });

    it('g_revise → テキストで修正指示を受け、前回下書きとともに反映する', async () => {
      const h = createHarness();

      await h.handlers.handleGbpPostback(postback(G_REVISE));
      expect(h.upsertCalls[0]).toMatchObject({
        flow: 'reply',
        stage: 'await_revision',
        draftText: 'ご来店ありがとうございました。',
      });

      const result = await h.handlers.handleGbpText(text('もっと丁寧に'));

      expect(result).toBe('handled');
      expect(h.generateCalls[0]?.revision).toEqual({
        instruction: 'もっと丁寧に',
        previousDraft: 'ご来店ありがとうございました。',
      });
      expect(h.replyCalls).toEqual([]);
    });
  });

  describe('承認と実行（Req 4.4, 4.5, 4.7）', () => {
    it('g_approve で CAS を reply フローで獲得し、返信を 1 回だけ実行する', async () => {
      const h = createHarness();

      await h.handlers.handleGbpPostback(postback(G_APPROVE));

      expect(h.casCalls).toEqual([{ ownerId: OWNER, flow: 'reply' }]);
      expect(h.replyCalls).toEqual([
        {
          ownerId: OWNER,
          storeId: STORE_A,
          reviewName: PICKED_REVIEW.reviewName,
          comment: 'ご来店ありがとうございました。',
        },
      ]);
      expect(h.completeCalls).toEqual([{ ownerId: OWNER, flow: 'reply' }]);
      expect(h.currentSession()).toBeNull();
      expect(h.replies).toEqual([[buildGbpReplySucceededMessage('テスト食堂A')]]);
    });

    it('二重タップでも返信は高々 1 回（CAS 排他）', async () => {
      const h = createHarness();

      await Promise.all([
        h.handlers.handleGbpPostback(postback(G_APPROVE)),
        h.handlers.handleGbpPostback(postback(G_APPROVE)),
      ]);

      expect(h.replyCalls).toHaveLength(1);
    });

    it('実行失敗時は下書きを温存して await_decision へ戻す（Req 4.7）', async () => {
      const h = createHarness({
        replyResult: { ok: false, error: { kind: 'rate_limited' } },
      });

      await h.handlers.handleGbpPostback(postback(G_APPROVE));

      expect(h.revertCalls).toEqual([{ ownerId: OWNER, flow: 'reply' }]);
      expect(h.currentSession()?.stage).toBe('await_decision');
      expect(h.currentSession()?.draft_text).toBe('ご来店ありがとうございました。');
      expect(h.replies).toEqual([[buildGbpReplyFailedMessage('transient')]]);
    });

    it('失敗後に再承認すると再試行できる', async () => {
      const h = createHarness({
        replyResult: { ok: false, error: { kind: 'upstream_error', status: 500 } },
      });

      await h.handlers.handleGbpPostback(postback(G_APPROVE));
      await h.handlers.handleGbpPostback(postback(G_APPROVE));

      expect(h.replyCalls).toHaveLength(2);
    });

    it('クライアントが例外を投げても一過性障害として扱い executing に取り残さない', async () => {
      const h = createHarness({ replyThrows: true });

      await h.handlers.handleGbpPostback(postback(G_APPROVE));

      expect(h.revertCalls).toEqual([{ ownerId: OWNER, flow: 'reply' }]);
      expect(h.replies).toEqual([[buildGbpReplyFailedMessage('transient')]]);
    });

    it('失効（token_invalid）は再連携導線へ倒す', async () => {
      const h = createHarness({ replyResult: { ok: false, error: { kind: 'token_invalid' } } });

      await h.handlers.handleGbpPostback(postback(G_APPROVE));

      expect(h.replies).toEqual([[buildGbpReplyFailedMessage('reauth')]]);
    });
  });

  describe('承認ゲートの構造的保証（Req 4.5）', () => {
    it('g_approve 以外のすべての経路で upsertReviewReply が呼ばれない', async () => {
      const actions = [
        G_REPLY,
        G_OVERWRITE,
        G_REGEN,
        G_REVISE,
        G_CANCEL,
        pickReview(0),
        encodeGbpPostback({ action: 'g_connect' }),
        encodeGbpPostback({ action: 'g_status' }),
        encodeGbpPostback({ action: 'g_post' }),
        encodeGbpPostback({ action: 'g_pick_store', index: 0 }),
        'a=g_unknown',
        'not-a-postback',
      ];

      for (const stage of [
        'await_review_pick',
        'await_overwrite_ok',
        'await_decision',
        'await_revision',
      ] as const) {
        for (const data of actions) {
          const h = createHarness({
            session: replySession({ stage, payload: { review: PICKED_REVIEW, reviews: [PICKED_REVIEW] } }),
          });
          await h.handlers.handleGbpPostback(postback(data));
          expect(h.replyCalls, `${stage} / ${data}`).toEqual([]);
        }
        const textHarness = createHarness({
          session: replySession({ stage, payload: { review: PICKED_REVIEW } }),
        });
        await textHarness.handlers.handleGbpText(text('任意のテキスト'));
        expect(textHarness.replyCalls, `${stage} / text`).toEqual([]);
      }
    });
  });

  describe('フロー間の混線防止（TOCTOU・CAS の flow 条件）', () => {
    it('投稿セッションの承認は reply の CAS を打たず、返信下書きを投稿しない', async () => {
      // 投稿フロー（post/await_decision）に対する g_approve。
      const h = createHarness({
        session: replySession({ flow: 'post', payload: { material: { ownerInput: '要点' } } }),
      });

      await h.handlers.handleGbpPostback(postback(G_APPROVE));

      expect(h.casCalls).toEqual([{ ownerId: OWNER, flow: 'post' }]);
      expect(h.replyCalls).toEqual([]);
      expect(h.postCalls).toHaveLength(1);
    });

    it('loadSession 後に返信セッションへ差し替わっても、投稿経路は返信下書きを投稿しない', async () => {
      // TOCTOU: loadSession は post/await_decision を観測 → CAS 直前に reply へ置換。
      // CAS が flow 条件を持たないと、返信下書きが createLocalPost で投稿されてしまう。
      const h = createHarness({
        session: replySession({ flow: 'post', payload: { material: { ownerInput: '要点' } } }),
        mutateBeforeCas: () =>
          replySession({ flow: 'reply', draft_text: '返信の下書き（投稿してはならない）' }),
      });

      await h.handlers.handleGbpPostback(postback(G_APPROVE));

      expect(h.casCalls).toEqual([{ ownerId: OWNER, flow: 'post' }]);
      expect(h.postCalls).toEqual([]);
      expect(h.replyCalls).toEqual([]);
    });

    it('loadSession 後に投稿セッションへ差し替わっても、返信経路は投稿下書きを返信しない', async () => {
      const h = createHarness({
        mutateBeforeCas: () =>
          replySession({
            flow: 'post',
            draft_text: '投稿の下書き（返信してはならない）',
            payload: { material: { ownerInput: '要点' } },
          }),
      });

      await h.handlers.handleGbpPostback(postback(G_APPROVE));

      expect(h.casCalls).toEqual([{ ownerId: OWNER, flow: 'reply' }]);
      expect(h.replyCalls).toEqual([]);
      expect(h.postCalls).toEqual([]);
    });
  });

  describe('状態案内の flow 分岐', () => {
    it('返信フローの await_decision では返信向けの案内を返す（投稿向けと同一文面にしない）', async () => {
      const replyState = buildGbpCurrentStateMessage(replySession());
      const postState = buildGbpCurrentStateMessage(
        replySession({ flow: 'post', payload: { material: { ownerInput: '要点' } } }),
      );

      expect(JSON.stringify(replyState)).toContain('返信');
      expect(replyState).not.toEqual(postState);
    });

    it('await_review_pick / await_overwrite_ok も専用の案内を持つ', async () => {
      const pick = buildGbpCurrentStateMessage(replySession({ stage: 'await_review_pick' }));
      const overwrite = buildGbpCurrentStateMessage(
        replySession({ stage: 'await_overwrite_ok' }),
      );

      expect(pick).not.toEqual(overwrite);
      expect(JSON.stringify(pick)).toContain('クチコミ');
    });

    it('g_cancel は下書きごとセッションを破棄する', async () => {
      const h = createHarness();

      await h.handlers.handleGbpPostback(postback(G_CANCEL));

      expect(h.clearCalls).toEqual([OWNER]);
      expect(h.replies).toEqual([[buildGbpCancelledMessage()]]);
    });
  });

  // モック GBP での一気通貫（design「Integration Tests 2」・tasks.md 4.2）。
  // 各ステージを事前シードで個別に検証する上のテスト群に対し、ここでは 1 つのハーネスの
  // セッション状態を跨いで開始 → 選択 → 承認まで連続実行し、状態機械の遷移が実際に
  // 繋がることと、承認まで GBP へ書き込まないこと（Req 4.5）を通しで証明する。
  describe('一気通貫（integration・モック GBP）', () => {
    it('未返信クチコミ経路: g_reply → 選択 → 承認で返信を 1 回だけ投稿する（Req 4.1–4.5）', async () => {
      const unreplied = review({
        reviewName: 'accounts/1/locations/2/reviews/u1',
        rating: 3,
        comment: '普通でした',
        hasReply: false,
      });
      const h = createHarness({ reviews: [unreplied], session: null });

      // 開始: オンデマンド取得 → 候補提示（await_review_pick）。
      await h.handlers.handleGbpPostback(postback(G_REPLY));
      expect(h.listReviewsCalls).toHaveLength(1);
      expect(h.currentSession()?.stage).toBe('await_review_pick');
      expect(h.replyCalls).toEqual([]);

      // 選択: 未返信 → 下書き生成（await_decision）。承認前は書き込まない。
      await h.handlers.handleGbpPostback(postback(pickReview(0)));
      expect(h.generateCalls).toHaveLength(1);
      expect(h.currentSession()?.stage).toBe('await_decision');
      expect(h.replyCalls).toEqual([]);

      // 承認: 返信を 1 回だけ投稿し、成功でセッションを消す。
      await h.handlers.handleGbpPostback(postback(G_APPROVE));
      expect(h.replyCalls).toEqual([
        {
          ownerId: OWNER,
          storeId: STORE_A,
          reviewName: 'accounts/1/locations/2/reviews/u1',
          comment: '生成された返信の下書き',
        },
      ]);
      expect(h.currentSession()).toBeNull();
      expect(h.replies.at(-1)).toEqual([buildGbpReplySucceededMessage('テスト食堂A')]);
    });

    it('既返信クチコミ経路: g_reply → 選択 → 上書き確認 → 承認で返信を投稿する（Req 4.6・低評価も同一導線）', async () => {
      // rating=1 の既返信クチコミ。低評価でも隠さず同一の導線で扱う（Req 4.9）。
      const replied = review({
        reviewName: 'accounts/1/locations/2/reviews/x1',
        rating: 1,
        comment: '対応が残念でした',
        hasReply: true,
        replyComment: '以前の返信本文です。',
      });
      const h = createHarness({ reviews: [replied], session: null });

      await h.handlers.handleGbpPostback(postback(G_REPLY));
      expect(h.currentSession()?.stage).toBe('await_review_pick');

      // 既返信を選ぶと上書き確認（await_overwrite_ok）。下書きはまだ生成しない（Req 4.6）。
      await h.handlers.handleGbpPostback(postback(pickReview(0)));
      expect(h.generateCalls).toEqual([]);
      expect(h.currentSession()?.stage).toBe('await_overwrite_ok');
      expect(h.replyCalls).toEqual([]);

      // 上書き同意 → 下書き生成（await_decision）。
      await h.handlers.handleGbpPostback(postback(G_OVERWRITE));
      expect(h.generateCalls).toHaveLength(1);
      expect(h.currentSession()?.stage).toBe('await_decision');
      expect(h.replyCalls).toEqual([]);

      // 承認 → 上書きで返信を投稿。
      await h.handlers.handleGbpPostback(postback(G_APPROVE));
      expect(h.replyCalls).toEqual([
        {
          ownerId: OWNER,
          storeId: STORE_A,
          reviewName: 'accounts/1/locations/2/reviews/x1',
          comment: '生成された返信の下書き',
        },
      ]);
      expect(h.currentSession()).toBeNull();
    });
  });
});
