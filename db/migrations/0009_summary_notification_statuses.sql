-- 0009_summary_notification_statuses.sql
-- line-on-demand-report（Issue #256）: 通知記録 summary_deliveries.status に「送らなかった理由」の 3 値を足す。
--
-- 背景: 配信ジョブは、毎朝すべての店舗へ日次カードを送る形から、意味のある変化があった日にだけ
-- 短い通知を送る形へ変わる（line-on-demand-report Requirement 1）。通知記録は「その店舗のその日に
-- 通知を送ったか、送らなかったならなぜか」を 1 行で表す。送らない日も理由つきで 1 行を残すので、
-- 同じ日の再実行は `UNIQUE (store_id, summary_date)` によって同じ店舗を判定し直さない（1.8）。
--
--   skipped_no_change         比較可能だが新着も順位変動も無い（前日の集計が無い場合を含む・1.4）
--   skipped_not_comparable    当日の集計が比較可能でない（取得失敗・評価を持つ競合なし・自店未評価・1.5）
--   skipped_menu_unavailable  完了後メニューが準備されていない、またはオーナーへ張れなかった（1.10）
--
-- 既存の 4 値（delivered / failed / skipped_no_summary / quota_exceeded）の意味は変えない。
--
-- 0004 の CHECK は列制約で名前を持たず、PostgreSQL が summary_deliveries_status_check と名付けている
-- （0001〜0008 を当てた一時の DB で pg_constraint を引いて確かめた）。これを落とし、明示名
-- ck_summary_deliveries_status で作り直す。
-- **DROP に IF EXISTS を付けない。** 名前が違う環境で IF EXISTS を付けると、旧い 4 値の CHECK が残った
-- まま新しい CHECK が足され、migration は成功するのに追加 3 値の書込だけが実行時に落ちる。付けなければ
-- この migration ごと失敗してロールバックされ、何も変わらない側へ倒れる。
--
-- 旧コードと互換である: 値の集合を広げるだけなので、旧イメージが書く 4 値は受理され続け、既存行が
-- ADD CONSTRAINT の検証で落ちることもない。そのためコードより先に当てる（design.md「Migration Strategy」
-- の Step A）。本番ではマージの後に当て、次の問い合わせで CHECK が 7 値の 1 本だけであることを確かめる:
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'summary_deliveries'::regclass AND contype = 'c';
--
-- 新テーブルは無い。書込責任は変わらず TypeScript（db/write-boundary.md）。
BEGIN;

ALTER TABLE summary_deliveries
    DROP CONSTRAINT summary_deliveries_status_check,
    ADD CONSTRAINT ck_summary_deliveries_status CHECK (status IN (
        'delivered',
        'failed',
        'skipped_no_summary',
        'quota_exceeded',
        'skipped_no_change',
        'skipped_not_comparable',
        'skipped_menu_unavailable'
    ));

COMMIT;
