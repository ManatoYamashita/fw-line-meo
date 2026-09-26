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
  createAuditLog,
} from '@fwlm/db';
import type { StoreCandidate } from '@fwlm/db';
import { createApp, type AppDeps } from '../src/app.js';
import { createSignatureVerifier } from '../src/webhook/signature.js';
import { createConversationHandlers } from '../src/onboarding/conversation.js';
import { createStoreIdentificationService } from '@fwlm/store-identification';
import { encodePostback } from '../src/onboarding/stages.js';
import type { LineMessenger } from '../src/line/client.js';
import type { PlacesSearchAdapter, SearchOutcome } from '@fwlm/store-identification';
import {
  buildGreetingMessage,
  buildStoreNameInputGuidanceMessage,
  buildCandidateCarouselMessage,
  buildConfirmationMessage,
  buildCompletionMessage,
  buildStatusGuidanceMessage,
} from '../src/line/messages.js';
import { encodeReportPostback } from '@fwlm/line-report';
import { createStoreIdentifiedOwnerRouterFactory } from '../src/owner/router.js';
import { buildPreparingNotice } from '../src/report/builders/notices.js';

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
const LIFF_STORE_DETAIL_URL = 'https://liff.line.me/test-liff-id';
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
    push: vi.fn(async (): Promise<void> => {}),
    getProfile: vi.fn(async (lineUserId: string) => {
      const displayName = profiles[lineUserId];
      return displayName ? { displayName } : null;
    }),
    linkRichMenu: vi.fn(async (): Promise<void> => {}),
    startLoading: vi.fn(async (): Promise<void> => {}),
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
      // 補助的処理の成否の記録。内容の検証は conversation.test.ts が担う。
      logger: { info: vi.fn(), warn: vi.fn() },
      auditLog: (input) => createAuditLog(deps.pool, input),
      lineRichMenuCompletedId: RICHMENU_COMPLETED_ID,
      liffStoreDetailUrl: LIFF_STORE_DETAIL_URL,
      // index.ts と同じ振り分け口の作り方（リクエストごとに router と ReportHandler を作る）。
      createOwnerRouter: createStoreIdentifiedOwnerRouterFactory({
        db: deps.pool,
        sessions: { getOrCreateSession, updateSession },
        auditLog: (input) => createAuditLog(deps.pool, input),
        lineRichMenuCompletedId: RICHMENU_COMPLETED_ID,
        liffStoreDetailUrl: LIFF_STORE_DETAIL_URL,
      }),
    });

    const appDeps: AppDeps = {
      signatureVerifier: createSignatureVerifier(CHANNEL_SECRET),
      recordWebhookEventOnce: (webhookEventId) => recordWebhookEventOnce(deps.pool, webhookEventId),
      conversationHandlers,
      messenger: deps.messenger,
      logger: { error: vi.fn() },
      structuredLog: vi.fn(),
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
      expect(messenger.reply).toHaveBeenNthCalledWith(5, 'reply-f0-5', [buildCompletionMessage(LIFF_STORE_DETAIL_URL)]);
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
      const storeId = store?.id;
      expect(storeId).toBeDefined();

      const auditRows = await pool.query<{ action: string; target_type: string; target_id: string }>(
        `SELECT action, target_type, target_id
           FROM audit_logs
          WHERE actor_id = $1
          ORDER BY occurred_at ASC`,
        [ownerFinal?.id],
      );
      expect(auditRows.rows).toEqual(expect.arrayContaining([
        { action: 'owner_created', target_type: 'owner', target_id: ownerFinal?.id },
        { action: 'onboarding_completed', target_type: 'store', target_id: storeId },
        { action: 'rich_menu_linked', target_type: 'owner', target_id: ownerFinal?.id },
      ]));

      // Req 6.3: 完了時にリッチメニューが完了後メニューへ切り替わる。
      expect(messenger.linkRichMenu).toHaveBeenCalledWith(userId, RICHMENU_COMPLETED_ID);

      expect(messenger.reply).toHaveBeenCalledTimes(5);
    },
  );

  // line-on-demand-report tasks 3.10（Requirements 2.6・2.9）: 代理店が店舗を登録したオーナーは、会話の段階が
  // 途中（店名入力待ち）のまま店舗特定済みになる。段階ではなく onboarding_status で振り分けるので、
  // オンボーディングの案内（店名の検索）ではなく、店舗特定済みオーナー向けの案内とレポートを返す。
  it(
    '代理店経路のオーナー（段階が店名入力待ちのまま確定店舗を持つ）: テキストにはステータス案内を返して完了後メニューを張り、' +
      'レポートの postback にはレポート応答を 1 回返す（line-on-demand-report Req 2.6, 2.9）',
    async () => {
      const pool = await getPool();
      const userId = 'Uf0-agency-path-user';
      const storeCandidate = candidate({ placeId: 'ChIJ_f0_agency_0', name: '試験食堂 代理店登録店' });
      // オンボーディングへ落ちれば、店名に見えるテキストでこの検索が呼ばれる。
      const places = createFakePlaces({ kind: 'found', candidates: [storeCandidate] });
      const messenger = createFakeMessenger();
      const app = buildApp({ messenger, places, pool });

      // 代理店による登録を再現する: オーナーと店名入力待ちの段階を作り、confirmStore で確定店舗を作る
      // （確定店舗の作成とオーナーの store_identified への遷移は、confirmStore の同じトランザクションで行われる）。
      const owner = await createOwner(pool, { agencyId: AG, lineUserId: userId });
      await getOrCreateSession(pool, userId);
      await updateSession(pool, userId, { stage: 'await_store_name', ownerId: owner.id });
      const confirmed = await createStoreIdentificationService({ pool, places }).confirmStore(owner.id, storeCandidate);
      expect(confirmed.kind).toBe('confirmed');
      expect((await findOwnerByLineUserId(pool, userId))?.onboarding_status).toBe('store_identified');
      expect((await getOrCreateSession(pool, userId)).stage).toBe('await_store_name');

      // 1. 店名に見えるテキスト → ステータス案内。検索しない。完了後メニューを張り、段階を completed に揃える。
      const statusBody = textBody(userId, 'reply-f0-agency-1', 'f0-evt-agency-text', '試験食堂');
      const statusRes = await app.request('/webhook', {
        method: 'POST',
        headers: { 'x-line-signature': sign(statusBody, CHANNEL_SECRET) },
        body: statusBody,
      });
      expect(statusRes.status).toBe(200);
      expect(messenger.reply).toHaveBeenCalledTimes(1);
      expect(messenger.reply).toHaveBeenNthCalledWith(1, 'reply-f0-agency-1', [buildStatusGuidanceMessage()]);
      expect(places.searchCandidates).not.toHaveBeenCalled();
      expect(messenger.linkRichMenu).toHaveBeenCalledTimes(1);
      expect(messenger.linkRichMenu).toHaveBeenCalledWith(userId, RICHMENU_COMPLETED_ID);
      expect((await getOrCreateSession(pool, userId)).stage).toBe('completed');
      const audits = await pool.query<{ action: string }>(
        `SELECT action FROM audit_logs WHERE actor_id = $1 AND action = 'rich_menu_linked'`,
        [owner.id],
      );
      expect(audits.rowCount).toBe(1);

      // 2. レポートの postback → 日次集計がまだ無いので、店舗名つきの準備中の案内を 1 回返す。段階は completed なので張り直さない。
      const reportData = encodeReportPostback({ kind: 'new_reviews', storeId: null, page: 0 });
      const reportBody = postbackBody(userId, 'reply-f0-agency-2', 'f0-evt-agency-report', reportData);
      const reportRes = await app.request('/webhook', {
        method: 'POST',
        headers: { 'x-line-signature': sign(reportBody, CHANNEL_SECRET) },
        body: reportBody,
      });
      expect(reportRes.status).toBe(200);
      expect(messenger.reply).toHaveBeenCalledTimes(2);
      expect(messenger.reply).toHaveBeenNthCalledWith(2, 'reply-f0-agency-2', [
        buildPreparingNotice({ storeName: storeCandidate.name }),
      ]);
      expect(messenger.linkRichMenu).toHaveBeenCalledTimes(1);
      expect(places.searchCandidates).not.toHaveBeenCalled();
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

  // store-suspension Requirement 6.4: ブロック（unfollow）とブロック解除（follow）は店舗の停止状態を変えない。
  // ブロックで自動停止すると、オーナー自身が配信を止める手段になる（competitive-daily-summary Requirement 3.10 と
  // store-suspension Requirement 8.1 が禁じる）。停止中の店舗が再友だち追加で再開されることも、利用中の店舗が
  // ブロックで停止されることも無いことを、実 DB の停止時刻で確かめる。停止時刻は SQL で直接立てる（書込は
  // dashboard-api の経路だけが持つため、この試験から停止の API は呼ばない）。
  it(
    'ブロック（unfollow）とブロック解除（follow）を受けても、停止中の店舗は停止時刻ごと停止のまま、' +
      '利用中の店舗は利用中のまま残り、停止・再開の監査も残らない（store-suspension Req 6.4）',
    async () => {
      const pool = await getPool();
      const userId = 'Uf0-suspension-follow-user';
      const suspendedStoreId = 'f0000000-0000-0000-0000-0000000064a1';
      const activeStoreId = 'f0000000-0000-0000-0000-0000000064a2';
      const suspendedAt = new Date('2026-09-01T00:00:00.000Z');
      const messenger = createFakeMessenger();
      const places = createFakePlaces({ kind: 'empty' });
      const app = buildApp({ messenger, places, pool });

      const owner = await createOwner(pool, { agencyId: AG, lineUserId: userId });
      await pool.query(`UPDATE owners SET onboarding_status = 'store_identified' WHERE id = $1`, [owner.id]);
      await pool.query(
        `INSERT INTO stores (id, owner_id, name, place_id, place_status, suspended_at)
         VALUES ($1, $3, '試験食堂 停止中', 'ChIJ_f0_suspension_0', 'confirmed', $4),
                ($2, $3, '試験食堂 利用中', 'ChIJ_f0_suspension_1', 'confirmed', NULL)`,
        [suspendedStoreId, activeStoreId, owner.id, suspendedAt],
      );
      await getOrCreateSession(pool, userId);
      await updateSession(pool, userId, { stage: 'completed', ownerId: owner.id });

      // LINE の unfollow は replyToken を持たない（ブロック後は応答できない）。
      const unfollowBody = JSON.stringify({
        destination: 'Uxxxxbotxxxx',
        events: [{ type: 'unfollow', source: { type: 'user', userId }, webhookEventId: 'f0-evt-suspension-unfollow' }],
      });
      const unfollowRes = await app.request('/webhook', {
        method: 'POST',
        headers: { 'x-line-signature': sign(unfollowBody, CHANNEL_SECRET) },
        body: unfollowBody,
      });
      expect(unfollowRes.status).toBe(200);
      expect(messenger.reply).not.toHaveBeenCalled();

      const refollowBody = followBody(userId, 'reply-f0-suspension-follow', 'f0-evt-suspension-follow');
      const refollowRes = await app.request('/webhook', {
        method: 'POST',
        headers: { 'x-line-signature': sign(refollowBody, CHANNEL_SECRET) },
        body: refollowBody,
      });
      expect(refollowRes.status).toBe(200);
      // follow が店舗特定済みオーナーの経路を実際に通ったこと（停止状態を見ずに素通りしたのではない）の確認。
      expect(messenger.reply).toHaveBeenCalledTimes(1);
      expect(messenger.reply).toHaveBeenCalledWith('reply-f0-suspension-follow', [buildStatusGuidanceMessage()]);

      const stores = await pool.query<{ id: string; suspended_at: Date | null }>(
        'SELECT id, suspended_at FROM stores WHERE owner_id = $1 ORDER BY id',
        [owner.id],
      );
      expect(stores.rows).toHaveLength(2);
      const byId = new Map(stores.rows.map((row) => [row.id, row.suspended_at]));
      expect(byId.get(suspendedStoreId)?.getTime()).toBe(suspendedAt.getTime());
      expect(byId.get(activeStoreId)).toBeNull();

      const suspensionAudits = await pool.query(
        `SELECT 1 FROM audit_logs
          WHERE target_id = ANY($1::uuid[]) AND action IN ('store_suspended', 'store_resumed')`,
        [[suspendedStoreId, activeStoreId]],
      );
      expect(suspensionAudits.rowCount).toBe(0);
    },
  );
});
