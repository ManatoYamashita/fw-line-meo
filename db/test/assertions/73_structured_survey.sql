-- assertions 73: structured survey の taxonomy・店舗別設定・構造化の匿名集計（Issue #436・0015）
-- 各拒否は DO ブロック + EXCEPTION で捕捉。期待通り拒否されなければ FAIL を RAISE（非ゼロ終了）。
-- CHECK / FK が複数ある表は CONSTRAINT 名まで確認する（別の制約が代わりに発火したまま緑にしない）。
BEGIN;
DO $$
DECLARE
    op uuid; ag uuid; ow uuid; s uuid; s2 uuid; t uuid; t2 uuid;
    cname text; n integer; bad text; b boolean; r bigint;
BEGIN
    -- ========================================================
    -- taxonomy の seed（#435 の確定事項）
    -- ========================================================

    -- (a) カテゴリは 6 つ。Target を持てるのは料理・ドリンクだけ。
    SELECT string_agg(code || ':' || allows_targets::text, ',' ORDER BY default_sort_order) INTO bad
    FROM survey_categories;
    IF bad IS DISTINCT FROM
        'food:true,drink:true,service_delivery:false,atmosphere:false,price:false,reservation_visit:false' THEN
        RAISE EXCEPTION 'FAIL(a): survey_categories の seed が #435 と一致しない: %', bad;
    END IF;
    SELECT string_agg(label, ',' ORDER BY default_sort_order) INTO bad FROM survey_categories;
    IF bad IS DISTINCT FROM '料理,ドリンク,接客・提供,店内・雰囲気,価格,予約・来店' THEN
        RAISE EXCEPTION 'FAIL(a): survey_categories の label が #435 と一致しない: %', bad;
    END IF;
    IF EXISTS (SELECT 1 FROM survey_categories WHERE NOT default_enabled) THEN
        RAISE EXCEPTION 'FAIL(a): 既定で非表示のカテゴリがある（非表示は店舗の override で表す）';
    END IF;
    RAISE NOTICE 'PASS 73a: survey_categories seed (6 categories, targets only for food/drink)';

    -- (b) facet は #436 の 21 個。
    SELECT count(*) INTO n FROM survey_facets
    WHERE code IN (
        'taste','volume','variety','appearance','temperature_condition',
        'service_courtesy','guidance','ordering_response','serving','checkout_response',
        'ambience','cleanliness','comfort','seating','noise_level',
        'food_price','drink_price','value',
        'reservation_ease','entry_wait','findability');
    IF n <> 21 OR (SELECT count(*) FROM survey_facets) <> 21 THEN
        RAISE EXCEPTION 'FAIL(b): survey_facets の seed が #436 の 21 個と一致しない（一致 %）', n;
    END IF;
    IF (SELECT label FROM survey_facets WHERE code = 'serving') IS DISTINCT FROM '料理・ドリンクの提供'
       OR (SELECT label FROM survey_facets WHERE code = 'noise_level') IS DISTINCT FROM '音・にぎやかさ' THEN
        RAISE EXCEPTION 'FAIL(b): survey_facets の label が #435 と一致しない';
    END IF;
    RAISE NOTICE 'PASS 73b: survey_facets seed (21 neutral facets)';

    -- (c) Category × Facet × scope の許可関係（#435 のツリー）。
    SELECT string_agg(category_code || '/' || scope || '=' || facets, ' ' ORDER BY category_code, scope) INTO bad
    FROM (
        SELECT category_code, scope, string_agg(facet_code, ',' ORDER BY sort_order) AS facets
        FROM survey_category_facets GROUP BY category_code, scope
    ) g;
    IF bad IS DISTINCT FROM
        'atmosphere/category=ambience,cleanliness,comfort,seating,noise_level '
        'drink/category=taste,variety,volume '
        'drink/target=taste,volume,temperature_condition '
        'food/category=taste,volume,variety,appearance '
        'food/target=taste,volume,appearance,temperature_condition '
        'price/category=food_price,drink_price,value '
        'reservation_visit/category=reservation_ease,entry_wait,findability '
        'service_delivery/category=service_courtesy,guidance,ordering_response,serving,checkout_response' THEN
        RAISE EXCEPTION 'FAIL(c): survey_category_facets が #435 のツリーと一致しない: %', bad;
    END IF;
    IF (SELECT count(*) FROM survey_category_facets) <> 30 THEN
        RAISE EXCEPTION 'FAIL(c): survey_category_facets が 30 行でない（% 行）',
            (SELECT count(*) FROM survey_category_facets);
    END IF;
    RAISE NOTICE 'PASS 73c: category/facet mapping matches #435';

    -- (d) scope = 'target' の facet は Target を持てるカテゴリにだけある。
    SELECT string_agg(cf.category_code || '/' || cf.facet_code, ', ') INTO bad
    FROM survey_category_facets cf JOIN survey_categories c ON c.code = cf.category_code
    WHERE cf.scope = 'target' AND NOT c.allows_targets;
    IF bad IS NOT NULL THEN
        RAISE EXCEPTION 'FAIL(d): Target を持てないカテゴリに target scope の facet: %', bad;
    END IF;
    -- 全カテゴリに category scope の facet が 1 つ以上・全 facet がどこかで使われている。
    SELECT string_agg(code, ', ') INTO bad FROM survey_categories c
    WHERE NOT EXISTS (SELECT 1 FROM survey_category_facets cf
                      WHERE cf.category_code = c.code AND cf.scope = 'category');
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'FAIL(d): category scope の facet が無いカテゴリ: %', bad; END IF;
    SELECT string_agg(code, ', ') INTO bad FROM survey_facets f
    WHERE NOT EXISTS (SELECT 1 FROM survey_category_facets cf WHERE cf.facet_code = f.code);
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'FAIL(d): どのカテゴリにも割り当てられていない facet: %', bad; END IF;
    RAISE NOTICE 'PASS 73d: target-scope facets only under target-capable categories';

    -- (e) 許可関係は seed の code だけ（FK）・scope は 2 値（CHECK）。
    BEGIN
        INSERT INTO survey_category_facets VALUES ('food', 'no_such_facet', 'category', 99);
        RAISE EXCEPTION 'FAIL(e): survey_facets に無い facet_code が受理された';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO survey_category_facets VALUES ('food', 'taste', 'store', 99);
        RAISE EXCEPTION 'FAIL(e): category / target 以外の scope が受理された';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    RAISE NOTICE 'PASS 73e: mapping rows are constrained to seed codes and two scopes';

    -- (f) legacy survey の観点（survey_aspects・0002）は 0015 で変わっていない。
    SELECT string_agg(code || ':' || label, ',' ORDER BY code) INTO bad FROM survey_aspects;
    IF bad IS DISTINCT FROM 'atmosphere:雰囲気,cleanliness:清潔さ,price:コスパ,service:接客,taste:味,volume:量' THEN
        RAISE EXCEPTION 'FAIL(f): survey_aspects が変わった: %', bad;
    END IF;
    RAISE NOTICE 'PASS 73f: legacy survey_aspects unchanged';

    -- ========================================================
    -- 店舗別の設定
    -- ========================================================
    -- (g) どの店舗も structured になっていない（migration は既存店舗の設定行を作らない）。
    IF EXISTS (SELECT 1 FROM store_survey_configs WHERE structured_enabled) THEN
        RAISE EXCEPTION 'FAIL(g): structured_enabled = true の店舗がある（既存店舗は legacy のまま）';
    END IF;

    INSERT INTO operators(name) VALUES ('op73') RETURNING id INTO op;
    INSERT INTO agencies(operator_id, name) VALUES (op, 'ag73') RETURNING id INTO ag;
    INSERT INTO owners(agency_id, line_user_id) VALUES (ag, 'U_a73') RETURNING id INTO ow;
    INSERT INTO stores(owner_id, name) VALUES (ow, 's73') RETURNING id INTO s;
    INSERT INTO stores(owner_id, name) VALUES (ow, 's73b') RETURNING id INTO s2;

    -- 既定は legacy・revision 1。
    INSERT INTO store_survey_configs(store_id) VALUES (s) RETURNING structured_enabled, revision INTO b, r;
    IF b IS DISTINCT FROM false OR r IS DISTINCT FROM 1 THEN
        RAISE EXCEPTION 'FAIL(g): 設定行の既定が legacy / revision 1 でない（structured=%, revision=%）', b, r;
    END IF;
    BEGIN
        INSERT INTO store_survey_configs(store_id, revision) VALUES (s2, 0);
        RAISE EXCEPTION 'FAIL(g): revision 0 が受理された';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    RAISE NOTICE 'PASS 73g: no store is structured; config defaults to legacy with revision 1';

    -- (h) 設定行の無い店舗に override・Target を作れない（revision の持ち主が必ず在る）。
    BEGIN
        INSERT INTO store_survey_category_settings VALUES (s2, 'food', true, 1);
        RAISE EXCEPTION 'FAIL(h): 設定行の無い店舗に category override が作られた';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO store_survey_targets(store_id, category_code, label, sort_order)
            VALUES (s2, 'food', '刺身盛り合わせ', 0);
        RAISE EXCEPTION 'FAIL(h): 設定行の無い店舗に Target が作られた';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO store_survey_category_settings VALUES (s, 'no_such_category', true, 1);
        RAISE EXCEPTION 'FAIL(h): survey_categories に無いカテゴリの override が受理された';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    RAISE NOTICE 'PASS 73h: overrides and targets require a config row and a seed category';

    -- (i) Target は料理・ドリンクにだけ作れる（複合 FK）。
    BEGIN
        INSERT INTO store_survey_targets(store_id, category_code, label, sort_order)
            VALUES (s, 'service_delivery', '店長', 0);
        RAISE EXCEPTION 'FAIL(i): Target を持てないカテゴリに Target が作られた';
    EXCEPTION WHEN foreign_key_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
        IF cname IS DISTINCT FROM 'fk_store_survey_targets_category' THEN
            RAISE EXCEPTION 'FAIL(i): 別の FK が発火した: %', cname;
        END IF;
    END;
    -- 全カテゴリについて照合する: Target を持てない 4 カテゴリはすべて拒否、料理・ドリンクは受理。
    FOR bad, b IN SELECT code, allows_targets FROM survey_categories ORDER BY code LOOP
        BEGIN
            INSERT INTO store_survey_targets(store_id, category_code, label, sort_order)
                VALUES (s, bad, '対応確認用', 0);
            IF NOT b THEN
                RAISE EXCEPTION 'FAIL(i): Target を持てないカテゴリ % に Target が作られた', bad;
            END IF;
        EXCEPTION WHEN foreign_key_violation THEN
            IF b THEN RAISE EXCEPTION 'FAIL(i): Target を持てるカテゴリ % が拒否された', bad; END IF;
        END;
    END LOOP;
    DELETE FROM store_survey_targets WHERE store_id = s AND label = '対応確認用';
    -- 補助列は生成列（常に true）。呼び手は false はもちろん true を明示しても書けない。
    IF (SELECT is_generated || ':' || generation_expression FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'store_survey_targets'
          AND column_name = 'category_allows_targets') IS DISTINCT FROM 'ALWAYS:true' THEN
        RAISE EXCEPTION 'FAIL(i): category_allows_targets が常に true の生成列でない';
    END IF;
    FOREACH b IN ARRAY ARRAY[false, true] LOOP
        BEGIN
            INSERT INTO store_survey_targets(store_id, category_code, category_allows_targets, label, sort_order)
                VALUES (s, 'service_delivery', b, '店長', 0);
            RAISE EXCEPTION 'FAIL(i): category_allows_targets = % を呼び手が書けた', b;
        EXCEPTION WHEN generated_always THEN NULL;
        END;
    END LOOP;
    INSERT INTO store_survey_targets(store_id, category_code, label, sort_order)
        VALUES (s, 'food', '生成列確認用', 0) RETURNING id INTO t;
    BEGIN
        UPDATE store_survey_targets SET category_allows_targets = false WHERE id = t;
        RAISE EXCEPTION 'FAIL(i): category_allows_targets を UPDATE で false にできた';
    EXCEPTION WHEN generated_always THEN NULL;
    END;
    -- カテゴリを Target を持てないカテゴリへ付け替えることも FK が拒否する。
    BEGIN
        UPDATE store_survey_targets SET category_code = 'price' WHERE id = t;
        RAISE EXCEPTION 'FAIL(i): Target を持てないカテゴリへ付け替えられた';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    DELETE FROM store_survey_targets WHERE id = t;
    RAISE NOTICE 'PASS 73i: targets only for target-capable categories (composite FK + generated helper column)';

    -- (j) label は 1 行の表示用文字列（前後空白・空・改行・制御文字を拒否）。
    FOREACH bad IN ARRAY ARRAY[' 刺身', '刺身 ', '', E'刺身\n盛り合わせ', E'刺身\t盛り', E'刺身\r'] LOOP
        BEGIN
            INSERT INTO store_survey_targets(store_id, category_code, label, sort_order)
                VALUES (s, 'food', bad, 0);
            RAISE EXCEPTION 'FAIL(j): 不正な label が受理された: %', quote_literal(bad);
        EXCEPTION WHEN check_violation THEN
            GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
            IF cname IS DISTINCT FROM 'store_survey_targets_label_check' THEN
                RAISE EXCEPTION 'FAIL(j): 別の CHECK が発火した: %', cname;
            END IF;
        END;
    END LOOP;
    RAISE NOTICE 'PASS 73j: target label must be a single trimmed non-empty line';

    -- (k) identity は UUID。名称変更で id は変わらず、非表示は soft delete。
    INSERT INTO store_survey_targets(store_id, category_code, label, sort_order)
        VALUES (s, 'food', '刺身盛り合わせ', 0) RETURNING id INTO t;
    UPDATE store_survey_targets SET label = 'お刺身盛り合わせ' WHERE id = t;
    IF NOT EXISTS (SELECT 1 FROM store_survey_targets WHERE id = t AND label = 'お刺身盛り合わせ') THEN
        RAISE EXCEPTION 'FAIL(k): 名称変更で行の identity が変わった';
    END IF;
    -- 同じ店舗・カテゴリに active な完全同名は作れない。
    BEGIN
        INSERT INTO store_survey_targets(store_id, category_code, label, sort_order)
            VALUES (s, 'food', 'お刺身盛り合わせ', 1);
        RAISE EXCEPTION 'FAIL(k): active な同名 Target が二重登録された';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    -- 名称変更でも active な同名へは衝突する（rename は INSERT と同じ一意性に従う）。
    INSERT INTO store_survey_targets(store_id, category_code, label, sort_order)
        VALUES (s, 'food', '焼き鳥5種盛り', 1) RETURNING id INTO t2;
    BEGIN
        UPDATE store_survey_targets SET label = 'お刺身盛り合わせ' WHERE id = t2;
        RAISE EXCEPTION 'FAIL(k): 名称変更で active な同名 Target が生まれた';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    -- 別カテゴリ・別店舗なら同名でよい。
    INSERT INTO store_survey_configs(store_id) VALUES (s2);
    INSERT INTO store_survey_targets(store_id, category_code, label, sort_order)
        VALUES (s, 'drink', 'お刺身盛り合わせ', 0), (s2, 'food', 'お刺身盛り合わせ', 0);
    -- 非表示にした名前では作り直せる（非表示の行は残る）。
    UPDATE store_survey_targets SET active = false WHERE id = t;
    INSERT INTO store_survey_targets(store_id, category_code, label, sort_order)
        VALUES (s, 'food', 'お刺身盛り合わせ', 2) RETURNING id INTO t2;
    IF t2 = t OR NOT EXISTS (SELECT 1 FROM store_survey_targets WHERE id = t AND NOT active) THEN
        RAISE EXCEPTION 'FAIL(k): soft delete した行が残っていない、または id が再利用された';
    END IF;
    -- 同名が active なあいだは、非表示の旧行を表示へ戻せない（active な同名が 2 つになる）。
    BEGIN
        UPDATE store_survey_targets SET active = true WHERE id = t;
        RAISE EXCEPTION 'FAIL(k): 非表示の旧行を戻して active な同名 Target が生まれた';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    RAISE NOTICE 'PASS 73k: target identity is a stable UUID; active labels are unique per store/category';

    -- ========================================================
    -- 構造化の匿名集計
    -- ========================================================
    -- (l) Target を指すグループ数はグループ数を超えない。
    BEGIN
        INSERT INTO survey_structured_material_tallies(
            store_id, period_month, positive_group_count, concern_group_count,
            positive_target_count, concern_target_count, positive_facet_count, concern_facet_count,
            has_comment, count)
        VALUES (s, DATE '2026-10-01', 1, 0, 2, 0, 0, 0, false, 1);
        RAISE EXCEPTION 'FAIL(l): target_count > group_count が受理された';
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
        IF cname IS DISTINCT FROM 'ck_structured_material_targets_within_groups' THEN
            RAISE EXCEPTION 'FAIL(l): 別の CHECK が発火した: %', cname;
        END IF;
    END;
    -- (l2) 検証済みの回答から作れない厚みは拒否する（極性ごと・両方の極性で確かめる）。
    --      並びは (group, target, facet)。期待する制約名も照合する。
    FOR bad, cname IN
        SELECT * FROM (VALUES
            ('0,0,1', 'ck_structured_material_empty_polarity'),        -- グループ 0 なのに facet
            ('2,0,0', 'ck_structured_material_facets_cover_groups'),   -- カテゴリ全体のグループに facet が無い
            ('2,1,0', 'ck_structured_material_facets_cover_groups'),   -- Target を指さない 1 グループに facet が無い
            ('1,2,2', 'ck_structured_material_targets_within_groups')  -- Target を指すグループがグループ数を超える
        ) AS v(counts, constraint_name)
    LOOP
        FOR b IN SELECT unnest(ARRAY[true, false]) LOOP
            DECLARE
                g smallint := split_part(bad, ',', 1)::smallint;
                tg smallint := split_part(bad, ',', 2)::smallint;
                f smallint := split_part(bad, ',', 3)::smallint;
                got text;
            BEGIN
                BEGIN
                    INSERT INTO survey_structured_material_tallies(
                        store_id, period_month, positive_group_count, concern_group_count,
                        positive_target_count, concern_target_count, positive_facet_count, concern_facet_count,
                        has_comment, count)
                    VALUES (s, DATE '2026-09-01',
                            CASE WHEN b THEN g ELSE 0 END, CASE WHEN b THEN 0 ELSE g END,
                            CASE WHEN b THEN tg ELSE 0 END, CASE WHEN b THEN 0 ELSE tg END,
                            CASE WHEN b THEN f ELSE 0 END, CASE WHEN b THEN 0 ELSE f END,
                            false, 1);
                    RAISE EXCEPTION 'FAIL(l2): 作れない厚み (group,target,facet)=(%) が受理された（positive=%）', bad, b;
                EXCEPTION WHEN check_violation THEN
                    GET STACKED DIAGNOSTICS got = CONSTRAINT_NAME;
                    IF got IS DISTINCT FROM cname THEN
                        RAISE EXCEPTION 'FAIL(l2): (%) の拒否が想定外の CHECK: % （期待 %・positive=%）', bad, got, cname, b;
                    END IF;
                END;
            END;
        END LOOP;
    END LOOP;
    -- (l3) 検証済みの回答から作れる厚みは受理する（両方の極性で）。
    --   (0,0,0) 何も選ばない / (1,1,0) Target だけ / (1,0,1) カテゴリ全体の facet /
    --   (2,1,1) Target だけ ＋ カテゴリ全体の facet / (2,2,0) Target だけ ×2
    FOR bad IN SELECT unnest(ARRAY['0,0,0', '1,1,0', '1,0,1', '2,1,1', '2,2,0']) LOOP
        FOR b IN SELECT unnest(ARRAY[true, false]) LOOP
            DECLARE
                g smallint := split_part(bad, ',', 1)::smallint;
                tg smallint := split_part(bad, ',', 2)::smallint;
                f smallint := split_part(bad, ',', 3)::smallint;
            BEGIN
                INSERT INTO survey_structured_material_tallies(
                    store_id, period_month, positive_group_count, concern_group_count,
                    positive_target_count, concern_target_count, positive_facet_count, concern_facet_count,
                    has_comment, count)
                VALUES (s, DATE '2026-09-01',
                        CASE WHEN b THEN g ELSE 0 END, CASE WHEN b THEN 0 ELSE g END,
                        CASE WHEN b THEN tg ELSE 0 END, CASE WHEN b THEN 0 ELSE tg END,
                        CASE WHEN b THEN f ELSE 0 END, CASE WHEN b THEN 0 ELSE f END,
                        false, 1)
                ON CONFLICT ON CONSTRAINT ux_survey_structured_material DO NOTHING;
            EXCEPTION WHEN check_violation THEN
                RAISE EXCEPTION 'FAIL(l3): 作れる厚み (group,target,facet)=(%) が拒否された（positive=%）', bad, b;
            END;
        END LOOP;
    END LOOP;
    -- (m) period_month は月初・自然キーは一意。
    BEGIN
        INSERT INTO survey_structured_material_tallies(
            store_id, period_month, positive_group_count, concern_group_count,
            positive_target_count, concern_target_count, positive_facet_count, concern_facet_count,
            has_comment, count)
        VALUES (s, DATE '2026-10-15', 0, 0, 0, 0, 0, 0, false, 1);
        RAISE EXCEPTION 'FAIL(m): 月初以外の period_month が受理された';
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
        IF cname IS DISTINCT FROM 'survey_structured_material_tallies_period_month_check' THEN
            RAISE EXCEPTION 'FAIL(m): 別の CHECK が発火した: %', cname;
        END IF;
    END;
    INSERT INTO survey_structured_material_tallies(
        store_id, period_month, positive_group_count, concern_group_count,
        positive_target_count, concern_target_count, positive_facet_count, concern_facet_count,
        has_comment, count)
    VALUES (s, DATE '2026-10-01', 2, 1, 1, 1, 3, 0, true, 1);
    BEGIN
        INSERT INTO survey_structured_material_tallies(
            store_id, period_month, positive_group_count, concern_group_count,
            positive_target_count, concern_target_count, positive_facet_count, concern_facet_count,
            has_comment, count)
        VALUES (s, DATE '2026-10-01', 2, 1, 1, 1, 3, 0, true, 5);
        RAISE EXCEPTION 'FAIL(m): 同じ厚みの行が二重登録された';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    RAISE NOTICE 'PASS 73l/m: structured material tallies accept only counts a validated answer can produce';
END $$;
ROLLBACK;
