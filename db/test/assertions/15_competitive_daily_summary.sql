-- assertions 1.1（competitive-daily-summary）: daily_summaries / summary_deliveries / owners.delivery_hour
-- FK 孤児拒否・store×日付 一意制約・status ドメイン CHECK（両テーブル）・delivery_hour 範囲 CHECK（境界含む）を検証する。
-- 各拒否は DO ブロック + EXCEPTION で捕捉。期待通り拒否されなければ FAIL を RAISE（非ゼロ終了）。
BEGIN;
DO $$
DECLARE op uuid; ag uuid; ow uuid; s uuid; rk uuid;
BEGIN
    INSERT INTO operators(name) VALUES ('op') RETURNING id INTO op;
    INSERT INTO agencies(operator_id, name) VALUES (op, 'ag') RETURNING id INTO ag;
    INSERT INTO owners(agency_id, line_user_id) VALUES (ag, 'U_cds') RETURNING id INTO ow;
    INSERT INTO stores(owner_id, name) VALUES (ow, 's') RETURNING id INTO s;
    rk := gen_random_uuid();

    -- FK 孤児拒否: daily_summaries.store_id / summary_deliveries.store_id
    BEGIN INSERT INTO daily_summaries(store_id, summary_date, status)
            VALUES (gen_random_uuid(), DATE '2026-06-01', 'ready');
        RAISE EXCEPTION 'FAIL: orphan daily_summaries.store_id'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
    BEGIN INSERT INTO summary_deliveries(store_id, summary_date, line_user_id, status, retry_key)
            VALUES (gen_random_uuid(), DATE '2026-06-01', 'U_cds', 'delivered', rk);
        RAISE EXCEPTION 'FAIL: orphan summary_deliveries.store_id'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;

    -- daily_summaries: 正常系 + status ドメイン CHECK 両分岐
    INSERT INTO daily_summaries(store_id, summary_date, status, rank, rank_total, rating, review_count)
        VALUES (s, DATE '2026-06-01', 'ready', 1, 3, 4.2, 100);
    INSERT INTO daily_summaries(store_id, summary_date, status)
        VALUES (s, DATE '2026-06-02', 'no_competitors');
    INSERT INTO daily_summaries(store_id, summary_date, status)
        VALUES (s, DATE '2026-06-03', 'failed');
    BEGIN INSERT INTO daily_summaries(store_id, summary_date, status)
            VALUES (s, DATE '2026-06-04', 'bogus');
        RAISE EXCEPTION 'FAIL: daily_summaries.status accepted invalid value'; EXCEPTION WHEN check_violation THEN NULL; END;

    -- daily_summaries: 既定値（new_review_count=0, new_reviews/competitors='[]'）
    PERFORM 1 FROM daily_summaries
        WHERE store_id = s AND summary_date = DATE '2026-06-02'
          AND new_review_count = 0 AND new_reviews = '[]'::jsonb AND competitors = '[]'::jsonb;
    IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: daily_summaries defaults not applied'; END IF;

    -- daily_summaries: store×summary_date 一意
    BEGIN INSERT INTO daily_summaries(store_id, summary_date, status)
            VALUES (s, DATE '2026-06-01', 'ready');
        RAISE EXCEPTION 'FAIL: dup (store,summary_date) daily_summaries'; EXCEPTION WHEN unique_violation THEN NULL; END;

    RAISE NOTICE 'PASS 1.1a: daily_summaries FK/status CHECK/defaults/unique held';

    -- summary_deliveries: 正常系 + status ドメイン CHECK 全分岐
    INSERT INTO summary_deliveries(store_id, summary_date, line_user_id, status, retry_key, delivered_at)
        VALUES (s, DATE '2026-06-01', 'U_cds', 'delivered', gen_random_uuid(), now());
    INSERT INTO summary_deliveries(store_id, summary_date, line_user_id, status, retry_key)
        VALUES (s, DATE '2026-06-02', 'U_cds', 'failed', gen_random_uuid());
    INSERT INTO summary_deliveries(store_id, summary_date, line_user_id, status, retry_key)
        VALUES (s, DATE '2026-06-03', 'U_cds', 'skipped_no_summary', gen_random_uuid());
    INSERT INTO summary_deliveries(store_id, summary_date, line_user_id, status, retry_key)
        VALUES (s, DATE '2026-06-04', 'U_cds', 'quota_exceeded', gen_random_uuid());
    BEGIN INSERT INTO summary_deliveries(store_id, summary_date, line_user_id, status, retry_key)
            VALUES (s, DATE '2026-06-05', 'U_cds', 'bogus', gen_random_uuid());
        RAISE EXCEPTION 'FAIL: summary_deliveries.status accepted invalid value'; EXCEPTION WHEN check_violation THEN NULL; END;

    -- summary_deliveries: store×summary_date 一意（再送は同一行の更新で表現・新規行は拒否）
    BEGIN INSERT INTO summary_deliveries(store_id, summary_date, line_user_id, status, retry_key)
            VALUES (s, DATE '2026-06-01', 'U_cds', 'delivered', gen_random_uuid());
        RAISE EXCEPTION 'FAIL: dup (store,summary_date) summary_deliveries'; EXCEPTION WHEN unique_violation THEN NULL; END;

    RAISE NOTICE 'PASS 1.1b: summary_deliveries FK/status CHECK（全4分岐）/unique held';

    -- owners.delivery_hour: 既定値 7・境界値 0/23 許容・範囲外 -1/24 拒否
    PERFORM 1 FROM owners WHERE id = ow AND delivery_hour = 7;
    IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: owners.delivery_hour default != 7'; END IF;

    UPDATE owners SET delivery_hour = 0 WHERE id = ow;
    UPDATE owners SET delivery_hour = 23 WHERE id = ow;

    BEGIN UPDATE owners SET delivery_hour = -1 WHERE id = ow;
        RAISE EXCEPTION 'FAIL: delivery_hour accepted -1'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN UPDATE owners SET delivery_hour = 24 WHERE id = ow;
        RAISE EXCEPTION 'FAIL: delivery_hour accepted 24'; EXCEPTION WHEN check_violation THEN NULL; END;

    RAISE NOTICE 'PASS 1.1c: owners.delivery_hour default=7 and 0-23 CHECK (boundaries incl.) held';
END $$;
ROLLBACK;
