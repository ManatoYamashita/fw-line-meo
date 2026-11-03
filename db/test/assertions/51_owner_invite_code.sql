-- assertions 51: オーナーの登録に用いられた招待コードの記録（owners.invite_code_id・migration 0017・Issue #486）
-- agency-dashboard Requirement 8 の構造保証を検証する。
--   8.2 … 結びつけるコードは、オーナーと同じ代理店のものに限る（複合 FK・(c)(g)）
--   8.3 … 記録が参照するコードは削除できず、無効化しても結びつきは変わらない（(d)(e)(f)）
--   8.4 … 記録の無いオーナー（0017 より前の登録）は NULL のまま存在できる（(a)）
-- 別代理店のコードの拒否は制約名まで確かめる。単独の FK（invite_code_id → agency_invite_codes(id)）では
-- 別代理店のコードが通ってしまうので、(c) はその取り違えを赤にする。
BEGIN;
DO $$
DECLARE
    op      uuid;
    ag_a    uuid;
    ag_b    uuid;
    code_a  uuid;
    code_b  uuid;
    ow      uuid;
    got     uuid;
    deltype "char";
    cname   text;
BEGIN
    -- フィクスチャ: 同じ運営の下に代理店 A・B と、それぞれの招待コード
    INSERT INTO operators(name) VALUES ('op51') RETURNING id INTO op;
    INSERT INTO agencies(operator_id, name) VALUES (op, 'ag51a') RETURNING id INTO ag_a;
    INSERT INTO agencies(operator_id, name) VALUES (op, 'ag51b') RETURNING id INTO ag_b;
    INSERT INTO agency_invite_codes(agency_id, code) VALUES (ag_a, 'A51CODE1') RETURNING id INTO code_a;
    INSERT INTO agency_invite_codes(agency_id, code) VALUES (ag_b, 'B51CODE1') RETURNING id INTO code_b;

    -- (a) 8.4: 記録の無いオーナーは invite_code_id が NULL のまま作れる（0017 より前の登録と同じ形）。
    INSERT INTO owners(agency_id, line_user_id) VALUES (ag_a, 'U51-legacy') RETURNING id INTO ow;
    SELECT invite_code_id INTO got FROM owners WHERE id = ow;
    IF got IS NOT NULL THEN
        RAISE EXCEPTION 'FAIL(a): 記録の無いオーナーの invite_code_id が NULL でない: %', got;
    END IF;
    RAISE NOTICE 'PASS 51a: invite_code_id が NULL のオーナーを作れる';

    -- (b) 同じ代理店のコードと結びつけて作れる。
    INSERT INTO owners(agency_id, line_user_id, invite_code_id)
        VALUES (ag_a, 'U51-same', code_a) RETURNING id INTO ow;
    SELECT invite_code_id INTO got FROM owners WHERE id = ow;
    IF got IS DISTINCT FROM code_a THEN
        RAISE EXCEPTION 'FAIL(b): 同じ代理店のコードの記録が保存されていない: %', got;
    END IF;
    RAISE NOTICE 'PASS 51b: 同じ代理店のコードと結びつけたオーナーを作れる';

    -- (c) 8.2: 別の代理店のコードとは結びつけられない（複合 FK が拒否する）。
    BEGIN
        INSERT INTO owners(agency_id, line_user_id, invite_code_id)
            VALUES (ag_a, 'U51-cross', code_b);
        RAISE EXCEPTION 'FAIL(c): 別の代理店のコードと結びついたオーナーが受理された';
    EXCEPTION WHEN foreign_key_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
        IF cname IS DISTINCT FROM 'fk_owners_invite_code_same_agency' THEN
            RAISE EXCEPTION 'FAIL(c): 別の制約が発火した: %', cname;
        END IF;
    END;
    RAISE NOTICE 'PASS 51c: 別の代理店のコードは fk_owners_invite_code_same_agency が拒否する';

    -- (g) 8.2: 記録のあるオーナーの所属代理店を、コードの代理店から外す変更も拒否される。
    BEGIN
        UPDATE owners SET agency_id = ag_b WHERE id = ow;
        RAISE EXCEPTION 'FAIL(g): コードの代理店と食い違う所属代理店への変更が受理された';
    EXCEPTION WHEN foreign_key_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
        IF cname IS DISTINCT FROM 'fk_owners_invite_code_same_agency' THEN
            RAISE EXCEPTION 'FAIL(g): 別の制約が発火した: %', cname;
        END IF;
    END;
    RAISE NOTICE 'PASS 51g: 所属代理店をコードの代理店から外す変更を拒否する';

    -- (d) 8.3: 記録が参照するコードは削除できない。
    BEGIN
        DELETE FROM agency_invite_codes WHERE id = code_a;
        RAISE EXCEPTION 'FAIL(d): 記録が参照するコードの削除が受理された';
    EXCEPTION WHEN foreign_key_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
        IF cname IS DISTINCT FROM 'fk_owners_invite_code_same_agency' THEN
            RAISE EXCEPTION 'FAIL(d): 別の制約が発火した: %', cname;
        END IF;
    END;
    RAISE NOTICE 'PASS 51d: 記録が参照するコードは削除できない';

    -- (e) 8.3: コードを無効化しても、オーナーとの結びつきは変わらない。
    UPDATE agency_invite_codes SET disabled_at = now() WHERE id = code_a;
    SELECT invite_code_id INTO got FROM owners WHERE id = ow;
    IF got IS DISTINCT FROM code_a THEN
        RAISE EXCEPTION 'FAIL(e): 無効化の後に結びつきが変わった: %', got;
    END IF;
    RAISE NOTICE 'PASS 51e: コードの無効化で結びつきは変わらない';

    -- (f) 8.3: 削除の拒否は RESTRICT で宣言されている（NO ACTION や CASCADE / SET NULL への取り違えを止める）。
    SELECT confdeltype INTO deltype FROM pg_constraint
        WHERE conname = 'fk_owners_invite_code_same_agency' AND conrelid = 'owners'::regclass;
    IF deltype IS DISTINCT FROM 'r' THEN
        RAISE EXCEPTION 'FAIL(f): fk_owners_invite_code_same_agency の ON DELETE が RESTRICT でない: %', deltype;
    END IF;
    RAISE NOTICE 'PASS 51f: fk_owners_invite_code_same_agency は ON DELETE RESTRICT';

    RAISE NOTICE 'PASS 51: owner invite code record (same-agency composite FK / nullable / restrict) held';
END $$;
ROLLBACK;
