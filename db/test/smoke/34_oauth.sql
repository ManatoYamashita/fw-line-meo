-- smoke 3.4: 将来 OAuth トークン格納枠（店舗単位 / (store,provider) 重複は拒否）
BEGIN;
DO $$
DECLARE op uuid; ag uuid; ow uuid; s uuid;
BEGIN
    INSERT INTO operators(name) VALUES ('op') RETURNING id INTO op;
    INSERT INTO agencies(operator_id, name) VALUES (op, 'ag') RETURNING id INTO ag;
    INSERT INTO owners(agency_id, line_user_id) VALUES (ag, 'U_smoke_34') RETURNING id INTO ow;
    INSERT INTO stores(owner_id, name) VALUES (ow, 's') RETURNING id INTO s;

    INSERT INTO oauth_tokens(store_id, provider, token_ref) VALUES (s, 'google', 'ref1');
    RAISE NOTICE 'PASS 3.4a: store-level oauth token slot';

    BEGIN
        INSERT INTO oauth_tokens(store_id, provider, token_ref) VALUES (s, 'google', 'ref2');
        RAISE EXCEPTION 'FAIL: duplicate (store,provider) accepted';
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE 'PASS 3.4b: duplicate (store,provider) rejected';
    END;
END $$;
ROLLBACK;
