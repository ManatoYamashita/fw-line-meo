-- smoke 2.3: 店舗（1 owner:N stores / NULL place_id 併存 / 確定 place_id 重複は拒否）
BEGIN;
DO $$
DECLARE op uuid; ag uuid; ow uuid; s1 uuid; s2 uuid;
BEGIN
    INSERT INTO operators(name) VALUES ('op') RETURNING id INTO op;
    INSERT INTO agencies(operator_id, name) VALUES (op, 'ag') RETURNING id INTO ag;
    INSERT INTO owners(agency_id, line_user_id) VALUES (ag, 'U_smoke_23') RETURNING id INTO ow;

    INSERT INTO stores(owner_id, name) VALUES (ow, 's1') RETURNING id INTO s1;
    INSERT INTO stores(owner_id, name) VALUES (ow, 's2') RETURNING id INTO s2;
    RAISE NOTICE 'PASS 2.3a: 1 owner owns 2 stores (both NULL place_id coexist)';

    UPDATE stores SET place_id = 'PLACE_X', place_status = 'confirmed' WHERE id = s1;
    BEGIN
        UPDATE stores SET place_id = 'PLACE_X', place_status = 'confirmed' WHERE id = s2;
        RAISE EXCEPTION 'FAIL: duplicate confirmed place_id accepted';
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE 'PASS 2.3b: duplicate confirmed place_id rejected';
    END;
END $$;
ROLLBACK;
