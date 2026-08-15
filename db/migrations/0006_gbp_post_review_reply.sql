-- 0006_gbp_post_review_reply.sql
-- gbp-post-review-reply spec: GBP 連携の身元（gbp_locations）と会話セッション（gbp_sessions）の 2 表を追加。
-- PostgreSQL 15+ 互換。すべて追加のみ（既存テーブル・enum の変更なし。oauth_tokens は 0001 定義のまま実運用化）。
-- 書き込み境界は db/write-boundary.md（両テーブルとも TS リアルタイム応答層）を参照。0001-0004 適用後に実行する。

BEGIN;

-- ============================================================
-- Task 1.1: GBP 上の身元（store 1:1・連携成立時に oauth_tokens と同時作成・解除時に同時削除）
-- ============================================================
-- 書込責任: TypeScript（line-webhook。write-boundary.md へ追記必須）
CREATE TABLE gbp_locations (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id      uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    account_name  text NOT NULL,   -- accounts/{accountId}
    location_name text NOT NULL,   -- locations/{locationId}
    place_id      text NOT NULL,   -- 突合時点の stores.place_id
    can_operate_local_post boolean NOT NULL DEFAULT true,
    linked_at     timestamptz NOT NULL DEFAULT now(),
    -- 連携の単位は店舗（Req 1.7）。1 店舗につき高々 1 連携。
    CONSTRAINT ux_gbp_locations_store UNIQUE (store_id)
);

-- ============================================================
-- Task 1.1: GBP 会話フロー enum（connect/post/reply × 状態機械の段階）
-- ============================================================
CREATE TYPE gbp_flow AS ENUM ('connect', 'post', 'reply');
CREATE TYPE gbp_stage AS ENUM (
    'await_store', 'await_callback', 'await_input',
    'await_review_pick', 'await_overwrite_ok', 'await_decision', 'await_revision',
    'executing'  -- 承認実行中の排他用（CAS ガード。design.md GbpFlows の Concurrency strategy 参照）
);

-- ============================================================
-- Task 1.1: GBP 会話セッション（owner 単位に高々 1 つ・期限付き・一時状態のみ保持）
-- ============================================================
-- 書込責任: TypeScript（line-webhook。write-boundary.md へ追記必須）
CREATE TABLE gbp_sessions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id    uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    store_id    uuid REFERENCES stores(id) ON DELETE CASCADE,  -- await_store 中は NULL
    flow        gbp_flow NOT NULL,
    stage       gbp_stage NOT NULL,
    payload     jsonb NOT NULL DEFAULT '{}'::jsonb,  -- state nonce / material / reviews スナップショット
    draft_text  text,
    expires_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    -- 新フロー開始は旧セッションの置換（upsert）で表現。並行セッションは構造的に不可。
    CONSTRAINT ux_gbp_sessions_owner UNIQUE (owner_id)
);

COMMIT;
