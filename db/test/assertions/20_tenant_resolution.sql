-- assertions 5.2: テナント分離・LINE 解決・日次サマリー取得
BEGIN;
DO $$
DECLARE op uuid; ag1 uuid; ag2 uuid; ow1 uuid; ow2 uuid; s1 uuid; s2a uuid; s2b uuid; c uuid; cnt int;
BEGIN
    INSERT INTO operators(name) VALUES ('op') RETURNING id INTO op;
    INSERT INTO agencies(operator_id, name) VALUES (op, 'A1') RETURNING id INTO ag1;
    INSERT INTO agencies(operator_id, name) VALUES (op, 'A2') RETURNING id INTO ag2;
    INSERT INTO owners(agency_id, line_user_id) VALUES (ag1, 'U1') RETURNING id INTO ow1;
    INSERT INTO owners(agency_id, line_user_id) VALUES (ag2, 'U2') RETURNING id INTO ow2;
    INSERT INTO stores(owner_id, name) VALUES (ow1, 's1')  RETURNING id INTO s1;
    INSERT INTO stores(owner_id, name) VALUES (ow2, 's2a') RETURNING id INTO s2a;
    INSERT INTO stores(owner_id, name) VALUES (ow2, 's2b') RETURNING id INTO s2b;  -- ow2 が 2 店舗（1:N）

    -- テナント分離: 代理店スコープは自配下のみ
    SELECT count(*) INTO cnt FROM stores st JOIN owners o ON o.id = st.owner_id WHERE o.agency_id = ag1;
    IF cnt <> 1 THEN RAISE EXCEPTION 'FAIL: A1 scope=% expected 1', cnt; END IF;
    SELECT count(*) INTO cnt FROM stores st JOIN owners o ON o.id = st.owner_id WHERE o.agency_id = ag2;
    IF cnt <> 2 THEN RAISE EXCEPTION 'FAIL: A2 scope=% expected 2', cnt; END IF;
    PERFORM 1 FROM stores st JOIN owners o ON o.id = st.owner_id
        WHERE o.agency_id = ag1 AND st.id IN (s2a, s2b);
    IF FOUND THEN RAISE EXCEPTION 'FAIL: A1 scope leaked A2 store'; END IF;
    -- 運営スコープは全件
    SELECT count(*) INTO cnt FROM stores st
        JOIN owners o ON o.id = st.owner_id
        JOIN agencies a ON a.id = o.agency_id
        WHERE a.operator_id = op;
    IF cnt <> 3 THEN RAISE EXCEPTION 'FAIL: operator scope=% expected 3', cnt; END IF;
    RAISE NOTICE 'PASS 5.2a: tenant isolation (agency scoped, operator all)';

    -- LINE 解決: line_user_id -> owner -> 所有店舗
    SELECT count(*) INTO cnt FROM stores st JOIN owners o ON o.id = st.owner_id WHERE o.line_user_id = 'U2';
    IF cnt <> 2 THEN RAISE EXCEPTION 'FAIL: U2 owns % stores expected 2', cnt; END IF;
    RAISE NOTICE 'PASS 5.2b: LINE userId resolves owner and owned stores';

    -- 日次サマリー: 自店+競合の最新・過去
    INSERT INTO competitors(store_id, place_id) VALUES (s1, 'CMP1') RETURNING id INTO c;
    INSERT INTO rating_snapshots(store_id, subject_kind, place_id, captured_on, rating, review_count, rank) VALUES
        (s1, 'self', 'SELF', DATE '2026-06-01', 4.0, 100, 1),
        (s1, 'self', 'SELF', DATE '2026-06-02', 4.1, 101, 1);
    INSERT INTO rating_snapshots(store_id, subject_kind, competitor_id, place_id, captured_on, rating, review_count, rank) VALUES
        (s1, 'competitor', c, 'CMP1', DATE '2026-06-01', 3.5, 50, 2),
        (s1, 'competitor', c, 'CMP1', DATE '2026-06-02', 3.6, 51, 2);
    SELECT count(*) INTO cnt FROM rating_snapshots WHERE store_id = s1 AND captured_on = DATE '2026-06-02';
    IF cnt <> 2 THEN RAISE EXCEPTION 'FAIL: latest day rows=% expected 2 (self+competitor)', cnt; END IF;
    SELECT count(*) INTO cnt FROM rating_snapshots WHERE store_id = s1;
    IF cnt <> 4 THEN RAISE EXCEPTION 'FAIL: history rows=% expected 4', cnt; END IF;
    PERFORM 1 FROM rating_snapshots WHERE store_id = s1 AND subject_kind = 'self'
        ORDER BY captured_on DESC LIMIT 1;
    RAISE NOTICE 'PASS 5.2c: daily summary latest + history (self + competitor)';
END $$;
ROLLBACK;
