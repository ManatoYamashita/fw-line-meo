import { describe, it, expect, vi } from 'vitest';
import type { OnboardingSessionRow, OwnerRow, Queryable, SessionPatch, StoreCandidate } from '@fwlm/db';
import {
  createConversationHandlers,
  type ConversationDeps,
  type InviteCodesAccessor,
  type OwnersAccessor,
  type SessionsAccessor,
} from '../../src/onboarding/conversation.js';
import type { InboundEvent } from '../../src/webhook/dispatch.js';
import type { LineMessenger, LineMessage } from '../../src/line/client.js';
import type { ConnectablePool, TransactionClient } from '../../src/onboarding/store-identification.js';
import type {
  ConfirmOutcome,
  StoreIdentificationService,
} from '../../src/onboarding/store-identification.js';
import type { SearchOutcome } from '../../src/places/search.js';
import { encodePostback } from '../../src/onboarding/stages.js';
import {
  buildAlreadyCompletedMessage,
  buildConfirmationMessage as buildConfirmationMessageForAssertion,
  buildGreetingMessage,
  buildStoreNameInputGuidanceMessage,
} from '../../src/line/messages.js';

// タスク 3.2「招待コード段階の会話ロジック」／タスク 3.3「店名検索〜確定段階の会話ロジック」／
// タスク 3.4「完了段階・フォールバック・リッチメニュー再開導線」のモック deps テスト。
// Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4, 2.5（3.2）／3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.4, 4.5（3.3）／
//   4.3, 4.6, 5.2, 5.3, 6.2, 6.3（3.4）
// Design: 「ConversationHandlers」「データ層 Implementation Notes」（createOwner と
//   updateSession(stage→await_store_name) は同一 TX）。「StoreIdentificationService（拡張縫）」。

const FIXED_NOW = new Date('2026-07-11T00:00:00.000Z');
const AGENCY_ID = 'agency-1';
const RICHMENU_COMPLETED_ID = 'richmenu-completed-1';

function baseSession(overrides: Partial<OnboardingSessionRow> = {}): OnboardingSessionRow {
  return {
    line_user_id: 'U1',
    stage: 'await_invite_code',
    owner_id: null,
    candidates: null,
    selected_index: null,
    invite_failures: 0,
    locked_until: null,
    created_at: FIXED_NOW,
    updated_at: FIXED_NOW,
    ...overrides,
  };
}

function storeCandidate(overrides: Partial<StoreCandidate> = {}): StoreCandidate {
  return {
    placeId: 'ChIJ-place-1',
    name: 'テスト食堂',
    address: '東京都渋谷区1-1-1',
    latitude: 35.1,
    longitude: 139.1,
    types: ['restaurant', 'food'],
    ...overrides,
  };
}

function storeCandidates(count: number): StoreCandidate[] {
  return Array.from({ length: count }, (_, i) =>
    storeCandidate({ placeId: `ChIJ-place-${i}`, name: `テスト食堂${i}` }),
  );
}

function baseOwner(overrides: Partial<OwnerRow> = {}): OwnerRow {
  return {
    id: 'owner-1',
    agency_id: AGENCY_ID,
    line_user_id: 'U1',
    display_name: null,
    onboarding_status: 'pending',
    created_at: FIXED_NOW,
    ...overrides,
  };
}

// インメモリのフェイクセッションストア。updateSession が実際に db 引数へ渡された
// client を素通しで使うことだけを検証したいので、パッチ適用ロジックは最小限にする。
function createFakeSessionsAccessor(initial: OnboardingSessionRow): {
  accessor: SessionsAccessor;
  getState(): OnboardingSessionRow;
  updateCalls: { db: Queryable; patch: SessionPatch }[];
} {
  let state = initial;
  const updateCalls: { db: Queryable; patch: SessionPatch }[] = [];
  const accessor: SessionsAccessor = {
    async getOrCreateSession() {
      return state;
    },
    async updateSession(db, _lineUserId, patch) {
      updateCalls.push({ db, patch });
      state = {
        ...state,
        stage: patch.stage ?? state.stage,
        owner_id: patch.ownerId !== undefined ? patch.ownerId : state.owner_id,
        invite_failures: patch.inviteFailures ?? state.invite_failures,
        locked_until: patch.lockedUntil !== undefined ? patch.lockedUntil : state.locked_until,
      };
    },
  };
  return { accessor, getState: () => state, updateCalls };
}

function createFakeOwnersAccessor(existingOwner: OwnerRow | null): {
  accessor: OwnersAccessor;
  createOwnerCalls: { db: Queryable; input: unknown }[];
} {
  const createOwnerCalls: { db: Queryable; input: unknown }[] = [];
  const accessor: OwnersAccessor = {
    async findOwnerByLineUserId() {
      return existingOwner;
    },
    async createOwner(db, input) {
      createOwnerCalls.push({ db, input });
      return baseOwner({ agency_id: input.agencyId, line_user_id: input.lineUserId });
    },
  };
  return { accessor, createOwnerCalls };
}

function createFakeInviteCodesAccessor(validCodes: Record<string, { agencyId: string }>): {
  accessor: InviteCodesAccessor;
  findCalls: string[];
} {
  const findCalls: string[] = [];
  const accessor: InviteCodesAccessor = {
    async findActiveInviteCode(_db, code) {
      findCalls.push(code);
      return validCodes[code] ?? null;
    },
  };
  return { accessor, findCalls };
}

// タスク 3.1 で構築済みの StoreIdentificationService のフェイク実装。
// searchCandidates/confirmStore の戻り値をテストごとに差し替えられるようにし、
// confirmStore に渡された引数（ownerId・candidate）を記録して「セッションに保存された
// 実際に提示済みの候補」がそのまま渡されたことを検証できるようにする。
function createFakeIdentificationService(config: {
  searchOutcome?: SearchOutcome;
  confirmOutcome?: ConfirmOutcome;
}): {
  service: StoreIdentificationService;
  searchCalls: string[];
  confirmCalls: { ownerId: string; candidate: StoreCandidate }[];
} {
  const searchCalls: string[] = [];
  const confirmCalls: { ownerId: string; candidate: StoreCandidate }[] = [];
  const service: StoreIdentificationService = {
    async searchCandidates(storeName: string) {
      searchCalls.push(storeName);
      return config.searchOutcome ?? { kind: 'empty' };
    },
    async confirmStore(ownerId: string, candidate: StoreCandidate) {
      confirmCalls.push({ ownerId, candidate });
      return config.confirmOutcome ?? { kind: 'confirmed', storeId: 'store-1' };
    },
  };
  return { service, searchCalls, confirmCalls };
}

function createFakeMessenger(): LineMessenger & { replies: { replyToken: string; messages: readonly LineMessage[] }[] } {
  const replies: { replyToken: string; messages: readonly LineMessage[] }[] = [];
  return {
    replies,
    async reply(replyToken, messages) {
      replies.push({ replyToken, messages });
    },
    async getProfile() {
      return { displayName: 'テストオーナー' };
    },
    async linkRichMenu() {
      // 未使用（タスク 3.4 の対象）。
    },
  };
}

// store-identification.ts と同じ「TransactionClient/ConnectablePool 構造的型付け」パターンの
// フェイク実装。BEGIN/COMMIT/ROLLBACK の呼び出し列と、connect() が返した client が
// createOwner/updateSession に渡された client と同一オブジェクトであることを記録する。
function createFakePool(): { pool: ConnectablePool; queryLog: string[]; releaseCount: number } {
  const queryLog: string[] = [];
  let releaseCount = 0;
  const client: TransactionClient = {
    async query(text: unknown) {
      if (typeof text === 'string') {
        queryLog.push(text);
      }
      return { rows: [], rowCount: 0 } as never;
    },
    release() {
      releaseCount += 1;
    },
  };
  const pool: ConnectablePool = {
    async connect() {
      return client;
    },
  };
  return {
    pool,
    queryLog,
    get releaseCount() {
      return releaseCount;
    },
  };
}

function buildDeps(overrides: {
  session: OnboardingSessionRow;
  existingOwner?: OwnerRow | null;
  validCodes?: Record<string, { agencyId: string }>;
  now?: Date;
  searchOutcome?: SearchOutcome;
  confirmOutcome?: ConfirmOutcome;
  messenger?: ReturnType<typeof createFakeMessenger>;
}): {
  deps: ConversationDeps;
  sessionsFake: ReturnType<typeof createFakeSessionsAccessor>;
  ownersFake: ReturnType<typeof createFakeOwnersAccessor>;
  inviteCodesFake: ReturnType<typeof createFakeInviteCodesAccessor>;
  identificationFake: ReturnType<typeof createFakeIdentificationService>;
  messenger: ReturnType<typeof createFakeMessenger>;
  poolFake: ReturnType<typeof createFakePool>;
} {
  const sessionsFake = createFakeSessionsAccessor(overrides.session);
  const ownersFake = createFakeOwnersAccessor(overrides.existingOwner ?? null);
  const inviteCodesFake = createFakeInviteCodesAccessor(overrides.validCodes ?? {});
  const identificationFake = createFakeIdentificationService({
    searchOutcome: overrides.searchOutcome,
    confirmOutcome: overrides.confirmOutcome,
  });
  const messenger = overrides.messenger ?? createFakeMessenger();
  const poolFake = createFakePool();
  const db: Queryable = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as Queryable;

  const deps: ConversationDeps = {
    db,
    pool: poolFake.pool,
    sessions: sessionsFake.accessor,
    owners: ownersFake.accessor,
    inviteCodes: inviteCodesFake.accessor,
    identification: identificationFake.service,
    messenger,
    now: () => overrides.now ?? FIXED_NOW,
    lineRichMenuCompletedId: RICHMENU_COMPLETED_ID,
  };

  return { deps, sessionsFake, ownersFake, inviteCodesFake, identificationFake, messenger, poolFake };
}

describe('createConversationHandlers', () => {
  describe('follow イベント', () => {
    it('新規ユーザーの友だち追加 → 挨拶 reply、owner 作成は試みない（Req 1.1）', async () => {
      const { deps, ownersFake, messenger } = buildDeps({
        session: baseSession(),
        existingOwner: null,
      });
      const handlers = createConversationHandlers(deps);

      const event: InboundEvent = { kind: 'follow', lineUserId: 'U1', replyToken: 'rt-1' };
      await handlers.handleEvent(event);

      expect(ownersFake.createOwnerCalls).toHaveLength(0);
      expect(messenger.replies).toHaveLength(1);
      expect(messenger.replies[0]?.replyToken).toBe('rt-1');
      const [message] = messenger.replies[0]?.messages ?? [];
      expect(message?.type).toBe('text');
      expect((message as { text: string }).text).toContain('招待コード');
    });

    it('既存オーナーの再友だち追加 → owner を重複作成せず、現在の段階の精密な案内を再送する（Req 1.2/5.2）', async () => {
      const existingOwner = baseOwner();
      const session = baseSession({
        stage: 'await_store_name',
        owner_id: existingOwner.id,
      });
      const { deps, ownersFake, messenger } = buildDeps({ session, existingOwner });
      const handlers = createConversationHandlers(deps);

      const event: InboundEvent = { kind: 'follow', lineUserId: 'U1', replyToken: 'rt-2' };
      await handlers.handleEvent(event);

      expect(ownersFake.createOwnerCalls).toHaveLength(0);
      expect(messenger.replies).toHaveLength(1);
      const [message] = messenger.replies[0]?.messages ?? [];
      // タスク 3.4: 汎用の「ご登録いただいています」ではなく、await_store_name に実際に
      // 入った際に送信したのと同一の文言（buildStoreNameInputGuidanceMessage）を再送する。
      expect(message).toEqual(buildStoreNameInputGuidanceMessage());
    });
  });

  describe('招待コード段階のテキスト入力', () => {
    it('有効なコード → 単一トランザクションで owner 作成＋stage 遷移（Req 2.1, 2.4）', async () => {
      const session = baseSession({ invite_failures: 2 });
      const { deps, sessionsFake, ownersFake, poolFake, messenger } = buildDeps({
        session,
        validCodes: { VALIDCODE: { agencyId: AGENCY_ID } },
      });
      const handlers = createConversationHandlers(deps);

      const event: InboundEvent = {
        kind: 'text',
        lineUserId: 'U1',
        replyToken: 'rt-3',
        text: 'VALIDCODE',
      };
      await handlers.handleEvent(event);

      // owner 作成
      expect(ownersFake.createOwnerCalls).toHaveLength(1);
      expect(ownersFake.createOwnerCalls[0]?.input).toMatchObject({
        agencyId: AGENCY_ID,
        lineUserId: 'U1',
      });

      // updateSession は 1 回だけ・stage と ownerId を同一呼び出しで渡す
      expect(sessionsFake.updateCalls).toHaveLength(1);
      const call = sessionsFake.updateCalls[0]!;
      expect(call.patch.stage).toBe('await_store_name');
      expect(call.patch.ownerId).toBe('owner-1');
      expect(call.patch.inviteFailures).toBe(0);

      // createOwner と updateSession は同一トランザクションクライアント（pool.connect() の戻り値）を通した
      // ことを構造的に証明する: フェイク pool が返した唯一の client オブジェクトが両方の db 引数として渡っている。
      const connectedClient = await poolFake.pool.connect();
      expect(ownersFake.createOwnerCalls[0]?.db).toBe(connectedClient);
      expect(call.db).toBe(connectedClient);

      // BEGIN → COMMIT の順で発行され、client は解放されている
      // （connectedClient を得るための検証用 connect() 呼び出し自体は client.query を発行しないため
      //   queryLog には影響しない）。
      expect(poolFake.queryLog).toEqual(['BEGIN', 'COMMIT']);
      expect(poolFake.releaseCount).toBe(1);

      // 完了案内 reply
      const [message] = messenger.replies[0]?.messages ?? [];
      expect((message as { text: string }).text).toContain('お店の名前');
    });

    it('無効なコード（5回未満）→ 登録せず失敗カウンタのみ加算、再入力案内（Req 2.2）', async () => {
      const session = baseSession({ invite_failures: 1 });
      const { deps, sessionsFake, ownersFake, messenger } = buildDeps({ session, validCodes: {} });
      const handlers = createConversationHandlers(deps);

      const event: InboundEvent = {
        kind: 'text',
        lineUserId: 'U1',
        replyToken: 'rt-4',
        text: 'WRONGCODE',
      };
      await handlers.handleEvent(event);

      expect(ownersFake.createOwnerCalls).toHaveLength(0);
      expect(sessionsFake.updateCalls).toHaveLength(1);
      expect(sessionsFake.updateCalls[0]?.patch.inviteFailures).toBe(2);
      expect(sessionsFake.updateCalls[0]?.patch.lockedUntil).toBeUndefined();
      expect(sessionsFake.updateCalls[0]?.patch.stage).toBeUndefined();

      const [message] = messenger.replies[0]?.messages ?? [];
      expect((message as { text: string }).text).toContain('もう一度');
    });

    it('無効なコードが連続5回目 → ロック（locked_until 設定）＋ロック案内 reply（Req 2.3）', async () => {
      const session = baseSession({ invite_failures: 4 });
      const { deps, sessionsFake, messenger } = buildDeps({ session, validCodes: {} });
      const handlers = createConversationHandlers(deps);

      const event: InboundEvent = {
        kind: 'text',
        lineUserId: 'U1',
        replyToken: 'rt-5',
        text: 'WRONGCODE',
      };
      await handlers.handleEvent(event);

      expect(sessionsFake.updateCalls).toHaveLength(1);
      const patch = sessionsFake.updateCalls[0]!.patch;
      expect(patch.inviteFailures).toBe(5);
      expect(patch.lockedUntil).toBeInstanceOf(Date);
      expect(patch.lockedUntil!.getTime()).toBe(FIXED_NOW.getTime() + 10 * 60 * 1000);

      const [message] = messenger.replies[0]?.messages ?? [];
      expect((message as { text: string }).text).toContain('停止');
    });

    it('4回目の失敗ではロックしない（閾値の正確性）', async () => {
      const session = baseSession({ invite_failures: 3 });
      const { deps, sessionsFake } = buildDeps({ session, validCodes: {} });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'text',
        lineUserId: 'U1',
        replyToken: 'rt-6',
        text: 'WRONGCODE',
      });

      const patch = sessionsFake.updateCalls[0]!.patch;
      expect(patch.inviteFailures).toBe(4);
      expect(patch.lockedUntil).toBeUndefined();
    });

    it('ロック中の入力は待機案内のみ・コード再検証や失敗カウント加算を行わない（Req 2.3）', async () => {
      const lockedUntil = new Date(FIXED_NOW.getTime() + 5 * 60 * 1000); // まだロック解除前
      const session = baseSession({ invite_failures: 5, locked_until: lockedUntil });
      const { deps, sessionsFake, inviteCodesFake, messenger } = buildDeps({
        session,
        validCodes: { VALIDCODE: { agencyId: AGENCY_ID } },
      });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'text',
        lineUserId: 'U1',
        replyToken: 'rt-7',
        text: 'VALIDCODE',
      });

      expect(inviteCodesFake.findCalls).toHaveLength(0);
      expect(sessionsFake.updateCalls).toHaveLength(0);
      const [message] = messenger.replies[0]?.messages ?? [];
      expect((message as { text: string }).text).toContain('停止');
    });
  });

  describe('店名検索段階（await_store_name）のテキスト入力', () => {
    it('検索で候補が見つかる → セッションに候補を保存し stage は await_store_name のまま・カルーセル reply（Req 3.1）', async () => {
      const candidates = storeCandidates(3);
      const session = baseSession({ stage: 'await_store_name', owner_id: 'owner-1' });
      const { deps, sessionsFake, identificationFake, messenger } = buildDeps({
        session,
        searchOutcome: { kind: 'found', candidates },
      });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'text',
        lineUserId: 'U1',
        replyToken: 'rt-8',
        text: 'テスト食堂',
      });

      expect(identificationFake.searchCalls).toEqual(['テスト食堂']);
      expect(sessionsFake.updateCalls).toHaveLength(1);
      const patch = sessionsFake.updateCalls[0]!.patch;
      expect(patch.stage).toBe('await_store_name');
      expect(patch.candidates).toEqual(candidates);
      expect(patch.selectedIndex).toBeNull();

      const [message] = messenger.replies[0]?.messages ?? [];
      expect(message?.type).toBe('flex');
    });

    it('検索結果 0 件 → 見つからなかった旨の案内、stage は変更しない（Req 3.2）', async () => {
      const session = baseSession({ stage: 'await_store_name', owner_id: 'owner-1' });
      const { deps, sessionsFake, messenger } = buildDeps({
        session,
        searchOutcome: { kind: 'empty' },
      });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'text',
        lineUserId: 'U1',
        replyToken: 'rt-9',
        text: '存在しないお店',
      });

      // すでに await_store_name のため updateSession は一切呼ばれない（stage 不変を構造的に証明）。
      expect(sessionsFake.updateCalls).toHaveLength(0);
      const [message] = messenger.replies[0]?.messages ?? [];
      expect((message as { text: string }).text).toContain('見つかりませんでした');
    });

    it('検索が外部要因で失敗 → エラー案内、進捗（セッション）は一切変更しない（Req 3.3）', async () => {
      const session = baseSession({
        stage: 'await_store_name',
        owner_id: 'owner-1',
        candidates: storeCandidates(2),
      });
      const { deps, sessionsFake, messenger } = buildDeps({
        session,
        searchOutcome: { kind: 'error' },
      });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'text',
        lineUserId: 'U1',
        replyToken: 'rt-10',
        text: 'テスト食堂',
      });

      expect(sessionsFake.updateCalls).toHaveLength(0);
      const [message] = messenger.replies[0]?.messages ?? [];
      expect((message as { text: string }).text).toContain('エラー');
    });

    it('別の店名テキストが届いたら再検索し候補を提示し直す（Req 3.4）', async () => {
      const firstCandidates = storeCandidates(2);
      const secondCandidates = storeCandidates(4);
      const session = baseSession({
        stage: 'await_store_name',
        owner_id: 'owner-1',
        candidates: firstCandidates,
      });
      const { deps, identificationFake, sessionsFake, messenger } = buildDeps({
        session,
        searchOutcome: { kind: 'found', candidates: secondCandidates },
      });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'text',
        lineUserId: 'U1',
        replyToken: 'rt-11',
        text: '別のお店',
      });

      expect(identificationFake.searchCalls).toEqual(['別のお店']);
      expect(sessionsFake.updateCalls[0]?.patch.candidates).toEqual(secondCandidates);
      const [message] = messenger.replies[0]?.messages ?? [];
      expect(message?.type).toBe('flex');
    });
  });

  describe('確認待ち段階（await_confirmation）中の新しい店名テキスト（Req 3.4）', () => {
    it('await_confirmation 中に別の店名テキストが届くと再検索し await_store_name へ戻す', async () => {
      const previousCandidates = storeCandidates(2);
      const newCandidates = storeCandidates(3);
      const session = baseSession({
        stage: 'await_confirmation',
        owner_id: 'owner-1',
        candidates: previousCandidates,
        selected_index: 0,
      });
      const { deps, sessionsFake, identificationFake } = buildDeps({
        session,
        searchOutcome: { kind: 'found', candidates: newCandidates },
      });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'text',
        lineUserId: 'U1',
        replyToken: 'rt-12',
        text: 'やっぱり別のお店',
      });

      expect(identificationFake.searchCalls).toEqual(['やっぱり別のお店']);
      expect(sessionsFake.updateCalls).toHaveLength(1);
      const patch = sessionsFake.updateCalls[0]!.patch;
      expect(patch.stage).toBe('await_store_name');
      expect(patch.candidates).toEqual(newCandidates);
      expect(patch.selectedIndex).toBeNull();
    });

    it('await_confirmation 中に検索が 0 件でも stage を await_store_name へ戻す（取りやめと同等の離脱）', async () => {
      const session = baseSession({
        stage: 'await_confirmation',
        owner_id: 'owner-1',
        candidates: storeCandidates(2),
        selected_index: 0,
      });
      const { deps, sessionsFake, messenger } = buildDeps({
        session,
        searchOutcome: { kind: 'empty' },
      });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'text',
        lineUserId: 'U1',
        replyToken: 'rt-13',
        text: '存在しないお店',
      });

      expect(sessionsFake.updateCalls).toHaveLength(1);
      const patch = sessionsFake.updateCalls[0]!.patch;
      expect(patch.stage).toBe('await_store_name');
      // Req 3.2: 進捗（候補等）は変更しない。stage 以外のフィールドは patch に含めない。
      expect(patch.candidates).toBeUndefined();
      expect(patch.selectedIndex).toBeUndefined();
      const [message] = messenger.replies[0]?.messages ?? [];
      expect((message as { text: string }).text).toContain('見つかりませんでした');
    });

    it('await_confirmation 中に検索が外部要因で失敗しても stage を await_store_name へ戻す（Req 3.3・3.4）', async () => {
      const session = baseSession({
        stage: 'await_confirmation',
        owner_id: 'owner-1',
        candidates: storeCandidates(2),
        selected_index: 0,
      });
      const { deps, sessionsFake, messenger } = buildDeps({
        session,
        searchOutcome: { kind: 'error' },
      });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'text',
        lineUserId: 'U1',
        replyToken: 'rt-13b',
        text: 'タイムアウトするお店',
      });

      expect(sessionsFake.updateCalls).toHaveLength(1);
      const patch = sessionsFake.updateCalls[0]!.patch;
      expect(patch.stage).toBe('await_store_name');
      // Req 3.3: 進捗（候補等）は変更しない。stage 以外のフィールドは patch に含めない。
      expect(patch.candidates).toBeUndefined();
      expect(patch.selectedIndex).toBeUndefined();
      const [message] = messenger.replies[0]?.messages ?? [];
      expect((message as { text: string }).text).toContain('エラーが発生しました');
    });
  });

  describe('候補選択の postback（select_candidate・Req 4.1, 3.4）', () => {
    it('有効な index → セッションの候補と照合し、確認メッセージ reply・stage は await_confirmation へ（Req 4.1）', async () => {
      const candidates = storeCandidates(3);
      const session = baseSession({
        stage: 'await_store_name',
        owner_id: 'owner-1',
        candidates,
      });
      const { deps, sessionsFake, messenger } = buildDeps({ session });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'postback',
        lineUserId: 'U1',
        replyToken: 'rt-14',
        data: encodePostback({ kind: 'select_candidate', index: 1 }),
      });

      expect(sessionsFake.updateCalls).toHaveLength(1);
      const patch = sessionsFake.updateCalls[0]!.patch;
      expect(patch.stage).toBe('await_confirmation');
      expect(patch.selectedIndex).toBe(1);

      const [message] = messenger.replies[0]?.messages ?? [];
      expect(message?.type).toBe('flex');
      expect((message as { altText: string }).altText).toContain(candidates[1]!.name);
    });

    it('範囲外の index（古いカルーセルからの選択）→ クラッシュせず安全側フォールバック案内、stage は変更しない', async () => {
      const candidates = storeCandidates(2);
      const session = baseSession({
        stage: 'await_store_name',
        owner_id: 'owner-1',
        candidates,
      });
      const { deps, sessionsFake, messenger } = buildDeps({ session });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'postback',
        lineUserId: 'U1',
        replyToken: 'rt-15',
        data: encodePostback({ kind: 'select_candidate', index: 5 }),
      });

      expect(sessionsFake.updateCalls).toHaveLength(0);
      const [message] = messenger.replies[0]?.messages ?? [];
      expect((message as { text: string }).text).toContain('選択できませんでした');
    });

    it('候補が一件もセッションに保存されていない状態での選択 → クラッシュせず安全側フォールバック案内', async () => {
      const session = baseSession({
        stage: 'await_store_name',
        owner_id: 'owner-1',
        candidates: null,
      });
      const { deps, sessionsFake, messenger } = buildDeps({ session });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'postback',
        lineUserId: 'U1',
        replyToken: 'rt-16',
        data: encodePostback({ kind: 'select_candidate', index: 0 }),
      });

      expect(sessionsFake.updateCalls).toHaveLength(0);
      const [message] = messenger.replies[0]?.messages ?? [];
      expect((message as { text: string }).text).toContain('選択できませんでした');
    });
  });

  describe('確定・取りやめの postback（confirm/restart・Req 4.2, 4.4, 4.5）', () => {
    it('確定 → confirmStore が session 由来の ownerId・candidate で呼ばれ、完了 reply・stage は completed（Req 4.2）', async () => {
      const candidates = storeCandidates(3);
      const session = baseSession({
        stage: 'await_confirmation',
        owner_id: 'owner-1',
        candidates,
        selected_index: 2,
      });
      const { deps, sessionsFake, identificationFake, messenger } = buildDeps({
        session,
        confirmOutcome: { kind: 'confirmed', storeId: 'store-1' },
      });
      const linkRichMenuSpy = vi.spyOn(messenger, 'linkRichMenu');
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'postback',
        lineUserId: 'U1',
        replyToken: 'rt-17',
        data: encodePostback({ kind: 'confirm' }),
      });

      expect(identificationFake.confirmCalls).toHaveLength(1);
      expect(identificationFake.confirmCalls[0]).toEqual({
        ownerId: 'owner-1',
        candidate: candidates[2],
      });

      expect(sessionsFake.updateCalls).toHaveLength(1);
      expect(sessionsFake.updateCalls[0]?.patch.stage).toBe('completed');

      const [message] = messenger.replies[0]?.messages ?? [];
      expect((message as { text: string }).text).toContain('完了');

      // Req 6.3: 完了時にリッチメニューを完了後メニューへ即時リンクする。
      expect(linkRichMenuSpy).toHaveBeenCalledTimes(1);
      expect(linkRichMenuSpy).toHaveBeenCalledWith('U1', RICHMENU_COMPLETED_ID);
    });

    it('確定 → linkRichMenu が reject しても handleEvent はクラッシュせず完了 reply は送信済みのまま解決する（Req 6.3 の副作用の扱い）', async () => {
      const candidates = storeCandidates(1);
      const session = baseSession({
        stage: 'await_confirmation',
        owner_id: 'owner-1',
        candidates,
        selected_index: 0,
      });
      const messenger = createFakeMessenger();
      messenger.linkRichMenu = vi.fn(async () => {
        throw new Error('linkRichMenu failed (simulated LINE API error)');
      });
      const { deps, sessionsFake } = buildDeps({
        session,
        confirmOutcome: { kind: 'confirmed', storeId: 'store-1' },
        messenger,
      });
      const handlers = createConversationHandlers(deps);

      await expect(
        handlers.handleEvent({
          kind: 'postback',
          lineUserId: 'U1',
          replyToken: 'rt-17b',
          data: encodePostback({ kind: 'confirm' }),
        }),
      ).resolves.toBeUndefined();

      // DB 状態遷移（completed）は linkRichMenu の失敗と無関係にすでに確定している。
      expect(sessionsFake.updateCalls[0]?.patch.stage).toBe('completed');
      // 完了案内 reply はすでに送信済み。
      const [message] = messenger.replies[0]?.messages ?? [];
      expect((message as { text: string }).text).toContain('完了');
    });

    it('確定 → place_already_registered → 運営問い合わせ案内、stage は変更せず、linkRichMenu は呼ばれない（Req 4.4）', async () => {
      const session = baseSession({
        stage: 'await_confirmation',
        owner_id: 'owner-1',
        candidates: storeCandidates(1),
        selected_index: 0,
      });
      const { deps, sessionsFake, messenger } = buildDeps({
        session,
        confirmOutcome: { kind: 'place_already_registered' },
      });
      const linkRichMenuSpy = vi.spyOn(messenger, 'linkRichMenu');
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'postback',
        lineUserId: 'U1',
        replyToken: 'rt-18',
        data: encodePostback({ kind: 'confirm' }),
      });

      expect(sessionsFake.updateCalls).toHaveLength(0);
      expect(linkRichMenuSpy).not.toHaveBeenCalled();
      const [message] = messenger.replies[0]?.messages ?? [];
      expect((message as { text: string }).text).toContain('運営');
    });

    it('取りやめ（restart）→ await_store_name へ戻り、候補・選択インデックスはクリアされる（Req 4.5）', async () => {
      const session = baseSession({
        stage: 'await_confirmation',
        owner_id: 'owner-1',
        candidates: storeCandidates(2),
        selected_index: 0,
      });
      const { deps, sessionsFake, messenger } = buildDeps({ session });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'postback',
        lineUserId: 'U1',
        replyToken: 'rt-19',
        data: encodePostback({ kind: 'restart' }),
      });

      expect(sessionsFake.updateCalls).toHaveLength(1);
      const patch = sessionsFake.updateCalls[0]!.patch;
      expect(patch.stage).toBe('await_store_name');
      expect(patch.candidates).toBeNull();
      expect(patch.selectedIndex).toBeNull();

      const [message] = messenger.replies[0]?.messages ?? [];
      expect((message as { text: string }).text).toContain('お店の名前');
    });
  });

  describe('completed 段階（Req 4.6）', () => {
    it('text イベント → 固定の完了案内のみ・セッション更新なし', async () => {
      const session = baseSession({ stage: 'completed', owner_id: 'owner-1' });
      const { deps, sessionsFake, messenger } = buildDeps({ session });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'text',
        lineUserId: 'U1',
        replyToken: 'rt-20',
        text: 'まだ何か送ってみる',
      });

      expect(sessionsFake.updateCalls).toHaveLength(0);
      expect(messenger.replies).toHaveLength(1);
      const [message] = messenger.replies[0]?.messages ?? [];
      expect(message).toEqual(buildAlreadyCompletedMessage());
    });

    it('postback イベント（confirm 等の任意の action）→ 固定の完了案内のみ・セッション更新なし', async () => {
      const session = baseSession({ stage: 'completed', owner_id: 'owner-1' });
      const { deps, sessionsFake, messenger } = buildDeps({ session });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'postback',
        lineUserId: 'U1',
        replyToken: 'rt-21',
        data: encodePostback({ kind: 'confirm' }),
      });

      expect(sessionsFake.updateCalls).toHaveLength(0);
      const [message] = messenger.replies[0]?.messages ?? [];
      expect(message).toEqual(buildAlreadyCompletedMessage());
    });

    it('不正な postback data（decode 不能）でも固定の完了案内のみ・セッション更新なし', async () => {
      const session = baseSession({ stage: 'completed', owner_id: 'owner-1' });
      const { deps, sessionsFake, messenger } = buildDeps({ session });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'postback',
        lineUserId: 'U1',
        replyToken: 'rt-22',
        data: 'garbage-data',
      });

      expect(sessionsFake.updateCalls).toHaveLength(0);
      const [message] = messenger.replies[0]?.messages ?? [];
      expect(message).toEqual(buildAlreadyCompletedMessage());
    });
  });

  describe('段階外・期待外の入力への fallback（Req 5.3）', () => {
    it('await_invite_code 段階に stage 不一致の postback（confirm）→ 招待コード入力案内を再送する', async () => {
      const session = baseSession({ stage: 'await_invite_code' });
      const { deps, sessionsFake, messenger } = buildDeps({ session });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'postback',
        lineUserId: 'U1',
        replyToken: 'rt-23',
        data: encodePostback({ kind: 'confirm' }),
      });

      expect(sessionsFake.updateCalls).toHaveLength(0);
      const [message] = messenger.replies[0]?.messages ?? [];
      expect(message).toEqual(buildGreetingMessage());
    });

    it('await_store_name 段階に stage 不一致の postback（confirm）→ 店名入力案内を再送する', async () => {
      const session = baseSession({
        stage: 'await_store_name',
        owner_id: 'owner-1',
        candidates: storeCandidates(2),
      });
      const { deps, sessionsFake, messenger } = buildDeps({ session });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'postback',
        lineUserId: 'U1',
        replyToken: 'rt-24',
        data: encodePostback({ kind: 'confirm' }),
      });

      expect(sessionsFake.updateCalls).toHaveLength(0);
      const [message] = messenger.replies[0]?.messages ?? [];
      expect(message).toEqual(buildStoreNameInputGuidanceMessage());
    });

    it('await_confirmation 段階に stage 不一致の postback（select_candidate）→ 選択済み候補の確認案内を再送する', async () => {
      const candidates = storeCandidates(2);
      const session = baseSession({
        stage: 'await_confirmation',
        owner_id: 'owner-1',
        candidates,
        selected_index: 1,
      });
      const { deps, sessionsFake, messenger } = buildDeps({ session });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'postback',
        lineUserId: 'U1',
        replyToken: 'rt-25',
        data: encodePostback({ kind: 'select_candidate', index: 0 }),
      });

      expect(sessionsFake.updateCalls).toHaveLength(0);
      const [message] = messenger.replies[0]?.messages ?? [];
      expect(message).toEqual(buildConfirmationMessageForAssertion(candidates[1]!));
    });

    it('不正・破損した postback data（decode 不能）→ 現在の段階（await_store_name）の案内を再送する', async () => {
      const session = baseSession({ stage: 'await_store_name', owner_id: 'owner-1' });
      const { deps, sessionsFake, messenger } = buildDeps({ session });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'postback',
        lineUserId: 'U1',
        replyToken: 'rt-26',
        data: 'not-a-valid-postback',
      });

      expect(sessionsFake.updateCalls).toHaveLength(0);
      const [message] = messenger.replies[0]?.messages ?? [];
      expect(message).toEqual(buildStoreNameInputGuidanceMessage());
    });
  });

  describe('テキスト以外の送信（unsupported message・Req 5.3）', () => {
    it('未登録ユーザー（セッション新規作成＝await_invite_code）→ 招待コード入力案内を再送する', async () => {
      // 未知ユーザーの unsupported は getOrCreateSession が await_invite_code の新規
      // セッションを返すため、テキスト入力の未知ユーザーと同様に招待コード案内へ倒れる。
      const session = baseSession({ stage: 'await_invite_code' });
      const { deps, sessionsFake, messenger } = buildDeps({ session, existingOwner: null });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'unsupported',
        lineUserId: 'U1',
        replyToken: 'rt-31',
      });

      expect(sessionsFake.updateCalls).toHaveLength(0);
      expect(messenger.replies).toHaveLength(1);
      expect(messenger.replies[0]?.replyToken).toBe('rt-31');
      const [message] = messenger.replies[0]?.messages ?? [];
      expect(message).toEqual(buildGreetingMessage());
    });

    it('await_store_name 段階でのスタンプ等 → 店名入力案内を再送する', async () => {
      const session = baseSession({ stage: 'await_store_name', owner_id: 'owner-1' });
      const { deps, sessionsFake, identificationFake, messenger } = buildDeps({ session });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'unsupported',
        lineUserId: 'U1',
        replyToken: 'rt-32',
      });

      // 検索は起動されず、セッションも変更されない（案内の再送のみ）。
      expect(identificationFake.searchCalls).toHaveLength(0);
      expect(sessionsFake.updateCalls).toHaveLength(0);
      const [message] = messenger.replies[0]?.messages ?? [];
      expect(message).toEqual(buildStoreNameInputGuidanceMessage());
    });

    it('await_confirmation 段階でのスタンプ等 → 選択済み候補の確認案内を再送する', async () => {
      const candidates = storeCandidates(2);
      const session = baseSession({
        stage: 'await_confirmation',
        owner_id: 'owner-1',
        candidates,
        selected_index: 1,
      });
      const { deps, sessionsFake, messenger } = buildDeps({ session });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'unsupported',
        lineUserId: 'U1',
        replyToken: 'rt-33',
      });

      expect(sessionsFake.updateCalls).toHaveLength(0);
      const [message] = messenger.replies[0]?.messages ?? [];
      expect(message).toEqual(buildConfirmationMessageForAssertion(candidates[1]!));
    });

    it('completed 段階でのスタンプ等 → 固定の完了案内のみ・セッション更新なし（Req 4.6 と整合）', async () => {
      const session = baseSession({ stage: 'completed', owner_id: 'owner-1' });
      const { deps, sessionsFake, messenger } = buildDeps({ session });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'unsupported',
        lineUserId: 'U1',
        replyToken: 'rt-34',
      });

      expect(sessionsFake.updateCalls).toHaveLength(0);
      const [message] = messenger.replies[0]?.messages ?? [];
      expect(message).toEqual(buildAlreadyCompletedMessage());
    });
  });

  describe('リッチメニューからの resume postback（Req 6.2）', () => {
    it('await_invite_code 段階での resume → 招待コード入力案内を再送する', async () => {
      const session = baseSession({ stage: 'await_invite_code' });
      const { deps, sessionsFake, messenger } = buildDeps({ session });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'postback',
        lineUserId: 'U1',
        replyToken: 'rt-27',
        data: encodePostback({ kind: 'resume' }),
      });

      expect(sessionsFake.updateCalls).toHaveLength(0);
      const [message] = messenger.replies[0]?.messages ?? [];
      expect(message).toEqual(buildGreetingMessage());
    });

    it('await_store_name 段階での resume → 店名入力案内を再送する', async () => {
      const session = baseSession({ stage: 'await_store_name', owner_id: 'owner-1' });
      const { deps, sessionsFake, messenger } = buildDeps({ session });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'postback',
        lineUserId: 'U1',
        replyToken: 'rt-28',
        data: encodePostback({ kind: 'resume' }),
      });

      expect(sessionsFake.updateCalls).toHaveLength(0);
      const [message] = messenger.replies[0]?.messages ?? [];
      expect(message).toEqual(buildStoreNameInputGuidanceMessage());
    });

    it('await_confirmation 段階での resume → 選択済み候補の確認案内を再送する', async () => {
      const candidates = storeCandidates(2);
      const session = baseSession({
        stage: 'await_confirmation',
        owner_id: 'owner-1',
        candidates,
        selected_index: 0,
      });
      const { deps, sessionsFake, messenger } = buildDeps({ session });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'postback',
        lineUserId: 'U1',
        replyToken: 'rt-29',
        data: encodePostback({ kind: 'resume' }),
      });

      expect(sessionsFake.updateCalls).toHaveLength(0);
      const [message] = messenger.replies[0]?.messages ?? [];
      expect(message).toEqual(buildConfirmationMessageForAssertion(candidates[0]!));
    });

    it('completed 段階での resume → 固定の完了案内（他の段階の resume と異なり以後の操作を要求しない）', async () => {
      const session = baseSession({ stage: 'completed', owner_id: 'owner-1' });
      const { deps, sessionsFake, messenger } = buildDeps({ session });
      const handlers = createConversationHandlers(deps);

      await handlers.handleEvent({
        kind: 'postback',
        lineUserId: 'U1',
        replyToken: 'rt-30',
        data: encodePostback({ kind: 'resume' }),
      });

      expect(sessionsFake.updateCalls).toHaveLength(0);
      const [message] = messenger.replies[0]?.messages ?? [];
      expect(message).toEqual(buildAlreadyCompletedMessage());
    });
  });
});
