-- assertions 1.1（gbp-post-review-reply）: gbp_locations / gbp_sessions / gbp_flow / gbp_stage
-- store 一意・owner 一意・FK 孤児拒否・ON DELETE CASCADE・enum 全値（'executing' 含む）・
-- 既定値（can_operate_local_post=true / payload='{}'）・NOT NULL を検証する。
-- 各拒否は DO ブロック + EXCEPTION で捕捉。期待通り拒否されなければ FAIL を RAISE（非ゼロ終了）。
BEGIN;
DO $$
DECLARE op uuid; ag uuid; ow uuid; ow2 uuid; s uuid; s2 uuid; sess uuid;
BEGIN
    INSERT INTO operators(name) VALUES ('op50') RETURNING id INTO op;
    INSERT INTO agencies(operator_id, name) VALUES (op, 'ag50') RETURNING id INTO ag;
    INSERT INTO owners(agency_id, line_user_id) VALUES (ag, 'U_50_a') RETURNING id INTO ow;
    INSERT INTO owners(agency_id, line_user_id) VALUES (ag, 'U_50_b') RETURNING id INTO ow2;
    INSERT INTO stores(owner_id, name) VALUES (ow, 's50_1') RETURNING id INTO s;
    INSERT INTO stores(owner_id, name) VALUES (ow, 's50_2') RETURNING id INTO s2;

    -- gbp_locations: FK 孤児拒否
    BEGIN INSERT INTO gbp_locations(store_id, account_name, location_name, place_id)
            VALUES (gen_random_uuid(), 'accounts/1', 'locations/1', 'P_orphan');
        RAISE EXCEPTION 'FAIL: orphan gbp_locations.store_id'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;

    -- gbp_locations: 正常系 + 既定値（can_operate_local_post=true / linked_at 自動設定）
    INSERT INTO gbp_locations(store_id, account_name, location_name, place_id)
        VALUES (s, 'accounts/111', 'locations/222', 'P_50_1');
    PERFORM 1 FROM gbp_locations
        WHERE store_id = s AND can_operate_local_post = true AND linked_at IS NOT NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: gbp_locations defaults not applied'; END IF;

    -- gbp_locations: account_name / location_name / place_id は NOT NULL
    BEGIN INSERT INTO gbp_locations(store_id, account_name, location_name, place_id)
            VALUES (s2, NULL, 'locations/9', 'P_50_x');
        RAISE EXCEPTION 'FAIL: NULL account_name accepted'; EXCEPTION WHEN not_null_violation THEN NULL; END;
    BEGIN INSERT INTO gbp_locations(store_id, account_name, location_name, place_id)
            VALUES (s2, 'accounts/9', NULL, 'P_50_x');
        RAISE EXCEPTION 'FAIL: NULL location_name accepted'; EXCEPTION WHEN not_null_violation THEN NULL; END;
    BEGIN INSERT INTO gbp_locations(store_id, account_name, location_name, place_id)
            VALUES (s2, 'accounts/9', 'locations/9', NULL);
        RAISE EXCEPTION 'FAIL: NULL place_id accepted'; EXCEPTION WHEN not_null_violation THEN NULL; END;

    -- gbp_locations: store_id 一意（1 店舗 1 連携。Req 1.7 の店舗単位独立の器）
    BEGIN INSERT INTO gbp_locations(store_id, account_name, location_name, place_id)
            VALUES (s, 'accounts/333', 'locations/444', 'P_50_dup');
        RAISE EXCEPTION 'FAIL: dup gbp_locations.store_id accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;

    -- gbp_locations: 別店舗の連携は独立して共存できる（Req 1.7）
    INSERT INTO gbp_locations(store_id, account_name, location_name, place_id, can_operate_local_post)
        VALUES (s2, 'accounts/555', 'locations/666', 'P_50_2', false);

    -- gbp_locations: store 削除で CASCADE、他店舗の行は非影響（Req 1.7）
    DELETE FROM stores WHERE id = s2;
    PERFORM 1 FROM gbp_locations WHERE store_id = s2;
    IF FOUND THEN RAISE EXCEPTION 'FAIL: gbp_locations not cascaded on store delete'; END IF;
    PERFORM 1 FROM gbp_locations WHERE store_id = s;
    IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: unrelated store link affected by other store delete'; END IF;

    RAISE NOTICE 'PASS 1.1a: gbp_locations FK/NOT NULL/unique(store)/defaults/cascade held';

    -- gbp_sessions: FK 孤児拒否（owner_id / store_id）
    BEGIN INSERT INTO gbp_sessions(owner_id, flow, stage, expires_at)
            VALUES (gen_random_uuid(), 'connect', 'await_callback', now() + interval '30 min');
        RAISE EXCEPTION 'FAIL: orphan gbp_sessions.owner_id'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
    BEGIN INSERT INTO gbp_sessions(owner_id, store_id, flow, stage, expires_at)
            VALUES (ow, gen_random_uuid(), 'post', 'await_input', now() + interval '30 min');
        RAISE EXCEPTION 'FAIL: orphan gbp_sessions.store_id'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;

    -- gbp_sessions: store_id NULL 許容（await_store 中）+ payload 既定値 '{}'
    INSERT INTO gbp_sessions(owner_id, flow, stage, expires_at)
        VALUES (ow, 'post', 'await_store', now() + interval '30 min') RETURNING id INTO sess;
    PERFORM 1 FROM gbp_sessions
        WHERE id = sess AND store_id IS NULL AND payload = '{}'::jsonb
          AND draft_text IS NULL AND updated_at IS NOT NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: gbp_sessions defaults/null store not as expected'; END IF;

    -- gbp_sessions: expires_at は NOT NULL（期限のないセッションを作れない）
    BEGIN INSERT INTO gbp_sessions(owner_id, flow, stage)
            VALUES (ow2, 'connect', 'await_callback');
        RAISE EXCEPTION 'FAIL: NULL expires_at accepted'; EXCEPTION WHEN not_null_violation THEN NULL; END;

    -- gbp_sessions: owner_id 一意（owner 単位に高々 1 セッション）
    BEGIN INSERT INTO gbp_sessions(owner_id, flow, stage, expires_at)
            VALUES (ow, 'reply', 'await_review_pick', now() + interval '30 min');
        RAISE EXCEPTION 'FAIL: dup gbp_sessions.owner_id accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;

    -- gbp_stage: 全 8 値が有効（CAS 排他用の 'executing' 含む）
    UPDATE gbp_sessions SET store_id = s, stage = 'await_callback' WHERE id = sess;
    UPDATE gbp_sessions SET stage = 'await_input'        WHERE id = sess;
    UPDATE gbp_sessions SET stage = 'await_review_pick'  WHERE id = sess;
    UPDATE gbp_sessions SET stage = 'await_overwrite_ok' WHERE id = sess;
    UPDATE gbp_sessions SET stage = 'await_decision'     WHERE id = sess;
    UPDATE gbp_sessions SET stage = 'await_revision'     WHERE id = sess;
    UPDATE gbp_sessions SET stage = 'executing'          WHERE id = sess;
    UPDATE gbp_sessions SET stage = 'await_store'        WHERE id = sess;
    BEGIN UPDATE gbp_sessions SET stage = 'no_such_stage' WHERE id = sess;
        RAISE EXCEPTION 'FAIL: invalid gbp_stage accepted'; EXCEPTION WHEN invalid_text_representation THEN NULL; END;

    -- gbp_flow: 全 3 値が有効・不正値は拒否
    UPDATE gbp_sessions SET flow = 'connect' WHERE id = sess;
    UPDATE gbp_sessions SET flow = 'post'    WHERE id = sess;
    UPDATE gbp_sessions SET flow = 'reply'   WHERE id = sess;
    BEGIN UPDATE gbp_sessions SET flow = 'no_such_flow' WHERE id = sess;
        RAISE EXCEPTION 'FAIL: invalid gbp_flow accepted'; EXCEPTION WHEN invalid_text_representation THEN NULL; END;

    -- gbp_sessions: store 削除で CASCADE（store_id 参照行ごと消える）
    UPDATE gbp_sessions SET store_id = s WHERE id = sess;
    DELETE FROM gbp_locations WHERE store_id = s;  -- store 削除の前提（CASCADE でも消えるが明示）
    DELETE FROM stores WHERE id = s;
    PERFORM 1 FROM gbp_sessions WHERE id = sess;
    IF FOUND THEN RAISE EXCEPTION 'FAIL: gbp_sessions not cascaded on store delete'; END IF;

    -- gbp_sessions: owner 削除で CASCADE
    INSERT INTO gbp_sessions(owner_id, flow, stage, expires_at)
        VALUES (ow2, 'connect', 'await_callback', now() + interval '30 min');
    DELETE FROM owners WHERE id = ow2;
    PERFORM 1 FROM gbp_sessions WHERE owner_id = ow2;
    IF FOUND THEN RAISE EXCEPTION 'FAIL: gbp_sessions not cascaded on owner delete'; END IF;

    RAISE NOTICE 'PASS 1.1b: gbp_sessions FK/unique(owner)/enum all values(executing incl.)/cascade held';
END $$;
ROLLBACK;
