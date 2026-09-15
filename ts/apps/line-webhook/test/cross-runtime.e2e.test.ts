// クロスランタイム契約検証（line-on-demand-report tasks 2.5）— レポート用の読み出しの半分。
//
// go/internal/batch/crossruntime_test.go（Go 半分）が実 postgres に対して実際の batch.Run を実行し、
// daily_summaries を書き込む。本ファイルは別プロセス・別言語から同じ postgres へ接続し、line-webhook の
// レポートが使う読み出し（@fwlm/db の findLatestDailySummary・listDailySummariesEndingAt）でその行を読む。
// 配信と詳細画面の読込の同種の検証は、delivery-job と store-detail の cross-runtime.e2e.test.ts が受け持つ。
//
// 確かめるのは次の 2 つである。
//   - 口コミの帰属 3 項目（口コミを Google Maps で開く URL・投稿者のプロフィールの URL・画像の URL）:
//     Go は値のある口コミに 3 項目を書き、値の無い口コミにはキーごと書かない（3 項目を足す前に書かれた
//     行の要素と同じ形になる）。TS の読み出しが、どちらの要素もそのままの形で返すこと（Req 8.2・8.6・8.7）
//   - 30 日の窓: Go の削除（PurgeOlderThan）が実際に残した最古の行（基準日の 29 日前 = 30 日目）を、TS の
//     範囲の読み出し（listDailySummariesEndingAt）が同じ基準日の窓の中で返すこと（Req 6.7）。30 という値は
//     Go と TS の二重定義なので、Go が 30 日目の行まで消す食い違いと、範囲の読み出しの窓が Go より狭くなる
//     食い違いは、ここで赤になる。ここで検出できないものは次の 2 つで、どちらも packages/db の
//     report-reads.db.test.ts が関数ごとに 30 日目を返し 31 日目を返さないことで固定している
//       - TS の窓が広がる食い違い（31 日目の行は Go が消しているので、ここには残っていない）
//       - 最新の行の読み出し（findLatestDailySummary）の窓（Go は確定店舗すべてに当日の行を書くので、
//         この基準日で最も新しい行は常に当日の行になる）
//
// 基準日には、Go が行を書く固定日 2026-07-12 を渡す（実行日の日付を渡すと、窓の外になり 0 行を読む）。
// レポートの組み立て（Flex）はここでは行わない（tasks 3.11 で、新着口コミのレポートまで広げる）。
//
// 実行方法: db/test/cross_runtime_steps.sh が Go 側テストの後に CROSS_RUNTIME_GO_SEEDED=1 付きで実行する。
// 通常の `pnpm -C ts run test` では前提データ（Go の書込み）が無いため無条件 skip する。
import { afterAll, describe, expect, it } from 'vitest';
import { closePool, findLatestDailySummary, getPool, listDailySummariesEndingAt } from '@fwlm/db';
import type { DailySummaryNewReview } from '@fwlm/db';

// go/internal/batch/crossruntime_test.go と一致させる固定識別子・日付・値（変更する場合は両ファイルを揃える）。
const READY_STORE_ID = 'c7100000-0000-0000-0000-000000000001';
/** Go の契約試験が行を書く日。レポートの基準日（日本時間の今日）として渡す。 */
const AS_OF = '2026-07-12';
/** 基準日の 29 日前。Go の削除が残す最古の日（30 日目）。 */
const DAY_30 = '2026-06-13';
/** Go が 30 日目の行へ書いた口コミ総数（行の取り違えを見分けるための値）。 */
const DAY_30_REVIEW_COUNT = 80;

// 帰属 3 項目を持つ新着口コミ。型の注釈で、DailySummaryNewReview が 3 項目を持つことも固定する
// （型から項目が消えると、ここが型検査で落ちる）。
const ATTRIBUTED_REVIEW: DailySummaryNewReview = {
  authorName: 'テスト太郎',
  publishTime: '2026-07-12T01:00:00Z',
  rating: 5,
  textExcerpt: 'とても美味しかったです、また来ます',
  authorUri: 'https://www.google.com/maps/contrib/cross-runtime-author/reviews',
  authorPhotoUri: 'https://lh3.googleusercontent.com/a/cross-runtime-photo',
  googleMapsUri: 'https://www.google.com/maps/reviews/data=cross-runtime-review',
};

// 帰属 3 項目を持たない新着口コミ（3 項目を足す前に書かれた行の要素と同じ形）。
const UNATTRIBUTED_REVIEW: DailySummaryNewReview = {
  authorName: 'テスト花子',
  publishTime: '2026-07-12T02:00:00Z',
  rating: 4,
  textExcerpt: '落ち着いて食事ができました',
};

const goSideRan = process.env.CROSS_RUNTIME_GO_SEEDED === '1';

describe.skipIf(!process.env.DATABASE_URL || !goSideRan)(
  'line-webhook cross-runtime contract — Go が書いた daily_summaries をレポート用の読み出しが読む',
  () => {
    afterAll(async () => {
      await closePool();
    });

    it('最新の行の新着口コミを、帰属 3 項目を持つ要素と持たない要素のまま返す', async () => {
      const pool = await getPool();
      const row = await findLatestDailySummary(pool, READY_STORE_ID, AS_OF);
      if (row === null) {
        throw new Error('readyStore の daily_summaries 行がありません — Go 側の段が先に走っていますか');
      }

      expect(row.summary_date).toBe(AS_OF);
      expect(row.status).toBe('ready');
      // 前日 90 件 → 当日 95 件。抜粋は前日の集計基準より後に投稿された 2 件。
      expect(row.new_review_count).toBe(5);
      expect(row.new_reviews).toHaveLength(2);

      const [attributed, unattributed] = row.new_reviews;
      if (attributed === undefined || unattributed === undefined) {
        throw new Error('新着口コミの抜粋が 2 件ありません');
      }

      // Go が受け取った 3 つの URL を、加工せずにそのまま返す。
      expect(attributed).toEqual(ATTRIBUTED_REVIEW);

      // 値の無い 3 項目は、null ではなくキーごと無い（Go の omitempty）。レポートはキーの有無で
      // 「導線を取得できているか」を判定するので、null や空文字が入っていても赤にする。
      expect(unattributed).toEqual(UNATTRIBUTED_REVIEW);
      expect(Object.keys(unattributed).sort()).toEqual(['authorName', 'publishTime', 'rating', 'textExcerpt']);
      expect('googleMapsUri' in unattributed).toBe(false);
      expect('authorUri' in unattributed).toBe(false);
      expect('authorPhotoUri' in unattributed).toBe(false);
    });

    it('Go の削除が残す最古の行（基準日の 29 日前・30 日目）を、同じ基準日の窓の中で返す', async () => {
      const pool = await getPool();
      // 基準日で終わる 30 暦日の範囲。Go は 30 日目と当日の行を残し、31 日目の行を消している
      // （Go 側の段がその状態を確かめてから終わる）。
      const rows = await listDailySummariesEndingAt(pool, READY_STORE_ID, AS_OF, 30, AS_OF);

      expect(rows.map((r) => r.summary_date)).toEqual([DAY_30, AS_OF]);
      expect(rows[0]?.review_count).toBe(DAY_30_REVIEW_COUNT);
    });
  },
);
