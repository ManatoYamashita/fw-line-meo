import { describe, it, expect } from 'vitest';
import type { OnboardingSessionRow, Queryable } from '@fwlm/db';
import {
  createConversationHandlers,
  type ConversationDeps,
} from '../../src/onboarding/conversation.js';
import type { InboundEvent } from '../../src/webhook/dispatch.js';
import type { LineMessage, LineMessenger } from '../../src/line/client.js';
import type { ConnectablePool } from '@fwlm/store-identification';
import type { StoreIdentificationService } from '@fwlm/store-identification';
import type { GbpFlowHandlers } from '../../src/gbp/flows.js';
import { encodeGbpPostback } from '../../src/gbp/postback.js';
import { encodePostback } from '../../src/onboarding/stages.js';
import { buildAlreadyCompletedMessage } from '../../src/line/messages.js';

// gbp-post-review-reply spec task 3.3 の委譲分岐テスト。
// completed 段階からの GBP 委譲（g_ prefix postback / アクティブセッション時の text）のみを扱い、
// 既存オンボーディング挙動（test/onboarding/conversation.test.ts）は一切変更しない。
// Requirements: 1.1, 1.2, 1.3, 2.4, 2.5（委譲の起点）。

const FIXED_NOW = new Date('2026-07-19T00:00:00.000Z');
const OWNER_ID = 'owner-completed-1';

function session(overrides: Partial<OnboardingSessionRow> = {}): OnboardingSessionRow {
  return {
    line_user_id: 'U1',
    stage: 'completed',
    owner_id: OWNER_ID,
    candidates: null,
    selected_index: null,
    invite_failures: 0,
    locked_until: null,
    created_at: FIXED_NOW,
    updated_at: FIXED_NOW,
    ...overrides,
  };
}

interface Harness {
  deps: ConversationDeps;
  replies: LineMessage[][];
  postbackCalls: { ownerId: string; data: string }[];
  textCalls: { ownerId: string; text: string }[];
}

function createHarness(options: {
  current?: OnboardingSessionRow;
  textResult?: 'handled' | 'not_handled';
  withGbp?: boolean;
}): Harness {
  const replies: LineMessage[][] = [];
  const postbackCalls: { ownerId: string; data: string }[] = [];
  const textCalls: { ownerId: string; text: string }[] = [];

  const gbp: GbpFlowHandlers = {
    async handleGbpPostback(event) {
      postbackCalls.push({ ownerId: event.ownerId, data: event.data });
    },
    async handleGbpText(event) {
      textCalls.push({ ownerId: event.ownerId, text: event.text });
      return options.textResult ?? 'not_handled';
    },
  };

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

  const deps: ConversationDeps = {
    db: {} as Queryable,
    pool: {} as ConnectablePool,
    sessions: {
      async getOrCreateSession() {
        return options.current ?? session();
      },
      async updateSession() {
        throw new Error('updateSession must not be called in completed-stage delegation');
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
    now: () => FIXED_NOW,
    lineRichMenuCompletedId: 'richmenu-completed',
    liffStoreDetailUrl: 'https://liff.line.me/test',
    ...(options.withGbp === false ? {} : { gbp }),
  };

  return { deps, replies, postbackCalls, textCalls };
}

function postbackEvent(data: string): InboundEvent {
  return { kind: 'postback', lineUserId: 'U1', replyToken: 'r1', data };
}

function textEvent(value: string): InboundEvent {
  return { kind: 'text', lineUserId: 'U1', replyToken: 'r1', text: value };
}

describe('completed 段階からの GBP 委譲（task 3.3）', () => {
  it('g_ prefix の postback は GbpFlows へ委譲し、完了案内は返さない', async () => {
    const h = createHarness({});
    const data = encodeGbpPostback({ action: 'g_connect' });

    await createConversationHandlers(h.deps).handleEvent(postbackEvent(data));

    expect(h.postbackCalls).toEqual([{ ownerId: OWNER_ID, data }]);
    expect(h.replies).toEqual([]);
  });

  it('g_ prefix でない postback は従来どおり固定の完了案内を返す（回帰ゼロ）', async () => {
    const h = createHarness({});

    await createConversationHandlers(h.deps).handleEvent(
      postbackEvent(encodePostback({ kind: 'resume' })),
    );

    expect(h.postbackCalls).toEqual([]);
    expect(h.replies).toEqual([[buildAlreadyCompletedMessage()]]);
  });

  it('completed 以外の段階では g_ postback を委譲しない（既存挙動を変えない）', async () => {
    const h = createHarness({ current: session({ stage: 'await_store_name', owner_id: OWNER_ID }) });

    await createConversationHandlers(h.deps).handleEvent(
      postbackEvent(encodeGbpPostback({ action: 'g_connect' })),
    );

    expect(h.postbackCalls).toEqual([]);
    expect(h.replies).toHaveLength(1);
  });

  it('completed のテキストは GbpFlows に問い合わせ、handled なら完了案内を返さない', async () => {
    const h = createHarness({ textResult: 'handled' });

    await createConversationHandlers(h.deps).handleEvent(textEvent('お知らせを投稿したい'));

    expect(h.textCalls).toEqual([{ ownerId: OWNER_ID, text: 'お知らせを投稿したい' }]);
    expect(h.replies).toEqual([]);
  });

  it('completed のテキストで not_handled なら従来どおり固定の完了案内を返す（回帰ゼロ）', async () => {
    const h = createHarness({ textResult: 'not_handled' });

    await createConversationHandlers(h.deps).handleEvent(textEvent('こんにちは'));

    expect(h.textCalls).toHaveLength(1);
    expect(h.replies).toEqual([[buildAlreadyCompletedMessage()]]);
  });

  it('GbpFlows 未配線でも completed 段階は従来どおり動作する', async () => {
    const h = createHarness({ withGbp: false });

    await createConversationHandlers(h.deps).handleEvent(
      postbackEvent(encodeGbpPostback({ action: 'g_connect' })),
    );
    await createConversationHandlers(h.deps).handleEvent(textEvent('こんにちは'));

    expect(h.postbackCalls).toEqual([]);
    expect(h.textCalls).toEqual([]);
    expect(h.replies).toEqual([
      [buildAlreadyCompletedMessage()],
      [buildAlreadyCompletedMessage()],
    ]);
  });

  it('owner_id が無い completed セッションは委譲せず完了案内を返す（防御的）', async () => {
    const h = createHarness({ current: session({ owner_id: null }) });

    await createConversationHandlers(h.deps).handleEvent(
      postbackEvent(encodeGbpPostback({ action: 'g_status' })),
    );

    expect(h.postbackCalls).toEqual([]);
    expect(h.replies).toEqual([[buildAlreadyCompletedMessage()]]);
  });
});
