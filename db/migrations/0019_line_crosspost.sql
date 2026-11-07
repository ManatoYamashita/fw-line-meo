-- 0019_line_crosspost.sql
-- line-crosspost spec（Issue #494）: LINE 起点の一括発信の下書き（crosspost_drafts）・写真（crosspost_media）・
-- 投稿先ごとの状態（crosspost_deliveries）の 3 表を追加する。
-- PostgreSQL 15+ 互換。すべて追加のみ（既存のテーブル・enum を変えない）。戻すときは 3 表と 4 enum を DROP する
-- （本機能は既定 OFF で、OFF のあいだアプリはこの 3 表を読まない）。
-- 書き込み境界は db/write-boundary.md（3 表とも TS リアルタイム応答層）。INSERT・UPDATE は line-webhook の SA だけ。
-- 保存期間を過ぎた行の削除だけは、利用者の操作に依存しないよう毎時の配信ジョブの SA も行う（DELETE のみ）。

BEGIN;

CREATE TYPE crosspost_draft_status AS ENUM ('collecting', 'reviewing', 'approved', 'canceled');
CREATE TYPE crosspost_input_mode AS ENUM ('none', 'ai_revision', 'manual');
CREATE TYPE crosspost_destination AS ENUM ('instagram', 'google');
CREATE TYPE crosspost_delivery_status AS ENUM (
    'queued', 'in_progress', 'succeeded', 'failed', 'unknown', 'canceled'
);

-- ============================================================
-- 下書き（owner あたり作成中は高々 1 つ・承認の後は変わらない）
-- ============================================================
-- 書込責任: TypeScript（line-webhook）
CREATE TABLE crosspost_drafts (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id          uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    store_id          uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    status            crosspost_draft_status NOT NULL DEFAULT 'collecting',
    -- 確認中に届いたテキストの解釈（none = 反映しない・ai_revision = 修正指示・manual = 店主の書き直し）
    input_mode        crosspost_input_mode NOT NULL DEFAULT 'none',
    input_destination crosspost_destination,
    -- 文・写真が変わるたびに +1。最終確認と承認の postback はこの値で縛る（古いカードから投稿させない）
    revision          integer NOT NULL DEFAULT 0,
    -- 店主が送った伝えたいこと（生成の素材）。店主自身の業務の内容で、来店客の情報ではない
    material_text     text NOT NULL DEFAULT '',
    instagram_text    text,
    google_text       text,
    approved_revision integer,
    approved_at       timestamptz,
    -- 投稿の結果を店主へ届けられた最後の時刻。投稿先の行の finished_at がこれより新しければ、まだ届けていない
    -- 結果がある（LINE への通知の失敗で結果を失わない・次の操作で見せる）
    result_notified_at timestamptz,
    -- 作成中の期限（最後の操作から）。承認・取り消しの後は使わない
    expires_at        timestamptz NOT NULL,
    -- 保存期間。過ぎた行は line-webhook が削除する（写真・投稿先の行は CASCADE）
    purge_after       timestamptz NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_crosspost_drafts_revision CHECK (revision >= 0),
    CONSTRAINT ck_crosspost_drafts_material_len CHECK (char_length(material_text) <= 2000),
    -- 各媒体の受理条件の上限（Instagram の caption 2,200 字・GBP の summary 1,500 字）
    CONSTRAINT ck_crosspost_drafts_instagram_len CHECK (instagram_text IS NULL OR char_length(instagram_text) <= 2200),
    CONSTRAINT ck_crosspost_drafts_google_len CHECK (google_text IS NULL OR char_length(google_text) <= 1500),
    CONSTRAINT ck_crosspost_drafts_approved CHECK (
        (status = 'approved') = (approved_at IS NOT NULL AND approved_revision IS NOT NULL)
    ),
    CONSTRAINT ck_crosspost_drafts_input CHECK (
        (input_mode = 'none') = (input_destination IS NULL)
        AND (input_mode = 'none' OR status = 'reviewing')
    ),
    CONSTRAINT ck_crosspost_drafts_purge CHECK (purge_after > created_at)
);

-- 作成中（collecting / reviewing）の下書きは owner あたり高々 1 つ。
CREATE UNIQUE INDEX ux_crosspost_drafts_open_owner
    ON crosspost_drafts (owner_id)
    WHERE status IN ('collecting', 'reviewing');
CREATE INDEX ix_crosspost_drafts_owner_created ON crosspost_drafts (owner_id, created_at DESC);
CREATE INDEX ix_crosspost_drafts_purge_after ON crosspost_drafts (purge_after);
-- 保存期間の削除（配信ジョブ・毎時）が期限切れの作成中の下書きを探す
CREATE INDEX ix_crosspost_drafts_open_expires ON crosspost_drafts (expires_at)
    WHERE status IN ('collecting', 'reviewing');

-- ============================================================
-- 写真（v1 は 1 下書き 1 枚。実体は非公開の置き場で、ここには鍵と寸法だけを持つ）
-- ============================================================
-- 書込責任: TypeScript（line-webhook）
CREATE TABLE crosspost_media (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    draft_id        uuid NOT NULL REFERENCES crosspost_drafts(id) ON DELETE CASCADE,
    -- LINE の message.id（同じ写真の重複保存の防止・問い合わせの手掛かり）
    line_message_id text NOT NULL,
    -- LINE の quoteToken。最終確認で店主が送った写真のメッセージそのものを引用し、公開する写真を取り違えない
    -- ために使う（公開の URL を作らずに済む）。秘密の値ではない。無い場合（外部の画像など）は NULL
    line_quote_token text,
    -- 置き場の中の名前（推測できない UUID）。URL ではない
    storage_key     text NOT NULL,
    -- 正規化の後の形式。v1 は JPEG だけを保存する
    content_type    text NOT NULL,
    width           integer NOT NULL,
    height          integer NOT NULL,
    byte_size       integer NOT NULL,
    sha256          text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ux_crosspost_media_draft UNIQUE (draft_id),
    CONSTRAINT ux_crosspost_media_storage_key UNIQUE (storage_key),
    CONSTRAINT ck_crosspost_media_content_type CHECK (content_type = 'image/jpeg'),
    CONSTRAINT ck_crosspost_media_dimensions CHECK (width > 0 AND height > 0 AND byte_size > 0),
    CONSTRAINT ck_crosspost_media_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_crosspost_media_quote_token CHECK (line_quote_token IS NULL OR char_length(line_quote_token) BETWEEN 1 AND 512)
);
-- 保存期間の削除（配信ジョブ・毎時）が古い写真の行を探す
CREATE INDEX ix_crosspost_media_created ON crosspost_media (created_at);

-- ============================================================
-- 投稿先ごとの状態（承認と同じトランザクションで作る・本文は承認の時点の写し）
-- ============================================================
-- 書込責任: TypeScript（line-webhook）
CREATE TABLE crosspost_deliveries (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    draft_id        uuid NOT NULL REFERENCES crosspost_drafts(id) ON DELETE CASCADE,
    destination     crosspost_destination NOT NULL,
    status          crosspost_delivery_status NOT NULL DEFAULT 'queued',
    body_text       text NOT NULL,
    -- 承認の時点で写真を付けたか。写真の行が後で消えても、写真付きで承認したことは残る
    with_media      boolean NOT NULL,
    media_id        uuid REFERENCES crosspost_media(id) ON DELETE SET NULL,
    attempt_count   integer NOT NULL DEFAULT 0,
    -- failed のときだけ意味を持つ。true = 投稿されていないことが確かで、もう一度送ってよい
    retryable       boolean NOT NULL DEFAULT false,
    failure_reason  text,
    unknown_reason  text,
    -- 外部 API の途中の到達点（例: Instagram の公開前のコンテナ ID）。秘密の値を入れない
    checkpoint      text,
    external_id     text,
    external_url    text,
    last_attempt_at timestamptz,
    finished_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ux_crosspost_deliveries_destination UNIQUE (draft_id, destination),
    CONSTRAINT ck_crosspost_deliveries_attempts CHECK (attempt_count BETWEEN 0 AND 10),
    CONSTRAINT ck_crosspost_deliveries_body_len CHECK (char_length(body_text) BETWEEN 1 AND 2200),
    CONSTRAINT ck_crosspost_deliveries_failure_reason CHECK (
        failure_reason IS NULL OR failure_reason IN (
            'not_ready', 'not_linked', 'token_invalid', 'permission_denied', 'rejected',
            'rate_limited', 'upstream_unavailable', 'media_unavailable', 'unsupported_content',
            'owner_reported_not_posted'
        )
    ),
    CONSTRAINT ck_crosspost_deliveries_unknown_reason CHECK (
        unknown_reason IS NULL OR unknown_reason IN (
            'timeout', 'network', 'upstream_5xx', 'adapter_threw', 'stale_in_progress'
        )
    ),
    -- 状態と付随する列の整合。failed は理由を、unknown は理由を必ず持ち、ほかの状態は持たない
    CONSTRAINT ck_crosspost_deliveries_state CHECK (
        ((status = 'failed') = (failure_reason IS NOT NULL))
        AND ((status = 'unknown') = (unknown_reason IS NOT NULL))
        AND (status = 'failed' OR retryable = false)
        AND ((status IN ('queued', 'in_progress')) = (finished_at IS NULL))
        AND (status = 'queued' OR last_attempt_at IS NOT NULL OR status = 'canceled')
    )
);

CREATE INDEX ix_crosspost_deliveries_status ON crosspost_deliveries (status);

COMMIT;
