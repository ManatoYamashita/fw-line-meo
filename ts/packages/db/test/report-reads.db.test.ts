// src/report-reads.ts（レポート用の読み出し・line-on-demand-report tasks 2.2）の DB テスト（実 postgres 必須）。
//
// 固定する性質:
//   - 30 日の窓は基準日 asOf を含む直近 30 暦日 [asOf-29日, asOf]。下限は Go の PurgeOlderThan
//     （summary_date <= asOf-30日 を削除する）と同じ境界にする。30 日目（asOf-29日）は返し、
//     31 日目（asOf-30日）は返さない
//   - 日付は 'YYYY-MM-DD' の文字列で返す（pg の Date への変換と実行環境の TZ に依存しない）
//   - 範囲の読み出しは、終点を含む N 暦日を日付の昇順で返す
//   - 店舗はオーナー本人の確定店舗だけを、作成順（同時刻は id の順）に返す
//   - 返す行は正規化の前の生の値である（正規化は呼出元が normalizeSummaryRatings で行う）
//   - 新着口コミの帰属 3 項目は、持つ要素ではその値を返し、持たない既存の要素では項目そのものが無い
//
// 他テストファイルと DB を共有するため、衝突しない固有 UUID prefix を使う（リポジトリ内で未使用の c8）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool, type Queryable } from '../src/pool.js';
import {
  findLatestDailySummary,
  listDailySummariesEndingAt,
  listReportableStores,
} from '../src/report-reads.js';
import type { DailySummaryNewReview, DailySummaryReadRow } from '../src/types.js';

const OP = 'c8000000-0000-0000-0000-000000000001';
const AG = 'c8000000-0000-0000-0000-000000000002';

// --- 店舗の一覧の検証用 ---
const OWNER_MULTI = 'c8000000-0000-0000-0000-000000000011'; // 確定店舗 4 つと未確定の店舗 1 つ
const OWNER_OTHER = 'c8000000-0000-0000-0000-000000000012'; // 別のオーナー（確定店舗 1 つ）
const OWNER_PENDING_ONLY = 'c8000000-0000-0000-0000-000000000013'; // 未確定の店舗だけ

// id の順と作成順を食い違わせる（最も古い店舗の id が最も大きい）。作成順だけ・id の順だけの
// どちらで並べても期待と一致しないようにするため。
const ST_OLDEST = 'c8000000-0000-0000-0000-0000000001f0';
const ST_MIDDLE = 'c8000000-0000-0000-0000-0000000001a0';
const ST_TIE_LOW = 'c8000000-0000-0000-0000-000000000110'; // ST_TIE_HIGH と同じ作成時刻
const ST_TIE_HIGH = 'c8000000-0000-0000-0000-000000000120';
const ST_PENDING = 'c8000000-0000-0000-0000-000000000130';
const ST_OTHER_OWNER = 'c8000000-0000-0000-0000-000000000140';
const ST_PENDING_ONLY = 'c8000000-0000-0000-0000-000000000150';

// --- 日次集計の読み出しの検証用 ---
const OWNER_SUMMARY = 'c8000000-0000-0000-0000-000000000014';
const ST_TREND = 'c8000000-0000-0000-0000-000000000201'; // 範囲・最新・行の形
const ST_WINDOW = 'c8000000-0000-0000-0000-000000000202'; // 30 日目と 31 日目
const ST_OUTSIDE_ONLY = 'c8000000-0000-0000-0000-000000000203'; // 31 日目の行だけ
const ST_STATUSES = 'c8000000-0000-0000-0000-000000000204'; // 取得失敗・競合なしの行を含む

// 基準日は Go の言語間試験が行を書く固定日と同じにする（go/internal/batch/crossruntime_test.go）。
const AS_OF = '2026-07-12';
const DAY_30 = '2026-06-13'; // asOf-29日: Go の削除が残す最古の日（窓の中）
const DAY_31 = '2026-06-12'; // asOf-30日: Go の削除が消す境界の日（窓の外）

const ATTRIBUTED_REVIEW: DailySummaryNewReview = {
  authorName: '検証 投稿者A',
  publishTime: '2026-07-11T09:30:00Z',
  rating: 5,
  textExcerpt: '検証用の本文です。',
  authorUri: 'https://www.google.com/maps/contrib/example-author-a',
  authorPhotoUri: 'https://lh3.googleusercontent.com/example-photo-a',
  googleMapsUri: 'https://www.google.com/maps/reviews/example-review-a',
};

// 帰属 3 項目を持たない既存の形（本 spec より前の Go が書いた行）。
const LEGACY_REVIEW: DailySummaryNewReview = {
  authorName: '検証 投稿者B',
  publishTime: '2026-07-11T08:00:00Z',
  rating: 3,
  textExcerpt: '検証用の本文です（帰属の項目を持たない既存の形）。',
};

function summaryOn(summaryDate: string, overrides: Partial<DailySummaryReadRow> = {}): DailySummaryReadRow {
  return {
    summary_date: summaryDate,
    status: 'ready',
    rank: 2,
    rank_total: 4,
    rank_prev: 2,
    rating: '4.1',
    review_count: 50,
    rating_prev: '4.1',
    review_count_prev: 50,
    new_review_count: 0,
    new_reviews: [],
    competitors: [],
    ...overrides,
  };
}

// ST_TREND の最新の行。競合の評価 0 と母数 3 は旧 Go の形のまま置く（読み出しが正規化しないことを見るため。
// 正規化すれば評価は null、母数は 2 になる）。
const LATEST_ROW = summaryOn(AS_OF, {
  rank: 2,
  rank_total: 3,
  rank_prev: 3,
  rating: '4.3',
  review_count: 120,
  rating_prev: '4.2',
  review_count_prev: 118,
  new_review_count: 2,
  new_reviews: [ATTRIBUTED_REVIEW, LEGACY_REVIEW],
  competitors: [
    { name: '検証競合1', rating: 4.5, reviewCount: 80, starDiff: -0.2 },
    { name: '検証競合2', rating: 0, reviewCount: 0, starDiff: 4.3 },
  ],
});

// ST_STATUSES の最新の行（取得失敗の日。順位と自店の値は持たない）。
const FAILED_LATEST_ROW = summaryOn(AS_OF, {
  status: 'failed',
  rank: null,
  rank_total: null,
  rank_prev: null,
  rating: null,
  review_count: null,
  rating_prev: null,
  review_count_prev: null,
});

async function insertStore(
  id: string,
  ownerId: string,
  name: string,
  confirmed: boolean,
  createdAt: string,
): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO stores (id, owner_id, name, place_id, place_status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`,
    [id, ownerId, name, confirmed ? `places/report-reads-${id}` : null, confirmed ? 'confirmed' : 'pending', createdAt],
  );
}

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

function datesOf(rows: readonly DailySummaryReadRow[]): string[] {
  return rows.map((row) => row.summary_date);
}

/**
 * 索引を使わない計画（表を頭から読む）の接続で run を呼ぶ。
 *
 * 既定の計画は (store_id, summary_date) の一意索引を昇順に辿るので、ORDER BY を落としても行は偶然に
 * 昇順で出てくる（その計画だけでは並び順を固定できない）。索引を使わせなければ行は挿入の順に出るので、
 * 並びが ORDER BY によるものかを確かめられる。設定はトランザクションの中だけで効かせ、最後に巻き戻す。
 */
async function withSequentialScan<T>(run: (db: Queryable) => Promise<T>): Promise<T> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_indexscan = off');
    await client.query('SET LOCAL enable_indexonlyscan = off');
    await client.query('SET LOCAL enable_bitmapscan = off');
    // 設定が効いて、同じ形の絞り込みが表を頭から読む計画になっていることを先に確かめる（効いていなければ、
    // この試験は既定の計画の試験と同じものになり、並び順を確かめたことにならない）。
    const plan = await client.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT 1 FROM daily_summaries ds
        WHERE ds.store_id = '${ST_TREND}' AND ds.summary_date > ('${AS_OF}'::date - 30)`,
    );
    expect(plan.rows.map((line) => line['QUERY PLAN']).join('\n')).toContain('Seq Scan');
    return await run(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe.skipIf(!process.env.DATABASE_URL)('report-reads (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, 'レポート読み出し検証運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      AG,
      OP,
      'レポート読み出し検証代理店',
    ]);
    for (const [ownerId, onboardingStatus] of [
      [OWNER_MULTI, 'store_identified'],
      [OWNER_OTHER, 'store_identified'],
      [OWNER_PENDING_ONLY, 'pending'],
      [OWNER_SUMMARY, 'store_identified'],
    ] as const) {
      await pool.query(
        'INSERT INTO owners (id, agency_id, line_user_id, onboarding_status) VALUES ($1, $2, $3, $4)',
        [ownerId, AG, `U-report-reads-${ownerId}`, onboardingStatus],
      );
    }

    // 挿入の順は作成順とも id の順とも違える（並べ替えを落とすと、挿入の順がそのまま出て食い違う）。
    await insertStore(ST_TIE_HIGH, OWNER_MULTI, 'レポート検証店 同時刻B', true, '2026-01-03T00:00:00Z');
    await insertStore(ST_OLDEST, OWNER_MULTI, 'レポート検証店 最古', true, '2026-01-01T00:00:00Z');
    await insertStore(ST_PENDING, OWNER_MULTI, 'レポート検証店 未確定', false, '2026-01-02T12:00:00Z');
    await insertStore(ST_TIE_LOW, OWNER_MULTI, 'レポート検証店 同時刻A', true, '2026-01-03T00:00:00Z');
    await insertStore(ST_MIDDLE, OWNER_MULTI, 'レポート検証店 中間', true, '2026-01-02T00:00:00Z');
    await insertStore(ST_OTHER_OWNER, OWNER_OTHER, 'レポート検証店 別オーナー', true, '2026-01-01T12:00:00Z');
    await insertStore(ST_PENDING_ONLY, OWNER_PENDING_ONLY, 'レポート検証店 未確定のみ', false, '2026-01-01T00:00:00Z');

    await insertStore(ST_TREND, OWNER_SUMMARY, 'レポート検証店 推移', true, '2026-01-01T00:00:00Z');
    await insertStore(ST_WINDOW, OWNER_SUMMARY, 'レポート検証店 窓', true, '2026-01-02T00:00:00Z');
    await insertStore(ST_OUTSIDE_ONLY, OWNER_SUMMARY, 'レポート検証店 窓の外', true, '2026-01-03T00:00:00Z');

    // ST_TREND: 挿入の順を日付の順とも逆順とも違える（最新の行を先頭にも末尾にも置かない）。
    // 表を頭から読む計画では行が挿入の順に出るので、並べ替えを落とすと期待と食い違う。
    // 2026-07-07・07-09・07-11 は行が無い日（欠損日）。
    await insertSummary(ST_TREND, summaryOn('2026-07-10'));
    await insertSummary(ST_TREND, summaryOn('2026-07-05')); // 終点 07-12 から数えて 8 暦日目（7 暦日の外）
    await insertSummary(ST_TREND, LATEST_ROW);
    await insertSummary(ST_TREND, summaryOn('2026-07-06')); // 終点 07-12 から数えて 7 暦日目（7 暦日の内）
    await insertSummary(ST_TREND, summaryOn('2026-07-08'));

    await insertSummary(ST_WINDOW, summaryOn(DAY_31));
    await insertSummary(ST_WINDOW, summaryOn(DAY_30));

    await insertSummary(ST_OUTSIDE_ONLY, summaryOn(DAY_31));

    // ST_STATUSES: 最新の日が取得失敗、その前の日に競合なしの行がある。
    await insertStore(ST_STATUSES, OWNER_SUMMARY, 'レポート検証店 状態', true, '2026-01-04T00:00:00Z');
    await insertSummary(ST_STATUSES, summaryOn('2026-07-10', { status: 'no_competitors', rank: null, rank_total: null }));
    await insertSummary(ST_STATUSES, summaryOn('2026-07-11'));
    await insertSummary(ST_STATUSES, FAILED_LATEST_ROW);
  });

  afterAll(async () => {
    await closePool();
  });

  describe('listReportableStores', () => {
    it('オーナー本人の確定店舗だけを作成順に返し、作成時刻が同じ店舗は id の順に並べる', async () => {
      const pool = await getPool();
      const stores = await listReportableStores(pool, OWNER_MULTI);

      // 未確定の店舗（ST_PENDING）と他のオーナーの店舗（ST_OTHER_OWNER）は、作成時刻が範囲の中でも返さない。
      // 項目は id と name だけにする（他の列を呼出元へ渡さない）。
      expect(stores).toStrictEqual([
        { id: ST_OLDEST, name: 'レポート検証店 最古' },
        { id: ST_MIDDLE, name: 'レポート検証店 中間' },
        { id: ST_TIE_LOW, name: 'レポート検証店 同時刻A' },
        { id: ST_TIE_HIGH, name: 'レポート検証店 同時刻B' },
      ]);
    });

    it('他のオーナーには、そのオーナーの確定店舗だけを返す', async () => {
      const pool = await getPool();
      expect(await listReportableStores(pool, OWNER_OTHER)).toStrictEqual([
        { id: ST_OTHER_OWNER, name: 'レポート検証店 別オーナー' },
      ]);
    });

    it('確定店舗を持たないオーナーには空の配列を返す（未確定の店舗は数えない）', async () => {
      const pool = await getPool();
      expect(await listReportableStores(pool, OWNER_PENDING_ONLY)).toStrictEqual([]);
    });
  });

  describe('findLatestDailySummary', () => {
    it('基準日から見た 30 日の窓の中で最も新しい行を、日付を文字列にして返す', async () => {
      const pool = await getPool();
      const row = await findLatestDailySummary(pool, ST_TREND, AS_OF);

      expect(typeof row?.summary_date).toBe('string');
      // 列はレポートが使う 12 項目だけにする（id・store_id・created_at を返さない）。
      expect(row).toStrictEqual(LATEST_ROW);
    });

    it('正規化の前の生の値を返す（評価 0 の競合と、それを数えた母数をそのまま返す）', async () => {
      const pool = await getPool();
      const row = await findLatestDailySummary(pool, ST_TREND, AS_OF);

      expect(row?.rank_total).toBe(3);
      expect(row?.competitors[1]?.rating).toBe(0);
      // numeric(2,1) の列は精度を保つため文字列で返る（pg の既定）。
      expect(row?.rating).toBe('4.3');
    });

    it('30 日目（基準日の 29 日前・Go の削除が残す最古の日）の行を返す', async () => {
      const pool = await getPool();
      const row = await findLatestDailySummary(pool, ST_WINDOW, AS_OF);

      expect(row?.summary_date).toBe(DAY_30);
    });

    it('31 日目（基準日の 30 日前・Go の削除が消す日）の行は返さず、窓の中に行が無ければ null を返す', async () => {
      const pool = await getPool();
      expect(await findLatestDailySummary(pool, ST_OUTSIDE_ONLY, AS_OF)).toBeNull();
    });

    it('窓の上端は基準日である（基準日より後の行は返さない）', async () => {
      const pool = await getPool();
      const row = await findLatestDailySummary(pool, ST_TREND, '2026-07-09');

      expect(row?.summary_date).toBe('2026-07-08');
    });
  });

  describe('listDailySummariesEndingAt', () => {
    it('終点を含む 7 暦日の行を、日付を文字列にして昇順で返す（8 暦日目は含めない）', async () => {
      const pool = await getPool();
      const rows = await listDailySummariesEndingAt(pool, ST_TREND, AS_OF, 7, AS_OF);

      expect(datesOf(rows)).toStrictEqual(['2026-07-06', '2026-07-08', '2026-07-10', '2026-07-12']);
      expect(rows.every((row) => typeof row.summary_date === 'string')).toBe(true);
      // 行の形は findLatestDailySummary と同じ。
      expect(rows.at(-1)).toStrictEqual(LATEST_ROW);
    });

    it('終点より後の行は含めない', async () => {
      const pool = await getPool();
      const rows = await listDailySummariesEndingAt(pool, ST_TREND, '2026-07-10', 3, AS_OF);

      expect(datesOf(rows)).toStrictEqual(['2026-07-08', '2026-07-10']);
    });

    it('基準日から見た 30 日の窓の外（31 日目）は、範囲の中でも含めない', async () => {
      const pool = await getPool();
      // 範囲は 06-12〜06-18 で 31 日目（06-12）を含むが、窓の外なので返さない。
      const rows = await listDailySummariesEndingAt(pool, ST_WINDOW, '2026-06-18', 7, AS_OF);

      expect(datesOf(rows)).toStrictEqual([DAY_30]);
    });

    it('基準日より後の行は、範囲の中でも含めない', async () => {
      const pool = await getPool();
      const rows = await listDailySummariesEndingAt(pool, ST_TREND, AS_OF, 7, '2026-07-09');

      expect(datesOf(rows)).toStrictEqual(['2026-07-06', '2026-07-08']);
    });

    it('指定した店舗の行だけを返す（同じ範囲に行を持つ他の店舗の行を含めない）', async () => {
      const pool = await getPool();
      expect(await listDailySummariesEndingAt(pool, ST_WINDOW, AS_OF, 7, AS_OF)).toStrictEqual([]);
    });
  });

  // 取得失敗と競合なしの行も読み出しは除かない。最新が取得失敗なら取得失敗の案内（7.2）、推移では
  // 取得失敗の日（6.4）と比較不能の日として表示するので、ここで落とすとそれらの分岐へ届かない。
  describe('状態で行を絞らない', () => {
    it('最新の行が取得失敗なら、その行を返す（その前の成功した行へ繰り下げない）', async () => {
      const pool = await getPool();
      expect(await findLatestDailySummary(pool, ST_STATUSES, AS_OF)).toStrictEqual(FAILED_LATEST_ROW);
    });

    it('範囲は取得失敗と競合なしの行も含めて返す', async () => {
      const pool = await getPool();
      const rows = await listDailySummariesEndingAt(pool, ST_STATUSES, AS_OF, 7, AS_OF);

      expect(rows.map((row) => [row.summary_date, row.status])).toStrictEqual([
        ['2026-07-10', 'no_competitors'],
        ['2026-07-11', 'ready'],
        ['2026-07-12', 'failed'],
      ]);
    });
  });

  describe('並び順は索引の順に頼らない', () => {
    it('表を頭から読む計画でも、範囲は日付の昇順で、最新は最も新しい行を返す', async () => {
      const [rows, latest] = await withSequentialScan(async (db) => {
        const range = await listDailySummariesEndingAt(db, ST_TREND, AS_OF, 7, AS_OF);
        const newest = await findLatestDailySummary(db, ST_TREND, AS_OF);
        return [range, newest] as const;
      });

      expect(datesOf(rows)).toStrictEqual(['2026-07-06', '2026-07-08', '2026-07-10', '2026-07-12']);
      expect(latest?.summary_date).toBe(AS_OF);
    });
  });

  describe('新着口コミの帰属 3 項目（任意項目）', () => {
    it('3 項目を持つ口コミはその値を返し、持たない既存の口コミは項目そのものを持たない', async () => {
      const pool = await getPool();
      const row = await findLatestDailySummary(pool, ST_TREND, AS_OF);
      const [attributed, legacy] = row?.new_reviews ?? [];

      expect(attributed).toStrictEqual(ATTRIBUTED_REVIEW);
      expect(legacy).toStrictEqual(LEGACY_REVIEW);
      // null や undefined の値を持つのではなく、キーが無い（呼出元は「導線を取得できていない」と読む）。
      expect(Object.keys(legacy ?? {}).sort()).toStrictEqual([
        'authorName',
        'publishTime',
        'rating',
        'textExcerpt',
      ]);
    });
  });
});
