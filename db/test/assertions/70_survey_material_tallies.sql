-- assertions 70: survey_material_tallies（素材の厚みの匿名カウンタ・Issue #137 段階3）
-- 各拒否は DO ブロック + EXCEPTION で捕捉。期待通り拒否されなければ FAIL を RAISE（非ゼロ終了）。
--
-- 本表は CHECK を 3 つ持つ（period_month の月初・aspect_count の非負・count の非負）。
-- どれか 1 つでも発火すれば check_violation になるため、**CONSTRAINT 名まで確認する**。
-- 名前を見ないと「別の CHECK が代わりに発火していた」ケースを取り違えたまま緑になる。
BEGIN;
DO $$
DECLARE op uuid; ag uuid; ow uuid; s uuid; cname text; n integer;
BEGIN
    INSERT INTO operators(name) VALUES ('op70') RETURNING id INTO op;
    INSERT INTO agencies(operator_id, name) VALUES (op, 'ag70') RETURNING id INTO ag;
    INSERT INTO owners(agency_id, line_user_id) VALUES (ag, 'U_a70') RETURNING id INTO ow;
    INSERT INTO stores(owner_id, name) VALUES (ow, 's70') RETURNING id INTO s;

    -- (a) FK 孤児拒否
    BEGIN
        INSERT INTO survey_material_tallies(store_id, period_month, aspect_count, has_comment, count)
            VALUES (gen_random_uuid(), DATE '2026-06-01', 0, false, 1);
        RAISE EXCEPTION 'FAIL(a): 存在しない store_id の行が受理された';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    RAISE NOTICE 'PASS 70a: orphan store_id rejected';

    -- (b) 自然キーの一意性（store_id, period_month, aspect_count, has_comment）
    INSERT INTO survey_material_tallies(store_id, period_month, aspect_count, has_comment, count)
        VALUES (s, DATE '2026-06-01', 2, true, 1);
    BEGIN
        INSERT INTO survey_material_tallies(store_id, period_month, aspect_count, has_comment, count)
            VALUES (s, DATE '2026-06-01', 2, true, 5);
        RAISE EXCEPTION 'FAIL(b): 同一 (store, period, aspect_count, has_comment) が二重登録された';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    RAISE NOTICE 'PASS 70b: ux_survey_material rejects duplicates';

    -- (c) has_comment は自然キーの一部。同じ観点数でも有無が違えば別の行として共存する
    --     （ここが分かれていないと「一言の記入率」が取り出せない＝本表を足す意味が消える）
    INSERT INTO survey_material_tallies(store_id, period_month, aspect_count, has_comment, count)
        VALUES (s, DATE '2026-06-01', 2, false, 3);
    SELECT count(*) INTO n FROM survey_material_tallies
        WHERE store_id = s AND period_month = DATE '2026-06-01' AND aspect_count = 2;
    IF n <> 2 THEN
        RAISE EXCEPTION 'FAIL(c): has_comment 違いが別行にならない（行数=%）', n;
    END IF;
    RAISE NOTICE 'PASS 70c: has_comment distinguishes rows within the same aspect_count';

    -- (d) period_month は月初のみ
    BEGIN
        INSERT INTO survey_material_tallies(store_id, period_month, aspect_count, has_comment, count)
            VALUES (s, DATE '2026-06-15', 0, false, 1);
        RAISE EXCEPTION 'FAIL(d): 月初以外の period_month が受理された';
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
        IF cname IS DISTINCT FROM 'survey_material_tallies_period_month_check' THEN
            RAISE EXCEPTION 'FAIL(d): 別の CHECK が発火した: %', cname;
        END IF;
    END;
    RAISE NOTICE 'PASS 70d: non-month-start period rejected by the period_month CHECK';

    -- (e) aspect_count は非負。**上限は意図的に持たない**（survey_aspects は seed が SoT で
    --     軸は増えうる。ここへ 6 を直書きすると軸追加時に集計だけが静かに欠ける）。
    BEGIN
        INSERT INTO survey_material_tallies(store_id, period_month, aspect_count, has_comment, count)
            VALUES (s, DATE '2026-07-01', -1, false, 1);
        RAISE EXCEPTION 'FAIL(e): 負の aspect_count が受理された';
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
        IF cname IS DISTINCT FROM 'survey_material_tallies_aspect_count_check' THEN
            RAISE EXCEPTION 'FAIL(e): 別の CHECK が発火した: %', cname;
        END IF;
    END;
    INSERT INTO survey_material_tallies(store_id, period_month, aspect_count, has_comment, count)
        VALUES (s, DATE '2026-07-01', 7, false, 1);
    RAISE NOTICE 'PASS 70e: aspect_count rejects negatives and accepts values above the current 6 aspects';

    -- (f) count は非負
    BEGIN
        INSERT INTO survey_material_tallies(store_id, period_month, aspect_count, has_comment, count)
            VALUES (s, DATE '2026-08-01', 0, false, -1);
        RAISE EXCEPTION 'FAIL(f): 負の count が受理された';
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
        IF cname IS DISTINCT FROM 'survey_material_tallies_count_check' THEN
            RAISE EXCEPTION 'FAIL(f): 別の CHECK が発火した: %', cname;
        END IF;
    END;
    RAISE NOTICE 'PASS 70f: negative count rejected by the count CHECK';

    -- (g) has_comment は NOT NULL（「不明」を作らない。有無しか持たないことが本表の前提）
    BEGIN
        INSERT INTO survey_material_tallies(store_id, period_month, aspect_count, has_comment, count)
            VALUES (s, DATE '2026-09-01', 0, NULL, 1);
        RAISE EXCEPTION 'FAIL(g): has_comment NULL が受理された';
    EXCEPTION WHEN not_null_violation THEN NULL;
    END;
    RAISE NOTICE 'PASS 70g: has_comment is NOT NULL';
END $$;
ROLLBACK;
