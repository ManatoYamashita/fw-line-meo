// レポート用の読み出し（line-on-demand-report）。
//
// line-webhook の 3 つのレポート（新着口コミ・競合店との比較・直近の推移）が使う、オーナーの確定店舗と
// 日次集計の読み出しを 1 か所に置く。SELECT だけを発行し、書き込みはしない（daily_summaries を書くのは
// Go だけで、line-webhook は読むだけである）。各関数の問い合わせは 1 回である。
//
// 30 日の窓: 基準日 asOf（日本時間の 'YYYY-MM-DD'）を含む直近 30 暦日 [asOf-29日, asOf]。
// - 下限は Go の 30 日ローリング削除（go/internal/repo/summaries.go の PurgeOlderThan。
//   summary_date <= asOf-30日 の行を消す）と同じ境界にする。削除が遅れても 30 日を超える行を返さない
// - 上限は基準日である。Go は日本時間の当日を summary_date に書くので、呼出元が日本時間の今日を渡す
//   限り、行を取りこぼさない
// - 基準日を引数で受けるのは、試験（Go の言語間試験は固定日で行を書く）で日付を固定できるように
//   するためである（store-detail の queryStoreDetail と同じ形）。SQL に now() や CURRENT_DATE を持たない
// - 30 という値は Go と TS の二重定義である。Go の削除が実際に残した最古の行（30 日目）を範囲の読み出しが
//   返すことは、言語間の契約試験（ts/apps/line-webhook/test/cross-runtime.e2e.test.ts）で確かめる。
//   30 日目を返して 31 日目を返さないことは、関数ごとに report-reads.db.test.ts で固定する
//
// 日付は to_char で文字列にして読む。pg 既定の Date への変換は実行環境の TZ に依存するため使わない。
// 並べ替えと絞り込みは表の列（ds.summary_date）で書く。出力の列名も summary_date なので、修飾しない
// 名前を ORDER BY に書くと出力の文字列の方を指す（PostgreSQL の規則）。

import type { Queryable } from './pool.js';
import type { DailySummaryReadRow } from './types.js';

/** レポートの対象にできる店舗（オーナー本人の確定店舗）。 */
export interface ReportableStore {
  readonly id: string;
  readonly name: string;
}

// DailySummaryReadRow の 13 項目と 1:1。
const READ_COLUMNS = `to_char(ds.summary_date, 'YYYY-MM-DD') AS summary_date,
       ds.status, ds.rank, ds.rank_total, ds.rank_prev,
       ds.rating, ds.review_count, ds.rating_prev, ds.review_count_prev,
       ds.new_review_count, ds.new_reviews, ds.competitors,
       ds.google_maps_reviews_uri`;

/**
 * オーナー本人の確定店舗を作成順（作成時刻が同じなら id の順）に返す。無ければ空の配列。
 *
 * 前提: ownerId は署名検証済みの LINE ユーザーから導いたオーナー ID に限る。
 * 店舗の利用停止状態（Issue #252）が先に入った場合は、この 1 か所に停止中を除く述語を足す。
 */
export async function listReportableStores(db: Queryable, ownerId: string): Promise<ReportableStore[]> {
  const res = await db.query<ReportableStore>(
    `SELECT id, name
       FROM stores
      WHERE owner_id = $1
        AND place_status = 'confirmed'
      ORDER BY created_at, id`,
    [ownerId],
  );
  return res.rows;
}

/**
 * 基準日 asOf（日本時間の 'YYYY-MM-DD'）から見た 30 日の窓の中で最も新しい行を返す。無ければ null。
 *
 * 前提: storeId は listReportableStores が返した集合の要素に限る。
 * 返す行は正規化の前の生の値である（呼出元が normalizeSummaryRatings を通す）。
 */
export async function findLatestDailySummary(
  db: Queryable,
  storeId: string,
  asOf: string,
): Promise<DailySummaryReadRow | null> {
  const res = await db.query<DailySummaryReadRow>(
    `SELECT ${READ_COLUMNS}
       FROM daily_summaries ds
      WHERE ds.store_id = $1
        AND ds.summary_date > ($2::date - 30)
        AND ds.summary_date <= $2::date
      ORDER BY ds.summary_date DESC
      LIMIT 1`,
    [storeId, asOf],
  );
  return res.rows[0] ?? null;
}

/**
 * 終点 endDate を含む days 暦日（endDate の days-1 日前から endDate まで）の行を、日付の昇順で返す。
 * 基準日 asOf から見た 30 日の窓の外の行は、範囲の中でも含めない。行が無い日は結果に現れない
 * （欠損日の扱いは呼出元が決める）。
 *
 * 前提: storeId は listReportableStores が返した集合の要素に限る。days は 1 以上の整数。
 * 返す行は正規化の前の生の値である（呼出元が normalizeSummaryRatings を通す）。
 */
export async function listDailySummariesEndingAt(
  db: Queryable,
  storeId: string,
  endDate: string,
  days: number,
  asOf: string,
): Promise<DailySummaryReadRow[]> {
  const res = await db.query<DailySummaryReadRow>(
    `SELECT ${READ_COLUMNS}
       FROM daily_summaries ds
      WHERE ds.store_id = $1
        AND ds.summary_date > ($2::date - $3::integer)
        AND ds.summary_date <= $2::date
        AND ds.summary_date > ($4::date - 30)
        AND ds.summary_date <= $4::date
      ORDER BY ds.summary_date ASC`,
    [storeId, endDate, days, asOf],
  );
  return res.rows;
}
