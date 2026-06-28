-- assertions 5.1: スキーマ制約マトリクス（全 FK 孤児拒否 / 一意 / 部分一意 / CHECK 全分岐 / ドメイン CHECK）
-- 各拒否は DO ブロック + EXCEPTION で捕捉。期待通り拒否されなければ FAIL を RAISE（非ゼロ終了）。
BEGIN;
DO $$
DECLARE op uuid; ag uuid; ow uuid; s uuid; c uuid; op2 uuid; ag2 uuid; s2 uuid; cb uuid;
BEGIN
    INSERT INTO operators(name) VALUES ('op') RETURNING id INTO op;
    INSERT INTO agencies(operator_id, name) VALUES (op, 'ag') RETURNING id INTO ag;
    INSERT INTO owners(agency_id, line_user_id) VALUES (ag, 'U_c') RETURNING id INTO ow;
    INSERT INTO stores(owner_id, name) VALUES (ow, 's') RETURNING id INTO s;
    INSERT INTO competitors(store_id, place_id) VALUES (s, 'CMP1') RETURNING id INTO c;
    -- 別 operator 配下の agency / 別店舗とその競合（複合 FK テスト用）
    INSERT INTO operators(name) VALUES ('op2') RETURNING id INTO op2;
    INSERT INTO agencies(operator_id, name) VALUES (op2, 'ag2') RETURNING id INTO ag2;
    INSERT INTO stores(owner_id, name) VALUES (ow, 's2') RETURNING id INTO s2;
    INSERT INTO competitors(store_id, place_id) VALUES (s2, 'CMPB') RETURNING id INTO cb;

    -- FK 孤児拒否
    BEGIN INSERT INTO agencies(operator_id, name) VALUES (gen_random_uuid(), 'x');
        RAISE EXCEPTION 'FAIL: orphan agency'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
    BEGIN INSERT INTO owners(agency_id, line_user_id) VALUES (gen_random_uuid(), 'x');
        RAISE EXCEPTION 'FAIL: orphan owner'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
    BEGIN INSERT INTO stores(owner_id, name) VALUES (gen_random_uuid(), 'x');
        RAISE EXCEPTION 'FAIL: orphan store'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
    BEGIN INSERT INTO competitors(store_id, place_id) VALUES (gen_random_uuid(), 'x');
        RAISE EXCEPTION 'FAIL: orphan competitor'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
    BEGIN INSERT INTO rating_snapshots(store_id, subject_kind, place_id, captured_on)
            VALUES (gen_random_uuid(), 'self', 'x', DATE '2026-06-01');
        RAISE EXCEPTION 'FAIL: orphan snapshot'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
    BEGIN INSERT INTO survey_rating_tallies(store_id, period_month, star, count)
            VALUES (gen_random_uuid(), DATE '2026-06-01', 5, 1);
        RAISE EXCEPTION 'FAIL: orphan survey_rating'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
    BEGIN INSERT INTO survey_aspect_tallies(store_id, period_month, aspect_code, count)
            VALUES (gen_random_uuid(), DATE '2026-06-01', 'taste', 1);
        RAISE EXCEPTION 'FAIL: orphan survey_aspect'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
    BEGIN INSERT INTO oauth_tokens(store_id, provider, token_ref) VALUES (gen_random_uuid(), 'google', 'r');
        RAISE EXCEPTION 'FAIL: orphan oauth'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
    BEGIN INSERT INTO survey_aspect_tallies(store_id, period_month, aspect_code, count)
            VALUES (s, DATE '2026-06-01', 'NOPE', 1);
        RAISE EXCEPTION 'FAIL: bad aspect_code FK'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
    BEGIN INSERT INTO stores(owner_id, name, category_code) VALUES (ow, 'x', 'NOPE');
        RAISE EXCEPTION 'FAIL: bad category_code FK'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;

    -- 一意制約
    BEGIN INSERT INTO owners(agency_id, line_user_id) VALUES (ag, 'U_c');
        RAISE EXCEPTION 'FAIL: dup line_user_id'; EXCEPTION WHEN unique_violation THEN NULL; END;
    INSERT INTO dashboard_users(role, operator_id, auth_subject) VALUES ('operator', op, 'AS1');
    BEGIN INSERT INTO dashboard_users(role, operator_id, auth_subject) VALUES ('operator', op, 'AS1');
        RAISE EXCEPTION 'FAIL: dup auth_subject'; EXCEPTION WHEN unique_violation THEN NULL; END;
    BEGIN INSERT INTO competitors(store_id, place_id) VALUES (s, 'CMP1');
        RAISE EXCEPTION 'FAIL: dup (store,place) competitor'; EXCEPTION WHEN unique_violation THEN NULL; END;
    INSERT INTO oauth_tokens(store_id, provider, token_ref) VALUES (s, 'google', 'r1');
    BEGIN INSERT INTO oauth_tokens(store_id, provider, token_ref) VALUES (s, 'google', 'r2');
        RAISE EXCEPTION 'FAIL: dup (store,provider) oauth'; EXCEPTION WHEN unique_violation THEN NULL; END;

    -- place_id 部分一意（確定重複拒否 / NULL 併存）
    INSERT INTO stores(owner_id, name, place_id, place_status) VALUES (ow, 'sa', 'PX', 'confirmed');
    BEGIN INSERT INTO stores(owner_id, name, place_id, place_status) VALUES (ow, 'sb', 'PX', 'confirmed');
        RAISE EXCEPTION 'FAIL: dup confirmed place_id'; EXCEPTION WHEN unique_violation THEN NULL; END;
    INSERT INTO stores(owner_id, name) VALUES (ow, 'n1');
    INSERT INTO stores(owner_id, name) VALUES (ow, 'n2');  -- NULL place_id 併存 OK

    -- dashboard role/scope CHECK 両方向
    BEGIN INSERT INTO dashboard_users(role, operator_id, agency_id, auth_subject) VALUES ('operator', op, ag, 'ASx');
        RAISE EXCEPTION 'FAIL: operator+agency_id'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO dashboard_users(role, operator_id, auth_subject) VALUES ('agency', op, 'ASy');
        RAISE EXCEPTION 'FAIL: agency-without-agency_id'; EXCEPTION WHEN check_violation THEN NULL; END;

    -- snapshot subject CHECK 両方向
    BEGIN INSERT INTO rating_snapshots(store_id, subject_kind, competitor_id, place_id, captured_on)
            VALUES (s, 'self', c, 'x', DATE '2026-06-03');
        RAISE EXCEPTION 'FAIL: self-with-competitor'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO rating_snapshots(store_id, subject_kind, place_id, captured_on)
            VALUES (s, 'competitor', 'x', DATE '2026-06-03');
        RAISE EXCEPTION 'FAIL: competitor-without-competitor_id'; EXCEPTION WHEN check_violation THEN NULL; END;

    -- snapshot 部分一意（自店/競合それぞれ 1 日 1 行）
    INSERT INTO rating_snapshots(store_id, subject_kind, place_id, captured_on, rating, review_count, rank)
        VALUES (s, 'self', 'SP', DATE '2026-06-01', 4.0, 10, 1);
    BEGIN INSERT INTO rating_snapshots(store_id, subject_kind, place_id, captured_on, rating, review_count, rank)
            VALUES (s, 'self', 'SP', DATE '2026-06-01', 4.1, 11, 1);
        RAISE EXCEPTION 'FAIL: dup self snapshot'; EXCEPTION WHEN unique_violation THEN NULL; END;
    INSERT INTO rating_snapshots(store_id, subject_kind, competitor_id, place_id, captured_on, rating, review_count, rank)
        VALUES (s, 'competitor', c, 'CMP1', DATE '2026-06-01', 3.5, 5, 2);
    BEGIN INSERT INTO rating_snapshots(store_id, subject_kind, competitor_id, place_id, captured_on, rating, review_count, rank)
            VALUES (s, 'competitor', c, 'CMP1', DATE '2026-06-01', 3.6, 6, 2);
        RAISE EXCEPTION 'FAIL: dup competitor snapshot'; EXCEPTION WHEN unique_violation THEN NULL; END;

    -- survey 一意キー
    INSERT INTO survey_rating_tallies(store_id, period_month, star, count) VALUES (s, DATE '2026-06-01', 5, 1);
    BEGIN INSERT INTO survey_rating_tallies(store_id, period_month, star, count) VALUES (s, DATE '2026-06-01', 5, 2);
        RAISE EXCEPTION 'FAIL: dup survey_rating'; EXCEPTION WHEN unique_violation THEN NULL; END;
    INSERT INTO survey_aspect_tallies(store_id, period_month, aspect_code, count) VALUES (s, DATE '2026-06-01', 'taste', 1);
    BEGIN INSERT INTO survey_aspect_tallies(store_id, period_month, aspect_code, count) VALUES (s, DATE '2026-06-01', 'taste', 2);
        RAISE EXCEPTION 'FAIL: dup survey_aspect'; EXCEPTION WHEN unique_violation THEN NULL; END;

    -- ドメイン CHECK
    BEGIN INSERT INTO survey_rating_tallies(store_id, period_month, star, count) VALUES (s, DATE '2026-06-15', 4, 1);
        RAISE EXCEPTION 'FAIL: non-month-start period'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO rating_snapshots(store_id, subject_kind, place_id, captured_on, rating)
            VALUES (s, 'self', 'SP2', DATE '2026-07-01', 9.9);
        RAISE EXCEPTION 'FAIL: rating out of range'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO survey_rating_tallies(store_id, period_month, star, count) VALUES (s, DATE '2026-07-01', 6, 1);
        RAISE EXCEPTION 'FAIL: star out of range'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO survey_rating_tallies(store_id, period_month, star, count) VALUES (s, DATE '2026-07-01', 5, -1);
        RAISE EXCEPTION 'FAIL: negative count'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO rating_snapshots(store_id, subject_kind, place_id, captured_on, rank)
            VALUES (s, 'self', 'SP3', DATE '2026-08-01', 0);
        RAISE EXCEPTION 'FAIL: rank < 1'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO rating_snapshots(store_id, subject_kind, place_id, captured_on, review_count)
            VALUES (s, 'self', 'SP4', DATE '2026-09-01', -5);
        RAISE EXCEPTION 'FAIL: negative review_count'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO stores(owner_id, name, latitude) VALUES (ow, 'badlat', 95);
        RAISE EXCEPTION 'FAIL: latitude out of range'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO stores(owner_id, name, longitude) VALUES (ow, 'badlng', 200);
        RAISE EXCEPTION 'FAIL: longitude out of range'; EXCEPTION WHEN check_violation THEN NULL; END;

    -- 複合 FK: agency ロールに別 operator 配下の agency を紐付け → 拒否
    BEGIN INSERT INTO dashboard_users(role, operator_id, agency_id, auth_subject)
            VALUES ('agency', op, ag2, 'AS_xop');
        RAISE EXCEPTION 'FAIL: cross-operator agency accepted'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
    -- 複合 FK: 別店舗の競合を rating_snapshots に紐付け → 拒否
    BEGIN INSERT INTO rating_snapshots(store_id, subject_kind, competitor_id, place_id, captured_on)
            VALUES (s, 'competitor', cb, 'x', DATE '2026-10-01');
        RAISE EXCEPTION 'FAIL: cross-store competitor snapshot accepted'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;

    -- place CHECK: confirmed + place_id NULL → 拒否 / pending + place_id 付き → 拒否
    BEGIN INSERT INTO stores(owner_id, name, place_status) VALUES (ow, 'conf_null', 'confirmed');
        RAISE EXCEPTION 'FAIL: confirmed with NULL place_id'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO stores(owner_id, name, place_id, place_status) VALUES (ow, 'pend_pid', 'PP', 'pending');
        RAISE EXCEPTION 'FAIL: pending with place_id'; EXCEPTION WHEN check_violation THEN NULL; END;

    RAISE NOTICE 'PASS 5.1: full constraint matrix held (incl composite FKs and place CHECK)';
END $$;
ROLLBACK;
