-- 0006_survey_material_tallies.sql
-- review-acquisition: アンケート回答の「素材の厚み」を匿名のまま月次集計する（Issue #137 段階3）
-- PostgreSQL 15+ 互換。すべて追加のみ（既存テーブル/カラムの変更・削除なし）。
-- 書き込み境界は db/write-boundary.md を参照。0005 適用後に実行する。

BEGIN;

-- ============================================================
-- 素材の厚み（観点の選択数 × 一言の有無）の匿名カウンタ。
--
-- なぜ必要か: AI 下書きの事実性の逸脱は「素材が薄いとき」に起きる（Issue #132 の実測。
-- 具体的な一言がある素材は 40 サンプル中 0 件）。入力導線を変えるのが構造的な是正だが、
-- 現状は「観点ゼロの回答が何件あるか」「一言の記入率」のどちらも分からない。
-- survey_aspect_tallies は延べ数しか持たないため、1 人が 3 個選んだのか 3 人が 1 個ずつ
-- 選んだのかを区別できない。導線を変えた前後を比較する土台がないまま Requirement 2
-- （匿名・低摩擦）を削るのは、効果も害も測れない変更になる。
--
-- 匿名性: 保持するのは選択の **個数** と一言の **有無** だけで、本文は列として存在しない
-- （Requirement 5.1/5.3）。既存 tallies と同じく created_at も持たない（時刻を残さない）。
-- この構造は db/test/assertions/30_compliance.sql の列 allowlist と
-- db/test/smoke/35_survey_material.sql の文字列列チェックが機械強制する。実行主体は
-- ts-ci の `db/test スイート` ステップ（scripts/run-db-test-suites.sh・Issue #156）である。
-- **#156 以前はその実行主体が存在せず、この行は書かれた時点から偽だった**（どのワークフローも
-- db/test を呼んでおらず、comment_body 列を足す migration は CI を全緑のまま通過しえた）。
-- ============================================================
-- 書込責任: TypeScript（write-boundary.md へ追記必須）
CREATE TABLE survey_material_tallies (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id     uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
    period_month date NOT NULL CHECK (EXTRACT(DAY FROM period_month) = 1),
    -- 選択された観点の数（同一回答内の重複は除去済み）。上限は書かない: survey_aspects は
    -- seed が単一情報源で軸は増えうる（write-boundary.md の共有定数の規律）。ここへ 6 を
    -- 直書きすると軸追加時に INSERT が落ち、しかも呼び手が tally_failed で握り潰すため
    -- 集計だけが静かに欠ける。入力の健全性はアプリ側（許可 code のみ受理）で担保する。
    aspect_count smallint NOT NULL CHECK (aspect_count >= 0),
    -- 一言が入力されたかどうかのみ。本文は保持しない。
    has_comment  boolean NOT NULL,
    count        integer NOT NULL DEFAULT 0 CHECK (count >= 0),
    CONSTRAINT ux_survey_material UNIQUE (store_id, period_month, aspect_count, has_comment)
);

COMMIT;

-- RED 対照 1（**マージ禁止**・Issue #156 の完了条件のための一時コミット）:
-- 「一言の本文を保存する列」を注入する。30_compliance.sql の列 allowlist と
-- smoke/35 の文字列列チェックの**両方**が発火することを CI 上で確かめる。
ALTER TABLE survey_material_tallies ADD COLUMN comment_body text;
