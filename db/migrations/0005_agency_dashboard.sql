-- 0005_agency_dashboard.sql
-- agency-dashboard spec: dashboard_users に Google ログイン用の自然キー email と無効化列 disabled_at を追加。
-- 追加のみ（既存行・既存制約を破壊しない）。0001〜0004 適用後に実行する。
-- 書き込み境界は db/write-boundary.md 参照（新テーブルなし・dashboard_users は既存 TS 境界のため変更なし）。

BEGIN;

-- ============================================================
-- Task 1.1: dashboard_users への列追加と auth_subject NULL 許容化。
-- 保留（未ログイン）状態を email のみで表現し、初回 Google ログインで auth_subject を確定（リンク）する。
-- 既存行は auth_subject 設定済みのため後続 CHECK を自明に満たす。既存 UNIQUE(auth_subject) は維持。
-- ============================================================
ALTER TABLE dashboard_users
    ADD COLUMN email       text,
    ADD COLUMN disabled_at timestamptz,
    ALTER COLUMN auth_subject DROP NOT NULL;

-- ============================================================
-- Task 1.1: 身元の下限保証。保留行（未ログイン）は email 必須・リンク済み行は auth_subject 必須。
-- 少なくとも一方が非 NULL であることを構造強制する。
-- ============================================================
ALTER TABLE dashboard_users
    ADD CONSTRAINT ck_dashboard_users_identity
        CHECK (auth_subject IS NOT NULL OR email IS NOT NULL);

-- ============================================================
-- Task 1.1: email は小文字正規化して保存し、大文字小文字を無視して一意（NULL は複数併存可）。
-- リンク前の保留行の email が一意であることを保証し、初回ログインの原子的リンクの前提を与える。
-- ============================================================
CREATE UNIQUE INDEX ux_dashboard_users_email
    ON dashboard_users (lower(email)) WHERE email IS NOT NULL;

COMMIT;
