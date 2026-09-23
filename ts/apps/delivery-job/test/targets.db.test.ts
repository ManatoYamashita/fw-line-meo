import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getPool, closePool } from '@fwlm/db';
import type { Queryable } from '@fwlm/db';
import { queryDeliveryTargets, queryOwnersDueWithoutSummary } from '../src/targets.js';

// 他テストファイルと DB を共有するため、衝突しない固有 UUID / place_id を使う（delivery-settings.db.test.ts の慣習に準拠）。
// 配信時刻も他ファイルと分ける（index.e2e は 14 時・cross-runtime は 17 時・report-flow の共有オーナーは 7 時）。
const OP = 'a0000000-0000-0000-0000-000000000001';
const AG = 'a0000000-0000-0000-0000-000000000002';

const OW_READY = 'a0000000-0000-0000-0000-000000000011'; // hour=9・当日summary有・前日summary有・未配信 → 対象
const OW_WRONG_HOUR = 'a0000000-0000-0000-0000-000000000012'; // hour=10 → 除外
const OW_NO_SUMMARY = 'a0000000-0000-0000-0000-000000000013'; // hour=9・当日summary無 → skip候補
const OW_ALREADY_DELIVERED = 'a0000000-0000-0000-0000-000000000014'; // hour=9・当日summary有・配信済 → 除外
const OW_UNCONFIRMED = 'a0000000-0000-0000-0000-000000000015'; // hour=9・place_status=pending → 両方から除外
const OW_FIRST_DAY = 'a0000000-0000-0000-0000-000000000016'; // hour=9・当日summary有・前日summary無 → 対象（前日は null）
const OW_UNCONFIRMED_WITH_SUMMARY = 'a0000000-0000-0000-0000-000000000017'; // hour=9・place_status=pending・当日summary有 → 除外
// 店舗の利用停止（Issue #252・store-suspension 4.1–4.4）。停止中の 2 店と、停止中の店舗と同じ条件で利用中の対照 1 店。
const OW_SUSPENDED_WITH_SUMMARY = 'a0000000-0000-0000-0000-000000000018'; // hour=9・当日summary有・未配信・停止中 → 除外
const OW_ACTIVE_CONTROL = 'a0000000-0000-0000-0000-000000000019'; // 上と同じ条件で利用中 → 対象
const OW_SUSPENDED_NO_SUMMARY = 'a0000000-0000-0000-0000-00000000001a'; // hour=9・当日summary無・停止中 → skip候補からも除外

const ST_READY = 'b0000000-0000-0000-0000-000000000011';
const ST_WRONG_HOUR = 'b0000000-0000-0000-0000-000000000012';
const ST_NO_SUMMARY = 'b0000000-0000-0000-0000-000000000013';
const ST_ALREADY_DELIVERED = 'b0000000-0000-0000-0000-000000000014';
const ST_UNCONFIRMED = 'b0000000-0000-0000-0000-000000000015';
const ST_FIRST_DAY = 'b0000000-0000-0000-0000-000000000016';
const ST_UNCONFIRMED_WITH_SUMMARY = 'b0000000-0000-0000-0000-000000000017';
const ST_SUSPENDED_WITH_SUMMARY = 'b0000000-0000-0000-0000-000000000018';
const ST_ACTIVE_CONTROL = 'b0000000-0000-0000-0000-000000000019';
const ST_SUSPENDED_NO_SUMMARY = 'b0000000-0000-0000-0000-00000000001a';

const TARGET_HOUR = 9;
const TODAY = '2026-07-12';
const YESTERDAY = '2026-07-11'; // 当日の暦日の 1 日前（前日の行の summary_date）

describe.skipIf(!process.env.DATABASE_URL)('targets (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();

    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, '配信対象運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      AG,
      OP,
      '配信対象代理店',
    ]);

    const owners: Array<[string, number]> = [
      [OW_READY, TARGET_HOUR],
      [OW_WRONG_HOUR, TARGET_HOUR + 1],
      [OW_NO_SUMMARY, TARGET_HOUR],
      [OW_ALREADY_DELIVERED, TARGET_HOUR],
      [OW_UNCONFIRMED, TARGET_HOUR],
      [OW_FIRST_DAY, TARGET_HOUR],
      [OW_UNCONFIRMED_WITH_SUMMARY, TARGET_HOUR],
      [OW_SUSPENDED_WITH_SUMMARY, TARGET_HOUR],
      [OW_ACTIVE_CONTROL, TARGET_HOUR],
      [OW_SUSPENDED_NO_SUMMARY, TARGET_HOUR],
    ];
    for (const [id, hour] of owners) {
      await pool.query(
        'INSERT INTO owners (id, agency_id, line_user_id, onboarding_status, delivery_hour) VALUES ($1, $2, $3, $4, $5)',
        [id, AG, `U-${id}`, 'active', hour],
      );
    }

    const stores: Array<[string, string, string, boolean]> = [
      [ST_READY, OW_READY, 'places/target-ready', true],
      [ST_WRONG_HOUR, OW_WRONG_HOUR, 'places/target-wrong-hour', true],
      [ST_NO_SUMMARY, OW_NO_SUMMARY, 'places/target-no-summary', true],
      [ST_ALREADY_DELIVERED, OW_ALREADY_DELIVERED, 'places/target-already-delivered', true],
      [ST_UNCONFIRMED, OW_UNCONFIRMED, 'places/target-unconfirmed', false],
      [ST_FIRST_DAY, OW_FIRST_DAY, 'places/target-first-day', true],
      [ST_UNCONFIRMED_WITH_SUMMARY, OW_UNCONFIRMED_WITH_SUMMARY, 'places/target-unconfirmed-with-summary', false],
      [ST_SUSPENDED_WITH_SUMMARY, OW_SUSPENDED_WITH_SUMMARY, 'places/target-suspended-with-summary', true],
      [ST_ACTIVE_CONTROL, OW_ACTIVE_CONTROL, 'places/target-active-control', true],
      [ST_SUSPENDED_NO_SUMMARY, OW_SUSPENDED_NO_SUMMARY, 'places/target-suspended-no-summary', true],
    ];
    for (const [id, ownerId, placeId, confirmed] of stores) {
      if (confirmed) {
        await pool.query(
          'INSERT INTO stores (id, owner_id, name, place_id, place_status) VALUES ($1, $2, $3, $4, $5)',
          [id, ownerId, `店舗 ${id}`, placeId, 'confirmed'],
        );
      } else {
        await pool.query('INSERT INTO stores (id, owner_id, name) VALUES ($1, $2, $3)', [
          id,
          ownerId,
          `店舗 ${id}`,
        ]);
      }
    }

    // 当日 daily_summaries: ready 対象・wrong-hour 対象・already-delivered 対象・first-day 対象・
    // unconfirmed-with-summary 対象に用意する（no-summary / unconfirmed は意図的に未挿入）。
    //
    // unconfirmed-with-summary は、実運用では未確定店舗に日次集計が生成されないため起こらない組み合わせだが、
    // 「特定済みの店舗だけを対象にする」述語（3.4）が実際に効いていることを試験で示すために置く。
    // 述語が無ければこの店舗が対象として返ってしまう。
    for (const storeId of [
      ST_READY,
      ST_WRONG_HOUR,
      ST_ALREADY_DELIVERED,
      ST_FIRST_DAY,
      ST_UNCONFIRMED_WITH_SUMMARY,
      ST_SUSPENDED_WITH_SUMMARY,
      ST_ACTIVE_CONTROL,
    ]) {
      await pool.query(
        `INSERT INTO daily_summaries (store_id, summary_date, status, rank, rank_total, rating, review_count, new_review_count)
         VALUES ($1, $2, 'ready', 1, 3, '4.5', 100, 0)`,
        [storeId, TODAY],
      );
    }

    // 前日 daily_summaries: ready 対象のみに用意する（first-day 対象は前日の行を持たない店舗を表す）。
    // 旧 Go が書いた形（評価の無い競合を 0 として書き、母数に数えている）にして、返る前日の行が
    // 正規化を通っている（母数 6 → 5）ことを試験で見分けられるようにする。
    await pool.query(
      `INSERT INTO daily_summaries
         (store_id, summary_date, status, rank, rank_total, rating, review_count, new_review_count, competitors)
       VALUES ($1, $2, 'ready', 2, 6, '4.2', 98, 0, $3::jsonb)`,
      [
        ST_READY,
        YESTERDAY,
        JSON.stringify([
          { name: '競合イチ', rating: 4.5, reviewCount: 300, starDiff: -0.3 },
          { name: '競合ニ', rating: 4.0, reviewCount: 200, starDiff: 0.2 },
          { name: '競合サン', rating: 3.8, reviewCount: 100, starDiff: 0.4 },
          { name: '競合ヨン', rating: 3.5, reviewCount: 50, starDiff: 0.7 },
          { name: '競合ゴ', rating: 0, reviewCount: 0, starDiff: 4.2 },
        ]),
      ],
    );

    // 停止中の 2 店は、停止時刻を SQL で直接立てる（データ層の停止操作に依存しない）。
    //
    // 停止中で当日の集計を持つ店舗は、日次サマリーの作成後から配信時刻までの間に停止された店舗を表す（4.2）。
    // 停止中の店舗は日次取得の対象から外れるため通常は当日の集計を持たないが、この店舗を置かないと
    // queryDeliveryTargets の停止の述語を消しても結果が変わらず、試験が空振りする。
    await pool.query('UPDATE stores SET suspended_at = now() WHERE id = ANY($1::uuid[])', [
      [ST_SUSPENDED_WITH_SUMMARY, ST_SUSPENDED_NO_SUMMARY],
    ]);

    // already-delivered には summary_deliveries 行も用意し「未配信」条件から外れることを検証する。
    await pool.query(
      `INSERT INTO summary_deliveries (store_id, summary_date, line_user_id, status, retry_key)
       VALUES ($1, $2, $3, 'delivered', gen_random_uuid())`,
      [ST_ALREADY_DELIVERED, TODAY, `U-${OW_ALREADY_DELIVERED}`],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  describe('queryDeliveryTargets', () => {
    it('正しい配信時刻・当日summary有・未配信の対象のみを返す', async () => {
      const pool = await getPool();
      const targets = await queryDeliveryTargets(pool, TARGET_HOUR, TODAY);

      const storeIds = targets.map((t) => t.storeId);
      expect(storeIds).toContain(ST_READY);
      expect(storeIds).not.toContain(ST_WRONG_HOUR);
      expect(storeIds).not.toContain(ST_NO_SUMMARY);
      expect(storeIds).not.toContain(ST_ALREADY_DELIVERED);
      expect(storeIds).not.toContain(ST_UNCONFIRMED);
      // 当日の集計がある未確定店舗も、特定済みでないため対象にならない（3.4）。
      expect(storeIds).not.toContain(ST_UNCONFIRMED_WITH_SUMMARY);
    });

    it('店舗名を返す（通知に店舗名を出すため・1.7/3.8）', async () => {
      const pool = await getPool();
      const targets = await queryDeliveryTargets(pool, TARGET_HOUR, TODAY);
      const target = targets.find((t) => t.storeId === ST_READY);

      expect(target?.storeName).toBe(`店舗 ${ST_READY}`);
    });

    it('前日の行を、正規化を通した形で返す', async () => {
      const pool = await getPool();
      const targets = await queryDeliveryTargets(pool, TARGET_HOUR, TODAY);
      const target = targets.find((t) => t.storeId === ST_READY);

      expect(target?.yesterday).not.toBeNull();
      expect(target?.yesterday?.status).toBe('ready');
      expect(target?.yesterday?.rank).toBe(2);
      // 前日の行は旧 Go の形（評価 0 の競合 1 店を母数に数えた rank_total = 6）で入れてある。
      // 正規化を通っていれば 5 になる（Issue #255）。
      expect(target?.yesterday?.rank_total).toBe(5);
    });

    it('前日の行が無い店舗も対象として返し、前日は null にする', async () => {
      const pool = await getPool();
      const targets = await queryDeliveryTargets(pool, TARGET_HOUR, TODAY);
      const target = targets.find((t) => t.storeId === ST_FIRST_DAY);

      expect(target).toBeDefined();
      expect(target?.storeName).toBe(`店舗 ${ST_FIRST_DAY}`);
      expect(target?.yesterday).toBeNull();
    });

    it('DB の読み出しは対象の件数によらず 1 回である（店舗ごとに引き直さない）', async () => {
      const pool = await getPool();
      const db = { query: pool.query.bind(pool) } satisfies Queryable;
      const querySpy = vi.spyOn(db, 'query');

      const targets = await queryDeliveryTargets(db, TARGET_HOUR, TODAY);

      // 回数の固定が空振りしないよう、対象が複数件あることを先に確かめる（1 件なら N+1 と 1 回が同じになる）。
      expect(targets.length).toBeGreaterThanOrEqual(2);
      expect(querySpy).toHaveBeenCalledTimes(1);
    });

    it('対象の summary/lineUserId が daily_summaries・owners の実データと一致する', async () => {
      const pool = await getPool();
      const targets = await queryDeliveryTargets(pool, TARGET_HOUR, TODAY);
      const target = targets.find((t) => t.storeId === ST_READY);

      expect(target).toBeDefined();
      expect(target?.lineUserId).toBe(`U-${OW_READY}`);
      expect(target?.summary.status).toBe('ready');
      expect(target?.summary.rank).toBe(1);
      expect(target?.summary.store_id).toBe(ST_READY);
    });

    it('当日の集計があり配信時刻に達した未記録の店舗でも、停止中なら対象にせず、同じ条件の利用中の店舗は対象にする（4.1・4.2）', async () => {
      const pool = await getPool();
      const targets = await queryDeliveryTargets(pool, TARGET_HOUR, TODAY);
      const storeIds = targets.map((t) => t.storeId);

      expect(storeIds).not.toContain(ST_SUSPENDED_WITH_SUMMARY);
      // 対照: 停止中でないことだけが異なる店舗は対象になる（除外の理由が停止であることを示す）。
      expect(storeIds).toContain(ST_ACTIVE_CONTROL);
    });

    it('再開された店舗は、当日の集計があれば通常どおり対象にする（4.4）', async () => {
      const pool = await getPool();
      await pool.query('UPDATE stores SET suspended_at = NULL WHERE id = $1', [ST_SUSPENDED_WITH_SUMMARY]);
      try {
        const targets = await queryDeliveryTargets(pool, TARGET_HOUR, TODAY);
        expect(targets.map((t) => t.storeId)).toContain(ST_SUSPENDED_WITH_SUMMARY);
      } finally {
        // 後続の試験が停止中の前提で読むため、停止状態へ戻す。
        await pool.query('UPDATE stores SET suspended_at = now() WHERE id = $1', [ST_SUSPENDED_WITH_SUMMARY]);
      }
    });

    it('異なる配信時刻を指定すると wrong-hour 対象が返る', async () => {
      const pool = await getPool();
      const targets = await queryDeliveryTargets(pool, TARGET_HOUR + 1, TODAY);
      expect(targets.map((t) => t.storeId)).toContain(ST_WRONG_HOUR);
    });

    it('異常系: 範囲外の時刻は例外を送出する', async () => {
      const pool = await getPool();
      await expect(queryDeliveryTargets(pool, 24, TODAY)).rejects.toThrow(RangeError);
      await expect(queryDeliveryTargets(pool, -1, TODAY)).rejects.toThrow(RangeError);
    });
  });

  describe('queryOwnersDueWithoutSummary', () => {
    it('配信時刻は該当するが当日summaryが無い対象をskip候補として検出する（silent dropしない）', async () => {
      const pool = await getPool();
      const skipCandidates = await queryOwnersDueWithoutSummary(pool, TARGET_HOUR, TODAY);
      const storeIds = skipCandidates.map((c) => c.storeId);

      expect(storeIds).toContain(ST_NO_SUMMARY);
      // summary が既にある対象は skip 候補ではない。
      expect(storeIds).not.toContain(ST_READY);
      expect(storeIds).not.toContain(ST_ALREADY_DELIVERED);
      // 未確定店舗（place_status=pending）は「特定済み」ではないため skip 候補にもならない。
      expect(storeIds).not.toContain(ST_UNCONFIRMED);
    });

    it('当日の集計が無く配信時刻に達した店舗でも、停止中なら見送り記録の対象にしない（4.3）', async () => {
      const pool = await getPool();
      const skipCandidates = await queryOwnersDueWithoutSummary(pool, TARGET_HOUR, TODAY);
      const storeIds = skipCandidates.map((c) => c.storeId);

      expect(storeIds).not.toContain(ST_SUSPENDED_NO_SUMMARY);
      // 対照: 停止中でないことだけが異なる店舗（ST_NO_SUMMARY）は見送り記録の対象になる。
      expect(storeIds).toContain(ST_NO_SUMMARY);
    });

    it('lineUserId が owners の実データと一致する', async () => {
      const pool = await getPool();
      const skipCandidates = await queryOwnersDueWithoutSummary(pool, TARGET_HOUR, TODAY);
      const candidate = skipCandidates.find((c) => c.storeId === ST_NO_SUMMARY);
      expect(candidate?.lineUserId).toBe(`U-${OW_NO_SUMMARY}`);
    });

    it('既に summary_deliveries が記録済み（前回実行でskip記録済み等）の対象は再検出しない', async () => {
      const pool = await getPool();
      // ST_NO_SUMMARY に skipped_no_summary を記録した状態を模して再検出されないことを確認する。
      await pool.query(
        `INSERT INTO summary_deliveries (store_id, summary_date, line_user_id, status, retry_key)
         VALUES ($1, $2, $3, 'skipped_no_summary', gen_random_uuid())`,
        [ST_NO_SUMMARY, TODAY, `U-${OW_NO_SUMMARY}`],
      );

      const skipCandidates = await queryOwnersDueWithoutSummary(pool, TARGET_HOUR, TODAY);
      expect(skipCandidates.map((c) => c.storeId)).not.toContain(ST_NO_SUMMARY);
    });

    it('異常系: 範囲外の時刻は例外を送出する', async () => {
      const pool = await getPool();
      await expect(queryOwnersDueWithoutSummary(pool, 24, TODAY)).rejects.toThrow(RangeError);
    });
  });
});

// Issue #255: Google に評価が無い店（クチコミ 0 件）の読込時の正規化。
//
// 旧 Go は評価の欠落をゼロ値 0 として書いていた（本番の実物: 競合 5 店のうち 1 店が rating 0・
// reviewCount 0 で、比較集合の最下位に数えられ rank_total を 1 つ水増ししていた）。新 Go は null を書き、
// 比較集合から外す。配信は両方の形を読む（デプロイ当日は旧 Go が 06:00 に書いた行を後の配信時刻に読む）
// ので、読込境界で同じ形へ揃えることを実データで固定する。
//
// 上の describe と日付・時刻・識別子を分け、互いの件数検査を汚さない。
const UNRATED_OP = 'a1000000-0000-0000-0000-000000000001';
const UNRATED_AG = 'a1000000-0000-0000-0000-000000000002';
const OW_LEGACY_COMPETITOR_ZERO = 'a1000000-0000-0000-0000-000000000011';
const OW_LEGACY_SELF_ZERO = 'a1000000-0000-0000-0000-000000000012';
const OW_NEW_NULL = 'a1000000-0000-0000-0000-000000000013';
const ST_LEGACY_COMPETITOR_ZERO = 'b1000000-0000-0000-0000-000000000011';
const ST_LEGACY_SELF_ZERO = 'b1000000-0000-0000-0000-000000000012';
const ST_NEW_NULL = 'b1000000-0000-0000-0000-000000000013';
const UNRATED_HOUR = 11;
const UNRATED_DAY = '2026-07-13';

describe.skipIf(!process.env.DATABASE_URL)('targets (DB) — 評価の無い店の正規化（Issue #255）', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [UNRATED_OP, '未評価正規化運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      UNRATED_AG,
      UNRATED_OP,
      '未評価正規化代理店',
    ]);

    const rows: Array<{
      readonly owner: string;
      readonly store: string;
      readonly rank: number;
      readonly rankTotal: number;
      readonly rankPrev: number | null;
      readonly rating: string;
      readonly reviewCount: number;
      readonly ratingPrev: string | null;
      readonly competitors: ReadonlyArray<{ name: string; rating: number | null; reviewCount: number; starDiff: number | null }>;
    }> = [
      {
        // 旧 Go・自店に評価あり: 評価 0 の競合が最下位に数えられ、rank_total が 1 つ多い。
        owner: OW_LEGACY_COMPETITOR_ZERO,
        store: ST_LEGACY_COMPETITOR_ZERO,
        rank: 1,
        rankTotal: 6,
        rankPrev: 1,
        rating: '4.3',
        reviewCount: 2288,
        ratingPrev: '4.3',
        competitors: [
          { name: '競合イチ', rating: 4.0, reviewCount: 300, starDiff: 0.3 },
          { name: '競合ニ', rating: 3.9, reviewCount: 200, starDiff: 0.4 },
          { name: '競合サン', rating: 3.7, reviewCount: 100, starDiff: 0.6 },
          { name: '競合ヨン', rating: 3.3, reviewCount: 50, starDiff: 1.0 },
          { name: '競合ゴ', rating: 0, reviewCount: 0, starDiff: 4.3 },
        ],
      },
      {
        // 旧 Go・自店に評価なし: 自店が 0 として順位付けされ、星差も「0 − 競合」になっている。
        owner: OW_LEGACY_SELF_ZERO,
        store: ST_LEGACY_SELF_ZERO,
        rank: 3,
        rankTotal: 3,
        rankPrev: 3,
        rating: '0.0',
        reviewCount: 0,
        ratingPrev: '0.0',
        competitors: [
          { name: '競合イチ', rating: 4.5, reviewCount: 120, starDiff: -4.5 },
          { name: '競合ニ', rating: 4.0, reviewCount: 80, starDiff: -4.0 },
        ],
      },
      {
        // 新 Go: 評価の無い店は null で書かれ、rank_total には最初から数えられていない。
        owner: OW_NEW_NULL,
        store: ST_NEW_NULL,
        rank: 2,
        rankTotal: 3,
        rankPrev: 2,
        rating: '4.3',
        reviewCount: 50,
        ratingPrev: '4.3',
        competitors: [
          { name: '競合イチ', rating: 4.5, reviewCount: 100, starDiff: -0.2 },
          { name: '競合ニ', rating: 4.0, reviewCount: 30, starDiff: 0.3 },
          { name: '競合サン', rating: null, reviewCount: 0, starDiff: null },
        ],
      },
    ];

    for (const row of rows) {
      await pool.query(
        'INSERT INTO owners (id, agency_id, line_user_id, onboarding_status, delivery_hour) VALUES ($1, $2, $3, $4, $5)',
        [row.owner, UNRATED_AG, `U-${row.owner}`, 'active', UNRATED_HOUR],
      );
      await pool.query(
        'INSERT INTO stores (id, owner_id, name, place_id, place_status) VALUES ($1, $2, $3, $4, $5)',
        [row.store, row.owner, `店舗 ${row.store}`, `places/${row.store}`, 'confirmed'],
      );
      await pool.query(
        `INSERT INTO daily_summaries
           (store_id, summary_date, status, rank, rank_total, rank_prev, rating, review_count, rating_prev,
            review_count_prev, new_review_count, competitors)
         VALUES ($1, $2, 'ready', $3, $4, $5, $6, $7, $8, $7, 0, $9::jsonb)`,
        [
          row.store,
          UNRATED_DAY,
          row.rank,
          row.rankTotal,
          row.rankPrev,
          row.rating,
          row.reviewCount,
          row.ratingPrev,
          JSON.stringify(row.competitors),
        ],
      );
    }
  });

  afterAll(async () => {
    await closePool();
  });

  async function summaryOf(storeId: string) {
    const pool = await getPool();
    const targets = await queryDeliveryTargets(pool, UNRATED_HOUR, UNRATED_DAY);
    const target = targets.find((t) => t.storeId === storeId);
    if (target === undefined) {
      throw new Error(`target ${storeId} not found`);
    }
    return target.summary;
  }

  it('旧 Go の評価 0 の競合を「評価なし」として読み、水増しされた母数をその件数だけ戻す', async () => {
    const summary = await summaryOf(ST_LEGACY_COMPETITOR_ZERO);

    // 評価 0 の店は常に最下位に数えられていたので、自店の順位は正しく、母数だけが 1 つ多い。
    expect(summary.rank).toBe(1);
    expect(summary.rank_total).toBe(5);
    expect(summary.rank_prev).toBe(1);
    expect(summary.rating).toBe('4.3');
    expect(summary.competitors).toEqual([
      { name: '競合イチ', rating: 4.0, reviewCount: 300, starDiff: 0.3 },
      { name: '競合ニ', rating: 3.9, reviewCount: 200, starDiff: 0.4 },
      { name: '競合サン', rating: 3.7, reviewCount: 100, starDiff: 0.6 },
      { name: '競合ヨン', rating: 3.3, reviewCount: 50, starDiff: 1.0 },
      { name: '競合ゴ', rating: null, reviewCount: 0, starDiff: null },
    ]);
  });

  it('旧 Go の自店の評価 0 を「評価なし」として読み、順位と星差を持たせない', async () => {
    const summary = await summaryOf(ST_LEGACY_SELF_ZERO);

    expect(summary.rating).toBeNull();
    expect(summary.rating_prev).toBeNull();
    expect(summary.rank).toBeNull();
    expect(summary.rank_total).toBeNull();
    expect(summary.rank_prev).toBeNull();
    expect(summary.review_count).toBe(0);
    // 競合自身の評価は残し、自店と比べられない星差だけを消す。
    expect(summary.competitors).toEqual([
      { name: '競合イチ', rating: 4.5, reviewCount: 120, starDiff: null },
      { name: '競合ニ', rating: 4.0, reviewCount: 80, starDiff: null },
    ]);
  });

  it('新 Go の null はそのまま読み、母数を二重に引かない', async () => {
    const summary = await summaryOf(ST_NEW_NULL);

    expect(summary.rank).toBe(2);
    expect(summary.rank_total).toBe(3);
    expect(summary.competitors).toEqual([
      { name: '競合イチ', rating: 4.5, reviewCount: 100, starDiff: -0.2 },
      { name: '競合ニ', rating: 4.0, reviewCount: 30, starDiff: 0.3 },
      { name: '競合サン', rating: null, reviewCount: 0, starDiff: null },
    ]);
  });
});
