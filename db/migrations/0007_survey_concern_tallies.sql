-- 0007_survey_concern_tallies.sql
-- review-acquisition（Issue #221）: 気になった点の匿名集計と、素材の厚みへの個数の追加。
--
-- 背景: アンケートは観点を「良かった点」でしか尋ねず、星 1〜2 の客にも肯定側の観点だけを
-- 選ばせていた。投稿導線を分岐させていなくても、素材の集め方が肯定側へ偏れば、否定的な
-- クチコミを書きにくくする作用は同じである（Google「Rating Manipulation」は販売者が否定的な
-- クチコミを抑えること・肯定的なものを選んで求めることを認めていない）。そこで全ての客に
-- 「気になった点」を良かった点と同じ観点で尋ねる（Requirement 2.2 / 2.4 / 2.11）。
--
-- 1. survey_concern_tallies（新設）
--    survey_aspect_tallies と同じ形のカウンタ。**極性は表で分ける。** 同じ表に極性の列を足す
--    形にしなかったのは、既存表の一意制約と UPSERT を変えずに済み、survey_aspect_tallies の
--    「良かった点別件数」（Requirement 5.2）という意味をそのまま保てるからである。観点は同じ
--    survey_aspects を参照する（コード内に選択肢を二重定義しない・write-boundary.md）。
--
-- 2. survey_material_tallies.concern_count（追加）と一意制約の張り替え
--    素材の厚みは「観点ゼロの回答が何割か」を出すための指標（Issue #137 段階3）。気になった点
--    だけを選んだ回答を観点ゼロと同じ行に数えると分布が壊れるので、気になった点の個数を
--    自然キーへ加える（Requirement 5.6）。既存行は 0 になる（改訂前は尋ねていなかったので正しい）。
--
-- **適用からデプロイ完了までの間、旧コードの集計は失敗する。** 旧コードの UPSERT は
-- `ON CONFLICT (store_id, period_month, aspect_count, has_comment)` と旧制約の列を名指ししており、
-- 張り替え後は一致する一意制約が無くなる。rating / aspect と同一トランザクションなので、その回答の
-- 集計は丸ごとロールバックされる（客の体験は Requirement 5.4 で守られる）。本番は
-- 0007 → infra/sql/grants.sql → マージの順で、適用はマージ直前に行う。
--
-- 匿名性: 追加するのは固定のカウンタ列だけで、本文を持つ列は無い。
-- db/test/assertions/30_compliance.sql の列 allowlist と 71 / 70 が機械強制する。
-- ============================================================
-- 書込責任: TypeScript（write-boundary.md へ追記必須）
BEGIN;

CREATE TABLE survey_concern_tallies (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id     uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
    period_month date NOT NULL CHECK (EXTRACT(DAY FROM period_month) = 1),
    aspect_code  text NOT NULL REFERENCES survey_aspects(code) ON DELETE RESTRICT,
    count        integer NOT NULL DEFAULT 0 CHECK (count >= 0),
    CONSTRAINT ux_survey_concern UNIQUE (store_id, period_month, aspect_code)
);

-- 既定の 0 は既存行のためにある（改訂前は気になった点を尋ねていない）。上限は書かない:
-- aspect_count と同じく survey_aspects は seed が単一情報源で軸は増えうる。
ALTER TABLE survey_material_tallies
    ADD COLUMN concern_count smallint NOT NULL DEFAULT 0 CHECK (concern_count >= 0);

ALTER TABLE survey_material_tallies
    DROP CONSTRAINT ux_survey_material,
    ADD CONSTRAINT ux_survey_material
        UNIQUE (store_id, period_month, aspect_count, concern_count, has_comment);

COMMIT;
