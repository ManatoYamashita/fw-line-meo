import { describe, it, expect, vi } from 'vitest';
import type { OnboardingSessionRow, OwnerRow, Queryable, SessionPatch } from '@fwlm/db';
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

// タスク 3.2「招待コード段階の会話ロジック」のモック deps テスト。
// Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4, 2.5
// Design: 「ConversationHandlers」「データ層 Implementation Notes」（createOwner と
//   updateSession(stage→await_store_name) は同一 TX）。

const FIXED_NOW = new Date('2026-07-11T00:00:00.000Z');
const AGENCY_ID = 'agency-1';

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
}): {
  deps: ConversationDeps;
  sessionsFake: ReturnType<typeof createFakeSessionsAccessor>;
  ownersFake: ReturnType<typeof createFakeOwnersAccessor>;
  inviteCodesFake: ReturnType<typeof createFakeInviteCodesAccessor>;
  messenger: ReturnType<typeof createFakeMessenger>;
  poolFake: ReturnType<typeof createFakePool>;
} {
  const sessionsFake = createFakeSessionsAccessor(overrides.session);
  const ownersFake = createFakeOwnersAccessor(overrides.existingOwner ?? null);
  const inviteCodesFake = createFakeInviteCodesAccessor(overrides.validCodes ?? {});
  const messenger = createFakeMessenger();
  const poolFake = createFakePool();
  const db: Queryable = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as Queryable;

  const deps: ConversationDeps = {
    db,
    pool: poolFake.pool,
    sessions: sessionsFake.accessor,
    owners: ownersFake.accessor,
    inviteCodes: inviteCodesFake.accessor,
    messenger,
    now: () => overrides.now ?? FIXED_NOW,
  };

  return { deps, sessionsFake, ownersFake, inviteCodesFake, messenger, poolFake };
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

    it('既存オーナーの再友だち追加 → owner を重複作成しない（Req 1.2）', async () => {
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
      expect(message?.type).toBe('text');
      expect((message as { text: string }).text).toContain('ご登録いただいています');
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
});
