-- smoke 3.3: 匿名集計（顧客/個別回答テーブル不在 / カウンタ投入可 / period は月初）
BEGIN;
DO $$
DECLARE op uuid; ag uuid; ow uuid; s uuid;
BEGIN
    IF to_regclass('public.customers') IS NOT NULL
       OR to_regclass('public.survey_responses') IS NOT NULL
       OR to_regclass('public.responses') IS NOT NULL THEN
        RAISE EXCEPTION 'FAIL: an individual-response/customer table exists';
    END IF;
    RAISE NOTICE 'PASS 3.3a: no customer/individual-response table (structural anonymity)';

    INSERT INTO operators(name) VALUES ('op') RETURNING id INTO op;
    INSERT INTO agencies(operator_id, name) VALUES (op, 'ag') RETURNING id INTO ag;
    INSERT INTO owners(agency_id, line_user_id) VALUES (ag, 'U_smoke_33') RETURNING id INTO ow;
    INSERT INTO stores(owner_id, name) VALUES (ow, 's') RETURNING id INTO s;

    INSERT INTO survey_rating_tallies(store_id, period_month, star, count)
        VALUES (s, DATE '2026-06-01', 5, 3);
    INSERT INTO survey_aspect_tallies(store_id, period_month, aspect_code, count)
        VALUES (s, DATE '2026-06-01', 'taste', 3);
    RAISE NOTICE 'PASS 3.3b: anonymous tallies insertable';

    BEGIN
        INSERT INTO survey_rating_tallies(store_id, period_month, star, count)
            VALUES (s, DATE '2026-06-15', 5, 1);
        RAISE EXCEPTION 'FAIL: non-month-start period accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS 3.3c: non-month-start period rejected';
    END;
END $$;
ROLLBACK;
