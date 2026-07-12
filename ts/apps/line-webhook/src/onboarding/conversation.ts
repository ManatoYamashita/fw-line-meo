import type { OnboardingSessionRow, OwnerRow, Queryable, SessionPatch, StoreCandidate } from '@fwlm/db';
import type { InboundEvent } from '../webhook/dispatch.js';
import type { LineMessage, LineMessenger } from '../line/client.js';
import type {
  ConnectablePool,
  StoreIdentificationService,
  TransactionClient,
} from './store-identification.js';
import { decodePostback } from './stages.js';
import {
  buildAlreadyCompletedMessage,
  buildCandidateCarouselMessage,
  buildCandidateSelectionExpiredMessage,
  buildCompletionMessage,
  buildConfirmationMessage,
  buildGreetingMessage,
  buildInvalidInviteCodeMessage,
  buildInviteCodeLockedMessage,
  buildPlaceAlreadyRegisteredMessage,
  buildSearchFailedMessage,
  buildStoreNameInputGuidanceMessage,
  buildStoreNotFoundMessage,
} from '../line/messages.js';

// オンボーディング会話ロジック（design.md「ConversationHandlers」）。
// タスク 3.2 は follow 処理（Req 1.1, 1.2）と招待コード段階（Req 2.1-2.5）を実装した。
// タスク 3.3 は店名検索〜確定段階（Req 3.1-3.4, 4.1, 4.2, 4.4, 4.5）を追記した。
// 本タスク（3.4）は completed 段階の固定案内・段階別 fallback・resume postback・
// 完了時のリッチメニュー個別リンク（Req 4.3, 4.6, 5.2, 5.3, 6.2, 6.3）を追記する。
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
  // 店名検索・店舗確定（タスク 3.1 で構築済み・会話非依存のサービス）。
  identification: StoreIdentificationService;
  messenger: LineMessenger;
  // 現在時刻を注入する（ロック判定・ロック設定の両方でテスト可能性のため `new Date()` を直接使わない）。
  now(): Date;
  // Req 6.3: 店舗特定完了時に切り替える「完了後」リッチメニューの ID。
  // タスク 4.2 が config.ts の LINE_RICHMENU_COMPLETED_ID（既にタスク 1.3 で検証済み）から配線する。
  lineRichMenuCompletedId: string;
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
          return handlePostback(deps, event);
        case 'unsupported':
          return handleUnsupported(deps, event);
      }
    },
  };
}

/**
 * Req 5.3: テキスト以外の送信（スタンプ・画像等）への fallback。
 * セッションは一切更新せず、現在の段階で必要な操作の案内を再送するのみ。
 * 未知ユーザーの場合は getOrCreateSession が await_invite_code の新規セッションを返すため、
 * テキスト入力での未知ユーザーと同様に招待コード入力案内（buildGreetingMessage）へ倒れる。
 * completed 段階は buildStageGuidanceMessage 経由で固定の完了案内となる（Req 4.6 と整合）。
 */
async function handleUnsupported(
  deps: ConversationDeps,
  event: Extract<InboundEvent, { kind: 'unsupported' }>,
): Promise<void> {
  const session = await deps.sessions.getOrCreateSession(deps.db, event.lineUserId);
  await deps.messenger.reply(event.replyToken, [buildStageGuidanceMessage(session)]);
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

  // Req 1.2/5.2: 既存オーナーの再友だち追加（ブロック解除等）。重複作成せず、現在の段階に
  // 応じた精密な次の手順を再送する（resume postback・段階外入力 fallback と同じ
  // buildStageGuidanceMessage を再利用し、「進捗に応じた案内」の文言を三重化しない）。
  await deps.messenger.reply(event.replyToken, [buildStageGuidanceMessage(session)]);
}

/**
 * Req 5.2（中断後の再開）・5.3（段階外/期待外入力への fallback）・6.2（リッチメニュー resume
 * postback）で共通に必要な「現在の段階で必要な操作の案内を再送する」処理を一箇所に集約する。
 * 各段階へ実際に入った際に送信したのと同一の文言をそのまま返す（5.3 の要件文言「案内を再送する」
 * を字義通り満たす＝新しい汎用の「わかりません」文言を作らない）。
 */
function buildStageGuidanceMessage(session: OnboardingSessionRow): LineMessage {
  switch (session.stage) {
    case 'await_invite_code':
      return buildGreetingMessage();
    case 'await_store_name':
      return buildStoreNameInputGuidanceMessage();
    case 'await_confirmation': {
      const candidate: StoreCandidate | undefined =
        session.selected_index !== null ? session.candidates?.[session.selected_index] : undefined;
      if (!candidate) {
        // CHECK 制約・本会話フローの構造上は起こり得ないが（await_confirmation は必ず選択済み
        // 候補を伴う）、セッション不整合時にクラッシュさせない防御的フォールバック
        // （handleConfirm と同じ方針）。
        return buildCandidateSelectionExpiredMessage();
      }
      return buildConfirmationMessage(candidate);
    }
    case 'completed':
      return buildAlreadyCompletedMessage();
  }
}

async function handleText(
  deps: ConversationDeps,
  event: Extract<InboundEvent, { kind: 'text' }>,
): Promise<void> {
  const session = await deps.sessions.getOrCreateSession(deps.db, event.lineUserId);

  if (session.stage === 'completed') {
    // Req 4.6: completed 段階への入力は、内容を問わず固定案内のみを返す。
    // セッション更新・再検索・その他の処理は一切行わない。
    await deps.messenger.reply(event.replyToken, [buildAlreadyCompletedMessage()]);
    return;
  }

  if (session.stage === 'await_store_name' || session.stage === 'await_confirmation') {
    // Req 3.1: 店名入力待ちのテキストは検索を起動する。
    // Req 3.4（design.md stateDiagram-v2「await_confirmation --> await_store_name : 取りやめ
    // または 新店名テキスト」）: 確認待ち中に別の店名テキストが届いた場合も同じ再検索経路で
    // 処理し、以前の選択（selected_index）は新しい検索結果に置き換えられて破棄される。
    await handleStoreNameSearch(deps, event, session);
    return;
  }

  // ここに到達するのは session.stage === 'await_invite_code' のみ（残り 3 段階は上で処理済み）。
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
  // ロックが既に期限切れの場合、失敗カウンタを 0 起点で数え直す（ロック時点の
  // 値のまま計算すると、解除直後の1回目の誤入力で新しい5回分の猶予無しに
  // 即座に再ロックしてしまうため）。
  const lockExpired = session.locked_until !== null && session.locked_until.getTime() <= deps.now().getTime();
  const currentFailures = lockExpired ? 0 : session.invite_failures;
  const nextFailures = currentFailures + 1;

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
    ...(lockExpired ? { lockedUntil: null } : {}),
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

// --- 店名検索〜確定段階（タスク 3.3: Req 3.1-3.4, 4.1, 4.2, 4.4, 4.5） ---

/**
 * Req 3.1: 店名テキストから候補検索を起動する。
 * Req 3.2: 0 件は再入力案内（stage は変更しない＝呼び出し元がすでに await_store_name なら不変）。
 * Req 3.3: 外部要因の検索失敗はエラー案内（進捗を失わない＝同上）。
 * Req 3.4: await_confirmation から届いた新しい店名テキストも本関数で処理し、以前の選択
 * （selected_index・以前の candidates）は新しい検索結果で置き換えられる形で await_store_name へ戻す。
 */
async function handleStoreNameSearch(
  deps: ConversationDeps,
  event: Extract<InboundEvent, { kind: 'text' }>,
  session: OnboardingSessionRow,
): Promise<void> {
  const outcome = await deps.identification.searchCandidates(event.text);

  switch (outcome.kind) {
    case 'found': {
      // 提示した候補をそのままセッションへ保存する（postback 選択時に手元の候補と照合するため）。
      // まだ候補が選択されたわけではないため stage は await_store_name のまま
      // （design.md「候補提示（3.1）は await_store_name に留まり、postback 選択の受理で
      // await_confirmation へ入る」）。
      await deps.sessions.updateSession(deps.db, event.lineUserId, {
        stage: 'await_store_name',
        candidates: [...outcome.candidates],
        selectedIndex: null,
      });
      await deps.messenger.reply(event.replyToken, [buildCandidateCarouselMessage(outcome.candidates)]);
      return;
    }
    case 'empty': {
      // Req 3.2: 進捗（候補等）は変更しない。await_confirmation から来た場合のみ
      // await_store_name へ戻す（Req 3.4 の状態遷移。すでに await_store_name なら no-op）。
      if (session.stage !== 'await_store_name') {
        await deps.sessions.updateSession(deps.db, event.lineUserId, { stage: 'await_store_name' });
      }
      await deps.messenger.reply(event.replyToken, [buildStoreNotFoundMessage()]);
      return;
    }
    case 'error': {
      // Req 3.3: 外部要因の失敗。進捗（候補等）は失わない。
      if (session.stage !== 'await_store_name') {
        await deps.sessions.updateSession(deps.db, event.lineUserId, { stage: 'await_store_name' });
      }
      await deps.messenger.reply(event.replyToken, [buildSearchFailedMessage()]);
      return;
    }
  }
}

async function handlePostback(
  deps: ConversationDeps,
  event: Extract<InboundEvent, { kind: 'postback' }>,
): Promise<void> {
  const session = await deps.sessions.getOrCreateSession(deps.db, event.lineUserId);

  if (session.stage === 'completed') {
    // Req 4.6: completed 段階では postback の種類（resume 導線含む）を問わず固定案内のみ返す。
    // セッション更新・その他の処理は一切行わない。data の decode すら行う必要がない
    // （decode 結果に関わらず結論は変わらないため）。
    await deps.messenger.reply(event.replyToken, [buildAlreadyCompletedMessage()]);
    return;
  }

  const action = decodePostback(event.data);

  if (!action || action.kind === 'resume') {
    // action === null: 不正・破損した postback data（Req 5.3 の安全側フォールバック）。
    // action.kind === 'resume': リッチメニューからの再開導線（Req 6.2）。
    // いずれも「現在の段階で必要な操作の案内」を再送する（completed はすでに上で処理済み）。
    await deps.messenger.reply(event.replyToken, [buildStageGuidanceMessage(session)]);
    return;
  }

  if (session.stage === 'await_store_name' && action.kind === 'select_candidate') {
    return handleSelectCandidate(deps, event, session, action.index);
  }
  if (session.stage === 'await_confirmation' && action.kind === 'confirm') {
    return handleConfirm(deps, event, session);
  }
  if (session.stage === 'await_confirmation' && action.kind === 'restart') {
    return handleRestart(deps, event);
  }

  // Req 5.3: stage と action の組み合わせが一致しない（例: await_invite_code 中の confirm、
  // await_confirmation 中の select_candidate 等）。現在の段階の案内を再送する。
  await deps.messenger.reply(event.replyToken, [buildStageGuidanceMessage(session)]);
}

/**
 * Req 4.1: 候補選択の postback を受け取り、セッションに保存された候補配列と index を照合する。
 * Req 3.4 隣接: 古いカルーセル（再検索前）からの選択や、候補未保存状態での選択など、
 * 範囲外・不整合な index は例外を投げずに安全側フォールバック案内へ倒す
 * （`noUncheckedIndexedAccess` により配列の範囲外アクセスは型上も `undefined` となる）。
 */
async function handleSelectCandidate(
  deps: ConversationDeps,
  event: Extract<InboundEvent, { kind: 'postback' }>,
  session: OnboardingSessionRow,
  index: number,
): Promise<void> {
  const candidate: StoreCandidate | undefined = session.candidates?.[index];

  if (!candidate) {
    await deps.messenger.reply(event.replyToken, [buildCandidateSelectionExpiredMessage()]);
    return;
  }

  await deps.sessions.updateSession(deps.db, event.lineUserId, {
    stage: 'await_confirmation',
    selectedIndex: index,
  });
  await deps.messenger.reply(event.replyToken, [buildConfirmationMessage(candidate)]);
}

/**
 * Req 4.2: 確定 postback。セッションに保存された「実際に提示された候補」（session.candidates と
 * selected_index から導出）をそのまま StoreIdentificationService.confirmStore に渡す
 * （再検索・再取得は行わない＝提示内容と確定内容の不一致を防ぐ）。
 * Req 4.4: 既に他オーナーへ登録済みの Place は確定を行わず、運営への問い合わせ案内を返す。
 * stage は据え置く（候補自体が確定不能と判明しただけで、要件は「確定を行わず案内する」のみを
 * 求めており stage 変更を要求しないため。ユーザーはやり直す postback で再検索に戻れる）。
 */
async function handleConfirm(
  deps: ConversationDeps,
  event: Extract<InboundEvent, { kind: 'postback' }>,
  session: OnboardingSessionRow,
): Promise<void> {
  const candidate: StoreCandidate | undefined =
    session.selected_index !== null ? session.candidates?.[session.selected_index] : undefined;

  if (!session.owner_id || !candidate) {
    // 構造的には CHECK 制約（await_confirmation では owner_id 必須）と本会話フロー
    // （選択済みでなければ await_confirmation に入らない）により起こり得ないが、
    // セッション不整合時にクラッシュさせないための防御的フォールバック。
    await deps.messenger.reply(event.replyToken, [buildCandidateSelectionExpiredMessage()]);
    return;
  }

  const outcome = await deps.identification.confirmStore(session.owner_id, candidate);

  if (outcome.kind === 'place_already_registered') {
    await deps.messenger.reply(event.replyToken, [buildPlaceAlreadyRegisteredMessage()]);
    return;
  }

  await deps.sessions.updateSession(deps.db, event.lineUserId, { stage: 'completed' });
  await deps.messenger.reply(event.replyToken, [buildCompletionMessage()]);

  // Req 6.3: 完了時にリッチメニューを完了後メニューへ即時切り替える。
  // owner の状態遷移（onboarding_status='store_identified'）はすでに confirmStore 内の
  // トランザクションで commit 済みであり、この呼び出しはそれに付随するベストエフォートな
  // UX 補助動作（LINE 側のリッチメニュー割り当て）に過ぎない。ここで失敗しても
  // 巻き戻すべきトランザクションは存在せず、また reply は既に送信済みのため、
  // handleEvent 全体を失敗させることなく握りつぶす
  // （design.md「LineMessenger」の reply 失敗時の扱いと同じ「例外にしない」方針）。
  // ConversationDeps には専用ロガーが注入されていないため、ここでは記録しない
  // （将来ロガーが追加された場合はここに warn を追加すること）。
  try {
    await deps.messenger.linkRichMenu(event.lineUserId, deps.lineRichMenuCompletedId);
  } catch {
    // 意図的に無視する（上記コメント参照）。
  }
}

/** Req 4.5: 確認段階での取りやめ。店名入力からやり直せる状態に戻す。 */
async function handleRestart(
  deps: ConversationDeps,
  event: Extract<InboundEvent, { kind: 'postback' }>,
): Promise<void> {
  await deps.sessions.updateSession(deps.db, event.lineUserId, {
    stage: 'await_store_name',
    candidates: null,
    selectedIndex: null,
  });
  await deps.messenger.reply(event.replyToken, [buildStoreNameInputGuidanceMessage()]);
}
