-- 0015_structured_survey_foundation.sql
-- structured survey（Issue #436・PR 分割は #441 の PR1）: 飲食店向けの店舗別アンケート定義と、
-- 構造化回答の匿名集計の器を足す。PostgreSQL 15+ 互換。0014 適用後に実行する。
--
-- 構造（#435）:
--   Category ─┬─ category-wide Facet（例: 料理 → 味）
--             └─ Target（店舗が登録した料理名・ドリンク名）─ Target Facet（例: 料理 → 刺身盛り合わせ → 味）
--   ＋ Polarity（良かったところ / 気になったところ）
--
-- **既存の挙動を変えない。** 表を足すだけで、既存の表・列・制約・行に触れない。
--   - store_survey_configs へ既存店舗の行を入れない。行が無い店舗は legacy survey のまま
--     （structured_enabled の既定も false）。このファイルを適用しても、どの店舗も structured にならない。
--   - survey_aspects（legacy の観点・0002）には足さない。店舗固有の料理名を seed の固定カタログへ
--     混ぜない（#435「別レイヤーとして設計する」）。legacy の tallies の意味も変えない。
--
-- 戻し方（**手動復旧の参照手順。この migration の一部ではなく、適用時に実行されない**）:
-- この migration が足すのは下の 7 表だけで、既存の表はどれもこれらを参照しない（参照は新表 → 既存表の
-- 向きだけ）。リポジトリは down migration を持たないので、戻す必要が生じたときに運用者が判断して
-- 手で流す SQL をここに残す。**DROP は明示的なデータ破棄を伴う手動復旧であり、流すと店舗が登録した
-- Target・カテゴリ設定・設定行・構造化の集計がすべて失われる。**
-- 「structured_enabled = true の店舗が無いから安全」とは判断しない。structured_enabled = false の店舗にも
-- 設定行・カテゴリ設定・Target が残り得るし、集計の行は有効化を戻した後も残る。流す前に:
--   1. 新規 7 表それぞれの行の有無を確かめる（taxonomy 3 表は seed の行だけか、店舗設定 3 表と
--      構造化集計の表に行があるか）。
--   2. 店舗設定 3 表・構造化集計の表に行があれば、バックアップを取り、データを失うことの承認を得る。
--   3. 承認を得たうえで、下の SQL を手で流す。
-- 並びは参照する側 → される側（FK の依存順）:
--   -- 参照用。この migration では実行しない
--   -- DROP TABLE survey_structured_material_tallies;
--   -- DROP TABLE store_survey_targets;
--   -- DROP TABLE store_survey_category_settings;
--   -- DROP TABLE store_survey_configs;
--   -- DROP TABLE survey_category_facets;
--   -- DROP TABLE survey_facets;
--   -- DROP TABLE survey_categories;
--
-- 書込境界（db/write-boundary.md）:
--   - taxonomy 3 表（survey_categories / survey_facets / survey_category_facets）は seed が SoT で、
--     実行時はどの層も書かない（categories・survey_aspects と同じ扱い）。
--   - 店舗設定 3 表（store_survey_configs / store_survey_category_settings / store_survey_targets）は
--     TS リアルタイム応答層が書く。**どの SA に書かせるか（店舗オーナーの書込面）は #437 で決める。**
--     このファイルの時点ではどの SA にも DML を付与しない（infra/sql/grants.sql・
--     db/test/check_docs.sh の付与保留の宣言が機械強制する）。
--   - survey_structured_material_tallies は TS リアルタイム応答層（客向けアンケート Web）が加算する。
--
-- 匿名性: 個別回答を表す行・列を足さない。構造化集計表が持つのは店舗×月の **個数** と一言の **有無**
-- だけで、Target 名・自由記述本文・回答の識別子・時刻は持たない（db/test/assertions/30_compliance.sql の
-- 列 allowlist が機械強制する）。
-- ============================================================
BEGIN;

-- ============================================================
-- taxonomy（seed が SoT・実行時 read-only）
-- ============================================================

-- 大カテゴリ。allows_targets は「店舗が具体的な Target（料理名・ドリンク名）を登録できるか」。
-- (code, allows_targets) の一意制約は store_survey_targets からの複合 FK の参照先で、Target を
-- 持てないカテゴリへの Target の行を DB が拒否するためにある（code は単独でも一意）。
CREATE TABLE survey_categories (
    code               text PRIMARY KEY,
    label              text NOT NULL,
    allows_targets     boolean NOT NULL,
    default_enabled    boolean NOT NULL,
    default_sort_order smallint NOT NULL CHECK (default_sort_order >= 0),
    CONSTRAINT ux_survey_categories_code_targets UNIQUE (code, allows_targets)
);

-- 評価ポイント。極性を含まない中立の名称にする（良かった / 気になった の両方で同じ項目を使う・#435）。
CREATE TABLE survey_facets (
    code  text PRIMARY KEY,
    label text NOT NULL
);

-- Category と Facet の許可関係。scope = 'category' は「料理全体 → 味」、scope = 'target' は
-- 「刺身盛り合わせ → 味」。同じ facet が両方の scope に現れてよい（別の evidence として扱う・#435）。
-- MVP では店舗ごと・Target ごとの facet のカスタマイズを持たない（#436）。
CREATE TABLE survey_category_facets (
    category_code text NOT NULL REFERENCES survey_categories(code) ON DELETE RESTRICT,
    facet_code    text NOT NULL REFERENCES survey_facets(code) ON DELETE RESTRICT,
    scope         text NOT NULL CHECK (scope IN ('category', 'target')),
    sort_order    smallint NOT NULL CHECK (sort_order >= 0),
    PRIMARY KEY (category_code, facet_code, scope)
);

-- ============================================================
-- 店舗別の設定（TS リアルタイム応答層が書く・書込面は #437）
-- ============================================================

-- 店舗単位の設定のルート。**行が無い店舗・structured_enabled = false の店舗は legacy survey。**
-- revision は設定（カテゴリの表示・Target の追加・名称変更・非表示・並び替え）を変えるたびに、
-- その変更と同じトランザクションで +1 する（#437）。structured survey の pageToken へ表示時の値を
-- 署名し、送信時に一致しなければ古い画面の回答として受理しない（#436）。
CREATE TABLE store_survey_configs (
    store_id           uuid PRIMARY KEY REFERENCES stores(id) ON DELETE RESTRICT,
    structured_enabled boolean NOT NULL DEFAULT false,
    revision           bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

-- カテゴリの表示 / 非表示と並び順の店舗別 override。行の無いカテゴリは survey_categories の
-- default_enabled / default_sort_order を使う。親を store_survey_configs にするのは、override を
-- 持つ店舗には必ず revision の持ち主が在るようにするため。
CREATE TABLE store_survey_category_settings (
    store_id      uuid NOT NULL REFERENCES store_survey_configs(store_id) ON DELETE RESTRICT,
    category_code text NOT NULL REFERENCES survey_categories(code) ON DELETE RESTRICT,
    enabled       boolean NOT NULL,
    sort_order    smallint NOT NULL CHECK (sort_order >= 0),
    PRIMARY KEY (store_id, category_code)
);

-- 店舗自身が登録する料理名・ドリンク名。
--   - **identity は id（UUID）であって label ではない。** 名称を変えても id は変えない。客の回答・
--     pageToken・将来の集計は id で参照する。
--   - 非表示は active = false の soft delete。行を消すと、表示中の画面から送られた回答の id が
--     「存在しない」になり、名称の snapshot も取れなくなる。
--   - Target を持てるカテゴリ（allows_targets = true）以外へは作れない。category_allows_targets は
--     survey_categories(code, allows_targets) への複合 FK を成立させるためだけの **補助列** で、業務の
--     データではない（dashboard_users → agencies と同じ複合 FK による境界強制）。**生成列（常に true）に
--     しているので、呼び手は INSERT でも UPDATE でもこの列へ値を書けない**（true を明示しても拒否される）。
--     よって FK は常に (category_code, true) を参照し、Target を持てないカテゴリの行は FK が拒否する。
--     書込面（Issue #437）でこの列を入力に含めてはならない。
--   - 客の回答から自動登録しない（#436「customer input と store config を混同しない」）。
--   - label の責務分担: **DB は構造的に不正な文字列だけを拒否する**（前後の空白を持つ・空・改行を含む
--     制御文字を含む。どの上限値でも表示用の 1 行として成り立たないもの）。**プロダクト上の上限は
--     アプリが持つ**（#437: trim 後 1〜40 文字・料理 10 件・ドリンク 10 件を共有定数 1 箇所で）。
--     上限は利用テストで見直す運用値なので DB に書かない（0006 の aspect_count に上限を書かなかったのと
--     同じ理由。DB とアプリの 2 箇所に持つと片方だけ直す事故が起きる）。
--   - 同じ店舗・同じカテゴリに active な完全同名を作らない（部分一意インデックス）。非表示の行とは
--     重複してよい（非表示にした名前で作り直せる）。
CREATE TABLE store_survey_targets (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id                uuid NOT NULL REFERENCES store_survey_configs(store_id) ON DELETE RESTRICT,
    category_code           text NOT NULL,
    category_allows_targets boolean GENERATED ALWAYS AS (true) STORED,
    label                   text NOT NULL CHECK (
                                label = btrim(label)
                                AND char_length(label) >= 1
                                AND label !~ '[[:cntrl:]]'
                            ),
    active                  boolean NOT NULL DEFAULT true,
    sort_order              smallint NOT NULL CHECK (sort_order >= 0),
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_store_survey_targets_category
        FOREIGN KEY (category_code, category_allows_targets)
        REFERENCES survey_categories(code, allows_targets) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX ux_store_survey_targets_active_label
    ON store_survey_targets (store_id, category_code, label) WHERE active;

-- ============================================================
-- 構造化回答の素材の厚み（匿名集計・TS リアルタイム応答層が加算）
-- ============================================================

-- survey_material_tallies（legacy・0006/0008）の structured 版。legacy の表へ列を足して読み替えない
-- （#436「既存 tallies の意味を新しい構造へ無理に読み替えない」）。星の件数は survey_rating_tallies を
-- 共通に使う。
--   *_group_count  : 極性ごとの選択グループ数（Category 全体 1 つ・Target 1 つがそれぞれ 1 グループ）
--   *_target_count : そのうち Target を指すグループ数（グループは Category×Target で一意なので
--                    group_count を超えない）
--   *_facet_count  : 極性ごとの facet の選択数の合計
-- **Target 名・カテゴリ・facet の code・一言の本文・回答の識別子・時刻は持たない。** カテゴリ別・
-- Target 別の件数は MVP の要件ではない（#436）。持つのは厚みの分布を出すための個数だけである。
-- 個数の上限は書かない（0006 と同じく、taxonomy は seed で増えうる）。
CREATE TABLE survey_structured_material_tallies (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id              uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
    period_month          date NOT NULL CHECK (EXTRACT(DAY FROM period_month) = 1),
    positive_group_count  smallint NOT NULL CHECK (positive_group_count >= 0),
    concern_group_count   smallint NOT NULL CHECK (concern_group_count >= 0),
    positive_target_count smallint NOT NULL CHECK (positive_target_count >= 0),
    concern_target_count  smallint NOT NULL CHECK (concern_target_count >= 0),
    positive_facet_count  smallint NOT NULL CHECK (positive_facet_count >= 0),
    concern_facet_count   smallint NOT NULL CHECK (concern_facet_count >= 0),
    has_comment           boolean NOT NULL,
    count                 integer NOT NULL DEFAULT 0 CHECK (count >= 0),
    -- 3 つの CHECK は、検証済みの構造化回答（validateStructuredAnswer）から作れる厚みだけを受理する。
    -- 極性ごとに同じ式を課す。taxonomy に依存する上限（facet の最大数など）はここへ固定しない。
    --   (1) Target を指すグループはグループの一部である。
    --   (2) Target を指さないグループ（カテゴリ全体）は facet を 1 つ以上持つ。Target を指すグループは
    --       Target だけでよい（facet 0）。よって facet 数は「Target を指さないグループ数」以上になる。
    --   (3) グループが 0 なら Target も facet も 0（(2) だけでは group 0・facet 10 を拒めない）。
    CONSTRAINT ck_structured_material_targets_within_groups CHECK (
        positive_target_count <= positive_group_count
        AND concern_target_count <= concern_group_count
    ),
    CONSTRAINT ck_structured_material_facets_cover_groups CHECK (
        positive_facet_count >= positive_group_count - positive_target_count
        AND concern_facet_count >= concern_group_count - concern_target_count
    ),
    CONSTRAINT ck_structured_material_empty_polarity CHECK (
        (positive_group_count > 0 OR (positive_target_count = 0 AND positive_facet_count = 0))
        AND (concern_group_count > 0 OR (concern_target_count = 0 AND concern_facet_count = 0))
    ),
    CONSTRAINT ux_survey_structured_material UNIQUE (
        store_id, period_month,
        positive_group_count, concern_group_count,
        positive_target_count, concern_target_count,
        positive_facet_count, concern_facet_count,
        has_comment
    )
);

-- ============================================================
-- taxonomy の seed（#435 の確定事項・#436 の初期候補）。冪等（ON CONFLICT DO NOTHING・0002 と同じ）。
-- TS / Go のコード内に code の列挙を二重定義しない。客向けの定義は @fwlm/db の
-- readStoreSurveyDefinition がここから読む。
-- ============================================================

-- Target を持てるのは料理・ドリンクだけ（#436）。予約・来店は店舗側で非表示にできる前提（#435）だが、
-- 既定は表示にする（非表示は店舗の override で表す）。
INSERT INTO survey_categories (code, label, allows_targets, default_enabled, default_sort_order) VALUES
    ('food',              '料理',         true,  true, 10),
    ('drink',             'ドリンク',     true,  true, 20),
    ('service_delivery',  '接客・提供',   false, true, 30),
    ('atmosphere',        '店内・雰囲気', false, true, 40),
    ('price',             '価格',         false, true, 50),
    ('reservation_visit', '予約・来店',   false, true, 60)
ON CONFLICT (code) DO NOTHING;

INSERT INTO survey_facets (code, label) VALUES
    ('taste',                 '味'),
    ('volume',                '量'),
    ('variety',               '種類'),
    ('appearance',            '見た目'),
    ('temperature_condition', '温度・状態'),
    ('service_courtesy',      '接客の丁寧さ'),
    ('guidance',              '説明・案内'),
    ('ordering_response',     '注文時の対応'),
    ('serving',               '料理・ドリンクの提供'),
    ('checkout_response',     '会計時の対応'),
    ('ambience',              '店内の雰囲気'),
    ('cleanliness',           '清潔さ'),
    ('comfort',               '居心地'),
    ('seating',               '席'),
    ('noise_level',           '音・にぎやかさ'),
    ('food_price',            '料理の価格'),
    ('drink_price',           'ドリンクの価格'),
    ('value',                 'コスパ'),
    ('reservation_ease',      '予約のしやすさ'),
    ('entry_wait',            '入店までの待ち時間'),
    ('findability',           'お店の見つけやすさ')
ON CONFLICT (code) DO NOTHING;

-- 重複の整理（#435）: 料理の「提供の早さ」は接客・提供へ、ドリンクの価格は価格へ、注文・提供・会計は
-- 接客・提供へ寄せる。種類（variety）はメニュー全体についての評価なので category scope にだけ置く。
INSERT INTO survey_category_facets (category_code, facet_code, scope, sort_order) VALUES
    ('food',              'taste',                 'category', 10),
    ('food',              'volume',                'category', 20),
    ('food',              'variety',               'category', 30),
    ('food',              'appearance',            'category', 40),
    ('food',              'taste',                 'target',   10),
    ('food',              'volume',                'target',   20),
    ('food',              'appearance',            'target',   30),
    ('food',              'temperature_condition', 'target',   40),
    ('drink',             'taste',                 'category', 10),
    ('drink',             'variety',               'category', 20),
    ('drink',             'volume',                'category', 30),
    ('drink',             'taste',                 'target',   10),
    ('drink',             'volume',                'target',   20),
    ('drink',             'temperature_condition', 'target',   30),
    ('service_delivery',  'service_courtesy',      'category', 10),
    ('service_delivery',  'guidance',              'category', 20),
    ('service_delivery',  'ordering_response',     'category', 30),
    ('service_delivery',  'serving',               'category', 40),
    ('service_delivery',  'checkout_response',     'category', 50),
    ('atmosphere',        'ambience',              'category', 10),
    ('atmosphere',        'cleanliness',           'category', 20),
    ('atmosphere',        'comfort',               'category', 30),
    ('atmosphere',        'seating',               'category', 40),
    ('atmosphere',        'noise_level',           'category', 50),
    ('price',             'food_price',            'category', 10),
    ('price',             'drink_price',           'category', 20),
    ('price',             'value',                 'category', 30),
    ('reservation_visit', 'reservation_ease',      'category', 10),
    ('reservation_visit', 'entry_wait',            'category', 20),
    ('reservation_visit', 'findability',           'category', 30)
ON CONFLICT (category_code, facet_code, scope) DO NOTHING;

COMMIT;
