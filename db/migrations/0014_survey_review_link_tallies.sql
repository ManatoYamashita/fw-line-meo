-- 0014_survey_review_link_tallies.sql
-- review-acquisition（Issue #401）: 投稿導線の押下件数の匿名集計。
-- PostgreSQL 15+ 互換。表を足すだけで、既存の表・列・制約を変更しない。
-- 書き込み境界は db/write-boundary.md を参照。0013 適用後に実行する。
--
-- 背景: 代理店・運営のダッシュボード（QR パネル）に「その QR から Google の投稿画面へ進んだ回数」を
-- 出す（store-qr-issuance-ui Requirement 8）。押下の観測は構造化ログ `survey_review_link_opened` と
-- そのログベース指標にしか無く（Issue #137）、ダッシュボードからは読めない。Google への投稿そのものは
-- 客と Google の間で完結し、本システムは観測できない。
--
-- 何を数えるか: 下書き画面の押下のうち、回答の後にだけ発行される sessionToken で検証できたものだけ
-- （Requirement 5.9）。回答済み画面の押下（pageToken）は加算しない。重複は端末の側で、1 回の画面表示に
-- つき最初の押下だけを送ることで抑える（Requirement 5.10）。
--
-- 匿名性: 持つのは店舗×月の件数だけで、token・時刻・端末を識別しうる列を持たない。既存 tallies と
-- 同じく created_at も持たない。サーバー側で token を覚えれば重複を区別できるが、それは token の保持
-- そのものになるので採らない。この構造は db/test/assertions/30_compliance.sql の列 allowlist と
-- 72_survey_review_link_tallies.sql が機械強制する。
--
-- 適用の順序: 旧コードはこの表を知らないので、適用からデプロイまでの間に失敗は起きない。逆に適用より
-- 先にデプロイすると、加算がすべて失敗する（客の体験は Requirement 5.4 で守られ、失敗は
-- `review_link_tally_failed` に残る）。本番は 0014 → infra/sql/grants.sql → デプロイの順にする。
-- ============================================================
-- 書込責任: TypeScript（write-boundary.md へ追記必須）
BEGIN;

CREATE TABLE survey_review_link_tallies (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id     uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
    period_month date NOT NULL CHECK (EXTRACT(DAY FROM period_month) = 1),
    count        integer NOT NULL DEFAULT 0 CHECK (count >= 0),
    CONSTRAINT ux_survey_review_link UNIQUE (store_id, period_month)
);

COMMIT;
