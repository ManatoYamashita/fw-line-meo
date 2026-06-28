-- smoke 2.1: 階層・リネージ（operator->agency 作成可 / 孤児 agency は拒否）
BEGIN;
DO $$
DECLARE op uuid; ag uuid;
BEGIN
    INSERT INTO operators(name) VALUES ('op') RETURNING id INTO op;
    INSERT INTO agencies(operator_id, name) VALUES (op, 'ag') RETURNING id INTO ag;
    RAISE NOTICE 'PASS 2.1a: operator->agency created';

    BEGIN
        INSERT INTO agencies(operator_id, name) VALUES (gen_random_uuid(), 'orphan');
        RAISE EXCEPTION 'FAIL: orphan agency accepted';
    EXCEPTION WHEN foreign_key_violation THEN
        RAISE NOTICE 'PASS 2.1b: orphan agency rejected';
    END;
END $$;
ROLLBACK;
