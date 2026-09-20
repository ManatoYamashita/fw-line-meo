-- assertions 1.1（competitive-daily-summary）: daily_summaries / summary_deliveries / owners.delivery_hour
-- FK 孤児拒否・store×日付 一意制約・status ドメイン CHECK（両テーブル）・delivery_hour 範囲 CHECK（境界含む）を検証する。
-- 各拒否は DO ブロック + EXCEPTION で捕捉。期待通り拒否されなければ FAIL を RAISE（非ゼロ終了）。
--
-- summary_deliveries.status は 0010（line-on-demand-report・Issue #256）で 7 値になった。0004 の無名の
-- 列 CHECK を落とし、明示名 ck_summary_deliveries_status で作り直している。ここでは 7 値すべての受理、
-- 不正値をその CHECK が拒否すること、status に掛かる CHECK がその 1 本だけであること、その CHECK が
-- 許す値の集合がちょうど 7 値であることを確かめる。
BEGIN;
DO $$
DECLARE op uuid; ag uuid; ow uuid; s uuid; rk uuid; st text; d integer := 0; cname text; status_checks name[]; status_values text[];
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

    -- daily_summaries: google_maps_reviews_uri は既定で NULL（0011・Issue #303）。
    -- **空文字を既定にしない。** 空文字は「URL が無い」と区別できず、読み手が空の href を描く側へ倒れる。
    PERFORM 1 FROM daily_summaries
        WHERE store_id = s AND summary_date = DATE '2026-06-02'
          AND google_maps_reviews_uri IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: daily_summaries.google_maps_reviews_uri default is not NULL'; END IF;

    -- 値を入れれば保持し、NULL へ戻せる（NOT NULL 制約を後から足す改変を通さない）。
    UPDATE daily_summaries SET google_maps_reviews_uri = 'https://www.google.com/maps/place//data=x'
        WHERE store_id = s AND summary_date = DATE '2026-06-02';
    PERFORM 1 FROM daily_summaries
        WHERE store_id = s AND summary_date = DATE '2026-06-02'
          AND google_maps_reviews_uri = 'https://www.google.com/maps/place//data=x';
    IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: daily_summaries.google_maps_reviews_uri did not keep the value'; END IF;
    UPDATE daily_summaries SET google_maps_reviews_uri = NULL
        WHERE store_id = s AND summary_date = DATE '2026-06-02';

    -- daily_summaries: store×summary_date 一意
    BEGIN INSERT INTO daily_summaries(store_id, summary_date, status)
            VALUES (s, DATE '2026-06-01', 'ready');
        RAISE EXCEPTION 'FAIL: dup (store,summary_date) daily_summaries'; EXCEPTION WHEN unique_violation THEN NULL; END;

    RAISE NOTICE 'PASS 1.1a: daily_summaries FK/status CHECK/defaults/unique held';

    -- summary_deliveries: 正常系 + status ドメイン CHECK 全分岐（7 値・日付を 1 日ずつずらして 1 行ずつ入れる）。
    -- 先頭の 4 値は 0004 からの値で、旧コードが書く。移行の Step A では旧イメージが新しい CHECK の下で
    -- 動くので、この 4 値を受理し続けることが互換の条件である。残りの 3 値は送らなかった理由
    -- （変化なし・比較不能・メニュー未準備）で、0010 で足した。
    -- 素の INSERT だと、拒否されたときにどの値が落ちたかが FAIL の文に出ないので、値を名指しして落とす。
    FOREACH st IN ARRAY ARRAY[
        'delivered', 'failed', 'skipped_no_summary', 'quota_exceeded',
        'skipped_no_change', 'skipped_not_comparable', 'skipped_menu_unavailable'
    ] LOOP
        BEGIN INSERT INTO summary_deliveries(store_id, summary_date, line_user_id, status, retry_key)
                VALUES (s, DATE '2026-06-01' + d, 'U_cds', st, gen_random_uuid());
        EXCEPTION WHEN check_violation THEN
            RAISE EXCEPTION 'FAIL: summary_deliveries.status が有効な値 % を拒否した', st;
        END;
        d := d + 1;
    END LOOP;
    -- 配列を縮める編集で受理の検査が痩せたまま緑にならないよう、入れた行数も数える。
    IF d <> 7 THEN RAISE EXCEPTION 'FAIL: summary_deliveries.status の受理を % 値しか確かめていない（期待 7）', d; END IF;

    -- 不正値は ck_summary_deliveries_status が拒否する。発火した CHECK の名前まで見るのは、
    -- 別の名前の CHECK が代わりに拒否していても緑にしないため（明示名で作り直したことを確かめる）。
    BEGIN INSERT INTO summary_deliveries(store_id, summary_date, line_user_id, status, retry_key)
            VALUES (s, DATE '2026-06-01' + d, 'U_cds', 'bogus', gen_random_uuid());
        RAISE EXCEPTION 'FAIL: summary_deliveries.status accepted invalid value';
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
        IF cname IS DISTINCT FROM 'ck_summary_deliveries_status' THEN
            RAISE EXCEPTION 'FAIL: summary_deliveries.status の不正値を別の CHECK が拒否した: %', cname;
        END IF;
    END;

    -- status 列に掛かる CHECK は ck_summary_deliveries_status の 1 本だけ（0004 の無名の CHECK は落とした）。
    -- 表全体の CHECK を数えないのは、別の列に CHECK を足す将来の変更でこの検査が壊れないようにするため。
    SELECT array_agg(c.conname ORDER BY c.conname) INTO status_checks
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'status'
     WHERE c.conrelid = 'summary_deliveries'::regclass
       AND c.contype = 'c'
       AND a.attnum = ANY (c.conkey);
    IF status_checks IS DISTINCT FROM ARRAY['ck_summary_deliveries_status']::name[] THEN
        RAISE EXCEPTION 'FAIL: summary_deliveries.status の CHECK が ck_summary_deliveries_status の 1 本ではない: %', status_checks;
    END IF;

    -- CHECK が許す値の集合そのものも 7 値に固定する。受理の検査と番兵 1 つの拒否だけでは、
    -- 任意の 8 個目の値（例: 'pending'）を足す変更が緑のまま通るため。定義から引用符つきの値を取り出して比べる。
    SELECT array_agg(m[1] ORDER BY m[1] COLLATE "C") INTO status_values
      FROM pg_constraint c,
           regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''::text', 'g') AS m
     WHERE c.conrelid = 'summary_deliveries'::regclass
       AND c.conname = 'ck_summary_deliveries_status';
    IF status_values IS DISTINCT FROM ARRAY[
        'delivered', 'failed', 'quota_exceeded', 'skipped_menu_unavailable',
        'skipped_no_change', 'skipped_no_summary', 'skipped_not_comparable'
    ]::text[] THEN
        RAISE EXCEPTION 'FAIL: ck_summary_deliveries_status の値の集合が 7 値と一致しない: %', status_values;
    END IF;

    -- summary_deliveries: store×summary_date 一意（再送は同一行の更新で表現・新規行は拒否）
    BEGIN INSERT INTO summary_deliveries(store_id, summary_date, line_user_id, status, retry_key)
            VALUES (s, DATE '2026-06-01', 'U_cds', 'delivered', gen_random_uuid());
        RAISE EXCEPTION 'FAIL: dup (store,summary_date) summary_deliveries'; EXCEPTION WHEN unique_violation THEN NULL; END;

    RAISE NOTICE 'PASS 1.1b: summary_deliveries FK/status CHECK（全7分岐・不正値は ck_summary_deliveries_status が拒否・status の CHECK は 1 本・値の集合は 7 値）/unique held';

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
