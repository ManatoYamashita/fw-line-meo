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
  unlinkOwnerLine,
  listStoresWithStatus,
  listOwners,
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
  buildInvalidInviteCodeMessage,
  buildStoreNameInputGuidanceMessage,
  buildCandidateCarouselMessage,
  buildConfirmationMessage,
  buildCompletionMessage,
  buildPlaceAlreadyRegisteredMessage,
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
const INVITE_CODE_ID = 'f0000000-0000-0000-0000-0000000486c1';

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
    unlinkRichMenu: vi.fn(async (): Promise<void> => {}),
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
    await pool.query('INSERT INTO agency_invite_codes (id, agency_id, code) VALUES ($1, $2, $3)', [
      INVITE_CODE_ID,
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
      const owner = await createOwner(pool, { agencyId: AG, inviteCodeId: INVITE_CODE_ID, lineUserId: userId });
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

      const owner = await createOwner(pool, { agencyId: AG, inviteCodeId: INVITE_CODE_ID, lineUserId: userId });
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

  // owner-line-unlink 6.2・7.2: 解除済みオーナーの店舗と同じ Place を、同じ代理店の新しいオーナーが確定すると、
  // 会話はオンボーディング専用の確定で引継ぎを受け、通常の確定と同じ完了を返し、3 種の監査を実 DB に残す。
  // 解除から同じ LINE アカウントで再オンボーディングする通しの流れは 9.2 の結合試験が持つ。ここでは確定の
  // postback だけを実 HTTP で通し、会話と実のサービスの配線を確かめる。
  describe('オンボーディングの確定での引継ぎ（owner-line-unlink 6.2, 6.4, 6.5, 7.2）', () => {
    async function seedAwaitingConfirmation(
      pool: Awaited<ReturnType<typeof getPool>>,
      userId: string,
      selected: StoreCandidate,
    ) {
      const owner = await createOwner(pool, { agencyId: AG, inviteCodeId: INVITE_CODE_ID, lineUserId: userId });
      await getOrCreateSession(pool, userId);
      await updateSession(pool, userId, {
        stage: 'await_confirmation',
        ownerId: owner.id,
        candidates: [selected],
        selectedIndex: 0,
      });
      return owner;
    }

    function confirmRequest(app: ReturnType<typeof createApp>, userId: string, replyToken: string, eventId: string) {
      const body = postbackBody(userId, replyToken, eventId, encodePostback({ kind: 'confirm' }));
      return app.request('/webhook', {
        method: 'POST',
        headers: { 'x-line-signature': sign(body, CHANNEL_SECRET) },
        body,
      });
    }

    it('同じ代理店の解除済みオーナーの全店舗を引き継ぎ、完了の案内と完了後メニューを出し、3 種の監査を残す', async () => {
      const pool = await getPool();
      const previousUserId = 'Uf0-takeover-previous';
      const newUserId = 'Uf0-takeover-new';
      const confirmedStoreId = 'f0000000-0000-0000-0000-0000000487a1';
      const suspendedStoreId = 'f0000000-0000-0000-0000-0000000487a2';
      const selected = candidate({ placeId: 'ChIJ_f0_takeover_0', name: '引継ぎ食堂 本店' });
      const messenger = createFakeMessenger();
      const app = buildApp({ messenger, places: createFakePlaces({ kind: 'empty' }), pool });

      const previous = await createOwner(pool, {
        agencyId: AG,
        inviteCodeId: INVITE_CODE_ID,
        lineUserId: previousUserId,
      });
      await pool.query(`UPDATE owners SET onboarding_status = 'store_identified' WHERE id = $1`, [previous.id]);
      await pool.query(
        `INSERT INTO stores (id, owner_id, name, place_id, place_status, suspended_at)
         VALUES ($1, $3, '引継ぎ食堂 本店', 'ChIJ_f0_takeover_0', 'confirmed', NULL),
                ($2, $3, '引継ぎ食堂 支店', 'ChIJ_f0_takeover_1', 'confirmed', now())`,
        [confirmedStoreId, suspendedStoreId, previous.id],
      );
      expect((await unlinkOwnerLine(pool, { ownerId: previous.id, agencyId: null })).kind).toBe('changed');

      const owner = await seedAwaitingConfirmation(pool, newUserId, selected);

      const res = await confirmRequest(app, newUserId, 'reply-f0-takeover', 'f0-evt-takeover-confirm');
      expect(res.status).toBe(200);

      expect(messenger.reply).toHaveBeenCalledTimes(1);
      expect(messenger.reply).toHaveBeenCalledWith('reply-f0-takeover', [buildCompletionMessage(LIFF_STORE_DETAIL_URL)]);
      expect(messenger.linkRichMenu).toHaveBeenCalledTimes(1);
      expect(messenger.linkRichMenu).toHaveBeenCalledWith(newUserId, RICHMENU_COMPLETED_ID);

      expect((await findOwnerByLineUserId(pool, newUserId))?.onboarding_status).toBe('store_identified');
      const session = await getOrCreateSession(pool, newUserId);
      expect(session.stage).toBe('completed');
      const stores = await pool.query<{ id: string; owner_id: string }>(
        'SELECT id, owner_id FROM stores WHERE id = ANY($1::uuid[]) ORDER BY id',
        [[confirmedStoreId, suspendedStoreId]],
      );
      expect(stores.rows).toEqual([
        { id: confirmedStoreId, owner_id: owner.id },
        { id: suspendedStoreId, owner_id: owner.id },
      ]);

      const audits = await pool.query<{ actor_type: string; action: string; target_type: string; target_id: string }>(
        `SELECT actor_type, action, target_type, target_id
           FROM audit_logs
          WHERE actor_id = $1
            AND action IN ('onboarding_completed', 'owner_stores_taken_over', 'store_taken_over')
          ORDER BY action, target_id`,
        [owner.id],
      );
      expect(audits.rows).toEqual([
        { actor_type: 'owner', action: 'onboarding_completed', target_type: 'store', target_id: confirmedStoreId },
        { actor_type: 'owner', action: 'owner_stores_taken_over', target_type: 'owner', target_id: previous.id },
        { actor_type: 'owner', action: 'store_taken_over', target_type: 'store', target_id: confirmedStoreId },
        { actor_type: 'owner', action: 'store_taken_over', target_type: 'store', target_id: suspendedStoreId },
      ]);
    });

    it('所有者が連携中の Place は引き継がず、既存の登録済みの案内を返し、監査を残さない', async () => {
      const pool = await getPool();
      const holderUserId = 'Uf0-takeover-linked-holder';
      const newUserId = 'Uf0-takeover-rejected';
      const holderStoreId = 'f0000000-0000-0000-0000-0000000487b1';
      const selected = candidate({ placeId: 'ChIJ_f0_takeover_linked', name: '連携中食堂' });
      const messenger = createFakeMessenger();
      const app = buildApp({ messenger, places: createFakePlaces({ kind: 'empty' }), pool });

      const holder = await createOwner(pool, { agencyId: AG, inviteCodeId: INVITE_CODE_ID, lineUserId: holderUserId });
      await pool.query(`UPDATE owners SET onboarding_status = 'store_identified' WHERE id = $1`, [holder.id]);
      await pool.query(
        `INSERT INTO stores (id, owner_id, name, place_id, place_status)
         VALUES ($1, $2, '連携中食堂', 'ChIJ_f0_takeover_linked', 'confirmed')`,
        [holderStoreId, holder.id],
      );

      const owner = await seedAwaitingConfirmation(pool, newUserId, selected);

      const res = await confirmRequest(app, newUserId, 'reply-f0-takeover-rejected', 'f0-evt-takeover-rejected');
      expect(res.status).toBe(200);

      expect(messenger.reply).toHaveBeenCalledTimes(1);
      expect(messenger.reply).toHaveBeenCalledWith('reply-f0-takeover-rejected', [buildPlaceAlreadyRegisteredMessage()]);
      expect(messenger.linkRichMenu).not.toHaveBeenCalled();
      expect((await findOwnerByLineUserId(pool, newUserId))?.onboarding_status).toBe('pending');
      expect((await findStoreByPlaceId(pool, selected.placeId))?.owner_id).toBe(holder.id);

      const audits = await pool.query(
        `SELECT 1 FROM audit_logs
          WHERE actor_id = $1 OR target_id = $2`,
        [owner.id, holder.id],
      );
      expect(audits.rowCount).toBe(0);
    });
  });

  // owner-line-unlink 9.2: 解除から、同じ LINE アカウントの再オンボーディングと引継ぎまでを、実 HTTP・実 DB で通す。
  // 解除は管理画面の経路が使う DAL（unlinkOwnerLine）を直接呼ぶ（dashboard-api の HTTP 層の検証は
  // dashboard-api の試験が持つ）。店舗詳細画面の認可（Req 4.3, 6.8）は store-detail の route.db.test.ts が、
  // この流れが作る DB の形（オーナーの行の LINE ユーザー ID と stores.owner_id）に対して確かめる。
  describe('解除から同じ LINE アカウントでの再オンボーディング・引継ぎまで（owner-line-unlink 4.1–4.4, 6.2, 6.9, 8.2）', () => {
    const userId = 'Uf0-reonboard-same-account';
    const suspendedStoreId = 'f0000000-0000-0000-0000-0000000487c1';
    const pendingStoreId = 'f0000000-0000-0000-0000-0000000487c2';
    const placeCandidate = candidate({ placeId: 'ChIJ_f0_reonboard_0', name: '再登録食堂 本店' });

    // 連携の状態を表す列（Req 8.2 でブロックの前後を比べる対象）と、会話の行。
    async function linkStateOf(pool: Awaited<ReturnType<typeof getPool>>, ownerIds: readonly string[]) {
      const res = await pool.query<{
        id: string;
        line_user_id: string | null;
        line_unlinked_at: Date | null;
        menu_pending_line_user_id: string | null;
        taken_over_by_owner_id: string | null;
        onboarding_status: string;
      }>(
        `SELECT id, line_user_id, line_unlinked_at, menu_pending_line_user_id, taken_over_by_owner_id, onboarding_status
           FROM owners
          WHERE id = ANY($1::uuid[])
          ORDER BY id`,
        [ownerIds],
      );
      return res.rows;
    }

    async function sessionRowsOf(pool: Awaited<ReturnType<typeof getPool>>) {
      const res = await pool.query<{
        stage: string;
        owner_id: string | null;
        candidates: unknown;
        selected_index: number | null;
        invite_failures: number;
        locked_until: Date | null;
      }>(
        `SELECT stage, owner_id, candidates, selected_index, invite_failures, locked_until
           FROM onboarding_sessions
          WHERE line_user_id = $1`,
        [userId],
      );
      return res.rows;
    }

    function unfollowBody(webhookEventId: string): string {
      // LINE の unfollow は replyToken を持たない（ブロック後は応答できない）。
      return JSON.stringify({
        destination: 'Uxxxxbotxxxx',
        events: [{ type: 'unfollow', source: { type: 'user', userId }, webhookEventId }],
      });
    }

    async function send(app: ReturnType<typeof createApp>, body: string): Promise<void> {
      const res = await app.request('/webhook', {
        method: 'POST',
        headers: { 'x-line-signature': sign(body, CHANNEL_SECRET) },
        body,
      });
      expect(res.status).toBe(200);
    }

    const reportData = encodeReportPostback({ kind: 'new_reviews', storeId: null, page: 0 });

    it(
      '解除後の友だち追加・メッセージ・レポートの要求は最初の案内に戻って解除前の店舗を返さず、同じアカウントが' +
        '招待コードから同じ Place を確定すると全店舗を引き継ぎ、ブロックは連携の状態を変えない',
      async () => {
        const pool = await getPool();
        const places = createFakePlaces({ kind: 'found', candidates: [placeCandidate] });
        const messenger = createFakeMessenger({ [userId]: '再登録太郎' });
        const app = buildApp({ messenger, places, pool });

        // --- 1. 解除前: 同じアカウントが通常のオンボーディングで店舗を確定する ---
        await send(app, followBody(userId, 'reply-f0-re-0a', 'f0-evt-re-follow-0'));
        await send(app, textBody(userId, 'reply-f0-re-0b', 'f0-evt-re-invite-0', INVITE_CODE));
        await send(app, textBody(userId, 'reply-f0-re-0c', 'f0-evt-re-search-0', '再登録食堂'));
        await send(
          app,
          postbackBody(userId, 'reply-f0-re-0d', 'f0-evt-re-select-0', encodePostback({ kind: 'select_candidate', index: 0 })),
        );
        await send(app, postbackBody(userId, 'reply-f0-re-0e', 'f0-evt-re-confirm-0', encodePostback({ kind: 'confirm' })));
        expect(messenger.reply).toHaveBeenLastCalledWith('reply-f0-re-0e', [buildCompletionMessage(LIFF_STORE_DETAIL_URL)]);

        const previous = await findOwnerByLineUserId(pool, userId);
        expect(previous?.onboarding_status).toBe('store_identified');
        if (!previous) throw new Error('解除前のオーナーが作られていない');
        const confirmedStore = await findStoreByPlaceId(pool, placeCandidate.placeId);
        expect(confirmedStore?.owner_id).toBe(previous.id);
        if (!confirmedStore) throw new Error('解除前の店舗が確定されていない');

        // 代理店の登録で増えた店舗（停止中の確定済み・未確定）を、同じオーナーに持たせる。引継ぎは全店舗を移す（Req 6.1）。
        await pool.query(
          `INSERT INTO stores (id, owner_id, name, place_id, place_status, suspended_at)
           VALUES ($1, $3, '再登録食堂 支店', 'ChIJ_f0_reonboard_1', 'confirmed', '2026-09-01T00:00:00Z'),
                  ($2, $3, '再登録食堂 準備中', NULL, 'pending', NULL)`,
          [suspendedStoreId, pendingStoreId, previous.id],
        );
        const allStoreIds = [confirmedStore.id, suspendedStoreId, pendingStoreId];

        // 解除前は、レポートの要求に解除前の店舗の名前で応える（解除後の比較の対照）。
        await send(app, postbackBody(userId, 'reply-f0-re-0f', 'f0-evt-re-report-0', reportData));
        expect(messenger.reply).toHaveBeenLastCalledWith('reply-f0-re-0f', [
          buildPreparingNotice({ storeName: placeCandidate.name }),
        ]);

        // 解除前の会話は、完了の段階と提示した候補を持っている（持ち越されれば解除後の応答が変わる）。
        expect(await sessionRowsOf(pool)).toEqual([
          expect.objectContaining({ stage: 'completed', owner_id: previous.id, selected_index: 0 }),
        ]);

        // Req 8.2: 連携中にブロックしても、連携の状態は変わらない。
        const linkedBefore = await linkStateOf(pool, [previous.id]);
        await send(app, unfollowBody('f0-evt-re-unfollow-0'));
        expect(await linkStateOf(pool, [previous.id])).toEqual(linkedBefore);
        expect(linkedBefore[0]?.line_user_id).toBe(userId);
        expect(linkedBefore[0]?.line_unlinked_at).toBeNull();

        // --- 2. 解除 ---
        const unlinked = await unlinkOwnerLine(pool, { ownerId: previous.id, agencyId: AG });
        expect(unlinked).toEqual({ kind: 'changed', ownerId: previous.id, menuTarget: userId });
        // Req 4.2: 会話の行は解除と同じトランザクションで消え、段階・候補・失敗回数を持ち越さない。
        expect(await sessionRowsOf(pool)).toEqual([]);

        // Req 8.2: 解除済みのアカウントがブロックしても、解除済みのまま（連携中へ戻らない）。
        const unlinkedBefore = await linkStateOf(pool, [previous.id]);
        expect(unlinkedBefore[0]).toMatchObject({ line_user_id: null, menu_pending_line_user_id: userId });
        expect(unlinkedBefore[0]?.line_unlinked_at).toBeInstanceOf(Date);
        await send(app, unfollowBody('f0-evt-re-unfollow-1'));
        expect(await linkStateOf(pool, [previous.id])).toEqual(unlinkedBefore);

        // --- 3. 解除後の元の LINE アカウント ---
        vi.mocked(messenger.reply).mockClear();
        vi.mocked(messenger.linkRichMenu).mockClear();
        vi.mocked(messenger.unlinkRichMenu).mockClear();
        vi.mocked(places.searchCandidates).mockClear();

        // Req 4.1: 友だち追加（ブロック解除）で招待コードの入力を求める最初の案内を返し、個別メニューを外し直す（安全網）。
        await send(app, followBody(userId, 'reply-f0-re-1a', 'f0-evt-re-follow-1'));
        expect(messenger.reply).toHaveBeenLastCalledWith('reply-f0-re-1a', [buildGreetingMessage()]);
        expect(messenger.unlinkRichMenu).toHaveBeenCalledWith(userId);
        // Req 4.2: 新しい会話は最初の段階から始まる。
        expect(await sessionRowsOf(pool)).toEqual([
          {
            stage: 'await_invite_code',
            owner_id: null,
            candidates: null,
            selected_index: null,
            invite_failures: 0,
            locked_until: null,
          },
        ]);

        // Req 4.4: 残った完了後メニューからのレポートの要求にも、解除前の店舗を含めず最初の案内を返す。
        await send(app, postbackBody(userId, 'reply-f0-re-1b', 'f0-evt-re-report-1', reportData));
        expect(messenger.reply).toHaveBeenLastCalledWith('reply-f0-re-1b', [buildGreetingMessage()]);

        // Req 4.1, 4.2: メッセージは招待コードとして照合される（完了の段階を持ち越していれば、ステータス案内になる）。
        // 店名に見えても検索しない。失敗の回数は 0 から数える。
        await send(app, textBody(userId, 'reply-f0-re-1c', 'f0-evt-re-text-1', '再登録食堂'));
        expect(messenger.reply).toHaveBeenLastCalledWith('reply-f0-re-1c', [buildInvalidInviteCodeMessage()]);
        expect(places.searchCandidates).not.toHaveBeenCalled();
        expect(await sessionRowsOf(pool)).toEqual([expect.objectContaining({ stage: 'await_invite_code', invite_failures: 1 })]);

        // 解除後の応答のどれにも、解除前の店舗の名前は出ない。完了後メニューも張らない。
        expect(JSON.stringify(vi.mocked(messenger.reply).mock.calls)).not.toContain('再登録食堂');
        expect(messenger.linkRichMenu).not.toHaveBeenCalled();
        expect((await findOwnerByLineUserId(pool, userId))).toBeNull();

        // --- 4. 同じアカウントで招待コード → 同じ Place の確定 → 引継ぎ ---
        await send(app, textBody(userId, 'reply-f0-re-2a', 'f0-evt-re-invite-2', INVITE_CODE));
        expect(messenger.reply).toHaveBeenLastCalledWith('reply-f0-re-2a', [buildStoreNameInputGuidanceMessage()]);
        const successor = await findOwnerByLineUserId(pool, userId);
        expect(successor).toMatchObject({ agency_id: AG, onboarding_status: 'pending' });
        if (!successor) throw new Error('再登録のオーナーが作られていない');
        expect(successor.id).not.toBe(previous.id);

        await send(app, textBody(userId, 'reply-f0-re-2b', 'f0-evt-re-search-2', '再登録食堂'));
        expect(messenger.reply).toHaveBeenLastCalledWith('reply-f0-re-2b', [buildCandidateCarouselMessage([placeCandidate])]);
        await send(
          app,
          postbackBody(userId, 'reply-f0-re-2c', 'f0-evt-re-select-2', encodePostback({ kind: 'select_candidate', index: 0 })),
        );
        expect(messenger.reply).toHaveBeenLastCalledWith('reply-f0-re-2c', [buildConfirmationMessage(placeCandidate)]);

        // Req 6.2: 通常の確定と同じく、完了の案内と完了後メニューを提供する。
        await send(app, postbackBody(userId, 'reply-f0-re-2d', 'f0-evt-re-confirm-2', encodePostback({ kind: 'confirm' })));
        expect(messenger.reply).toHaveBeenLastCalledWith('reply-f0-re-2d', [buildCompletionMessage(LIFF_STORE_DETAIL_URL)]);
        expect(messenger.linkRichMenu).toHaveBeenCalledTimes(1);
        expect(messenger.linkRichMenu).toHaveBeenCalledWith(userId, RICHMENU_COMPLETED_ID);
        expect((await sessionRowsOf(pool))[0]?.stage).toBe('completed');

        // 全店舗（確定済み・停止中・未確定）が、店舗 ID・停止状態・確定状態を保ったまま新しいオーナーへ移る。
        const stores = await pool.query<{ id: string; owner_id: string; place_status: string; suspended: boolean }>(
          `SELECT id, owner_id, place_status, suspended_at IS NOT NULL AS suspended
             FROM stores WHERE id = ANY($1::uuid[]) ORDER BY id`,
          [allStoreIds],
        );
        expect(stores.rows).toEqual(
          [
            { id: confirmedStore.id, owner_id: successor.id, place_status: 'confirmed', suspended: false },
            { id: suspendedStoreId, owner_id: successor.id, place_status: 'confirmed', suspended: true },
            { id: pendingStoreId, owner_id: successor.id, place_status: 'pending', suspended: false },
          ].sort((a, b) => a.id.localeCompare(b.id)),
        );
        const [previousAfter, successorAfter] = [
          (await linkStateOf(pool, [previous.id]))[0],
          (await linkStateOf(pool, [successor.id]))[0],
        ];
        expect(previousAfter).toMatchObject({ line_user_id: null, taken_over_by_owner_id: successor.id });
        expect(successorAfter).toMatchObject({ line_user_id: userId, onboarding_status: 'store_identified' });

        // Req 6.9: 管理画面の店舗一覧（GET /stores が読む listStoresWithStatus）は、引き継いだ店舗を新しいオーナーの店舗として返す。
        const listed = (await listStoresWithStatus(pool, { agencyId: AG })).filter((s) => allStoreIds.includes(s.id));
        expect(listed.map((s) => [s.id, s.ownerId]).sort()).toEqual(allStoreIds.map((id) => [id, successor.id]).sort());
        expect(listed.every((s) => s.ownerDisplayName === '再登録太郎')).toBe(true);
        // オーナー一覧（GET /owners）は、旧オーナーを解除済み・引継ぎ先つきで、新しいオーナーを連携中・店舗つきで返す（Req 2.6）。
        const ownersListed = await listOwners(pool, AG);
        expect(ownersListed.find((o) => o.id === previous.id)).toMatchObject({
          lineLink: 'unlinked',
          storeNames: [],
          takenOverBy: { ownerId: successor.id, displayName: '再登録太郎' },
        });
        expect(ownersListed.find((o) => o.id === successor.id)).toMatchObject({
          lineLink: 'linked',
          storeNames: ['再登録食堂 本店', '再登録食堂 支店'],
          takenOverBy: null,
        });

        // 引き継いだアカウントのレポートの要求は、引き継いだ店舗で応える。
        await send(app, postbackBody(userId, 'reply-f0-re-2e', 'f0-evt-re-report-2', reportData));
        expect(messenger.reply).toHaveBeenLastCalledWith('reply-f0-re-2e', [
          buildPreparingNotice({ storeName: placeCandidate.name }),
        ]);

        // Req 8.2: 引き継いだ後のブロックも、どちらのオーナーの連携の状態も変えない。
        const takenOverBefore = await linkStateOf(pool, [previous.id, successor.id]);
        await send(app, unfollowBody('f0-evt-re-unfollow-2'));
        expect(await linkStateOf(pool, [previous.id, successor.id])).toEqual(takenOverBefore);
      },
    );
  });
});
