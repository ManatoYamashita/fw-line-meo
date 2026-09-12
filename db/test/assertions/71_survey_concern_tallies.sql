-- assertions 71: survey_concern_tallies（気になった点の匿名カウンタ・Issue #221）
-- 各拒否は DO ブロック + EXCEPTION で捕捉。期待通り拒否されなければ FAIL を RAISE（非ゼロ終了）。
--
-- 本表は survey_aspect_tallies（良かった点）と同じ形のカウンタで、観点は同じ survey_aspects を
-- 参照する（良かった点と気になった点を同じ観点・同じ重みで尋ねる・Req 2.4）。
-- CHECK は 2 つ（period_month の月初・count の非負）あるので、CONSTRAINT 名まで確認する。
-- 名前を見ないと「別の CHECK が代わりに発火していた」ケースを取り違えたまま緑になる。
BEGIN;
DO $$
DECLARE op uuid; ag uuid; ow uuid; s uuid; cname text; n integer;
BEGIN
    INSERT INTO operators(name) VALUES ('op71') RETURNING id INTO op;
    INSERT INTO agencies(operator_id, name) VALUES (op, 'ag71') RETURNING id INTO ag;
    INSERT INTO owners(agency_id, line_user_id) VALUES (ag, 'U_a71') RETURNING id INTO ow;
    INSERT INTO stores(owner_id, name) VALUES (ow, 's71') RETURNING id INTO s;

    -- (a) FK 孤児拒否（store）
    BEGIN
        INSERT INTO survey_concern_tallies(store_id, period_month, aspect_code, count)
            VALUES (gen_random_uuid(), DATE '2026-06-01', 'taste', 1);
        RAISE EXCEPTION 'FAIL(a): 存在しない store_id の行が受理された';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    RAISE NOTICE 'PASS 71a: orphan store_id rejected';

    -- (b) 観点は seed（survey_aspects）の code のみ。コード内に選択肢を二重定義しない規律を
    --     FK が構造で担保する（write-boundary.md の共有定数の規律）。
    BEGIN
        INSERT INTO survey_concern_tallies(store_id, period_month, aspect_code, count)
            VALUES (s, DATE '2026-06-01', 'no_such_aspect', 1);
        RAISE EXCEPTION 'FAIL(b): survey_aspects に無い aspect_code が受理された';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    RAISE NOTICE 'PASS 71b: unknown aspect_code rejected by FK to survey_aspects';

    -- (c) 自然キーの一意性（store_id, period_month, aspect_code）
    INSERT INTO survey_concern_tallies(store_id, period_month, aspect_code, count)
        VALUES (s, DATE '2026-06-01', 'taste', 1);
    BEGIN
        INSERT INTO survey_concern_tallies(store_id, period_month, aspect_code, count)
            VALUES (s, DATE '2026-06-01', 'taste', 5);
        RAISE EXCEPTION 'FAIL(c): 同一 (store, period, aspect_code) が二重登録された';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    RAISE NOTICE 'PASS 71c: ux_survey_concern rejects duplicates';

    -- (d) 良かった点と気になった点は別の表で数える。同じ観点が両方にあっても互いを上書きしない
    --     （同じ表に混ぜると「良かった点別件数」の意味が壊れる・Req 5.2）。
    INSERT INTO survey_aspect_tallies(store_id, period_month, aspect_code, count)
        VALUES (s, DATE '2026-06-01', 'taste', 4);
    SELECT count INTO n FROM survey_concern_tallies
        WHERE store_id = s AND period_month = DATE '2026-06-01' AND aspect_code = 'taste';
    IF n <> 1 THEN
        RAISE EXCEPTION 'FAIL(d): 良かった点の加算が気になった点の件数を変えた（count=%）', n;
    END IF;
    RAISE NOTICE 'PASS 71d: concern tallies are independent of aspect tallies for the same aspect';

    -- (e) period_month は月初のみ
    BEGIN
        INSERT INTO survey_concern_tallies(store_id, period_month, aspect_code, count)
            VALUES (s, DATE '2026-06-15', 'volume', 1);
        RAISE EXCEPTION 'FAIL(e): 月初以外の period_month が受理された';
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
        IF cname IS DISTINCT FROM 'survey_concern_tallies_period_month_check' THEN
            RAISE EXCEPTION 'FAIL(e): 別の CHECK が発火した: %', cname;
        END IF;
    END;
    RAISE NOTICE 'PASS 71e: non-month-start period rejected by the period_month CHECK';

    -- (f) count は非負
    BEGIN
        INSERT INTO survey_concern_tallies(store_id, period_month, aspect_code, count)
            VALUES (s, DATE '2026-07-01', 'volume', -1);
        RAISE EXCEPTION 'FAIL(f): 負の count が受理された';
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
        IF cname IS DISTINCT FROM 'survey_concern_tallies_count_check' THEN
            RAISE EXCEPTION 'FAIL(f): 別の CHECK が発火した: %', cname;
        END IF;
    END;
    RAISE NOTICE 'PASS 71f: negative count rejected by the count CHECK';

    -- (g) 本番の書き込みと同じ UPSERT の形（ON CONFLICT で 1 加算）が成立する
    INSERT INTO survey_concern_tallies(store_id, period_month, aspect_code, count)
        VALUES (s, DATE '2026-06-01', 'taste', 1)
        ON CONFLICT (store_id, period_month, aspect_code)
        DO UPDATE SET count = survey_concern_tallies.count + 1;
    SELECT count INTO n FROM survey_concern_tallies
        WHERE store_id = s AND period_month = DATE '2026-06-01' AND aspect_code = 'taste';
    IF n <> 2 THEN RAISE EXCEPTION 'FAIL(g): UPSERT で加算されない（count=%）', n; END IF;
    RAISE NOTICE 'PASS 71g: ON CONFLICT increments the counter';
END $$;
ROLLBACK;
