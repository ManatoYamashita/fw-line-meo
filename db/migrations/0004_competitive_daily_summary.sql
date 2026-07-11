-- 0004_competitive_daily_summary.sql
-- competitive-daily-summary: 日次サマリー・配信記録・配信時刻設定
-- PostgreSQL 15+ 互換。すべて追加のみ（既存テーブル/カラムの変更・削除なし。owners への列追加のみ例外）。
-- 書き込み境界は db/write-boundary.md（task 1.2 で本 spec 分を追記）を参照。

BEGIN;

-- ============================================================
-- Task 1.1: 日次サマリー（店舗×日付で一意の確定「配信素材」・生成後は不変・再実行時は全置換）
-- ============================================================
-- 書込責任: Go（write-boundary.md へ追記必須）
CREATE TABLE daily_summaries (
    id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id           uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
    summary_date       date NOT NULL,
    status             text NOT NULL CHECK (status IN ('ready', 'no_competitors', 'failed')),
    rank               integer,            -- failed 時 NULL
    rank_total         integer,            -- 比較集合サイズ（自店含む N）
    rank_prev          integer,            -- 前日なしは NULL（R3.7）
    rating             numeric(2,1),
    review_count       integer,
    rating_prev        numeric(2,1),
    review_count_prev  integer,
    new_review_count   integer NOT NULL DEFAULT 0,
    new_reviews        jsonb NOT NULL DEFAULT '[]',  -- [{authorName, publishTime, rating, textExcerpt}] 帰属表示用
    competitors        jsonb NOT NULL DEFAULT '[]',  -- [{name, rating, reviewCount, starDiff}] 表示順は rank 順
    created_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ux_daily_summaries_store_date UNIQUE (store_id, summary_date)
);
CREATE INDEX ix_daily_summaries_date ON daily_summaries (summary_date);

-- ============================================================
-- Task 1.1: 配信記録（店舗×日付で一意の「配信事実」・retry_key で冪等再送）
-- ============================================================
-- 書込責任: TypeScript（write-boundary.md へ追記必須）
CREATE TABLE summary_deliveries (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id         uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
    summary_date     date NOT NULL,
    line_user_id     text NOT NULL,
    status           text NOT NULL CHECK (status IN ('delivered', 'failed', 'skipped_no_summary', 'quota_exceeded')),
    retry_key        uuid NOT NULL,
    line_request_id  text,
    error_detail     text,
    delivered_at     timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ux_summary_deliveries_store_date UNIQUE (store_id, summary_date)
);

-- ============================================================
-- Task 1.1: 配信時刻設定（owners への追加のみ・時単位・default 7・0-23）
-- ============================================================
-- 書込責任: TypeScript（owners は既存 TS 境界）
ALTER TABLE owners ADD COLUMN delivery_hour smallint NOT NULL DEFAULT 7
    CHECK (delivery_hour BETWEEN 0 AND 23);

COMMIT;
