-- smoke 2.2: オーナーと LINE 識別子（解決可 / line_user_id 重複は拒否）
BEGIN;
DO $$
DECLARE op uuid; ag uuid; ow uuid;
BEGIN
    INSERT INTO operators(name) VALUES ('op') RETURNING id INTO op;
    INSERT INTO agencies(operator_id, name) VALUES (op, 'ag') RETURNING id INTO ag;
    INSERT INTO owners(agency_id, line_user_id) VALUES (ag, 'U_smoke_22') RETURNING id INTO ow;

    PERFORM 1 FROM owners WHERE line_user_id = 'U_smoke_22';
    IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: owner not resolvable by line_user_id'; END IF;
    RAISE NOTICE 'PASS 2.2a: owner resolvable by line_user_id';

    BEGIN
        INSERT INTO owners(agency_id, line_user_id) VALUES (ag, 'U_smoke_22');
        RAISE EXCEPTION 'FAIL: duplicate line_user_id accepted';
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE 'PASS 2.2b: duplicate line_user_id rejected';
    END;
END $$;
ROLLBACK;
