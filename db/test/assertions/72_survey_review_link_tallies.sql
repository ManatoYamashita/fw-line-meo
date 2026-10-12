-- assertions 72: survey_review_link_tallies（投稿導線の押下件数の匿名カウンタ・Issue #401）
-- 各拒否は DO ブロック + EXCEPTION で捕捉。期待通り拒否されなければ FAIL を RAISE（非ゼロ終了）。
--
-- 本表は店舗×月の件数だけを持つ（Requirement 5.9）。token・時刻・端末を識別しうる列を持たないことは
-- 30_compliance.sql の列 allowlist が強制し、ここでは制約の振る舞いを固定する。
-- CHECK は 2 つ（period_month の月初・count の非負）あるので、CONSTRAINT 名まで確認する。
-- 名前を見ないと「別の CHECK が代わりに発火していた」ケースを取り違えたまま緑になる。
BEGIN;
DO $$
DECLARE op uuid; ag uuid; ow uuid; s uuid; s2 uuid; cname text; n integer;
BEGIN
    INSERT INTO operators(name) VALUES ('op72') RETURNING id INTO op;
    INSERT INTO agencies(operator_id, name) VALUES (op, 'ag72') RETURNING id INTO ag;
    INSERT INTO owners(agency_id, line_user_id) VALUES (ag, 'U_a72') RETURNING id INTO ow;
    INSERT INTO stores(owner_id, name) VALUES (ow, 's72') RETURNING id INTO s;
    INSERT INTO stores(owner_id, name) VALUES (ow, 's72b') RETURNING id INTO s2;

    -- (a) FK 孤児拒否（store）
    BEGIN
        INSERT INTO survey_review_link_tallies(store_id, period_month, count)
            VALUES (gen_random_uuid(), DATE '2026-09-01', 1);
        RAISE EXCEPTION 'FAIL(a): 存在しない store_id の行が受理された';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    RAISE NOTICE 'PASS 72a: orphan store_id rejected';

    -- (b) 自然キーの一意性（store_id, period_month）。店舗×月に 1 行だけ
    INSERT INTO survey_review_link_tallies(store_id, period_month, count)
        VALUES (s, DATE '2026-09-01', 1);
    BEGIN
        INSERT INTO survey_review_link_tallies(store_id, period_month, count)
            VALUES (s, DATE '2026-09-01', 5);
        RAISE EXCEPTION 'FAIL(b): 同一 (store, period) が二重登録された';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    RAISE NOTICE 'PASS 72b: ux_survey_review_link rejects duplicates';

    -- (c) 別の店舗・別の月は別の行（自然キーが店舗×月であって、それより粗くない）
    INSERT INTO survey_review_link_tallies(store_id, period_month, count)
        VALUES (s2, DATE '2026-09-01', 1), (s, DATE '2026-08-01', 1);
    SELECT count(*) INTO n FROM survey_review_link_tallies WHERE store_id IN (s, s2);
    IF n <> 3 THEN RAISE EXCEPTION 'FAIL(c): 店舗×月の行が 3 行にならない（rows=%）', n; END IF;
    RAISE NOTICE 'PASS 72c: rows are keyed by store and month';

    -- (d) period_month は月初のみ
    BEGIN
        INSERT INTO survey_review_link_tallies(store_id, period_month, count)
            VALUES (s, DATE '2026-09-15', 1);
        RAISE EXCEPTION 'FAIL(d): 月初以外の period_month が受理された';
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
        IF cname IS DISTINCT FROM 'survey_review_link_tallies_period_month_check' THEN
            RAISE EXCEPTION 'FAIL(d): 別の CHECK が発火した: %', cname;
        END IF;
    END;
    RAISE NOTICE 'PASS 72d: non-month-start period rejected by the period_month CHECK';

    -- (e) count は非負
    BEGIN
        INSERT INTO survey_review_link_tallies(store_id, period_month, count)
            VALUES (s, DATE '2026-07-01', -1);
        RAISE EXCEPTION 'FAIL(e): 負の count が受理された';
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
        IF cname IS DISTINCT FROM 'survey_review_link_tallies_count_check' THEN
            RAISE EXCEPTION 'FAIL(e): 別の CHECK が発火した: %', cname;
        END IF;
    END;
    RAISE NOTICE 'PASS 72e: negative count rejected by the count CHECK';

    -- (f) 本番の書き込みと同じ UPSERT の形（ON CONFLICT で 1 加算）が成立する
    INSERT INTO survey_review_link_tallies(store_id, period_month, count)
        VALUES (s, DATE '2026-09-01', 1)
        ON CONFLICT (store_id, period_month)
        DO UPDATE SET count = survey_review_link_tallies.count + 1;
    SELECT count INTO n FROM survey_review_link_tallies
        WHERE store_id = s AND period_month = DATE '2026-09-01';
    IF n <> 2 THEN RAISE EXCEPTION 'FAIL(f): UPSERT で加算されない（count=%）', n; END IF;
    RAISE NOTICE 'PASS 72f: ON CONFLICT increments the counter';
END $$;
ROLLBACK;
