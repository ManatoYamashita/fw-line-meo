// レポートの通しの統合試験（line-on-demand-report tasks 3.11・design.md「Testing Strategy」の Integration Tests と
// 「Performance」・Requirements 2.3, 2.9, 3.1, 3.2, 3.3, 3.4, 3.6, 3.7, 7.1, 7.2, 7.3, 7.4）。
//
// 署名つきの webhook（app.request）から、実 postgres（ts-test-db）の読み出しを通って、偽の Messenger の Reply まで
// を貫く。差し替えるのは LINE と Google の外部 API（Messenger・Places）と時計だけで、会話・振り分け口・レポート
// 応答・読み出し・組立は本物を index.ts と同じ形で配線する（app-flow.db.test.ts と同じ方針）。
//
// 確かめること:
// - 単一店舗のオーナーの 3 つのレポート（店舗名・データ対象日・帰属表示）と、1 回の要求の DB の読み出しの回数
// - 複数店舗のオーナーの選択肢（本人の確定店舗だけ）→ 選択 → 選んだ店舗のレポート
// - 他のオーナーに実在する店舗 ID・本人の未確定の店舗 ID・存在しない ID の指定が、同じ再提示と同じ記録になること
//   （記録に店舗 ID を載せないこと）
// - 日次集計が無い店舗の準備中の案内と、最新の日次集計が取得失敗の店舗の案内・推移の注記
// - 代理店経路のオーナー（段階が店名入力待ちのまま確定店舗を持つ）が、オンボーディングの案内を受け取らないこと
//
// 期待する Reply は、試験が書いた行を各ビルダーへ渡した出力と突き合わせる。そのうえで、見出しの店舗名・データ対象日・
// 帰属表示・導線の URL を、ビルダーを経由しない文字列でも確かめる（表示の規則そのものはビルダーごとの単体試験が持つ）。
//
// 時計は振り分け口の作り方（createStoreIdentifiedOwnerRouterFactory）の now で固定する。日本時間の 1 時半（UTC では
// まだ前日）に置き、読み出しの基準日が日本時間の今日であることも通しで確かめる。
//
// 応答時間（Requirement 7.3）: ここで測れるのは外部 API を持たない経路の処理時間だけで、LINE との往復とコールド
// スタートは含まない（実機の確認が受け持つ）。ここでは、処理経路の事故的な劣化を見る緩い上限と、1 回の要求の DB の
// 問い合わせの回数（design.md「Performance」）を固定する。
//
// 他の試験ファイルと同じ DB を共有するので、リポジトリ内で未使用の UUID の接頭辞 c9 と、c9 を含む LINE ユーザー ID・
// Place ID を使う。店名は試験用の架空のもので、実在の店舗を指さない。DATABASE_URL が無ければ skip する。
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  closePool,
  createAuditLog,
  createOwner,
  findActiveInviteCode,
  findOwnerByLineUserId,
  getOrCreateSession,
  getPool,
  recordWebhookEventOnce,
  updateSession,
} from '@fwlm/db';
import type {
  DailySummaryNewReview,
  DailySummaryReadRow,
  Queryable,
  ReportableStore,
  StoreCandidate,
} from '@fwlm/db';
import {
  decodeReportPostback,
  encodeReportPostback,
  type ReportKind,
  type ReportRequest,
} from '@fwlm/line-report';
import type { Sink } from '@fwlm/observability';
import {
  createStoreIdentificationService,
  type PlacesSearchAdapter,
  type SearchOutcome,
} from '@fwlm/store-identification';
import { createApp, type AppDeps } from '../src/app.js';
import type { LineMessage, LineMessenger } from '../src/line/client.js';
import { buildStatusGuidanceMessage } from '../src/line/messages.js';
import { createConversationHandlers } from '../src/onboarding/conversation.js';
import { createStoreIdentifiedOwnerRouterFactory } from '../src/owner/router.js';
import { buildComparisonReport } from '../src/report/builders/comparison.js';
import { GOOGLE_MAPS_LINK_TEXT, buildNewReviewsReport } from '../src/report/builders/new-reviews.js';
import { buildFetchFailedNotice, buildPreparingNotice } from '../src/report/builders/notices.js';
import { buildStoreChoiceMessage } from '../src/report/builders/store-choice.js';
import { TREND_DAYS, buildTrendReport, classifyTrendDays, storeDetailUrlFor } from '../src/report/builders/trend.js';
import { ATTRIBUTION_TEXT, normalizeReadRow } from '../src/report/format.js';
import { createSignatureVerifier } from '../src/webhook/signature.js';

const OP = 'c9000000-0000-0000-0000-000000000001';
const AG = 'c9000000-0000-0000-0000-000000000002';

const CHANNEL_SECRET = 'c9-test-channel-secret';
const RICHMENU_COMPLETED_ID = 'c9-richmenu-completed';
const LIFF_STORE_DETAIL_URL = 'https://liff.line.me/2000000000-c9report';

// 日本時間 2026-07-13 01:30（UTC ではまだ 07-12）。読み出しの基準日は '2026-07-13' になる。
// UTC の日付を基準日に渡す誤りがあると、最新の行（07-13）が窓の外になり、見出しの日付が 7月12日 に変わる。
const FIXED_NOW = new Date('2026-07-12T16:30:00Z');
const TODAY_JST = '2026-07-13';

// 処理経路の事故的な劣化を見る緩い上限（app-flow.db.test.ts と同じ 5 秒）。本番の 5 秒（7.3）の充足の証明ではない。
const RESPONSE_TIME_SANITY_BUDGET_MS = 5000;

// --- 単一店舗のオーナー ---------------------------------------------------------------
const SINGLE_USER = 'Uc9-report-single-owner';
const SINGLE_STORE_NAME = 'レポート試験食堂 単店';

// 帰属 3 項目を持つ新着口コミ（低い評価の口コミも同じ形で出す）。
const REVIEW_ATTRIBUTED_LOW: DailySummaryNewReview = {
  authorName: '試験 投稿者イ',
  publishTime: '2026-07-12T10:15:00Z',
  rating: 2,
  textExcerpt: '試験用の本文です。料理が出てくるまで少し待ちました。',
  authorUri: 'https://www.google.com/maps/contrib/c9-author-i',
  authorPhotoUri: 'https://lh3.googleusercontent.com/a/c9-photo-i',
  googleMapsUri: 'https://www.google.com/maps/reviews/data=c9-review-i',
};
// 帰属 3 項目を持たない既存の形（本 spec より前の Go が書いた行）。内容を出さず、件数にだけ数える。
const REVIEW_LEGACY: DailySummaryNewReview = {
  authorName: '試験 投稿者ロ',
  publishTime: '2026-07-12T11:00:00Z',
  rating: 5,
  textExcerpt: '試験用の本文です（帰属の項目を持たない既存の形）。',
};
const REVIEW_ATTRIBUTED_HIGH: DailySummaryNewReview = {
  authorName: '試験 投稿者ハ',
  publishTime: '2026-07-12T12:30:00Z',
  rating: 5,
  textExcerpt: '試験用の本文です。また来ます。',
  googleMapsUri: 'https://www.google.com/maps/reviews/data=c9-review-ha',
};

function summaryOn(summaryDate: string, overrides: Partial<DailySummaryReadRow> = {}): DailySummaryReadRow {
  return {
    summary_date: summaryDate,
    status: 'ready',
    rank: 3,
    rank_total: 4,
    rank_prev: 3,
    rating: '4.1',
    review_count: 100,
    rating_prev: '4.1',
    review_count_prev: 100,
    new_review_count: 0,
    new_reviews: [],
    competitors: [
      { name: '比較試験亭', rating: 4.4, reviewCount: 210, starDiff: -0.3 },
      { name: '比較試験屋', rating: 4.2, reviewCount: 88, starDiff: -0.1 },
      { name: '比較試験庵', rating: 3.9, reviewCount: 45, starDiff: 0.2 },
    ],
    ...overrides,
  };
}

function failedSummaryOn(summaryDate: string): DailySummaryReadRow {
  return summaryOn(summaryDate, {
    status: 'failed',
    rank: null,
    rank_total: null,
    rank_prev: null,
    rating: null,
    review_count: null,
    rating_prev: null,
    review_count_prev: null,
    competitors: [],
  });
}

// 単一店舗の最新の行（基準日の当日）。評価のない競合を 1 店含む（正規化を通して末尾に並ぶ）。
const SINGLE_LATEST = summaryOn(TODAY_JST, {
  rank: 2,
  rank_total: 4,
  rank_prev: 3,
  rating: '4.2',
  review_count: 107,
  rating_prev: '4.1',
  review_count_prev: 104,
  new_review_count: 3,
  new_reviews: [REVIEW_ATTRIBUTED_LOW, REVIEW_LEGACY, REVIEW_ATTRIBUTED_HIGH],
  competitors: [
    { name: '比較試験亭', rating: 4.4, reviewCount: 212, starDiff: -0.2 },
    { name: '比較試験処', rating: null, reviewCount: 0, starDiff: null },
    { name: '比較試験屋', rating: 4.2, reviewCount: 90, starDiff: 0 },
    { name: '比較試験庵', rating: 3.9, reviewCount: 46, starDiff: 0.3 },
  ],
});

// 単一店舗の行。07-06 は推移の 7 暦日（07-07〜07-13）の外で、07-07・07-09・07-11 は行が無く、07-10 は取得失敗。
const SINGLE_ROWS: readonly DailySummaryReadRow[] = [
  summaryOn('2026-07-06', { rank: 4, review_count: 96 }),
  summaryOn('2026-07-08', { review_count: 100 }),
  failedSummaryOn('2026-07-10'),
  summaryOn('2026-07-12', { review_count: 104 }),
  SINGLE_LATEST,
];

// --- 複数店舗のオーナーと、別のオーナー -----------------------------------------------
const MULTI_USER = 'Uc9-report-multi-owner';
const MAIN_STORE_NAME = 'レポート試験食堂 本店'; // 日次集計が 1 件も無い（準備中）
const STATION_STORE_NAME = 'レポート試験食堂 駅前店'; // 最新の日次集計を取得できている
const WEST_STORE_NAME = 'レポート試験食堂 西口店'; // 最新の日次集計が取得失敗
/** 複数店舗のオーナー本人の、店舗特定が未完了の店舗。選択肢に並ばず、指定しても選べない（3.4・3.6）。 */
const MULTI_PENDING_STORE_ID = 'c9000000-0000-0000-0000-000000000101';
const MULTI_PENDING_STORE_NAME = 'レポート試験食堂 未確定店';

const OTHER_USER = 'Uc9-report-other-owner';
const OTHER_STORE_NAME = 'レポート試験食堂 別オーナー店';
/** どこにも存在しない店舗 ID（uuid の形はしている）。 */
const NONEXISTENT_STORE_ID = 'c9000000-0000-0000-0000-0000000000ff';

const STATION_LATEST = summaryOn(TODAY_JST, {
  review_count: 101,
  review_count_prev: 100,
  new_review_count: 1,
  new_reviews: [
    {
      authorName: '試験 投稿者ニ',
      publishTime: '2026-07-12T09:00:00Z',
      rating: 4,
      textExcerpt: '試験用の本文です。駅から近くて便利でした。',
      googleMapsUri: 'https://www.google.com/maps/reviews/data=c9-review-ni',
    },
  ],
});

// 西口店: 07-11・07-12 は取得できた日、最新の 07-13 は取得失敗。
const WEST_ROWS: readonly DailySummaryReadRow[] = [
  summaryOn('2026-07-11', { review_count: 60 }),
  summaryOn('2026-07-12', { rank: 2, review_count: 62 }),
  failedSummaryOn(TODAY_JST),
];

// 別のオーナーの店舗にも最新の行を置く。集合外の指定を集合の外で解決してしまうと、この店舗のレポートが返る。
const OTHER_LATEST = summaryOn(TODAY_JST, {
  new_review_count: 1,
  new_reviews: [
    {
      authorName: '試験 投稿者ホ',
      publishTime: '2026-07-12T08:00:00Z',
      rating: 3,
      textExcerpt: '試験用の本文です（別のオーナーの店舗）。',
      googleMapsUri: 'https://www.google.com/maps/reviews/data=c9-review-ho',
    },
  ],
});

// 代理店経路のオーナーの店舗の最新の行。
const AGENCY_LATEST = summaryOn(TODAY_JST, { review_count_prev: 100, new_review_count: 0 });

// --- 要求 ---------------------------------------------------------------------------

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

function postbackBody(userId: string, replyToken: string, webhookEventId: string, data: string): string {
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

function textBody(userId: string, replyToken: string, webhookEventId: string, text: string): string {
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

function menuRequest(kind: ReportKind): ReportRequest {
  // メニューの区画の postback と同じ形（店舗の指定なし・頁 0）。
  return { kind, storeId: null, page: 0 };
}

// --- 偽の外部 API -------------------------------------------------------------------

function createFakeMessenger(): LineMessenger {
  return {
    reply: vi.fn(async (): Promise<void> => {}),
    getProfile: vi.fn(async () => null),
    linkRichMenu: vi.fn(async (): Promise<void> => {}),
  };
}

function createFakePlaces(outcome: SearchOutcome): PlacesSearchAdapter {
  return { searchCandidates: vi.fn(async () => outcome) };
}

function candidate(placeId: string, name: string): StoreCandidate {
  return {
    placeId,
    name,
    address: '東京都試験区1-1-1',
    latitude: 35.6,
    longitude: 139.7,
    types: ['restaurant'],
  };
}

// --- DB の問い合わせの記録 ----------------------------------------------------------
//
// 会話と振り分け口（レポート応答を含む）が使う db を、pool.query をそのまま呼ぶ物に差し替え、呼ばれた SQL を記録する。
// 重複排除（recordWebhookEventOnce）・トランザクション（confirmStore）・監査記録は元の pool を使うので数えない。
// 重複排除はイベントごとの書き込みで、レポートの読み出しではない（design.md「Performance」の 4 回に含まれない）。
//
// design.md「Performance」の読み出しの回数（新着と比較は 4 回以内・推移は 5 回以内）は、SELECT の数で数える。
// 往復の数はそれより 1 回多い。セッションの読み出し（getOrCreateSession）は、行が既にあると、何も書かない
// INSERT（ON CONFLICT DO NOTHING）を送ってから SELECT するためである。試験は SELECT の数に加えて、往復の列を
// 区分ごとにそのまま固定する（どの区分の問い合わせが 1 つ増えても赤になる）。

type StatementKind =
  | 'owner'
  | 'session_create_attempt'
  | 'session'
  | 'stores'
  | 'latest_summary'
  | 'summary_range'
  | 'other';

function sqlTextOf(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (typeof arg === 'object' && arg !== null && 'text' in arg && typeof arg.text === 'string') return arg.text;
  throw new Error('query was called without SQL text');
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** 問い合わせを、design.md「Performance」の読み出しの区分に分ける。 */
function classifyStatement(sql: string): StatementKind {
  const text = normalizeSql(sql);
  if (/^SELECT .* FROM owners WHERE line_user_id = \$1$/.test(text)) return 'owner';
  if (/^INSERT INTO onboarding_sessions \(line_user_id\) VALUES \(\$1\) ON CONFLICT \(line_user_id\) DO NOTHING RETURNING /.test(text)) {
    return 'session_create_attempt';
  }
  if (/^SELECT .* FROM onboarding_sessions WHERE line_user_id = \$1$/.test(text)) return 'session';
  if (/^SELECT id, name FROM stores WHERE owner_id = \$1 AND place_status = 'confirmed' /.test(text)) return 'stores';
  if (/^SELECT .* FROM daily_summaries ds .* LIMIT 1$/.test(text)) return 'latest_summary';
  if (/^SELECT .* FROM daily_summaries ds .* ORDER BY ds\.summary_date ASC$/.test(text)) return 'summary_range';
  return 'other';
}

describe.skipIf(!process.env.DATABASE_URL)('line-webhook report flow (DB)', () => {
  let singleStoreId = '';
  /** 複数店舗のオーナーの確定店舗（作成順: 本店・駅前店・西口店）。 */
  let multiStores: ReportableStore[] = [];
  let otherStoreId = '';

  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, 'レポート通し試験運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [AG, OP, 'レポート通し試験代理店']);

    singleStoreId = await seedCompletedOwnerWithStores(SINGLE_USER, [
      candidate('ChIJ_c9_report_single', SINGLE_STORE_NAME),
    ]).then(([id]) => requireValue(id, 'single store id'));
    for (const row of SINGLE_ROWS) {
      await insertSummary(singleStoreId, row);
    }

    const multiNames = [MAIN_STORE_NAME, STATION_STORE_NAME, WEST_STORE_NAME];
    const multiIds = await seedCompletedOwnerWithStores(
      MULTI_USER,
      multiNames.map((name, index) => candidate(`ChIJ_c9_report_multi_${index}`, name)),
    );
    multiStores = multiNames.map((name, index) => ({ id: requireValue(multiIds[index], `multi store ${index}`), name }));
    const multiOwner = requireValue(await findOwnerByLineUserId(pool, MULTI_USER), 'multi owner');
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_id, place_status) VALUES ($1, $2, $3, NULL, 'pending')`,
      [MULTI_PENDING_STORE_ID, multiOwner.id, MULTI_PENDING_STORE_NAME],
    );
    await insertSummary(storeOf(STATION_STORE_NAME).id, STATION_LATEST);
    for (const row of WEST_ROWS) {
      await insertSummary(storeOf(WEST_STORE_NAME).id, row);
    }

    otherStoreId = await seedCompletedOwnerWithStores(OTHER_USER, [
      candidate('ChIJ_c9_report_other', OTHER_STORE_NAME),
    ]).then(([id]) => requireValue(id, 'other store id'));
    await insertSummary(otherStoreId, OTHER_LATEST);
  });

  afterAll(async () => {
    await closePool();
  });

  // --- 準備 -------------------------------------------------------------------------

  function requireValue<T>(value: T | undefined | null, what: string): T {
    if (value === undefined || value === null) {
      throw new Error(`missing ${what}`);
    }
    return value;
  }

  /** 複数店舗のオーナーの確定店舗を名前で引く。 */
  function storeOf(name: string): ReportableStore {
    return requireValue(
      multiStores.find((store) => store.name === name),
      `store ${name}`,
    );
  }

  /**
   * オンボーディングを終えたオーナー（段階 completed）を作り、候補ごとに confirmStore で確定店舗を作る
   * （確定店舗の作成とオーナーの store_identified への遷移は、本番と同じ confirmStore のトランザクションで行う）。
   * 確定店舗の ID を作成順に返す。
   */
  async function seedCompletedOwnerWithStores(lineUserId: string, candidates: readonly StoreCandidate[]): Promise<string[]> {
    const pool = await getPool();
    const owner = await createOwner(pool, { agencyId: AG, lineUserId });
    await getOrCreateSession(pool, lineUserId);
    await updateSession(pool, lineUserId, { stage: 'completed', ownerId: owner.id });
    const identification = createStoreIdentificationService({ pool, places: createFakePlaces({ kind: 'empty' }) });
    const storeIds: string[] = [];
    for (const storeCandidate of candidates) {
      const outcome = await identification.confirmStore(owner.id, storeCandidate);
      if (outcome.kind !== 'confirmed') {
        throw new Error(`confirmStore did not confirm ${storeCandidate.placeId}`);
      }
      storeIds.push(outcome.storeId);
    }
    return storeIds;
  }

  // 日次集計は Go だけが書く（書き込み境界）。ここでは試験の前提として、Go が書く形の行を直接置く。
  async function insertSummary(storeId: string, row: DailySummaryReadRow): Promise<void> {
    const pool = await getPool();
    await pool.query(
      `INSERT INTO daily_summaries
         (store_id, summary_date, status, rank, rank_total, rank_prev, rating, review_count,
          rating_prev, review_count_prev, new_review_count, new_reviews, competitors)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb)`,
      [
        storeId,
        row.summary_date,
        row.status,
        row.rank,
        row.rank_total,
        row.rank_prev,
        row.rating,
        row.review_count,
        row.rating_prev,
        row.review_count_prev,
        row.new_review_count,
        JSON.stringify(row.new_reviews),
        JSON.stringify(row.competitors),
      ],
    );
  }

  interface Harness {
    readonly app: ReturnType<typeof createApp>;
    readonly messenger: LineMessenger;
    readonly places: PlacesSearchAdapter;
    readonly structuredLog: ReturnType<typeof vi.fn<Sink>>;
    /** 最後に clearStatements してから、会話と振り分け口が発行した SQL の区分。 */
    statementKinds(): StatementKind[];
    /** 最後に clearStatements してから、会話と振り分け口が発行した SELECT の数（DB の読み出し）。 */
    readCount(): number;
    clearStatements(): void;
  }

  /** index.ts と同じ形で配線したアプリ。試験ごとに作り直し、偽物の呼び出しの記録を独立させる。 */
  async function buildHarness(): Promise<Harness> {
    const pool = await getPool();
    const db = { query: pool.query.bind(pool) } satisfies Queryable;
    const querySpy = vi.spyOn(db, 'query');
    const messenger = createFakeMessenger();
    // オンボーディングへ落ちれば、店名に見えるテキストでこの検索が呼ばれる。
    const places = createFakePlaces({ kind: 'found', candidates: [candidate('ChIJ_c9_report_search', '試験検索の店')] });
    const structuredLog = vi.fn<Sink>();

    const conversationHandlers = createConversationHandlers({
      db,
      pool,
      sessions: { getOrCreateSession, updateSession },
      owners: { findOwnerByLineUserId, createOwner },
      inviteCodes: { findActiveInviteCode },
      identification: createStoreIdentificationService({ pool, places }),
      messenger,
      now: () => FIXED_NOW,
      logger: { info: vi.fn(), warn: vi.fn() },
      auditLog: (input) => createAuditLog(pool, input),
      lineRichMenuCompletedId: RICHMENU_COMPLETED_ID,
      liffStoreDetailUrl: LIFF_STORE_DETAIL_URL,
      createOwnerRouter: createStoreIdentifiedOwnerRouterFactory({
        db,
        sessions: { getOrCreateSession, updateSession },
        auditLog: (input) => createAuditLog(pool, input),
        lineRichMenuCompletedId: RICHMENU_COMPLETED_ID,
        liffStoreDetailUrl: LIFF_STORE_DETAIL_URL,
        now: () => FIXED_NOW,
      }),
    });

    const appDeps: AppDeps = {
      signatureVerifier: createSignatureVerifier(CHANNEL_SECRET),
      recordWebhookEventOnce: (webhookEventId) => recordWebhookEventOnce(pool, webhookEventId),
      conversationHandlers,
      messenger,
      logger: { error: vi.fn() },
      structuredLog,
    };

    const statements = (): string[] => querySpy.mock.calls.map(([first]) => sqlTextOf(first));
    return {
      app: createApp(appDeps),
      messenger,
      places,
      structuredLog,
      statementKinds: () => statements().map(classifyStatement),
      readCount: () => statements().filter((sql) => normalizeSql(sql).startsWith('SELECT ')).length,
      clearStatements: () => querySpy.mockClear(),
    };
  }

  /** 署名つきの webhook を 1 回送り、200 が返ることと処理にかかった時間を確かめる。 */
  async function send(harness: Harness, body: string): Promise<void> {
    const startedAt = performance.now();
    const res = await harness.app.request('/webhook', {
      method: 'POST',
      headers: { 'x-line-signature': sign(body, CHANNEL_SECRET) },
      body,
    });
    const elapsedMs = performance.now() - startedAt;
    expect(res.status).toBe(200);
    expect(elapsedMs).toBeLessThan(RESPONSE_TIME_SANITY_BUDGET_MS);
  }

  async function sendPostback(harness: Harness, userId: string, tag: string, data: string): Promise<string> {
    const replyToken = `reply-c9-${tag}`;
    await send(harness, postbackBody(userId, replyToken, `c9-evt-${tag}`, data));
    return replyToken;
  }

  /** replyToken への Reply がちょうど 1 回で、メッセージが 1 つであることを確かめて、そのメッセージを返す（7.4）。 */
  function onlyReplyTo(harness: Harness, replyToken: string): LineMessage {
    const calls = vi.mocked(harness.messenger.reply).mock.calls.filter(([token]) => token === replyToken);
    expect(calls).toHaveLength(1);
    const messages = requireValue(calls[0], 'reply call')[1];
    expect(messages).toHaveLength(1);
    return requireValue(messages[0], 'reply message');
  }

  // --- Flex の中身を、ビルダーを経由せずに読む ----------------------------------------

  type JsonRecord = Readonly<Record<string, unknown>>;

  function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function bubbleOf(message: LineMessage): JsonRecord {
    if (message.type !== 'flex' || !isRecord(message.contents)) {
      throw new Error(`expected a flex message, got ${message.type}`);
    }
    return message.contents;
  }

  /** 部品を深さ優先・出現順にたどり、pick が返した値を集める。 */
  function collect<T>(node: unknown, pick: (record: JsonRecord) => T | null): T[] {
    if (Array.isArray(node)) return node.flatMap((child) => collect(child, pick));
    if (!isRecord(node)) return [];
    const own = pick(node);
    return [...(own === null ? [] : [own]), ...Object.values(node).flatMap((child) => collect(child, pick))];
  }

  /** text 部品の文言。 */
  function textsOf(node: unknown): string[] {
    return collect(node, (record) => (record.type === 'text' && typeof record.text === 'string' ? record.text : null));
  }

  /** uri アクションの label と uri。 */
  function uriActionsOf(node: unknown): Array<{ label: unknown; uri: unknown }> {
    return collect(node, (record) => (record.type === 'uri' ? { label: record.label, uri: record.uri } : null));
  }

  /** レポートの共通の形: 見出しが店舗名とデータの時点、footer の最後が帰属表示（3.3・3.8・8.1・8.3）。 */
  function expectReportFrame(message: LineMessage, storeName: string, dataSpan: string): JsonRecord {
    const bubble = bubbleOf(message);
    expect(textsOf(bubble.header)).toEqual([storeName, dataSpan]);
    expect(textsOf(bubble.footer).at(-1)).toBe(ATTRIBUTION_TEXT);
    return bubble;
  }

  // --- 1. 単一店舗の 3 つのレポートと、DB の読み出しの回数 -----------------------------

  describe('単一店舗のオーナー（Req 2.3, 3.1, 3.3, 7.3, 7.4）', () => {
    it('新着口コミ: 選択なしでその店舗のレポートを 1 回返し、DB の読み出しは 4 回（オーナー・セッション・店舗・最新の集計）', async () => {
      const harness = await buildHarness();
      const token = await sendPostback(
        harness,
        SINGLE_USER,
        'single-new-reviews',
        encodeReportPostback(menuRequest('new_reviews')),
      );

      const message = onlyReplyTo(harness, token);
      expect(message).toEqual(buildNewReviewsReport({ storeName: SINGLE_STORE_NAME }, normalizeReadRow(SINGLE_LATEST)));
      const bubble = expectReportFrame(message, SINGLE_STORE_NAME, '7月13日時点のデータ');
      // 帰属 3 項目を持つ口コミだけを、Google Maps への導線つきで出す。低い評価の口コミも隠さない。
      expect(uriActionsOf(bubble.body).filter(({ label }) => label === GOOGLE_MAPS_LINK_TEXT)).toEqual([
        { label: GOOGLE_MAPS_LINK_TEXT, uri: REVIEW_ATTRIBUTED_LOW.googleMapsUri },
        { label: GOOGLE_MAPS_LINK_TEXT, uri: REVIEW_ATTRIBUTED_HIGH.googleMapsUri },
      ]);
      expect(JSON.stringify(message)).not.toContain(REVIEW_LEGACY.authorName);

      // design.md「Performance」: 新着は 4 回以内。セッションは getOrCreateSession が作成を試みてから読むので、
      // SELECT の前に何も書かない INSERT（ON CONFLICT DO NOTHING）が 1 回ある。
      expect(harness.statementKinds()).toEqual(['owner', 'session_create_attempt', 'session', 'stores', 'latest_summary']);
      expect(harness.readCount()).toBe(4);
    });

    it('競合店との比較: その店舗のレポートを 1 回返し、DB の読み出しは 4 回', async () => {
      const harness = await buildHarness();
      const token = await sendPostback(
        harness,
        SINGLE_USER,
        'single-comparison',
        encodeReportPostback(menuRequest('comparison')),
      );

      const message = onlyReplyTo(harness, token);
      expect(message).toEqual(buildComparisonReport({ storeName: SINGLE_STORE_NAME }, normalizeReadRow(SINGLE_LATEST)));
      const bubble = expectReportFrame(message, SINGLE_STORE_NAME, '7月13日時点のデータ');
      // 評価のある競合を日次集計の順に、評価のない競合を末尾に並べる（正規化を通した行で組み立てている）。
      const competitorNames = textsOf(bubble.body).filter((text) => text.startsWith('比較試験'));
      expect(competitorNames).toEqual(['比較試験亭', '比較試験屋', '比較試験庵', '比較試験処']);

      expect(harness.statementKinds()).toEqual(['owner', 'session_create_attempt', 'session', 'stores', 'latest_summary']);
      expect(harness.readCount()).toBe(4);
    });

    it('直近の推移: 最新の集計の日を終点に 7 暦日の表を返し、DB の読み出しは 5 回（範囲の読み出しが 1 回多い）', async () => {
      const harness = await buildHarness();
      const token = await sendPostback(harness, SINGLE_USER, 'single-trend', encodeReportPostback(menuRequest('trend')));

      const message = onlyReplyTo(harness, token);
      // 範囲は 07-07〜07-13。07-06 の行は範囲の外なので表に出ない。
      const rowsInRange = SINGLE_ROWS.filter((row) => row.summary_date >= '2026-07-07').map(normalizeReadRow);
      expect(message).toEqual(
        buildTrendReport(
          { storeName: SINGLE_STORE_NAME },
          classifyTrendDays(TODAY_JST, rowsInRange, TREND_DAYS),
          false,
          storeDetailUrlFor(LIFF_STORE_DETAIL_URL, singleStoreId),
        ),
      );
      const bubble = expectReportFrame(message, SINGLE_STORE_NAME, '7月7日〜7月13日のデータ');
      // 詳細画面への導線は、この店舗のヒントを付けた LIFF の URL（6.6）。
      expect(uriActionsOf(bubble.footer).map(({ uri }) => uri)).toEqual([
        `${LIFF_STORE_DETAIL_URL}?storeId=${singleStoreId}`,
      ]);
      // 表の日付の列は 7 暦日（行の無い日と取得失敗の日も並べる）。
      const dayLabels = textsOf(bubble.body).filter((text) => /^7月\d+日$/.test(text));
      expect(dayLabels).toEqual(['7月7日', '7月8日', '7月9日', '7月10日', '7月11日', '7月12日', '7月13日']);

      // design.md「Performance」: 推移は 5 回以内（最新の集計の日付を終点に範囲を読むため 1 回多い）。
      expect(harness.statementKinds()).toEqual([
        'owner',
        'session_create_attempt',
        'session',
        'stores',
        'latest_summary',
        'summary_range',
      ]);
      expect(harness.readCount()).toBe(5);
    });
  });

  // --- 2. 複数店舗の選択肢 → 選択 ----------------------------------------------------

  describe('複数店舗のオーナー（Req 3.2, 3.3, 3.4）', () => {
    it('店舗の指定の無い要求には本人の確定店舗だけを選択肢に並べ、選んだ店舗の名前を示したレポートを返す', async () => {
      const harness = await buildHarness();
      const choiceToken = await sendPostback(
        harness,
        MULTI_USER,
        'multi-choice',
        encodeReportPostback(menuRequest('new_reviews')),
      );

      const choice = onlyReplyTo(harness, choiceToken);
      expect(choice).toEqual(
        buildStoreChoiceMessage('new_reviews', { stores: multiStores, pageIndex: 0, nextPageIndex: null }, 'multiple'),
      );
      if (choice.type !== 'text') {
        throw new Error('the store choice must be a text message with quick replies');
      }
      // 選択肢は作成順の確定店舗 3 つで、未確定の店舗と別のオーナーの店舗を含まない。
      const items = choice.quickReply?.items ?? [];
      expect(items.map((item) => item.action.displayText)).toEqual([
        MAIN_STORE_NAME,
        STATION_STORE_NAME,
        WEST_STORE_NAME,
      ]);
      expect(items.map((item) => decodeReportPostback(item.action.data))).toEqual(
        multiStores.map((store) => ({ kind: 'new_reviews', storeId: store.id, page: 0 })),
      );
      // 店舗が決まらない間は日次集計を読まない。
      expect(harness.statementKinds()).toEqual(['owner', 'session_create_attempt', 'session', 'stores']);

      // 返った選択肢の postback をそのまま送る（オーナーが「駅前店」を選ぶ）。
      harness.clearStatements();
      const station = requireValue(
        items.find((item) => item.action.displayText === STATION_STORE_NAME),
        'station choice',
      );
      const selectToken = await sendPostback(harness, MULTI_USER, 'multi-select-station', station.action.data);

      const report = onlyReplyTo(harness, selectToken);
      expect(report).toEqual(buildNewReviewsReport({ storeName: STATION_STORE_NAME }, normalizeReadRow(STATION_LATEST)));
      expectReportFrame(report, STATION_STORE_NAME, '7月13日時点のデータ');
      // 店舗の選択も 1 回の要求で、DB の読み出しは 4 回（7.3・design.md「Performance」）。
      expect(harness.statementKinds()).toEqual(['owner', 'session_create_attempt', 'session', 'stores', 'latest_summary']);
      expect(harness.readCount()).toBe(4);
      expect(harness.messenger.reply).toHaveBeenCalledTimes(2);
    });
  });

  // --- 3. 選べない店舗の指定の再提示 --------------------------------------------------

  describe('選べない店舗の指定（Req 3.4, 3.6）', () => {
    it(
      '他のオーナーに実在する店舗・本人の未確定の店舗・存在しない店舗の指定は、どれも同じ再提示と同じ記録になり、' +
        '指定された店舗の情報も ID も出さない',
      async () => {
        const harness = await buildHarness();
        const hints = [
          ['other-owner', otherStoreId],
          ['own-pending', MULTI_PENDING_STORE_ID],
          ['nonexistent', NONEXISTENT_STORE_ID],
        ] as const;

        const replies: LineMessage[] = [];
        for (const [tag, storeId] of hints) {
          const token = await sendPostback(
            harness,
            MULTI_USER,
            `hint-${tag}`,
            encodeReportPostback({ kind: 'new_reviews', storeId, page: 0 }),
          );
          replies.push(onlyReplyTo(harness, token));
        }

        // 3 つの Reply は互いに同じで、本人の確定店舗の選択肢に「その店舗は選べません。」を添えたもの。
        const expected = buildStoreChoiceMessage(
          'new_reviews',
          { stores: multiStores, pageIndex: 0, nextPageIndex: null },
          'invalid_choice',
        );
        expect(replies).toEqual([expected, expected, expected]);
        expect(expected.type === 'text' ? expected.text.split('\n')[0] : '').toBe('その店舗は選べません。');
        const replied = JSON.stringify(replies);
        for (const hidden of [OTHER_STORE_NAME, otherStoreId, MULTI_PENDING_STORE_NAME, MULTI_PENDING_STORE_ID, NONEXISTENT_STORE_ID]) {
          expect(replied).not.toContain(hidden);
        }
        // 集合の外の指定では、日次集計を読まない（別のオーナーの店舗の行へ触れない）。
        expect(harness.statementKinds().filter((kind) => kind === 'latest_summary' || kind === 'summary_range')).toEqual([]);

        // 記録: 指定を無視した事象と応答の区分が 3 回ずつ。どの記録にも店舗 ID と LINE ユーザー ID を載せない。
        const logged = harness.structuredLog.mock.calls.map(([level, event, fields]) => ({ level, event, fields }));
        expect(logged.filter(({ event }) => event === 'line-webhook.report_store_hint_ignored')).toEqual(
          hints.map(() => ({
            level: 'warn',
            event: 'line-webhook.report_store_hint_ignored',
            fields: { reportKind: 'new_reviews' },
          })),
        );
        expect(logged.filter(({ event }) => event === 'line-webhook.report_replied')).toEqual(
          hints.map(() => ({
            level: 'info',
            event: 'line-webhook.report_replied',
            fields: { reportKind: 'new_reviews', reportOutcome: 'store_choice' },
          })),
        );
        const loggedText = JSON.stringify(harness.structuredLog.mock.calls);
        for (const identifier of [...hints.map(([, storeId]) => storeId), ...multiStores.map((store) => store.id), MULTI_USER]) {
          expect(loggedText).not.toContain(identifier);
        }
      },
    );
  });

  // --- 4. 行なしと取得失敗 -------------------------------------------------------------

  describe('日次集計が無い店舗と、最新の日次集計が取得失敗の店舗（Req 7.1, 7.2）', () => {
    const KINDS: readonly ReportKind[] = ['new_reviews', 'comparison', 'trend'];

    it('日次集計が 1 件も無い店舗を選ぶと、3 種類とも店舗名を添えた準備中の案内を返す', async () => {
      const harness = await buildHarness();
      const main = storeOf(MAIN_STORE_NAME);
      for (const kind of KINDS) {
        harness.clearStatements();
        const token = await sendPostback(
          harness,
          MULTI_USER,
          `main-${kind}`,
          encodeReportPostback({ kind, storeId: main.id, page: 0 }),
        );
        const message = onlyReplyTo(harness, token);
        expect(message).toEqual(buildPreparingNotice({ storeName: MAIN_STORE_NAME }));
        expect(message.type === 'text' ? message.text.split('\n')[0] : '').toBe(
          `「${MAIN_STORE_NAME}」の初回のデータを準備しています。`,
        );
        // 最新の集計が無ければ、推移も範囲を読まない。
        expect(harness.statementKinds()).toEqual(['owner', 'session_create_attempt', 'session', 'stores', 'latest_summary']);
      }
      const outcomes = harness.structuredLog.mock.calls
        .filter(([, event]) => event === 'line-webhook.report_replied')
        .map(([, , fields]) => fields);
      expect(outcomes).toEqual(KINDS.map((kind) => ({ reportKind: kind, reportOutcome: 'preparing' })));
    });

    it('最新が取得失敗の店舗: 新着と比較は店舗名とデータ対象日を添えた取得失敗の案内、推移は失敗の日を示した表に注記を添える', async () => {
      const harness = await buildHarness();
      const west = storeOf(WEST_STORE_NAME);
      const request = (kind: ReportKind): string => encodeReportPostback({ kind, storeId: west.id, page: 0 });

      for (const kind of ['new_reviews', 'comparison'] as const) {
        const token = await sendPostback(harness, MULTI_USER, `west-${kind}`, request(kind));
        const message = onlyReplyTo(harness, token);
        expect(message).toEqual(buildFetchFailedNotice({ storeName: WEST_STORE_NAME }, TODAY_JST));
        expect(message.type === 'text' ? message.text.split('\n')[0] : '').toBe(
          `「${WEST_STORE_NAME}」の最新のデータ（7月13日分）を取得できませんでした。`,
        );
      }

      const trendToken = await sendPostback(harness, MULTI_USER, 'west-trend', request('trend'));
      const trend = onlyReplyTo(harness, trendToken);
      expect(trend).toEqual(
        buildTrendReport(
          { storeName: WEST_STORE_NAME },
          classifyTrendDays(TODAY_JST, WEST_ROWS.map(normalizeReadRow), TREND_DAYS),
          true,
          storeDetailUrlFor(LIFF_STORE_DETAIL_URL, west.id),
        ),
      );
      const bubble = expectReportFrame(trend, WEST_STORE_NAME, '7月7日〜7月13日のデータ');
      const bodyTexts = textsOf(bubble.body);
      expect(bodyTexts).toContain('最新のデータ（7月13日分）を取得できませんでした。次のデータの更新の後に、もう一度ご確認ください。');
      // 表の最終行（7月13日）は値を持たず「取得失敗」と示す。
      expect(bodyTexts.slice(-2)).toEqual(['7月13日', '取得失敗']);

      const outcomes = harness.structuredLog.mock.calls
        .filter(([, event]) => event === 'line-webhook.report_replied')
        .map(([, , fields]) => fields);
      expect(outcomes).toEqual(KINDS.map((kind) => ({ reportKind: kind, reportOutcome: 'fetch_failed' })));
    });
  });

  // --- 5. 代理店経路のオーナー ---------------------------------------------------------

  describe('代理店経路のオーナー（段階が店名入力待ちのまま確定店舗を持つ・Req 2.3, 2.9）', () => {
    /**
     * 代理店による登録を再現する。オーナーと店名入力待ちの段階を作り、confirmStore で確定店舗を作る
     * （オーナーは store_identified になるが、会話の段階は店名入力待ちのまま残る）。確定店舗には最新の行を置く。
     */
    async function seedAgencyRegisteredOwner(lineUserId: string, storeCandidate: StoreCandidate): Promise<string> {
      const pool = await getPool();
      const owner = await createOwner(pool, { agencyId: AG, lineUserId });
      await getOrCreateSession(pool, lineUserId);
      await updateSession(pool, lineUserId, { stage: 'await_store_name', ownerId: owner.id });
      const outcome = await createStoreIdentificationService({
        pool,
        places: createFakePlaces({ kind: 'empty' }),
      }).confirmStore(owner.id, storeCandidate);
      if (outcome.kind !== 'confirmed') {
        throw new Error('confirmStore did not confirm the agency-registered store');
      }
      await insertSummary(outcome.storeId, AGENCY_LATEST);
      // 前提: 店舗特定済みで、段階は店名入力待ちのまま。
      expect((await findOwnerByLineUserId(pool, lineUserId))?.onboarding_status).toBe('store_identified');
      expect((await getOrCreateSession(pool, lineUserId)).stage).toBe('await_store_name');
      return owner.id;
    }

    async function stageOf(lineUserId: string): Promise<string> {
      return (await getOrCreateSession(await getPool(), lineUserId)).stage;
    }

    it('店名に見えるテキストには、店名の検索ではなくステータス案内を返し、完了後メニューを張って段階を completed に揃える。続くレポートの要求にはレポートを返す', async () => {
      const lineUserId = 'Uc9-report-agency-text-first';
      const storeName = 'レポート試験食堂 代理店登録店';
      await seedAgencyRegisteredOwner(lineUserId, candidate('ChIJ_c9_report_agency_text', storeName));
      const harness = await buildHarness();

      const textToken = 'reply-c9-agency-text';
      await send(harness, textBody(lineUserId, textToken, 'c9-evt-agency-text', storeName));

      expect(onlyReplyTo(harness, textToken)).toEqual(buildStatusGuidanceMessage());
      expect(harness.places.searchCandidates).not.toHaveBeenCalled();
      expect(harness.messenger.linkRichMenu).toHaveBeenCalledTimes(1);
      expect(harness.messenger.linkRichMenu).toHaveBeenCalledWith(lineUserId, RICHMENU_COMPLETED_ID);
      expect(await stageOf(lineUserId)).toBe('completed');

      const reportToken = await sendPostback(
        harness,
        lineUserId,
        'agency-text-first-report',
        encodeReportPostback(menuRequest('new_reviews')),
      );
      expect(onlyReplyTo(harness, reportToken)).toEqual(
        buildNewReviewsReport({ storeName }, normalizeReadRow(AGENCY_LATEST)),
      );
      // 段階が completed になったので、張り直さない。
      expect(harness.messenger.linkRichMenu).toHaveBeenCalledTimes(1);
      expect(harness.messenger.reply).toHaveBeenCalledTimes(2);
    });

    it('最初の操作がレポートの要求でも、オンボーディングの案内ではなくレポートを 1 回返し、その後に完了後メニューを張る', async () => {
      const lineUserId = 'Uc9-report-agency-report-first';
      const storeName = 'レポート試験食堂 代理店登録二号店';
      await seedAgencyRegisteredOwner(lineUserId, candidate('ChIJ_c9_report_agency_report', storeName));
      const harness = await buildHarness();

      const token = await sendPostback(
        harness,
        lineUserId,
        'agency-report-first',
        encodeReportPostback(menuRequest('comparison')),
      );

      expect(onlyReplyTo(harness, token)).toEqual(
        buildComparisonReport({ storeName }, normalizeReadRow(AGENCY_LATEST)),
      );
      expect(harness.messenger.reply).toHaveBeenCalledTimes(1);
      expect(harness.places.searchCandidates).not.toHaveBeenCalled();
      expect(harness.messenger.linkRichMenu).toHaveBeenCalledTimes(1);
      expect(harness.messenger.linkRichMenu).toHaveBeenCalledWith(lineUserId, RICHMENU_COMPLETED_ID);
      expect(await stageOf(lineUserId)).toBe('completed');
    });
  });
});
