-- smoke 2.4: ダッシュボード認証 + RBAC スコープ CHECK
BEGIN;
DO $$
DECLARE op uuid; ag uuid;
BEGIN
    INSERT INTO operators(name) VALUES ('op') RETURNING id INTO op;
    INSERT INTO agencies(operator_id, name) VALUES (op, 'ag') RETURNING id INTO ag;

    INSERT INTO dashboard_users(role, operator_id, auth_subject)
        VALUES ('operator', op, 'sub_op_24');
    INSERT INTO dashboard_users(role, operator_id, agency_id, auth_subject)
        VALUES ('agency', op, ag, 'sub_ag_24');
    RAISE NOTICE 'PASS 2.4a: valid operator/agency dashboard users created';

    BEGIN
        INSERT INTO dashboard_users(role, operator_id, agency_id, auth_subject)
            VALUES ('operator', op, ag, 'sub_bad1_24');
        RAISE EXCEPTION 'FAIL: operator with agency_id accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS 2.4b: operator+agency_id rejected';
    END;

    BEGIN
        INSERT INTO dashboard_users(role, operator_id, auth_subject)
            VALUES ('agency', op, 'sub_bad2_24');
        RAISE EXCEPTION 'FAIL: agency without agency_id accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS 2.4c: agency without agency_id rejected';
    END;
END $$;
ROLLBACK;
