// クロスランタイム契約検証（Issue #255・competitive-daily-summary tasks 8.3）— 詳細画面の読込半分。
//
// go/internal/batch/crossruntime_test.go（Go 半分）が実 postgres に対して実際の batch.Run を実行し、
// daily_summaries を書き込む。本ファイルは別プロセス・別言語から同じ postgres へ接続し、詳細画面の
// 読込（queryStoreDetail・/api/detail が使うのと同じ関数）でその行を読む。配信側の同種の検証は
// ts/apps/delivery-job/test/cross-runtime.e2e.test.ts が受け持つ。これまで詳細画面の読込は、Go が
// 実際に書いた行では一度も検証されていなかった。
//
// 描画はここでは行わない。jsdom と pg を 1 ファイルに混ぜると、CI にしか無い認証経路（SCRAM）が
// ローカルで一度も試されないためである。代わりに、読んだ結果が `fixtures/unrated-competitor.ts` の
// 定数と一致することをここで確かめ、同じ定数を store-page.test.tsx が描画して「評価なし」と出ることを
// 確かめる（2 つのテストが同じ形を検証していることを、型と値の両方で結ぶ）。
//
// 実行方法: db/test/cross_runtime_steps.sh が Go 側テストの後に CROSS_RUNTIME_GO_SEEDED=1 付きで実行する。
// 通常の `pnpm -C ts run test` では前提データ（Go の書込み）が無いため無条件 skip する。
import { afterAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '@fwlm/db';
import { queryStoreDetail } from '../lib/data.js';
import { UNRATED_COMPETITOR_FROM_GO } from './fixtures/unrated-competitor.js';

// go/internal/batch/crossruntime_test.go と一致させる固定識別子・日付（変更する場合は両ファイルを揃える）。
const READY_STORE_ID = 'c7100000-0000-0000-0000-000000000001';
const NOCOMP_STORE_ID = 'c7100000-0000-0000-0000-000000000002';
const TODAY = '2026-07-12';

const goSideRan = process.env.CROSS_RUNTIME_GO_SEEDED === '1';

describe.skipIf(!process.env.DATABASE_URL || !goSideRan)(
  'store-detail cross-runtime contract — Go が書いた daily_summaries を詳細画面の読込が読む',
  () => {
    afterAll(async () => {
      await closePool();
    });

    it('評価の無い競合を、画面の単体テストが描く形（rating・starDiff が null）のまま返す', async () => {
      const pool = await getPool();
      const detail = await queryStoreDetail(pool, READY_STORE_ID, { asOf: TODAY });

      // 評価のある 3 店（自店 4.5・競合 4.0・3.8）で 1 位。評価の無い競合は母数に数えない。
      expect(detail.summary).toMatchObject({ status: 'ready', rank: 1, rankTotal: 3, rating: '4.5' });

      expect(detail.competitors).toHaveLength(3);
      expect(detail.competitors.map((c) => c.name)).toEqual(['競合イチ', '競合ニ', UNRATED_COMPETITOR_FROM_GO.name]);
      expect(detail.competitors[2]).toEqual(UNRATED_COMPETITOR_FROM_GO);
      // 評価のある競合の星差は「自店 − 競合」で残る（読込時の正規化が消していないこと）。
      expect(detail.competitors[0]?.starDiff).toBeCloseTo(0.5, 5);
      expect(detail.competitors[1]?.starDiff).toBeCloseTo(0.7, 5);
    });

    it('競合 0 件の店は空の一覧を返す（R1.3・R4.3）', async () => {
      const pool = await getPool();
      const detail = await queryStoreDetail(pool, NOCOMP_STORE_ID, { asOf: TODAY });

      expect(detail.summary?.status).toBe('no_competitors');
      expect(detail.competitors).toEqual([]);
    });
  },
);
