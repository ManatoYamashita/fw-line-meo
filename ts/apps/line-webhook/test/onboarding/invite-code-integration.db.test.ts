import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { getPool, closePool, findOwnerByLineUserId } from '@fwlm/db';
import { createConversationHandlers } from '../../src/onboarding/conversation.js';
import { createStoreIdentifiedOwnerRouterFactory } from '../../src/owner/router.js';
import { createStoreIdentificationService } from '@fwlm/store-identification';
import {
  getOrCreateSession,
  updateSession,
  createOwner,
  findActiveInviteCode,
} from '@fwlm/db';
import type { InboundEvent } from '../../src/webhook/dispatch.js';
import type { LineMessenger } from '../../src/line/client.js';
import type { PlacesSearchAdapter } from '@fwlm/store-identification';
import {
  buildGreetingMessage,
  buildStoreNameInputGuidanceMessage,
  buildInvalidInviteCodeMessage,
} from '../../src/line/messages.js';

// タスク 5.1「招待コード〜owner作成の統合検証」。
// 既存カバレッジとの棲み分け（Implementation Notes・タスク割当メモ参照）:
//   - ts/packages/db/test/invite-codes.db.test.ts（1.2）: findActiveInviteCode 単体（コード再利用性・
//     disabled_at 除外）を低レイヤで検証済み。
//   - ts/packages/db/test/owners.db.test.ts（1.2）: createOwner/findOwnerByLineUserId 単体を検証済み。
//   - ts/apps/line-webhook/test/app-flow.db.test.ts（4.2）: follow→…→完了のハッピーパス全通しを
//     「1 コード・1 オーナー」で検証済み（2 人目再利用・無効化後拒否は対象外）。
// 本ファイルは createConversationHandlers（3.2 実装）の招待コード段階ロジックを実 DB に対して駆動し、
// Requirement 2.5 の核心（同一コードでの複数オーナー登録・disabled_at 設定後の拒否）を、
// 上記いずれのファイルもカバーしていない「複数オーナーにまたがる」シナリオとして追加検証する。
//
// 他ファイルと衝突しない専用 UUID プレフィックス（f1。4.2 の Implementation Notes に「次は f1 以降」と
// 明記されている）。DATABASE_URL 無しは skip。
const OP = 'f1111111-1111-1111-1111-111111111110';
const AG = 'f1111111-1111-1111-1111-111111111111';

const RICHMENU_COMPLETED_ID = 'f1-richmenu-completed';
const LIFF_STORE_DETAIL_URL = 'https://liff.line.me/test-liff-id';
const INVITE_CODE = 'F1SHARED01';
// 入力の揺れ（小文字・前後の空白・改行・全角）の検証専用のコード。上のシナリオは INVITE_CODE を無効化するので分ける。
// 照合仕様の正常系を発行される形の値で確かめるため、発行形式（dashboard-api の invite-code-gen.ts の 31 字集合・8 字）に合わせる。
const CASED_INVITE_CODE = 'F7KQ2MXR';
const ISSUED_CODE_FORMAT = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);

/** 半角の英数字を全角へ（U+FF01〜U+FF5E は ASCII の 0x21〜0x7E から 0xFEE0 ずれた位置にある）。 */
function toFullWidth(text: string): string {
  return text.replace(/[!-~]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0));
}

const USER1 = 'Uf1-invite-owner-1';
const USER2 = 'Uf1-invite-owner-2';
const USER3 = 'Uf1-invite-owner-3';
const USER4 = 'Uf1-invite-owner-4';
const USER5 = 'Uf1-invite-owner-5';

// LINE/Google の外部 API を叩かないフェイク（本テストは招待コード段階のみを駆動するため
// searchCandidates は呼ばれない想定。呼ばれた場合はテストの前提が崩れているため明確に失敗させる）。
function createUnusedPlaces(): PlacesSearchAdapter {
  return {
    searchCandidates: vi.fn(async () => {
      throw new Error('unexpected searchCandidates call in invite-code-integration test');
    }),
  };
}

function createFakeMessenger(): LineMessenger {
  return {
    reply: vi.fn(async (): Promise<void> => {}),
    push: vi.fn(async (): Promise<void> => {}),
    getProfile: vi.fn(async () => null),
    linkRichMenu: vi.fn(async (): Promise<void> => {}),
    startLoading: vi.fn(async (): Promise<void> => {}),
  };
}

function follow(lineUserId: string, replyToken: string): InboundEvent {
  return { kind: 'follow', lineUserId, replyToken };
}

function text(lineUserId: string, replyToken: string, body: string): InboundEvent {
  return { kind: 'text', lineUserId, replyToken, text: body };
}

function createHandlers(pool: Awaited<ReturnType<typeof getPool>>, messenger: LineMessenger) {
  const identification = createStoreIdentificationService({ pool, places: createUnusedPlaces() });
  return createConversationHandlers({
    db: pool,
    pool,
    sessions: { getOrCreateSession, updateSession },
    owners: { findOwnerByLineUserId, createOwner },
    inviteCodes: { findActiveInviteCode },
    identification,
    messenger,
    now: () => new Date(),
    // 補助的処理の成否の記録。内容の検証は conversation.test.ts が担う。
    logger: { info: vi.fn(), warn: vi.fn() },
    lineRichMenuCompletedId: RICHMENU_COMPLETED_ID,
    liffStoreDetailUrl: LIFF_STORE_DETAIL_URL,
    createOwnerRouter: createStoreIdentifiedOwnerRouterFactory({
      db: pool,
      sessions: { getOrCreateSession, updateSession },
      lineRichMenuCompletedId: RICHMENU_COMPLETED_ID,
      liffStoreDetailUrl: LIFF_STORE_DETAIL_URL,
    }),
  });
}

describe.skipIf(!process.env.DATABASE_URL)('招待コード〜owner作成の統合検証 (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, 'invite-integration運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      AG,
      OP,
      'invite-integration代理店',
    ]);
    await pool.query('INSERT INTO agency_invite_codes (agency_id, code) VALUES ($1, $2)', [
      AG,
      INVITE_CODE,
    ]);
    await pool.query('INSERT INTO agency_invite_codes (agency_id, code) VALUES ($1, $2)', [
      AG,
      CASED_INVITE_CODE,
    ]);
  });

  afterAll(async () => {
    await closePool();
  });

  it(
    '有効コードでの owner 作成＋CHECK 制約検証 → 同一コードでの 2 人目登録成功 → ' +
      '無効化後の 3 人目拒否 を通しで検証する（Req 2.1, 2.4, 2.5）',
    async () => {
      const pool = await getPool();
      const messenger = createFakeMessenger();
      const handlers = createHandlers(pool, messenger);

      // --- 1. 有効コードでの owner 作成（Req 2.1）＋ CHECK 制約検証（Req 2.4） ---
      await handlers.handleEvent(follow(USER1, 'reply-f1-1a'));
      expect(messenger.reply).toHaveBeenNthCalledWith(1, 'reply-f1-1a', [buildGreetingMessage()]);

      await handlers.handleEvent(text(USER1, 'reply-f1-1b', INVITE_CODE));
      expect(messenger.reply).toHaveBeenNthCalledWith(2, 'reply-f1-1b', [
        buildStoreNameInputGuidanceMessage(),
      ]);

      const owner1 = await findOwnerByLineUserId(pool, USER1);
      expect(owner1).not.toBeNull();
      expect(owner1?.agency_id).toBe(AG); // Req 2.4: 代理店未確定オーナーは存在しない
      expect(owner1?.onboarding_status).toBe('pending');

      // セッション行を直接 DB から取得し、`ck_session_owner_stage`
      // （(stage = 'await_invite_code') = (owner_id IS NULL)）の不変条件が
      // 「stage は await_invite_code から離脱済み・owner_id は非 NULL」の組み合わせで
      // 実際に両立していることを明示的に検証する（Req 2.4 の構造保証をテストでも裏付ける）。
      const session1 = await pool.query<{ stage: string; owner_id: string | null }>(
        'SELECT stage, owner_id FROM onboarding_sessions WHERE line_user_id = $1',
        [USER1],
      );
      expect(session1.rows[0]?.stage).toBe('await_store_name');
      expect(session1.rows[0]?.stage).not.toBe('await_invite_code');
      expect(session1.rows[0]?.owner_id).not.toBeNull();
      expect(session1.rows[0]?.owner_id).toBe(owner1?.id);

      // --- 2. 同一コードで 2 人目のオーナー登録も成功する（Req 2.5: コードは共有・再利用可能） ---
      await handlers.handleEvent(follow(USER2, 'reply-f1-2a'));
      expect(messenger.reply).toHaveBeenNthCalledWith(3, 'reply-f1-2a', [buildGreetingMessage()]);

      await handlers.handleEvent(text(USER2, 'reply-f1-2b', INVITE_CODE));
      expect(messenger.reply).toHaveBeenNthCalledWith(4, 'reply-f1-2b', [
        buildStoreNameInputGuidanceMessage(),
      ]);

      const owner2 = await findOwnerByLineUserId(pool, USER2);
      expect(owner2).not.toBeNull();
      expect(owner2?.agency_id).toBe(AG); // Req 2.4（2人目についても構造的に成立することを明示）
      expect(owner2?.id).not.toBe(owner1?.id); // 2 人の別々の owner 行であることの決定的な証拠

      // 1 人目の owner 行は 2 人目の登録によって一切変化していない。
      const owner1After = await findOwnerByLineUserId(pool, USER1);
      expect(owner1After?.id).toBe(owner1?.id);
      expect(owner1After?.agency_id).toBe(owner1?.agency_id);
      expect(owner1After?.onboarding_status).toBe(owner1?.onboarding_status);

      // --- 3. コードを無効化（運営の SQL 操作を模す。Out of Boundary: 発行/無効化 UI は Issue #5） ---
      await pool.query('UPDATE agency_invite_codes SET disabled_at = now() WHERE code = $1', [
        INVITE_CODE,
      ]);

      // --- 4. 無効化後は 3 人目の同一コード送信が拒否される（Req 2.2 の帰結・2.5 の裏面） ---
      await handlers.handleEvent(follow(USER3, 'reply-f1-3a'));
      expect(messenger.reply).toHaveBeenNthCalledWith(5, 'reply-f1-3a', [buildGreetingMessage()]);

      await handlers.handleEvent(text(USER3, 'reply-f1-3b', INVITE_CODE));
      // ストア名入力案内ではなく、無効コード案内が返っていることを明示的に区別する。
      expect(messenger.reply).toHaveBeenNthCalledWith(6, 'reply-f1-3b', [
        buildInvalidInviteCodeMessage(),
      ]);
      expect(messenger.reply).not.toHaveBeenNthCalledWith(6, 'reply-f1-3b', [
        buildStoreNameInputGuidanceMessage(),
      ]);

      const owner3 = await findOwnerByLineUserId(pool, USER3);
      expect(owner3).toBeNull(); // owner は作成されていない

      const session3 = await pool.query<{ stage: string; owner_id: string | null; invite_failures: number }>(
        'SELECT stage, owner_id, invite_failures FROM onboarding_sessions WHERE line_user_id = $1',
        [USER3],
      );
      expect(session3.rows[0]?.stage).toBe('await_invite_code'); // 段階は進んでいない
      expect(session3.rows[0]?.owner_id).toBeNull();
      expect(session3.rows[0]?.invite_failures).toBe(1); // 無効コードとして失敗カウントされている

      expect(messenger.reply).toHaveBeenCalledTimes(6);
    },
  );

  it.each([
    ['小文字・前後の空白・末尾の改行', USER4, ` ${CASED_INVITE_CODE.toLowerCase()}\n`],
    ['全角英数（小文字）・全角スペース', USER5, `${toFullWidth(CASED_INVITE_CODE.toLowerCase())}${IDEOGRAPHIC_SPACE}`],
  ])('%s の入力でも、実 DB の大文字のコードに解決して登録へ進む', async (_label, lineUserId, input) => {
    expect(CASED_INVITE_CODE).toMatch(ISSUED_CODE_FORMAT);
    // 入力が実際に揺れている（そのままでは完全一致しない）ことを確かめ、テストの空振りを防ぐ。
    expect(input).not.toBe(CASED_INVITE_CODE);
    const pool = await getPool();
    const messenger = createFakeMessenger();
    const handlers = createHandlers(pool, messenger);

    await handlers.handleEvent(follow(lineUserId, `reply-${lineUserId}-a`));
    await handlers.handleEvent(text(lineUserId, `reply-${lineUserId}-b`, input));

    expect(messenger.reply).toHaveBeenNthCalledWith(2, `reply-${lineUserId}-b`, [
      buildStoreNameInputGuidanceMessage(),
    ]);
    const owner = await findOwnerByLineUserId(pool, lineUserId);
    expect(owner?.agency_id).toBe(AG);
    const session = await pool.query<{ stage: string; invite_failures: number }>(
      'SELECT stage, invite_failures FROM onboarding_sessions WHERE line_user_id = $1',
      [lineUserId],
    );
    expect(session.rows[0]?.stage).toBe('await_store_name');
    expect(session.rows[0]?.invite_failures).toBe(0);
  });
});
