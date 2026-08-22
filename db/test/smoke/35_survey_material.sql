-- smoke 3.5: 素材の厚みの匿名集計（投入可 / 加算の形 / 本文を持つ列が無いこと）
-- Issue #137 段階3。既存の 33_survey.sql（星・観点の匿名集計）と同じ観察の形を取る。
BEGIN;
DO $$
DECLARE op uuid; ag uuid; ow uuid; s uuid; c integer; cols text;
BEGIN
    INSERT INTO operators(name) VALUES ('op') RETURNING id INTO op;
    INSERT INTO agencies(operator_id, name) VALUES (op, 'ag') RETURNING id INTO ag;
    INSERT INTO owners(agency_id, line_user_id) VALUES (ag, 'U_smoke_35') RETURNING id INTO ow;
    INSERT INTO stores(owner_id, name) VALUES (ow, 's') RETURNING id INTO s;

    INSERT INTO survey_material_tallies(store_id, period_month, aspect_count, has_comment, count)
        VALUES (s, DATE '2026-06-01', 0, false, 1);
    RAISE NOTICE 'PASS 3.5a: material tally insertable';

    -- 本番の書き込みと同じ UPSERT の形（ON CONFLICT で 1 加算）が成立する
    INSERT INTO survey_material_tallies(store_id, period_month, aspect_count, has_comment, count)
        VALUES (s, DATE '2026-06-01', 0, false, 1)
        ON CONFLICT (store_id, period_month, aspect_count, has_comment)
        DO UPDATE SET count = survey_material_tallies.count + 1;
    SELECT count INTO c FROM survey_material_tallies
        WHERE store_id = s AND period_month = DATE '2026-06-01' AND aspect_count = 0 AND has_comment = false;
    IF c <> 2 THEN RAISE EXCEPTION 'FAIL: UPSERT で加算されない（count=%）', c; END IF;
    RAISE NOTICE 'PASS 3.5b: ON CONFLICT increments the counter';

    -- 一言の本文を持ちうる列が存在しない（匿名性の構造保証。allowlist は 30_compliance が持つ）
    SELECT string_agg(column_name, ', ') INTO cols
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'survey_material_tallies'
      AND data_type IN ('text', 'character varying');
    IF cols IS NOT NULL THEN
        RAISE EXCEPTION 'FAIL: survey_material_tallies に文字列列が存在する: %', cols;
    END IF;
    RAISE NOTICE 'PASS 3.5c: no text column (comment body cannot be stored)';
END $$;
ROLLBACK;
