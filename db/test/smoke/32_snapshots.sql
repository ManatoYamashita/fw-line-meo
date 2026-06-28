-- smoke 3.2: 評価・順位の時系列（自店+競合 / 同日 self 二重は拒否 / subject CHECK）
BEGIN;
DO $$
DECLARE op uuid; ag uuid; ow uuid; s uuid; c uuid;
BEGIN
    INSERT INTO operators(name) VALUES ('op') RETURNING id INTO op;
    INSERT INTO agencies(operator_id, name) VALUES (op, 'ag') RETURNING id INTO ag;
    INSERT INTO owners(agency_id, line_user_id) VALUES (ag, 'U_smoke_32') RETURNING id INTO ow;
    INSERT INTO stores(owner_id, name) VALUES (ow, 's') RETURNING id INTO s;
    INSERT INTO competitors(store_id, place_id) VALUES (s, 'CMP1') RETURNING id INTO c;

    INSERT INTO rating_snapshots(store_id, subject_kind, place_id, captured_on, rating, review_count, rank)
        VALUES (s, 'self', 'SELFPLACE', DATE '2026-06-01', 4.2, 100, 1);
    INSERT INTO rating_snapshots(store_id, subject_kind, competitor_id, place_id, captured_on, rating, review_count, rank)
        VALUES (s, 'competitor', c, 'CMP1', DATE '2026-06-01', 3.8, 50, 2);
    RAISE NOTICE 'PASS 3.2a: self + competitor snapshots for a day';

    BEGIN
        INSERT INTO rating_snapshots(store_id, subject_kind, place_id, captured_on, rating, review_count, rank)
            VALUES (s, 'self', 'SELFPLACE', DATE '2026-06-01', 4.3, 101, 1);
        RAISE EXCEPTION 'FAIL: duplicate self snapshot for the day accepted';
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE 'PASS 3.2b: duplicate self snapshot rejected';
    END;

    BEGIN
        INSERT INTO rating_snapshots(store_id, subject_kind, competitor_id, place_id, captured_on)
            VALUES (s, 'self', c, 'X', DATE '2026-06-02');
        RAISE EXCEPTION 'FAIL: self-with-competitor_id accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS 3.2c: self-with-competitor_id rejected';
    END;
END $$;
ROLLBACK;
