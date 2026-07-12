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
  findStoreByPlaceId,
  recordWebhookEventOnce,
} from '@fwlm/db';
import type { StoreCandidate } from '@fwlm/db';
import { createApp, type AppDeps } from '../src/app.js';
import { createSignatureVerifier } from '../src/webhook/signature.js';
import { createConversationHandlers } from '../src/onboarding/conversation.js';
import { createStoreIdentificationService } from '../src/onboarding/store-identification.js';
import { encodePostback } from '../src/onboarding/stages.js';
import type { LineMessenger } from '../src/line/client.js';
import type { PlacesSearchAdapter, SearchOutcome } from '../src/places/search.js';
import {
  buildGreetingMessage,
  buildStoreNameInputGuidanceMessage,
  buildCandidateCarouselMessage,
  buildConfirmationMessage,
  buildCompletionMessage,
} from '../src/line/messages.js';

// アプリレベルのフローテスト（タスク 4.2）。
// 実 postgres（ts-test-db）＋実 HTTP（app.request）＋実署名検証を貫通させ、
// LINE/Google の外部 API のみフェイクに差し替える（messenger／places）。
// index.ts の実配線（pool/recordWebhookEventOnce/ConversationHandlers 一式）を、
// index.ts 自体を経由せず createApp(deps) に対して同じ形の deps を組み立てて検証する
// （index.ts は Cloud Run 起動用の env 読み込み＋トップレベル await を含むため、
// テストからは createApp への配線を直接再現するのが素直）。
//
// 他ファイルと衝突しない専用 UUID プレフィックス（f0）。DATABASE_URL 無しは skip。
const OP = 'f0000000-0000-0000-0000-000000000000';
const AG = 'f0000000-0000-0000-0000-000000000001';

const CHANNEL_SECRET = 'f0-test-channel-secret';
const WRONG_CHANNEL_SECRET = 'f0-wrong-channel-secret';
const RICHMENU_COMPLETED_ID = 'f0-richmenu-completed';
const INVITE_CODE = 'F0ACTIVE01';

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

function postbackBody(
  userId: string,
  replyToken: string,
  webhookEventId: string,
  data: string,
): string {
  return JSON.stringify({
    destination: 'Uxxxxbotxxxx',
    events: [
      {
        type: 'postback',
        replyToken,
        source: { type: 'user', userId },
        webhookEventId,
        postback: { data },
      },
    ],
  });
}

function pingBody(): string {
  return JSON.stringify({ destination: 'Uxxxxbotxxxx', events: [] });
}

// Req 5.5 の応答時間（5 秒以内）に対する軽量な回帰ガード。
// 注意: これは本番 SLA の充足を証明するテストではない。この sandbox テスト環境の
// messenger/places アダプタはフェイク（ネットワーク往復なし）で応答が近瞬時であるため、
// ここで検証できるのは「リクエスト処理経路そのものに大きな事故的劣化がないこと」のみ。
// 本番での実 5 秒予算は LINE の reply token 有効期限内に、実 Places API・実 LINE API への
// ネットワークレイテンシを含めて収める必要があり（design.md 「Performance & Scalability」
// 応答予算 5.5 の記述を参照）、それは実ネットワークを経由しないこの環境では再現できない。
const RESPONSE_TIME_SANITY_BUDGET_MS = 5000;

async function timeWebhookRequest(
  app: ReturnType<typeof createApp>,
  init: { method: string; headers?: Record<string, string>; body: string },
): Promise<{ res: Response; elapsedMs: number }> {
  const startedAt = performance.now();
  const res = await app.request('/webhook', init);
  const elapsedMs = performance.now() - startedAt;
  return { res, elapsedMs };
}

function candidate(overrides: Partial<StoreCandidate> = {}): StoreCandidate {
  return {
    placeId: 'ChIJ_f0_default',
    name: 'テスト食堂',
    address: '東京都テスト区1-1-1',
    latitude: 35.6,
    longitude: 139.7,
    types: ['restaurant'],
    ...overrides,
  };
}

// LINE/Google の外部 API を叩かないフェイク（Constraint: 実 fetch を経由させない）。
function createFakePlaces(outcome: SearchOutcome): PlacesSearchAdapter {
  return { searchCandidates: vi.fn(async () => outcome) };
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

describe.skipIf(!process.env.DATABASE_URL)('line-webhook app-level flow (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, 'app-flow運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      AG,
      OP,
      'app-flow代理店',
    ]);
    await pool.query('INSERT INTO agency_invite_codes (agency_id, code) VALUES ($1, $2)', [
      AG,
      INVITE_CODE,
    ]);
  });

  afterAll(async () => {
    await closePool();
  });

  // 実 DB アクセサ＋フェイク messenger/places で組み立てた本物の ConversationHandlers を
  // 各テストで使い回す（createApp 自体は各テストで作り直し、モックの呼び出し回数を独立させる）。
  function buildApp(deps: { messenger: LineMessenger; places: PlacesSearchAdapter; pool: Awaited<ReturnType<typeof getPool>> }) {
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
    'ハッピーパス: follow → 招待コード → 店名検索 → 候補選択 → 確認 → 確定 → 完了 まで通し、' +
      'DB 状態とリッチメニュー切替が正しく反映される（Req 1.1, 2.1, 3.1, 4.1, 4.2, 4.3, 6.3）',
    async () => {
      const pool = await getPool();
      const userId = 'Uf0-happy-path-user';
      const candidate0 = candidate({ placeId: 'ChIJ_f0_happy_0', name: '福多郎食堂 本店' });
      const candidate1 = candidate({ placeId: 'ChIJ_f0_happy_1', name: '福多郎食堂 支店' });
      const places = createFakePlaces({ kind: 'found', candidates: [candidate0, candidate1] });
      const messenger = createFakeMessenger({ [userId]: 'ハッピーパス太郎' });
      const app = buildApp({ messenger, places, pool });

      // 1. follow（Req 1.1）: 未登録ユーザーへ挨拶＋招待コード入力案内。
      const { res: followRes, elapsedMs: followElapsedMs } = await timeWebhookRequest(app, {
        method: 'POST',
        headers: { 'x-line-signature': sign(followBody(userId, 'reply-f0-1', 'f0-evt-follow'), CHANNEL_SECRET) },
        body: followBody(userId, 'reply-f0-1', 'f0-evt-follow'),
      });
      expect(followRes.status).toBe(200);
      expect(messenger.reply).toHaveBeenNthCalledWith(1, 'reply-f0-1', [buildGreetingMessage()]);
      // Req 5.5 サニティ: この応答経路に事故的な大幅劣化がないことの回帰ガード（上記コメント参照）。
      expect(followElapsedMs).toBeLessThan(RESPONSE_TIME_SANITY_BUDGET_MS);

      // 2. 招待コード（Req 2.1）: 有効なコードで owner 作成・await_store_name へ遷移。
      const inviteBody = textBody(userId, 'reply-f0-2', 'f0-evt-invite', INVITE_CODE);
      const { res: inviteRes, elapsedMs: inviteElapsedMs } = await timeWebhookRequest(app, {
        method: 'POST',
        headers: { 'x-line-signature': sign(inviteBody, CHANNEL_SECRET) },
        body: inviteBody,
      });
      expect(inviteRes.status).toBe(200);
      expect(messenger.reply).toHaveBeenNthCalledWith(2, 'reply-f0-2', [
        buildStoreNameInputGuidanceMessage(),
      ]);
      expect(inviteElapsedMs).toBeLessThan(RESPONSE_TIME_SANITY_BUDGET_MS);

      const ownerAfterInvite = await findOwnerByLineUserId(pool, userId);
      expect(ownerAfterInvite).not.toBeNull();
      expect(ownerAfterInvite?.agency_id).toBe(AG);
      expect(ownerAfterInvite?.onboarding_status).toBe('pending');

      // 3. 店名検索（Req 3.1）: found → 候補カルーセル提示、stage は await_store_name のまま。
      const searchBody = textBody(userId, 'reply-f0-3', 'f0-evt-search', '福多郎食堂');
      const { res: searchRes, elapsedMs: searchElapsedMs } = await timeWebhookRequest(app, {
        method: 'POST',
        headers: { 'x-line-signature': sign(searchBody, CHANNEL_SECRET) },
        body: searchBody,
      });
      expect(searchRes.status).toBe(200);
      expect(messenger.reply).toHaveBeenNthCalledWith(3, 'reply-f0-3', [
        buildCandidateCarouselMessage([candidate0, candidate1]),
      ]);
      // Places 検索（フェイクだが実処理経路を通す）を含む段で、想定より大幅に遅くないことを確認する。
      expect(searchElapsedMs).toBeLessThan(RESPONSE_TIME_SANITY_BUDGET_MS);

      // 4. 候補選択 postback（Req 4.1）: index 0 を選択 → await_confirmation へ。
      const selectData = encodePostback({ kind: 'select_candidate', index: 0 });
      const selectBody = postbackBody(userId, 'reply-f0-4', 'f0-evt-select', selectData);
      const { res: selectRes, elapsedMs: selectElapsedMs } = await timeWebhookRequest(app, {
        method: 'POST',
        headers: { 'x-line-signature': sign(selectBody, CHANNEL_SECRET) },
        body: selectBody,
      });
      expect(selectRes.status).toBe(200);
      expect(messenger.reply).toHaveBeenNthCalledWith(4, 'reply-f0-4', [
        buildConfirmationMessage(candidate0),
      ]);
      expect(selectElapsedMs).toBeLessThan(RESPONSE_TIME_SANITY_BUDGET_MS);

      // 5. 確定 postback（Req 4.2, 4.3）: stores 作成＋owner 遷移＋completed 案内。
      const confirmData = encodePostback({ kind: 'confirm' });
      const confirmBody = postbackBody(userId, 'reply-f0-5', 'f0-evt-confirm', confirmData);
      const { res: confirmRes, elapsedMs: confirmElapsedMs } = await timeWebhookRequest(app, {
        method: 'POST',
        headers: { 'x-line-signature': sign(confirmBody, CHANNEL_SECRET) },
        body: confirmBody,
      });
      expect(confirmRes.status).toBe(200);
      expect(messenger.reply).toHaveBeenNthCalledWith(5, 'reply-f0-5', [buildCompletionMessage()]);
      // stores 作成＋owner 遷移＋リッチメニュー切替を1トランザクションで行う最も重い段。
      expect(confirmElapsedMs).toBeLessThan(RESPONSE_TIME_SANITY_BUDGET_MS);

      // --- 完了状態の検証 ---
      const ownerFinal = await findOwnerByLineUserId(pool, userId);
      expect(ownerFinal?.onboarding_status).toBe('store_identified');

      const store = await findStoreByPlaceId(pool, candidate0.placeId);
      expect(store).not.toBeNull();
      expect(store?.place_status).toBe('confirmed');
      expect(store?.place_id).toBe(candidate0.placeId);
      expect(store?.owner_id).toBe(ownerFinal?.id);

      // Req 6.3: 完了時にリッチメニューが完了後メニューへ切り替わる。
      expect(messenger.linkRichMenu).toHaveBeenCalledWith(userId, RICHMENU_COMPLETED_ID);

      expect(messenger.reply).toHaveBeenCalledTimes(5);
    },
  );

  it('接続確認 ping（events: []）は 200・DB 書き込みなし・messenger 呼び出しなし', async () => {
    const pool = await getPool();
    const messenger = createFakeMessenger();
    const places = createFakePlaces({ kind: 'empty' });
    const app = buildApp({ messenger, places, pool });

    // このテスト専用の line_user_id で COUNT を絞り込む（Vitest の fileParallelism により
    // 他ファイル・他ワークスペースパッケージのテストが同一 DB に並行して行を書き込むため、
    // 絞り込みなしの全表 COUNT(*) は他テストの書き込みと競合し flaky になる）。
    // ping は events: [] で何の line_user_id にも触れないため、この ID に対する行数は
    // 常に 0 のはず（＝before/after とも 0 のまま変化しない）ことを「書き込みなし」の証拠とする。
    const PING_PROBE_USER_ID = 'Uf0-ping-probe-user';
    const ownersBefore = await pool.query(
      'SELECT COUNT(*)::int AS count FROM owners WHERE line_user_id = $1',
      [PING_PROBE_USER_ID],
    );
    const sessionsBefore = await pool.query(
      'SELECT COUNT(*)::int AS count FROM onboarding_sessions WHERE line_user_id = $1',
      [PING_PROBE_USER_ID],
    );

    const res = await app.request('/webhook', {
      method: 'POST',
      headers: { 'x-line-signature': sign(pingBody(), CHANNEL_SECRET) },
      body: pingBody(),
    });

    expect(res.status).toBe(200);

    const ownersAfter = await pool.query(
      'SELECT COUNT(*)::int AS count FROM owners WHERE line_user_id = $1',
      [PING_PROBE_USER_ID],
    );
    const sessionsAfter = await pool.query(
      'SELECT COUNT(*)::int AS count FROM onboarding_sessions WHERE line_user_id = $1',
      [PING_PROBE_USER_ID],
    );
    expect(ownersAfter.rows[0]?.count).toBe(ownersBefore.rows[0]?.count);
    expect(sessionsAfter.rows[0]?.count).toBe(sessionsBefore.rows[0]?.count);

    expect(messenger.reply).not.toHaveBeenCalled();
    expect(messenger.getProfile).not.toHaveBeenCalled();
    expect(messenger.linkRichMenu).not.toHaveBeenCalled();
  });

  it('署名不正（誤った署名・ヘッダ欠落）は 401・DB 書き込みなし・messenger 呼び出しなし', async () => {
    const pool = await getPool();
    const messenger = createFakeMessenger();
    const places = createFakePlaces({ kind: 'empty' });
    const app = buildApp({ messenger, places, pool });

    const userId = 'Uf0-bad-signature-user';
    const body = followBody(userId, 'reply-f0-badsig', 'f0-evt-badsig');

    // 1) 誤った署名（間違ったチャネルシークレットで計算）。
    const wrongSigRes = await app.request('/webhook', {
      method: 'POST',
      headers: { 'x-line-signature': sign(body, WRONG_CHANNEL_SECRET) },
      body,
    });
    expect(wrongSigRes.status).toBe(401);

    // 2) 署名ヘッダ欠落。
    const missingHeaderRes = await app.request('/webhook', {
      method: 'POST',
      body,
    });
    expect(missingHeaderRes.status).toBe(401);

    expect(messenger.reply).not.toHaveBeenCalled();

    const session = await pool.query('SELECT 1 FROM onboarding_sessions WHERE line_user_id = $1', [
      userId,
    ]);
    expect(session.rowCount).toBe(0);

    const owner = await findOwnerByLineUserId(pool, userId);
    expect(owner).toBeNull();
  });

  it(
    '重複 webhookEventId（同一署名済みイベントを2回送信）は2回目が二重処理されない' +
      '（owner が2重作成されず、messenger への reply も合計1回のみ。Req 5.4）',
    async () => {
      const pool = await getPool();
      const userId = 'Uf0-dedup-user';
      const messenger = createFakeMessenger({ [userId]: '重複太郎' });
      const places = createFakePlaces({ kind: 'empty' });
      const app = buildApp({ messenger, places, pool });

      // 事前に follow で session を作成しておく（招待コード段階に到達させる）。
      const followRes = await app.request('/webhook', {
        method: 'POST',
        headers: {
          'x-line-signature': sign(followBody(userId, 'reply-f0-dedup-follow', 'f0-evt-dedup-follow'), CHANNEL_SECRET),
        },
        body: followBody(userId, 'reply-f0-dedup-follow', 'f0-evt-dedup-follow'),
      });
      expect(followRes.status).toBe(200);
      expect(messenger.reply).toHaveBeenCalledTimes(1);

      // 同一 webhookEventId（f0-evt-dedup-invite）で招待コードイベントを2回送信する。
      // dedup が機能していなければ、2回目の createOwner が UNIQUE(line_user_id) 違反で
      // 例外を投げ（あるいは owner が2重作成され）、この挙動から乖離が顕在化する。
      const dupBody = textBody(userId, 'reply-f0-dedup-invite', 'f0-evt-dedup-invite', INVITE_CODE);
      const dupHeaders = { 'x-line-signature': sign(dupBody, CHANNEL_SECRET) };

      const firstRes = await app.request('/webhook', { method: 'POST', headers: dupHeaders, body: dupBody });
      const secondRes = await app.request('/webhook', { method: 'POST', headers: dupHeaders, body: dupBody });

      expect(firstRes.status).toBe(200);
      expect(secondRes.status).toBe(200);

      // follow の 1 reply ＋ 招待コードの 1 reply のみ（2回目の重複配信からの reply は増えない）。
      expect(messenger.reply).toHaveBeenCalledTimes(2);

      const ownersRes = await pool.query('SELECT COUNT(*)::int AS count FROM owners WHERE line_user_id = $1', [
        userId,
      ]);
      expect(ownersRes.rows[0]?.count).toBe(1);

      const owner = await findOwnerByLineUserId(pool, userId);
      expect(owner?.onboarding_status).toBe('pending');
    },
  );
});
