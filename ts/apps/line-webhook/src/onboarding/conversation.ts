import type { OnboardingSessionRow, OwnerRow, Queryable, SessionPatch } from '@fwlm/db';
import type { InboundEvent } from '../webhook/dispatch.js';
import type { LineMessenger } from '../line/client.js';
import type { ConnectablePool, TransactionClient } from './store-identification.js';
import {
  buildGreetingMessage,
  buildInvalidInviteCodeMessage,
  buildInviteCodeLockedMessage,
  buildResumeGuidanceMessage,
  buildStoreNameInputGuidanceMessage,
} from '../line/messages.js';

// オンボーディング会話ロジック（design.md「ConversationHandlers」）の最初のスライス（タスク 3.2）。
// 対象は follow 処理（Req 1.1, 1.2）と招待コード段階（Req 2.1-2.5）のみ。
// await_store_name / await_confirmation / completed 段階の本実装はタスク 3.3・3.4 が担う。
// このファイルは今後（3.3, 3.4）同一ファイルに追記されていく前提で構成する。
//
// ConversationDeps の設計上の適応（design.md の簡略化を実アクセサに合わせて調整）:
// design.md の Service Interface スケッチは `updateSession(lineUserId, patch)` のように
// 暗黙の db を想定しているが、実際の @fwlm/db アクセサ（タスク 1.2）はすべて第一引数に
// 明示的な `Queryable` を取る。招待コード確定時の `createOwner`＋`updateSession` は
// 同一トランザクションで実行する不変条件（design.md データ層 Implementation Notes）があるため、
// 本 ConversationDeps は
//   - 日常の非トランザクション読み書き用の既定 `db: Queryable`
//   - 結合書き込み用にトランザクションを開ける `pool: ConnectablePool`
//     （タスク 3.1 の store-identification.ts と同一の構造的型付けパターンを再利用）
// の両方を公開し、SessionsAccessor/OwnersAccessor/InviteCodesAccessor の各メソッドは
// 呼び出し側が明示的に db（通常時は deps.db、結合書き込み時は開いた TransactionClient）を
// 渡せるシグネチャのまま保持する。

export interface SessionsAccessor {
  getOrCreateSession(db: Queryable, lineUserId: string): Promise<OnboardingSessionRow>;
  updateSession(db: Queryable, lineUserId: string, patch: SessionPatch): Promise<void>;
}

export interface OwnersAccessor {
  findOwnerByLineUserId(db: Queryable, lineUserId: string): Promise<OwnerRow | null>;
  createOwner(
    db: Queryable,
    input: { agencyId: string; lineUserId: string; displayName?: string | null },
  ): Promise<OwnerRow>;
}

export interface InviteCodesAccessor {
  findActiveInviteCode(db: Queryable, code: string): Promise<{ agencyId: string } | null>;
}

export interface ConversationDeps {
  db: Queryable;
  pool: ConnectablePool;
  sessions: SessionsAccessor;
  owners: OwnersAccessor;
  inviteCodes: InviteCodesAccessor;
  messenger: LineMessenger;
  // 現在時刻を注入する（ロック判定・ロック設定の両方でテスト可能性のため `new Date()` を直接使わない）。
  now(): Date;
}

export interface ConversationHandlers {
  handleEvent(event: InboundEvent): Promise<void>;
}

// Req 2.3: 同一 LINE ユーザーからの連続無効コード送信がこの回数に達したらロックする。
const INVITE_CODE_LOCK_THRESHOLD = 5;
const INVITE_CODE_LOCK_DURATION_MS = 10 * 60 * 1000;

export function createConversationHandlers(deps: ConversationDeps): ConversationHandlers {
  return {
    async handleEvent(event: InboundEvent): Promise<void> {
      switch (event.kind) {
        case 'follow':
          return handleFollow(deps, event);
        case 'text':
          return handleText(deps, event);
        case 'postback':
          // select_candidate/confirm/restart/resume の実処理はタスク 3.3・3.4 の対象範囲。
          // このタスクでは無応答のまま放置しない正直な最小フォールバックのみ返す。
          return handleUnhandledPostback(deps, event);
      }
    },
  };
}

async function handleFollow(
  deps: ConversationDeps,
  event: Extract<InboundEvent, { kind: 'follow' }>,
): Promise<void> {
  const [session, existingOwner] = await Promise.all([
    deps.sessions.getOrCreateSession(deps.db, event.lineUserId),
    deps.owners.findOwnerByLineUserId(deps.db, event.lineUserId),
  ]);

  if (!existingOwner || session.stage === 'await_invite_code') {
    // Req 1.1: 未登録ユーザーの友だち追加 → 挨拶＋招待コード入力案内。stage は据え置き（await_invite_code）。
    await deps.messenger.reply(event.replyToken, [buildGreetingMessage()]);
    return;
  }

  // Req 1.2: 既存オーナーの再友だち追加（ブロック解除等）。重複作成せず進捗案内のみ返す。
  // 段階別の精密な再開文言はタスク 3.3/3.4 が担うため、このタスクでは
  // 「登録済み・続きから再開できる」ことのみを伝える汎用の最小案内とする。
  await deps.messenger.reply(event.replyToken, [buildResumeGuidanceMessage()]);
}

async function handleText(
  deps: ConversationDeps,
  event: Extract<InboundEvent, { kind: 'text' }>,
): Promise<void> {
  const session = await deps.sessions.getOrCreateSession(deps.db, event.lineUserId);

  if (session.stage !== 'await_invite_code') {
    // await_store_name / await_confirmation / completed 段階のテキスト処理はタスク 3.3・3.4 が実装する。
    // このタスクでは無応答のまま放置しない正直な最小フォールバックのみ返す。
    await deps.messenger.reply(event.replyToken, [buildResumeGuidanceMessage()]);
    return;
  }

  if (session.locked_until && session.locked_until.getTime() > deps.now().getTime()) {
    // Req 2.3: ロック中はコード再検証・失敗カウント加算を一切行わず、待機案内のみ返す。
    await deps.messenger.reply(event.replyToken, [buildInviteCodeLockedMessage()]);
    return;
  }

  const activeCode = await deps.inviteCodes.findActiveInviteCode(deps.db, event.text);

  if (!activeCode) {
    await handleInvalidInviteCode(deps, event, session);
    return;
  }

  await handleValidInviteCode(deps, event, activeCode);
}

async function handleInvalidInviteCode(
  deps: ConversationDeps,
  event: Extract<InboundEvent, { kind: 'text' }>,
  session: OnboardingSessionRow,
): Promise<void> {
  const nextFailures = session.invite_failures + 1;

  if (nextFailures >= INVITE_CODE_LOCK_THRESHOLD) {
    // Req 2.3: 連続 5 回目の無効コードでロックする。
    const lockedUntil = new Date(deps.now().getTime() + INVITE_CODE_LOCK_DURATION_MS);
    await deps.sessions.updateSession(deps.db, event.lineUserId, {
      inviteFailures: nextFailures,
      lockedUntil,
    });
    await deps.messenger.reply(event.replyToken, [buildInviteCodeLockedMessage()]);
    return;
  }

  // Req 2.2: 登録は行わず、失敗カウンタのみ加算して再入力案内を返す。
  await deps.sessions.updateSession(deps.db, event.lineUserId, {
    inviteFailures: nextFailures,
  });
  await deps.messenger.reply(event.replyToken, [buildInvalidInviteCodeMessage()]);
}

async function handleValidInviteCode(
  deps: ConversationDeps,
  event: Extract<InboundEvent, { kind: 'text' }>,
  activeCode: { agencyId: string },
): Promise<void> {
  const profile = await deps.messenger.getProfile(event.lineUserId);
  const displayName = profile?.displayName ?? null;

  // Req 2.1, 2.4: owner 作成とセッション遷移（await_store_name・owner_id 設定）は同一トランザクションで行う。
  // `ck_session_owner_stage` CHECK（stage=await_invite_code ⇔ owner_id IS NULL）を満たすため、
  // stage と ownerId は同一 updateSession 呼び出しで渡す（design.md データ層 Implementation Notes）。
  const client: TransactionClient = await deps.pool.connect();
  let newOwner: OwnerRow;
  try {
    await client.query('BEGIN');

    newOwner = await deps.owners.createOwner(client, {
      agencyId: activeCode.agencyId,
      lineUserId: event.lineUserId,
      displayName,
    });

    await deps.sessions.updateSession(client, event.lineUserId, {
      stage: 'await_store_name',
      ownerId: newOwner.id,
      inviteFailures: 0,
    });

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await deps.messenger.reply(event.replyToken, [buildStoreNameInputGuidanceMessage()]);
}

async function handleUnhandledPostback(
  deps: ConversationDeps,
  event: Extract<InboundEvent, { kind: 'postback' }>,
): Promise<void> {
  // select_candidate/confirm/restart/resume の実処理はタスク 3.3・3.4 の対象範囲。
  await deps.messenger.reply(event.replyToken, [buildResumeGuidanceMessage()]);
}
