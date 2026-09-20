-- 0011_daily_summary_reviews_uri.sql
-- Issue #303: 日次集計へ「その店舗の口コミ一覧を Google Maps で開く URL」を足す。
--
-- 背景: Places API (New) の `Place.reviews` は原文で "sorted by relevance. A maximum of 5 reviews
-- can be returned." と定められ、新着順へ並べ替える手段を持たない。そのため口コミ数の多い店では、
-- 前日より後に投稿された口コミが上位 5 件へ入らず、「新着口コミの内容」が構造的に取れない。
--
--   本番の実測（2026-09-20）: daily_summaries は全 67 行・全期間で new_reviews が空配列。
--   同じ期間の new_review_count の総和は 22。口コミ 2291 件の店では、返る 5 件のうち
--   最も新しいものが約 3 か月前だった。
--
-- 結果として「新着口コミをみる」は件数だけを出して「内容は表示できません」で終わり、オーナーは
-- どこへも行けない。この列は、その行き止まりを解消する行き先（Google Maps の口コミ一覧。
-- そこでは新着順に読める）を保持する。値は Places の `googleMapsLinks.reviewsUri` をそのまま入れる。
--
-- NULL を許す理由は 2 つある。
--   1. この migration より前に書かれた行は値を持たない（旧い行を書き換えない）
--   2. 応答に `googleMapsLinks` を持たない店がありうる。Go は空文字のとき NULL を書き、
--      読み手（LINE のレポート・LIFF）は導線ごと置かない
-- NOT NULL + 既定値にはしない。既定の空文字は「URL が無い」と区別できず、読み手が
-- 「空文字の href」を描く側へ倒れる。
--
-- 旧コードと互換である: 列の追加だけで、既存の INSERT（列を明示する Go の WriteDailySummary と、
-- 3 列だけを与える db/test の検査）はそのまま通る。よってコードより先に当てる
-- （line-on-demand-report design.md「Migration Strategy」の Step A と同じ順）。
--
-- 本番へ当てた後の確認:
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_name = 'daily_summaries' AND column_name = 'google_maps_reviews_uri';
--
-- 新テーブルは無い。書込責任は変わらず Go 日次バッチ層（db/write-boundary.md）。
-- GRANT はテーブル単位なので infra/sql/grants.sql も変わらない。
BEGIN;

ALTER TABLE daily_summaries
    ADD COLUMN google_maps_reviews_uri text;

COMMENT ON COLUMN daily_summaries.google_maps_reviews_uri IS
    'その店舗の口コミ一覧を Google Maps で開く URL（Places の googleMapsLinks.reviewsUri）。取得できない日は NULL（Issue #303）。';

COMMIT;
