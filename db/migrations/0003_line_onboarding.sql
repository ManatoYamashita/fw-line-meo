-- 0003_line_onboarding.sql
-- line-onboarding spec: 招待コード・会話セッション・Webhook イベント重複排除の 3 表を追加。
-- 書き込み境界は db/write-boundary.md（TS リアルタイム応答層）を参照。0001/0002 適用後に実行する。

BEGIN;

-- ============================================================
-- Task 1.1: オンボーディング会話の段階 ENUM
-- ============================================================
CREATE TYPE onboarding_stage AS ENUM
    ('await_invite_code', 'await_store_name', 'await_confirmation', 'completed');

-- ============================================================
-- Task 1.1: 代理店招待コード（代理店単位・共有・disabled_at で失効。Req 2.5）
-- ============================================================
CREATE TABLE agency_invite_codes (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id   uuid NOT NULL REFERENCES agencies(id) ON DELETE RESTRICT,
    code        text NOT NULL UNIQUE,
    disabled_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Task 1.1: オーナーごとの会話進捗（PK=line_user_id・owner 誕生前から存在する唯一の状態置き場）。
-- 不変条件: stage='await_invite_code' ⇔ owner_id IS NULL（Req 2.4 を owners.agency_id NOT NULL と両輪で構造保証）。
-- ============================================================
CREATE TABLE onboarding_sessions (
    line_user_id    text PRIMARY KEY,
    stage           onboarding_stage NOT NULL DEFAULT 'await_invite_code',
    owner_id        uuid REFERENCES owners(id) ON DELETE CASCADE,
    candidates      jsonb,
    selected_index  int,
    invite_failures int NOT NULL DEFAULT 0,
    locked_until    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_session_owner_stage CHECK ((stage = 'await_invite_code') = (owner_id IS NULL))
);

-- ============================================================
-- Task 1.1: Webhook イベント重複排除（Req 5.4）。received_at は将来の掃除条件用に保持（MVP では未使用）。
-- ============================================================
CREATE TABLE line_webhook_events (
    webhook_event_id text PRIMARY KEY,
    received_at      timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- リネージ走査用インデックス
-- ============================================================
CREATE INDEX ix_invite_codes_agency ON agency_invite_codes (agency_id);
CREATE INDEX ix_sessions_owner      ON onboarding_sessions (owner_id);

COMMIT;
