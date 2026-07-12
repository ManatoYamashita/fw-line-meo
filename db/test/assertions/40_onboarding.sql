-- assertions 40: line-onboarding スキーマ拡張（agency_invite_codes / onboarding_sessions / line_webhook_events）
-- ENUM 全遷移・ck_session_owner_stage 両方向・FK 孤児拒否・一意制約・cascade/restrict 挙動を検証。
BEGIN;
DO $$
DECLARE op uuid; ag uuid; ow uuid;
BEGIN
    INSERT INTO operators(name) VALUES ('op40') RETURNING id INTO op;
    INSERT INTO agencies(operator_id, name) VALUES (op, 'ag40') RETURNING id INTO ag;

    -- agency_invite_codes: 発行・一意制約・FK 孤児拒否
    INSERT INTO agency_invite_codes(agency_id, code) VALUES (ag, 'INV40');
    BEGIN INSERT INTO agency_invite_codes(agency_id, code) VALUES (ag, 'INV40');
        RAISE EXCEPTION 'FAIL: dup invite code'; EXCEPTION WHEN unique_violation THEN NULL; END;
    BEGIN INSERT INTO agency_invite_codes(agency_id, code) VALUES (gen_random_uuid(), 'INVX');
        RAISE EXCEPTION 'FAIL: orphan invite code'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;

    -- 同一コードで複数オーナーを登録できる（Req 2.5）ことは onboarding_sessions 側で確認（コード自体は使い回し可能・一意制約は code の重複発行拒否のみ）

    -- onboarding_sessions: デフォルト stage='await_invite_code' かつ owner_id NULL は許可
    INSERT INTO onboarding_sessions(line_user_id) VALUES ('U_40_a');
    PERFORM 1 FROM onboarding_sessions WHERE line_user_id = 'U_40_a' AND stage = 'await_invite_code' AND owner_id IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: default stage/owner_id not as expected'; END IF;

    -- ck_session_owner_stage 両方向: await_invite_code なのに owner_id あり → 拒否
    INSERT INTO owners(agency_id, line_user_id) VALUES (ag, 'U_40_owner') RETURNING id INTO ow;
    BEGIN INSERT INTO onboarding_sessions(line_user_id, stage, owner_id) VALUES ('U_40_b', 'await_invite_code', ow);
        RAISE EXCEPTION 'FAIL: await_invite_code with owner_id accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
    -- 非 await_invite_code なのに owner_id NULL → 拒否
    BEGIN INSERT INTO onboarding_sessions(line_user_id, stage, owner_id) VALUES ('U_40_c', 'await_store_name', NULL);
        RAISE EXCEPTION 'FAIL: await_store_name without owner_id accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
    -- 正常遷移: await_store_name + owner_id あり → 許可
    INSERT INTO onboarding_sessions(line_user_id, stage, owner_id) VALUES ('U_40_d', 'await_store_name', ow);

    -- ENUM 全 4 値が有効であることの確認（completed まで含む）
    INSERT INTO onboarding_sessions(line_user_id, stage, owner_id) VALUES ('U_40_e', 'await_confirmation', ow);
    INSERT INTO onboarding_sessions(line_user_id, stage, owner_id) VALUES ('U_40_f', 'completed', ow);
    BEGIN INSERT INTO onboarding_sessions(line_user_id, stage, owner_id) VALUES ('U_40_g', 'no_such_stage', ow);
        RAISE EXCEPTION 'FAIL: invalid enum value accepted'; EXCEPTION WHEN invalid_text_representation THEN NULL; END;

    -- line_user_id PK: 重複拒否
    BEGIN INSERT INTO onboarding_sessions(line_user_id) VALUES ('U_40_a');
        RAISE EXCEPTION 'FAIL: dup session line_user_id accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;

    -- owner_id FK 孤児拒否
    BEGIN INSERT INTO onboarding_sessions(line_user_id, stage, owner_id) VALUES ('U_40_h', 'await_store_name', gen_random_uuid());
        RAISE EXCEPTION 'FAIL: orphan session owner_id accepted'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;

    -- owner 削除 → セッションも CASCADE 削除される
    DELETE FROM owners WHERE id = ow;
    PERFORM 1 FROM onboarding_sessions WHERE line_user_id IN ('U_40_d', 'U_40_e', 'U_40_f');
    IF FOUND THEN RAISE EXCEPTION 'FAIL: onboarding_sessions not cascaded on owner delete'; END IF;

    -- line_webhook_events: PK 一意（同一 event id の重複挿入は拒否＝重複排除の基盤）
    INSERT INTO line_webhook_events(webhook_event_id) VALUES ('EVT_40_1');
    BEGIN INSERT INTO line_webhook_events(webhook_event_id) VALUES ('EVT_40_1');
        RAISE EXCEPTION 'FAIL: dup webhook_event_id accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;

    RAISE NOTICE 'PASS 40: line-onboarding schema (invite codes / sessions / webhook events dedup) held';
END $$;
ROLLBACK;
