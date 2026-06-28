-- 0001_four_tier_baseline.sql
-- fw-line-meo 4階層データモデル baseline スキーマ
-- PostgreSQL 15+ 互換。UUID は gen_random_uuid()（PG13+ 標準・拡張不要）。
-- 書き込み境界は db/write-boundary.md（task 4.2）を参照。

BEGIN;

-- ============================================================
-- Task 1.2: 共有 ENUM 型と参照テーブル（共有定数の器・値は 0002 seed が SoT）
-- ============================================================
CREATE TYPE dashboard_role    AS ENUM ('operator', 'agency');
CREATE TYPE onboarding_status AS ENUM ('pending', 'store_identified', 'active');
CREATE TYPE place_status      AS ENUM ('pending', 'confirmed');
CREATE TYPE snapshot_subject  AS ENUM ('self', 'competitor');
CREATE TYPE oauth_provider    AS ENUM ('google');

CREATE TABLE categories (
    code  text PRIMARY KEY,
    label text NOT NULL
);

CREATE TABLE survey_aspects (
    code  text PRIMARY KEY,
    label text NOT NULL
);

-- ============================================================
-- Task 2.1: テナント階層（operators -> agencies）
-- 親欠落の子は作成不可（NOT NULL FK）。誤削除防止に ON DELETE RESTRICT。
-- ============================================================
CREATE TABLE operators (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agencies (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id uuid NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Task 2.2: オーナー（LINE 識別子）。line_user_id は全オーナー一意。
-- ============================================================
CREATE TABLE owners (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id         uuid NOT NULL REFERENCES agencies(id) ON DELETE RESTRICT,
    line_user_id      text NOT NULL UNIQUE,
    display_name      text,
    onboarding_status onboarding_status NOT NULL DEFAULT 'pending',
    created_at        timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Task 2.3: 店舗（1 オーナー:N 店舗）。place_id は確定時のみ一意・未確定 NULL 許容。
-- ============================================================
CREATE TABLE stores (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id      uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
    category_code text REFERENCES categories(code) ON DELETE RESTRICT,
    name          text NOT NULL,
    latitude      numeric(9,6) CHECK (latitude  BETWEEN -90  AND 90),
    longitude     numeric(9,6) CHECK (longitude BETWEEN -180 AND 180),
    place_id      text,
    place_status  place_status NOT NULL DEFAULT 'pending',
    created_at    timestamptz NOT NULL DEFAULT now()
);
-- 確定 place_id のみ一意（未確定 NULL の店舗は複数併存可）
CREATE UNIQUE INDEX ux_stores_place_id ON stores (place_id) WHERE place_id IS NOT NULL;

-- ============================================================
-- Task 2.4: ダッシュボード認証 + RBAC スコープ。資格情報は保持せず auth_subject 参照のみ。
-- role=operator は agency_id NULL（全体）/ role=agency は agency_id 必須（担当のみ）。
-- ============================================================
CREATE TABLE dashboard_users (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    role         dashboard_role NOT NULL,
    operator_id  uuid NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
    agency_id    uuid REFERENCES agencies(id) ON DELETE RESTRICT,
    auth_subject text NOT NULL UNIQUE,
    display_name text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_dashboard_role_scope CHECK (
        (role = 'operator' AND agency_id IS NULL)
        OR (role = 'agency' AND agency_id IS NOT NULL)
    )
);

-- ============================================================
-- Task 3.1: 競合（churn は active 論理非活性で表現・ハード削除しない）
-- ============================================================
CREATE TABLE competitors (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id   uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
    place_id   text NOT NULL,
    name       text,
    latitude   numeric(9,6) CHECK (latitude  BETWEEN -90  AND 90),
    longitude  numeric(9,6) CHECK (longitude BETWEEN -180 AND 180),
    active     boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ux_competitors_store_place UNIQUE (store_id, place_id)
);

-- ============================================================
-- Task 3.2: 評価・順位の時系列（追記専用）。
-- subject_kind と competitor_id の相関を CHECK。自店/競合それぞれ 1 日 1 行を部分一意で強制。
-- ============================================================
CREATE TABLE rating_snapshots (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id      uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
    subject_kind  snapshot_subject NOT NULL,
    competitor_id uuid REFERENCES competitors(id) ON DELETE RESTRICT,
    place_id      text NOT NULL,
    captured_on   date NOT NULL,
    rating        numeric(2,1) CHECK (rating BETWEEN 0 AND 5),
    review_count  integer CHECK (review_count >= 0),
    rank          integer CHECK (rank >= 1),
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_snapshot_subject CHECK (
        (subject_kind = 'self'       AND competitor_id IS NULL)
        OR (subject_kind = 'competitor' AND competitor_id IS NOT NULL)
    )
);
CREATE UNIQUE INDEX ux_rs_self ON rating_snapshots (store_id, captured_on)
    WHERE subject_kind = 'self';
CREATE UNIQUE INDEX ux_rs_comp ON rating_snapshots (store_id, competitor_id, captured_on)
    WHERE subject_kind = 'competitor';
CREATE INDEX ix_rs_store_captured ON rating_snapshots (store_id, captured_on DESC);

-- ============================================================
-- Task 3.3: アンケート匿名集計（store×period_month×次元のカウンタのみ）。
-- 顧客・個別回答・連絡先・端末識別子を表現する器は一切設けない（匿名性の構造保証）。
-- ============================================================
CREATE TABLE survey_rating_tallies (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id     uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
    period_month date NOT NULL CHECK (EXTRACT(DAY FROM period_month) = 1),
    star         smallint NOT NULL CHECK (star BETWEEN 1 AND 5),
    count        integer NOT NULL DEFAULT 0 CHECK (count >= 0),
    CONSTRAINT ux_survey_rating UNIQUE (store_id, period_month, star)
);

CREATE TABLE survey_aspect_tallies (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id     uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
    period_month date NOT NULL CHECK (EXTRACT(DAY FROM period_month) = 1),
    aspect_code  text NOT NULL REFERENCES survey_aspects(code) ON DELETE RESTRICT,
    count        integer NOT NULL DEFAULT 0 CHECK (count >= 0),
    CONSTRAINT ux_survey_aspect UNIQUE (store_id, period_month, aspect_code)
);

-- ============================================================
-- Task 3.4: 将来の OAuth トークン格納枠（店舗単位・第2フェーズ・定義のみ）。
-- テナント隔離は store->owner->agency。MVP では実データ運用しない。
-- ============================================================
CREATE TABLE oauth_tokens (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id   uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
    provider   oauth_provider NOT NULL,
    token_ref  text NOT NULL,
    scopes     text,
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ux_oauth_store_provider UNIQUE (store_id, provider)
);

-- ============================================================
-- リネージ走査用インデックス（RBAC スコープ: store->owner->agency->operator）
-- ============================================================
CREATE INDEX ix_agencies_operator ON agencies (operator_id);
CREATE INDEX ix_owners_agency     ON owners (agency_id);
CREATE INDEX ix_stores_owner      ON stores (owner_id);

COMMIT;
