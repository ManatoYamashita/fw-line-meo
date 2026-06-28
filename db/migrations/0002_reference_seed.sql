-- 0002_reference_seed.sql
-- 共有定数の単一情報源（SoT）。両言語（TS/Go）はこの code 値を参照し、コード内で二重定義しない。
-- 値は MVP スターターセット。追加はこのファイルへの追記のみで拡張する。
-- 0001 適用後に実行する。冪等（ON CONFLICT DO NOTHING）。

BEGIN;

-- 店舗ジャンル（stores.category_code の参照先）
INSERT INTO categories (code, label) VALUES
    ('ramen',    'ラーメン'),
    ('izakaya',  '居酒屋'),
    ('cafe',     'カフェ'),
    ('sushi',    '寿司'),
    ('yakiniku', '焼肉'),
    ('italian',  'イタリアン'),
    ('chinese',  '中華'),
    ('washoku',  '和食'),
    ('curry',    'カレー'),
    ('bakery',   'ベーカリー'),
    ('other',    'その他')
ON CONFLICT (code) DO NOTHING;

-- アンケート「良かった点」タップ選択肢（survey_aspect_tallies.aspect_code の参照先）
INSERT INTO survey_aspects (code, label) VALUES
    ('taste',       '味'),
    ('volume',      '量'),
    ('service',     '接客'),
    ('atmosphere',  '雰囲気'),
    ('price',       'コスパ'),
    ('cleanliness', '清潔さ')
ON CONFLICT (code) DO NOTHING;

COMMIT;
