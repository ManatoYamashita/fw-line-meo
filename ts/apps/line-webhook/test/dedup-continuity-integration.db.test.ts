import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import {
  getPool,
  closePool,
  getOrCreateSession,
  updateSession,
  findOwnerByLineUserId,
  createOwner,
  findActiveInviteCode,
  recordWebhookEventOnce,
} from '@fwlm/db';
import type { StoreCandidate } from '@fwlm/db';
import { createApp, type AppDeps } from '../src/app.js';
import { createSignatureVerifier } from '../src/webhook/signature.js';
import { createConversationHandlers } from '../src/onboarding/conversation.js';
import { createStoreIdentificationService } from '@fwlm/store-identification';
import type { LineMessenger } from '../src/line/client.js';
import type { PlacesSearchAdapter, SearchOutcome } from '@fwlm/store-identification';
import {
  buildGreetingMessage,
  buildStoreNameInputGuidanceMessage,
  buildCandidateCarouselMessage,
} from '../src/line/messages.js';

// タスク 5.2「重複防止と継続性の統合検証」。
// 既存カバレッジとの棲み分け（Implementation Notes・タスク割当メモ参照）:
//   - ts/apps/line-webhook/test/app-flow.db.test.ts（4.2）: 招待コードテキストイベントの
//     重複 webhookEventId を1点のみ検証済み（ハッピーパスの一部として）。本ファイルは
//     ディスパッチ層の dedup を「follow イベントの重複」という別シナリオで独立に検証する。
//   - ts/apps/line-webhook/test/onboarding/conversation.test.ts（3.2-3.4）: モック deps での
//     再友だち追加・段階案内の再送をユニットレベルで検証済み。本ファイルは同じ業務ルールを
//     実 postgres に対して駆動し直し、真の永続化を証明する。
//   - ts/apps/line-webhook/test/onboarding/invite-code-integration.db.test.ts（5.1）: 招待コード
//     固有の複数オーナー・無効化シナリオに特化。本ファイルはそれらと重複しない。
// 本ファイルはさらに、「別プロセス/別リクエストとして再訪した際に本当に DB からセッション状態を
// 読み戻しているか」（プロセスローカルなキャッシュに依存していないか）を、
// 同一 pool を共有するが JS 参照を一切共有しない 2 つの独立した Hono アプリインスタンス
// （createApp の 2 回の呼び出し）を跨いで直接 SQL で検証することで担保する。
//
// 他ファイルと衝突しない専用 UUID プレフィックス（f2。5.1 の Implementation Notes に
// 「次は f2 以降」と明記されている）。DATABASE_URL 無しは skip。
const OP = 'f2222222-2222-2222-2222-222222222220';
const AG = 'f2222222-2222-2222-2222-222222222221';

const CHANNEL_SECRET = 'f2-test-channel-secret';
const RICHMENU_COMPLETED_ID = 'f2-richmenu-completed';
const INVITE_CODE = 'F2ACTIVE01';

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

function followBody(userId: string, replyToken: string, webhookEventId: string): string {
  return JSON.stringify({
    destination: 'Uxxxxbotxxxx',
    events: [
      {
        type: 'follow',
        replyToken,
        source: { type: 'user', userId },
        webhookEventId,
      },
    ],
  });
}

function textBody(
  userId: string,
  replyToken: string,
  webhookEventId: string,
  text: string,
): string {
  return JSON.stringify({
    destination: 'Uxxxxbotxxxx',
    events: [
      {
        type: 'message',
        replyToken,
        source: { type: 'user', userId },
        webhookEventId,
        message: { type: 'text', text },
      },
    ],
  });
}

function candidate(overrides: Partial<StoreCandidate> = {}): StoreCandidate {
  return {
    placeId: 'ChIJ_f2_default',
    name: 'テスト食堂',
    address: '東京都テスト区2-2-2',
    latitude: 35.6,
    longitude: 139.7,
    types: ['restaurant'],
    ...overrides,
  };
}

// LINE/Google の外部 API を叩かないフェイク。
function createFakePlaces(outcome: SearchOutcome): PlacesSearchAdapter {
  return { searchCandidates: vi.fn(async () => outcome) };
}

// 店名検索が発生しないはずのシナリオ（follow・招待コード段階のみ）で誤って呼ばれた場合に
// テストの前提崩れを明確に失敗させる（5.1 の同種フェイクと同じ方針）。
function createUnusedPlaces(): PlacesSearchAdapter {
  return {
    searchCandidates: vi.fn(async () => {
      throw new Error('unexpected searchCandidates call in dedup-continuity-integration test');
    }),
  };
}

function createFakeMessenger(profiles: Record<string, string | undefined> = {}): LineMessenger {
  return {
    reply: vi.fn(async (): Promise<void> => {}),
    getProfile: vi.fn(async (lineUserId: string) => {
      const displayName = profiles[lineUserId];
      return displayName ? { displayName } : null;
    }),
    linkRichMenu: vi.fn(async (): Promise<void> => {}),
  };
}

describe.skipIf(!process.env.DATABASE_URL)('line-webhook 重複防止と継続性の統合検証 (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, 'dedup-continuity運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      AG,
      OP,
      'dedup-continuity代理店',
    ]);
    await pool.query('INSERT INTO agency_invite_codes (agency_id, code) VALUES ($1, $2)', [
      AG,
      INVITE_CODE,
    ]);
  });

  afterAll(async () => {
    await closePool();
  });

  // 実 DB アクセサ＋フェイク messenger/places で組み立てた本物の ConversationHandlers を持つ
  // 独立した Hono アプリインスタンスを構築する（app-flow.db.test.ts と同じ配線パターン）。
  // 呼び出すたびに新しいクロージャ変数（dispatcher・inFlightReplyToken 等）を持つ全く別の
  // インスタンスになる点が、継続性シナリオでの「プロセスローカルキャッシュに依存していないか」の
  // 検証にとって重要。
  function buildApp(deps: {
    messenger: LineMessenger;
    places: PlacesSearchAdapter;
    pool: Awaited<ReturnType<typeof getPool>>;
  }) {
    const identification = createStoreIdentificationService({
      pool: deps.pool,
      places: deps.places,
    });
    const conversationHandlers = createConversationHandlers({
      db: deps.pool,
      pool: deps.pool,
      sessions: { getOrCreateSession, updateSession },
      owners: { findOwnerByLineUserId, createOwner },
      inviteCodes: { findActiveInviteCode },
      identification,
      messenger: deps.messenger,
      now: () => new Date(),
      lineRichMenuCompletedId: RICHMENU_COMPLETED_ID,
    });

    const appDeps: AppDeps = {
      signatureVerifier: createSignatureVerifier(CHANNEL_SECRET),
      recordWebhookEventOnce: (webhookEventId) => recordWebhookEventOnce(deps.pool, webhookEventId),
      conversationHandlers,
      messenger: deps.messenger,
      logger: { error: vi.fn() },
    };

    return createApp(appDeps);
  }

  it(
    '重複 webhookEventId（follow イベントを同一 id で2回送信）は2回目がディスパッチ層で' +
      'スキップされ、line_webhook_events への記録・会話処理・reply がいずれも1回のみ行われる（Req 5.4）',
    async () => {
      const pool = await getPool();
      const userId = 'Uf2-dedup-follow-user';
      const messenger = createFakeMessenger();
      const places = createUnusedPlaces();
      const app = buildApp({ messenger, places, pool });

      const webhookEventId = 'f2-evt-dedup-follow';
      const body = followBody(userId, 'reply-f2-dedup-1', webhookEventId);
      const headers = { 'x-line-signature': sign(body, CHANNEL_SECRET) };

      const firstRes = await app.request('/webhook', { method: 'POST', headers, body });
      const secondRes = await app.request('/webhook', { method: 'POST', headers, body });

      expect(firstRes.status).toBe(200);
      expect(secondRes.status).toBe(200);

      // ディスパッチ層の dedup（recordWebhookEventOnce）が実 DB に対して機能していることの
      // 直接証拠: 該当 webhookEventId は line_webhook_events に厳密に1件のみ存在する。
      const evt = await pool.query(
        'SELECT COUNT(*)::int AS count FROM line_webhook_events WHERE webhook_event_id = $1',
        [webhookEventId],
      );
      expect(evt.rows[0]?.count).toBe(1);

      // dedup が壊れていれば2回目も handleFollow が実行され reply が2回呼ばれるはず。
      // 実際には1回のみ＝会話処理そのものが2回目でスキップされたことの証拠。
      expect(messenger.reply).toHaveBeenCalledTimes(1);
      expect(messenger.reply).toHaveBeenNthCalledWith(1, 'reply-f2-dedup-1', [buildGreetingMessage()]);

      // セッション行も1回の getOrCreateSession のみに由来し、二重作成されていない。
      const sessions = await pool.query(
        'SELECT COUNT(*)::int AS count FROM onboarding_sessions WHERE line_user_id = $1',
        [userId],
      );
      expect(sessions.rows[0]?.count).toBe(1);
    },
  );

  it(
    '既存 owner が再度 follow（別 webhookEventId・実際の新規配信）しても owners 行は重複作成されず、' +
      '既存セッションの現在段階に応じた案内が返る（新規挨拶ではない。Req 1.2, 5.2）',
    async () => {
      const pool = await getPool();
      const userId = 'Uf2-refollow-user';
      const messenger = createFakeMessenger({ [userId]: '再訪太郎' });
      const places = createUnusedPlaces();
      const app = buildApp({ messenger, places, pool });

      // 1. 初回 follow → 挨拶（未登録ユーザー）。
      const firstFollowBody = followBody(userId, 'reply-f2-refollow-1', 'f2-evt-refollow-follow-1');
      const firstFollowRes = await app.request('/webhook', {
        method: 'POST',
        headers: { 'x-line-signature': sign(firstFollowBody, CHANNEL_SECRET) },
        body: firstFollowBody,
      });
      expect(firstFollowRes.status).toBe(200);
      expect(messenger.reply).toHaveBeenNthCalledWith(1, 'reply-f2-refollow-1', [buildGreetingMessage()]);

      // 2. 有効な招待コードで owner 作成・await_store_name へ遷移。
      const inviteBody = textBody(userId, 'reply-f2-refollow-2', 'f2-evt-refollow-invite', INVITE_CODE);
      const inviteRes = await app.request('/webhook', {
        method: 'POST',
        headers: { 'x-line-signature': sign(inviteBody, CHANNEL_SECRET) },
        body: inviteBody,
      });
      expect(inviteRes.status).toBe(200);
      expect(messenger.reply).toHaveBeenNthCalledWith(2, 'reply-f2-refollow-2', [
        buildStoreNameInputGuidanceMessage(),
      ]);

      const ownerAfterInvite = await findOwnerByLineUserId(pool, userId);
      expect(ownerAfterInvite).not.toBeNull();

      // 3. 再度 follow（ブロック解除等を模す、実際に別の webhookEventId を持つ新規配信。
      //    これは dedup シナリオではなく、Req 1.2 が要求する「再友だち追加」そのもの）。
      const secondFollowBody = followBody(userId, 'reply-f2-refollow-3', 'f2-evt-refollow-follow-2');
      const secondFollowRes = await app.request('/webhook', {
        method: 'POST',
        headers: { 'x-line-signature': sign(secondFollowBody, CHANNEL_SECRET) },
        body: secondFollowBody,
      });
      expect(secondFollowRes.status).toBe(200);

      // 既存セッションの現在段階（await_store_name）に応じた案内が返る＝新規挨拶ではない。
      expect(messenger.reply).toHaveBeenNthCalledWith(3, 'reply-f2-refollow-3', [
        buildStoreNameInputGuidanceMessage(),
      ]);
      expect(messenger.reply).not.toHaveBeenNthCalledWith(3, 'reply-f2-refollow-3', [
        buildGreetingMessage(),
      ]);

      // owners 行はこの line_user_id につき厳密に1件のみ（重複作成なし）。
      const ownersCount = await pool.query(
        'SELECT COUNT(*)::int AS count FROM owners WHERE line_user_id = $1',
        [userId],
      );
      expect(ownersCount.rows[0]?.count).toBe(1);

      // 再友だち追加によって owner 行自体が新規作成・変化していないことの決定的な証拠。
      const ownerFinal = await findOwnerByLineUserId(pool, userId);
      expect(ownerFinal?.id).toBe(ownerAfterInvite?.id);
      expect(ownerFinal?.onboarding_status).toBe(ownerAfterInvite?.onboarding_status);
    },
  );

  it(
    '中断→再訪: 招待コード段階を経て await_store_name に到達した後、' +
      '一切 JS 参照を共有しない別の Hono アプリインスタンス（同一 DB pool のみ共有）からの' +
      '後続リクエストが、実 DB から同一 stage を読み戻して店名検索を正しく処理する（Req 5.1, 5.2）',
    async () => {
      const pool = await getPool();
      const userId = 'Uf2-stage-persist-user';

      // --- 1つ目のアプリインスタンス: follow → 招待コード。await_store_name に到達して「中断」する。 ---
      const messenger1 = createFakeMessenger({ [userId]: '中断太郎' });
      const app1 = buildApp({ messenger: messenger1, places: createUnusedPlaces(), pool });

      const followBodyStr = followBody(userId, 'reply-f2-persist-1', 'f2-evt-persist-follow');
      const followRes = await app1.request('/webhook', {
        method: 'POST',
        headers: { 'x-line-signature': sign(followBodyStr, CHANNEL_SECRET) },
        body: followBodyStr,
      });
      expect(followRes.status).toBe(200);

      const inviteBody = textBody(userId, 'reply-f2-persist-2', 'f2-evt-persist-invite', INVITE_CODE);
      const inviteRes = await app1.request('/webhook', {
        method: 'POST',
        headers: { 'x-line-signature': sign(inviteBody, CHANNEL_SECRET) },
        body: inviteBody,
      });
      expect(inviteRes.status).toBe(200);
      expect(messenger1.reply).toHaveBeenNthCalledWith(2, 'reply-f2-persist-2', [
        buildStoreNameInputGuidanceMessage(),
      ]);

      // --- 「中断」の直接証拠: DB へ直接クエリし、await_store_name で永続化されていることを
      //     app1 のプロセス内状態を一切経由せず確認する。 ---
      const sessionMidway = await pool.query<{ stage: string; owner_id: string | null }>(
        'SELECT stage, owner_id FROM onboarding_sessions WHERE line_user_id = $1',
        [userId],
      );
      expect(sessionMidway.rows[0]?.stage).toBe('await_store_name');
      expect(sessionMidway.rows[0]?.owner_id).not.toBeNull();

      // --- 「再訪」: 全く別の Hono アプリインスタンス（app1 とは別の dispatcher・別の
      //     messenger フェイク・別の ConversationHandlers クロージャを持ち、JS 参照は
      //     一切共有しない。共有するのは同一 DB pool のみ）。
      //     店名検索がここで正しく機能するなら、それは「実際に DB から stage を読み戻した」
      //     ことの証拠であり、プロセスローカルなキャッシュに依存していないことを示す。
      const candidate0 = candidate({ placeId: 'ChIJ_f2_persist_0', name: '中断食堂' });
      const messenger2 = createFakeMessenger({ [userId]: '中断太郎' });
      const places2 = createFakePlaces({ kind: 'found', candidates: [candidate0] });
      const app2 = buildApp({ messenger: messenger2, places: places2, pool });

      const searchBody = textBody(userId, 'reply-f2-persist-3', 'f2-evt-persist-search', '中断食堂');
      const searchRes = await app2.request('/webhook', {
        method: 'POST',
        headers: { 'x-line-signature': sign(searchBody, CHANNEL_SECRET) },
        body: searchBody,
      });
      expect(searchRes.status).toBe(200);
      expect(messenger2.reply).toHaveBeenCalledTimes(1);
      expect(messenger2.reply).toHaveBeenNthCalledWith(1, 'reply-f2-persist-3', [
        buildCandidateCarouselMessage([candidate0]),
      ]);

      // --- 検索後も再度 DB へ直接クエリし、stage が維持され candidates が実際に永続化されたことを
      //     確認する（app2 の戻り値やモック呼び出しのみに頼らない）。 ---
      const sessionAfter = await pool.query<{ stage: string; candidates: StoreCandidate[] | null }>(
        'SELECT stage, candidates FROM onboarding_sessions WHERE line_user_id = $1',
        [userId],
      );
      expect(sessionAfter.rows[0]?.stage).toBe('await_store_name');
      expect(sessionAfter.rows[0]?.candidates).toEqual([candidate0]);
    },
  );
});
