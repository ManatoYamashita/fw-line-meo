-- smoke 3.1: 競合（複数関連づけ / active 非活性化 / (store,place) 重複は拒否）
BEGIN;
DO $$
DECLARE op uuid; ag uuid; ow uuid; s uuid; c uuid;
BEGIN
    INSERT INTO operators(name) VALUES ('op') RETURNING id INTO op;
    INSERT INTO agencies(operator_id, name) VALUES (op, 'ag') RETURNING id INTO ag;
    INSERT INTO owners(agency_id, line_user_id) VALUES (ag, 'U_smoke_31') RETURNING id INTO ow;
    INSERT INTO stores(owner_id, name) VALUES (ow, 's') RETURNING id INTO s;

    INSERT INTO competitors(store_id, place_id, name) VALUES (s, 'CMP1', 'c1') RETURNING id INTO c;
    INSERT INTO competitors(store_id, place_id, name) VALUES (s, 'CMP2', 'c2');
    RAISE NOTICE 'PASS 3.1a: multiple competitors per store';

    UPDATE competitors SET active = false WHERE id = c;
    RAISE NOTICE 'PASS 3.1b: competitor deactivated (churn)';

    BEGIN
        INSERT INTO competitors(store_id, place_id, name) VALUES (s, 'CMP1', 'dup');
        RAISE EXCEPTION 'FAIL: duplicate (store,place) competitor accepted';
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE 'PASS 3.1c: duplicate (store,place) competitor rejected';
    END;
END $$;
ROLLBACK;
