// レポート要求の応答の試験（design.md「ReportHandler」・Requirements 2.3, 3.1, 3.2, 3.3, 3.6, 3.7, 3.8, 4.1,
// 5.1, 6.1, 7.1, 7.2, 7.4, 7.5）。
// - 店舗の一覧 → 解決 → 種類ごとの読み出し → 正規化 → 組立 → Reply 1 回、の順で応えること
// - 例外を投げずに戻る分岐はすべて Reply がちょうど 1 回、例外を投げるときは 0 回であること
// - 店舗を解決した後の例外は店舗名つきの StoreScopedReportError に包み、解決する前の例外は包まないこと
// - 読み出しの基準日が日本時間の今日であること（日本時間の 0〜9 時に UTC の日付を渡さないこと）
// - 推移は最新の集計を読んでから、その日付を終点に範囲を読むこと
// - 応答ごとの記録と、集合外の指定を無視した記録に、店舗 ID を載せないこと
//
// 読み出しと Reply と記録は偽物に差し替える。応答の中身は各ビルダーの出力と突き合わせる（ビルダーの
// 表示の規則はビルダーごとの試験が持つ）。店名は試験用の架空のもので、実在の店舗を指さない。
import { describe, expect, it, vi } from 'vitest';
import type {
  DailySummaryCompetitor,
  DailySummaryNewReview,
  DailySummaryReadRow,
  Queryable,
  ReportableStore,
} from '@fwlm/db';
import type { LogFields } from '@fwlm/observability';
import type { ReportKind, ReportRequest } from '@fwlm/line-report';
import type { LineMessage } from '../../src/line/client.js';
import { buildComparisonReport } from '../../src/report/builders/comparison.js';
import { buildNewReviewsReport } from '../../src/report/builders/new-reviews.js';
import {
  buildFetchFailedNotice,
  buildNoStoreNotice,
  buildPreparingNotice,
} from '../../src/report/builders/notices.js';
import { buildStoreChoiceMessage } from '../../src/report/builders/store-choice.js';
import {
  TREND_DAYS,
  buildTrendReport,
  classifyTrendDays,
  storeDetailUrlFor,
} from '../../src/report/builders/trend.js';
import { StoreScopedReportError } from '../../src/report/errors.js';
import { FlexBubbleTooLargeError, normalizeReadRow } from '../../src/report/format.js';
import {
  createReportHandler,
  type ReportHandlerDeps,
  type ReportOutcome,
  type ReportReadsAccessor,
} from '../../src/report/handler.js';

const KINDS: readonly ReportKind[] = ['new_reviews', 'comparison', 'trend'];

const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REPLY_TOKEN = 'reply-token-report-1';
const LIFF_URL = 'https://liff.line.me/2000000000-abcdefgh';

const STORE_A: ReportableStore = { id: '11111111-1111-4111-8111-111111111111', name: '試験食堂 駅前店' };
const STORE_B: ReportableStore = { id: '22222222-2222-4222-8222-222222222222', name: '試験食堂 本店' };
// 集合外の店舗 ID。前者は「他のオーナーに実在する店舗」、後者は「どこにも存在しない店舗」の役である。
// 単体試験では集合の外であることだけが効くので、2 つの応答と記録が同じであることを確かめる。
const OTHER_OWNER_STORE_ID = '33333333-3333-4333-8333-333333333333';
const NONEXISTENT_STORE_ID = '44444444-4444-4444-8444-444444444444';

// 日本時間 2026-09-15 12:00。基準日は '2026-09-15'。
const NOON_JST = new Date('2026-09-15T03:00:00Z');
const TODAY_JST = '2026-09-15';

// --- 行 ----------------------------------------------------------------------------

function competitor(name: string, rating: number | null, reviewCount: number, starDiff: number | null): DailySummaryCompetitor {
  return { name, rating, reviewCount, starDiff };
}

function review(overrides: Partial<DailySummaryNewReview> = {}): DailySummaryNewReview {
  return {
    authorName: '試験投稿者',
    publishTime: '2026-09-14T09:30:00Z',
    rating: 2,
    textExcerpt: '料理が出てくるまで少し待ちました。',
    googleMapsUri: 'https://www.google.com/maps/reviews/data=!4m8!14m7!1m6!2m5!1sTEST',
    ...overrides,
  };
}

// 取得に成功した行。旧 Go が書いた評価 0 の競合を 1 店含む（正規化を通さないと「★0」と母数に数えられる）。
function readyRow(date: string, overrides: Partial<DailySummaryReadRow> = {}): DailySummaryReadRow {
  return {
    summary_date: date,
    status: 'ready',
    rank: 2,
    rank_total: 4,
    rank_prev: 3,
    rating: '4.2',
    review_count: 120,
    rating_prev: '4.1',
    review_count_prev: 118,
    new_review_count: 2,
    new_reviews: [review()],
    competitors: [
      competitor('試験競合A', 4.5, 300, -0.3),
      competitor('試験競合B', 4.0, 80, 0.2),
      competitor('試験競合C', 0, 0, 4.2),
    ],
    ...overrides,
  };
}

function failedRow(date: string): DailySummaryReadRow {
  return {
    summary_date: date,
    status: 'failed',
    rank: null,
    rank_total: null,
    rank_prev: null,
    rating: null,
    review_count: null,
    rating_prev: null,
    review_count_prev: null,
    new_review_count: 0,
    new_reviews: [],
    competitors: [],
  };
}

// --- 偽物 --------------------------------------------------------------------------

interface LatestCall {
  readonly db: Queryable;
  readonly storeId: string;
  readonly asOf: string;
}

interface RangeCall {
  readonly db: Queryable;
  readonly storeId: string;
  readonly endDate: string;
  readonly days: number;
  readonly asOf: string;
}

interface FakeReadsOptions {
  readonly stores?: readonly ReportableStore[] | Error;
  readonly latest?: DailySummaryReadRow | null | Error;
  readonly range?: readonly DailySummaryReadRow[] | Error;
}

function fakeReads(options: FakeReadsOptions) {
  const order: string[] = [];
  const storesCalls: Array<{ readonly db: Queryable; readonly ownerId: string }> = [];
  const latestCalls: LatestCall[] = [];
  const rangeCalls: RangeCall[] = [];
  const reads: ReportReadsAccessor = {
    async listReportableStores(db, ownerId) {
      order.push('stores');
      storesCalls.push({ db, ownerId });
      const stores = options.stores ?? [STORE_A];
      if (stores instanceof Error) {
        throw stores;
      }
      return [...stores];
    },
    async findLatestDailySummary(db, storeId, asOf) {
      order.push('latest');
      latestCalls.push({ db, storeId, asOf });
      const latest = options.latest === undefined ? readyRow(TODAY_JST) : options.latest;
      if (latest instanceof Error) {
        throw latest;
      }
      return latest;
    },
    async listDailySummariesEndingAt(db, storeId, endDate, days, asOf) {
      order.push('range');
      rangeCalls.push({ db, storeId, endDate, days, asOf });
      const range = options.range ?? [];
      if (range instanceof Error) {
        throw range;
      }
      return [...range];
    },
  };
  return { reads, order, storesCalls, latestCalls, rangeCalls };
}

interface ReplyCall {
  readonly replyToken: string;
  readonly messages: readonly LineMessage[];
}

interface LogCall {
  readonly level: 'info' | 'warn';
  readonly event: string;
  readonly fields: LogFields | undefined;
}

// 読み出しは偽物へ渡すので、DB へ直接は触れない。触れたら試験の前提が崩れているので落とす。
const DB = {
  query: vi.fn(() => {
    throw new Error('the handler must read through the injected reads');
  }),
} as unknown as Queryable;

function setup(options: FakeReadsOptions & { readonly now?: Date } = {}) {
  const fake = fakeReads(options);
  const replies: ReplyCall[] = [];
  const logs: LogCall[] = [];
  const deps: ReportHandlerDeps = {
    db: DB,
    messenger: {
      async reply(replyToken, messages) {
        replies.push({ replyToken, messages });
      },
    },
    liffStoreDetailUrl: LIFF_URL,
    logger: {
      info: (event, fields) => logs.push({ level: 'info', event, fields }),
      warn: (event, fields) => logs.push({ level: 'warn', event, fields }),
    },
    reads: fake.reads,
    now: () => options.now ?? NOON_JST,
  };
  const handler = createReportHandler(deps);
  const handle = (request: ReportRequest): Promise<ReportOutcome> =>
    handler.handle({ replyToken: REPLY_TOKEN, ownerId: OWNER_ID, request });
  return { ...fake, replies, logs, handle };
}

function menuRequest(kind: ReportKind): ReportRequest {
  return { kind, storeId: null, page: 0 };
}

function repliedEvent(kind: ReportKind, outcome: ReportOutcome): LogCall {
  return { level: 'info', event: 'line-webhook.report_replied', fields: { reportKind: kind, reportOutcome: outcome } };
}

// 記録のどこにも識別子が現れないこと。値として持たないだけでなく、別の項目へ紛れ込ませていないことも見る。
function expectNoIdentifiersLogged(logs: readonly LogCall[], ids: readonly string[]): void {
  const serialized = JSON.stringify(logs);
  for (const id of ids) {
    expect(serialized).not.toContain(id);
  }
  for (const { fields } of logs) {
    expect(fields === undefined ? [] : Object.keys(fields)).not.toContain('storeId');
  }
}

// --- 店舗なし ------------------------------------------------------------------------

describe('ReportHandler: 対象店舗が無い（3.7）', () => {
  it.each(KINDS)('%s: 店舗が無い案内を 1 回返し、集計を読まない', async (kind) => {
    const t = setup({ stores: [] });

    await expect(t.handle(menuRequest(kind))).resolves.toBe('no_store');

    expect(t.replies).toEqual([{ replyToken: REPLY_TOKEN, messages: [buildNoStoreNotice()] }]);
    expect(t.order).toEqual(['stores']);
    expect(t.logs).toEqual([repliedEvent(kind, 'no_store')]);
  });

  it('店舗の指定があっても、店舗が無ければ同じ案内を返し、指定を無視した記録を出さない', async () => {
    const t = setup({ stores: [] });

    await expect(t.handle({ kind: 'comparison', storeId: OTHER_OWNER_STORE_ID, page: 0 })).resolves.toBe('no_store');

    expect(t.replies).toEqual([{ replyToken: REPLY_TOKEN, messages: [buildNoStoreNotice()] }]);
    expect(t.logs).toEqual([repliedEvent('comparison', 'no_store')]);
  });
});

// --- 1 店舗のレポート ----------------------------------------------------------------

describe('ReportHandler: 1 店舗のオーナーは選択なしでレポートを受け取る（3.1・3.3・4.1・5.1・6.1）', () => {
  it('新着口コミ: 最新の集計を正規化して組み立てたレポートを 1 回返す', async () => {
    const latest = readyRow(TODAY_JST);
    const t = setup({ latest });

    await expect(t.handle(menuRequest('new_reviews'))).resolves.toBe('report');

    expect(t.replies).toEqual([
      {
        replyToken: REPLY_TOKEN,
        messages: [buildNewReviewsReport({ storeName: STORE_A.name }, normalizeReadRow(latest))],
      },
    ]);
    expect(t.order).toEqual(['stores', 'latest']);
    expect(t.logs).toEqual([repliedEvent('new_reviews', 'report')]);
  });

  it('競合店との比較: 最新の集計を正規化して組み立てたレポートを 1 回返す', async () => {
    const latest = readyRow(TODAY_JST);
    const t = setup({ latest });

    await expect(t.handle(menuRequest('comparison'))).resolves.toBe('report');

    const expected = buildComparisonReport({ storeName: STORE_A.name }, normalizeReadRow(latest));
    expect(t.replies).toEqual([{ replyToken: REPLY_TOKEN, messages: [expected] }]);
    // 旧 Go の評価 0 の競合を正規化していれば、母数に数えず「★0」も出さない。正規化を飛ばすと
    // 組立の入力が変わり、上の一致が崩れる。ここでは正規化が効く行であることを確かめておく。
    expect(JSON.stringify(expected)).not.toContain('★0');
    expect(t.order).toEqual(['stores', 'latest']);
    expect(t.logs).toEqual([repliedEvent('comparison', 'report')]);
  });

  it('直近の推移: 最新の集計の日付を終点に 7 日の範囲を読み、組み立てたレポートを 1 回返す', async () => {
    const latest = readyRow(TODAY_JST);
    const range = [readyRow('2026-09-13', { rank: 3 }), readyRow('2026-09-14'), latest];
    const t = setup({ latest, range });

    await expect(t.handle(menuRequest('trend'))).resolves.toBe('report');

    const days = classifyTrendDays(TODAY_JST, range.map(normalizeReadRow), TREND_DAYS);
    expect(t.replies).toEqual([
      {
        replyToken: REPLY_TOKEN,
        messages: [buildTrendReport({ storeName: STORE_A.name }, days, false, storeDetailUrlFor(LIFF_URL, STORE_A.id))],
      },
    ]);
    expect(t.order).toEqual(['stores', 'latest', 'range']);
    expect(t.rangeCalls).toEqual([
      { db: DB, storeId: STORE_A.id, endDate: TODAY_JST, days: TREND_DAYS, asOf: TODAY_JST },
    ]);
    expect(t.logs).toEqual([repliedEvent('trend', 'report')]);
  });

  it('直近の推移: 最新の集計が今日より前なら、範囲の終点は今日ではなく最新の集計の日付である', async () => {
    const latest = readyRow('2026-09-12');
    const range = [readyRow('2026-09-10'), readyRow('2026-09-11'), latest];
    const t = setup({ latest, range });

    await expect(t.handle(menuRequest('trend'))).resolves.toBe('report');

    expect(t.rangeCalls).toEqual([
      { db: DB, storeId: STORE_A.id, endDate: '2026-09-12', days: TREND_DAYS, asOf: TODAY_JST },
    ]);
    const days = classifyTrendDays('2026-09-12', range.map(normalizeReadRow), TREND_DAYS);
    expect(t.replies).toEqual([
      {
        replyToken: REPLY_TOKEN,
        messages: [buildTrendReport({ storeName: STORE_A.name }, days, false, storeDetailUrlFor(LIFF_URL, STORE_A.id))],
      },
    ]);
  });

  it.each(KINDS)('%s: 読み出しは店舗の一覧のオーナー ID と、解決した店舗の ID で行う', async (kind) => {
    const t = setup({ range: [readyRow(TODAY_JST)] });

    await t.handle(menuRequest(kind));

    expect(t.storesCalls).toEqual([{ db: DB, ownerId: OWNER_ID }]);
    expect(t.latestCalls).toEqual([{ db: DB, storeId: STORE_A.id, asOf: TODAY_JST }]);
    expect(t.rangeCalls.map((call) => call.storeId)).toEqual(kind === 'trend' ? [STORE_A.id] : []);
    expect(DB.query).not.toHaveBeenCalled();
  });
});

// --- 基準日 --------------------------------------------------------------------------

describe('ReportHandler: 読み出しの基準日は日本時間の今日である', () => {
  it.each([
    // [現在時刻（UTC）, 日本時間の今日]
    ['2026-09-14T16:30:00Z', '2026-09-15'], // 日本時間 1:30（UTC ではまだ前日）
    ['2026-09-14T15:00:00Z', '2026-09-15'], // 日本時間 0:00 ちょうど
    ['2026-09-14T14:59:59Z', '2026-09-14'], // 日本時間 23:59:59
    ['2026-09-15T14:59:59Z', '2026-09-15'], // 日本時間 23:59:59（UTC では同じ日の昼）
    ['2026-12-31T15:00:00Z', '2027-01-01'], // 年をまたぐ
  ])('現在が %s なら基準日は %s', async (nowIso, asOf) => {
    const latest = readyRow(asOf);
    const t = setup({ now: new Date(nowIso), latest, range: [latest] });

    await t.handle(menuRequest('trend'));

    expect(t.latestCalls.map((call) => call.asOf)).toEqual([asOf]);
    expect(t.rangeCalls.map((call) => call.asOf)).toEqual([asOf]);
  });
});

// --- 複数店舗と選択 ------------------------------------------------------------------

describe('ReportHandler: 複数店舗のオーナー（3.2・3.3・3.6）', () => {
  it.each(KINDS)('%s: 店舗の指定が無ければ選択肢を 1 回返し、集計を読まない', async (kind) => {
    const t = setup({ stores: [STORE_A, STORE_B] });

    await expect(t.handle(menuRequest(kind))).resolves.toBe('store_choice');

    const page = { stores: [STORE_A, STORE_B], pageIndex: 0, nextPageIndex: null };
    expect(t.replies).toEqual([{ replyToken: REPLY_TOKEN, messages: [buildStoreChoiceMessage(kind, page, 'multiple')] }]);
    expect(t.order).toEqual(['stores']);
    expect(t.logs).toEqual([repliedEvent(kind, 'store_choice')]);
  });

  it('選んだ店舗が集合の中にあれば、その店舗の集計を読み、その店舗名のレポートを返す', async () => {
    const latest = readyRow(TODAY_JST);
    const t = setup({ stores: [STORE_A, STORE_B], latest });

    await expect(t.handle({ kind: 'comparison', storeId: STORE_B.id, page: 0 })).resolves.toBe('report');

    expect(t.latestCalls.map((call) => call.storeId)).toEqual([STORE_B.id]);
    expect(t.replies).toEqual([
      {
        replyToken: REPLY_TOKEN,
        messages: [buildComparisonReport({ storeName: STORE_B.name }, normalizeReadRow(latest))],
      },
    ]);
    expect(t.logs).toEqual([repliedEvent('comparison', 'report')]);
  });

  it('集合外の店舗の指定は選択肢を再提示し、店舗 ID を載せずに指定を無視した記録を出す', async () => {
    const t = setup({ stores: [STORE_A, STORE_B] });

    await expect(t.handle({ kind: 'trend', storeId: OTHER_OWNER_STORE_ID, page: 0 })).resolves.toBe('store_choice');

    const page = { stores: [STORE_A, STORE_B], pageIndex: 0, nextPageIndex: null };
    expect(t.replies).toEqual([
      { replyToken: REPLY_TOKEN, messages: [buildStoreChoiceMessage('trend', page, 'invalid_choice')] },
    ]);
    expect(t.order).toEqual(['stores']);
    expect(t.logs).toEqual([
      { level: 'warn', event: 'line-webhook.report_store_hint_ignored', fields: { reportKind: 'trend' } },
      repliedEvent('trend', 'store_choice'),
    ]);
    expectNoIdentifiersLogged(t.logs, [OTHER_OWNER_STORE_ID, STORE_A.id, STORE_B.id, OWNER_ID]);
  });

  it('1 店舗のオーナーでも、集合外の指定には選択肢を再提示する（指定した店舗の情報を開示しない）', async () => {
    const t = setup({ stores: [STORE_A] });

    await expect(t.handle({ kind: 'new_reviews', storeId: OTHER_OWNER_STORE_ID, page: 0 })).resolves.toBe(
      'store_choice',
    );

    const page = { stores: [STORE_A], pageIndex: 0, nextPageIndex: null };
    expect(t.replies).toEqual([
      { replyToken: REPLY_TOKEN, messages: [buildStoreChoiceMessage('new_reviews', page, 'invalid_choice')] },
    ]);
    expect(t.order).toEqual(['stores']);
    expect(t.logs.map((log) => log.event)).toEqual([
      'line-webhook.report_store_hint_ignored',
      'line-webhook.report_replied',
    ]);
  });

  it('他のオーナーに実在する店舗 ID と、どこにも無い店舗 ID で、応答と記録が同じである', async () => {
    const other = setup({ stores: [STORE_A, STORE_B] });
    const missing = setup({ stores: [STORE_A, STORE_B] });

    await other.handle({ kind: 'comparison', storeId: OTHER_OWNER_STORE_ID, page: 0 });
    await missing.handle({ kind: 'comparison', storeId: NONEXISTENT_STORE_ID, page: 0 });

    expect(other.replies).toEqual(missing.replies);
    expect(other.logs).toEqual(missing.logs);
    expectNoIdentifiersLogged([...other.logs, ...missing.logs], [OTHER_OWNER_STORE_ID, NONEXISTENT_STORE_ID]);
  });
});

// --- 準備中と取得失敗 ----------------------------------------------------------------

describe('ReportHandler: 集計が無い・最新が取得失敗（7.1・7.2）', () => {
  it.each(KINDS)('%s: 集計が 1 件も無ければ、店舗名を添えた準備中の案内を 1 回返す', async (kind) => {
    const t = setup({ latest: null });

    await expect(t.handle(menuRequest(kind))).resolves.toBe('preparing');

    expect(t.replies).toEqual([
      { replyToken: REPLY_TOKEN, messages: [buildPreparingNotice({ storeName: STORE_A.name })] },
    ]);
    // 推移も範囲を読まない（終点にする最新の日付が無い）。
    expect(t.order).toEqual(['stores', 'latest']);
    expect(t.logs).toEqual([repliedEvent(kind, 'preparing')]);
  });

  it.each(['new_reviews', 'comparison'] as const)(
    '%s: 最新が取得失敗なら、店舗名とデータ対象日を添えた取得失敗の案内を 1 回返す',
    async (kind) => {
      const t = setup({ latest: failedRow('2026-09-14') });

      await expect(t.handle(menuRequest(kind))).resolves.toBe('fetch_failed');

      expect(t.replies).toEqual([
        {
          replyToken: REPLY_TOKEN,
          messages: [buildFetchFailedNotice({ storeName: STORE_A.name }, '2026-09-14')],
        },
      ]);
      expect(t.order).toEqual(['stores', 'latest']);
      expect(t.logs).toEqual([repliedEvent(kind, 'fetch_failed')]);
    },
  );

  it('直近の推移: 最新が取得失敗なら、失敗日を含む表に最新の取得失敗の注記を添えて 1 回返す', async () => {
    const latest = failedRow('2026-09-14');
    const range = [readyRow('2026-09-12'), readyRow('2026-09-13'), latest];
    const t = setup({ latest, range });

    await expect(t.handle(menuRequest('trend'))).resolves.toBe('fetch_failed');

    expect(t.rangeCalls).toEqual([
      { db: DB, storeId: STORE_A.id, endDate: '2026-09-14', days: TREND_DAYS, asOf: TODAY_JST },
    ]);
    const days = classifyTrendDays('2026-09-14', range.map(normalizeReadRow), TREND_DAYS);
    expect(days.at(-1)?.kind).toBe('failed');
    expect(t.replies).toEqual([
      {
        replyToken: REPLY_TOKEN,
        messages: [buildTrendReport({ storeName: STORE_A.name }, days, true, storeDetailUrlFor(LIFF_URL, STORE_A.id))],
      },
    ]);
    expect(t.logs).toEqual([repliedEvent('trend', 'fetch_failed')]);
  });
});

// --- 例外 ----------------------------------------------------------------------------

describe('ReportHandler: 例外（7.4・7.5）', () => {
  it.each(KINDS)('%s: 店舗を解決する前の例外は包まずに投げ、Reply を送らない', async (kind) => {
    const failure = new Error('stores read failed');
    const t = setup({ stores: failure });

    const rejection = await t.handle(menuRequest(kind)).then(
      () => null,
      (err: unknown) => err,
    );

    expect(rejection).toBe(failure);
    expect(rejection).not.toBeInstanceOf(StoreScopedReportError);
    expect(t.replies).toEqual([]);
    expect(t.logs).toEqual([]);
  });

  it.each(KINDS)('%s: 最新の集計の読み出しの例外は、店舗名つきの例外に包んで投げ、Reply を送らない', async (kind) => {
    const failure = new Error('latest read failed');
    const t = setup({ stores: [STORE_A, STORE_B], latest: failure });

    const rejection = await t.handle({ kind, storeId: STORE_B.id, page: 0 }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(rejection).toBeInstanceOf(StoreScopedReportError);
    expect(rejection).toMatchObject({ storeName: STORE_B.name, cause: failure });
    expect(t.replies).toEqual([]);
    expect(t.logs).toEqual([]);
  });

  it('直近の推移: 範囲の読み出しの例外も、店舗名つきの例外に包んで投げ、Reply を送らない', async () => {
    const failure = new Error('range read failed');
    const t = setup({ latest: readyRow(TODAY_JST), range: failure });

    const rejection = await t.handle(menuRequest('trend')).then(
      () => null,
      (err: unknown) => err,
    );

    expect(rejection).toBeInstanceOf(StoreScopedReportError);
    expect(rejection).toMatchObject({ storeName: STORE_A.name, cause: failure });
    expect(t.replies).toEqual([]);
    expect(t.logs).toEqual([]);
  });

  it.each(['new_reviews', 'comparison', 'trend'] as const)(
    '%s: 組立の例外（極端に長い店舗名で 30KB を超える）も店舗名つきの例外に包み、Reply を送らない',
    async (kind) => {
      const store: ReportableStore = { id: STORE_A.id, name: '長'.repeat(12_000) };
      const latest = readyRow(TODAY_JST);
      const t = setup({ stores: [store], latest, range: [latest] });

      const rejection = await t.handle(menuRequest(kind)).then(
        () => null,
        (err: unknown) => err,
      );

      expect(rejection).toBeInstanceOf(StoreScopedReportError);
      expect(rejection).toMatchObject({ storeName: store.name });
      expect((rejection as StoreScopedReportError).cause).toBeInstanceOf(FlexBubbleTooLargeError);
      expect(t.replies).toEqual([]);
      expect(t.logs).toEqual([]);
    },
  );

  it('新着口コミ: 本文を落としても 30KB を超える極端に長い投稿者名は、店舗名つきの例外に包み、Reply を送らない', async () => {
    const latest = readyRow(TODAY_JST, { new_review_count: 1, new_reviews: [review({ authorName: '名'.repeat(12_000) })] });
    const t = setup({ latest });

    const rejection = await t.handle(menuRequest('new_reviews')).then(
      () => null,
      (err: unknown) => err,
    );

    expect(rejection).toBeInstanceOf(StoreScopedReportError);
    expect(rejection).toMatchObject({ storeName: STORE_A.name });
    expect((rejection as StoreScopedReportError).cause).toBeInstanceOf(FlexBubbleTooLargeError);
    expect(t.replies).toEqual([]);
    expect(t.logs).toEqual([]);
  });

  it('直近の推移: 最新の取得失敗と範囲の最終日の分類が食い違えば、店舗名つきの例外に包み、Reply を送らない', async () => {
    // 2 回の読み出しの間に日次バッチが同じ日の行を書き直した場合に当たる（最新は失敗、範囲の同じ日は成功）。
    const t = setup({ latest: failedRow(TODAY_JST), range: [readyRow(TODAY_JST)] });

    const rejection = await t.handle(menuRequest('trend')).then(
      () => null,
      (err: unknown) => err,
    );

    expect(rejection).toBeInstanceOf(StoreScopedReportError);
    expect(rejection).toMatchObject({ storeName: STORE_A.name });
    expect(t.replies).toEqual([]);
  });

  it('StoreScopedReportError の本文と種別に店舗名を入れない（記録は種別だけを載せる）', () => {
    const error = new StoreScopedReportError('試験食堂 駅前店', { cause: new Error('inner') });

    expect(error.name).toBe('StoreScopedReportError');
    expect(error.constructor.name).toBe('StoreScopedReportError');
    expect(error.message).not.toContain('試験食堂');
    expect(error.storeName).toBe('試験食堂 駅前店');
  });
});
