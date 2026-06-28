-- smoke 1.3: 共有定数 seed が SoT として投入済み
DO $$
BEGIN
    IF (SELECT count(*) FROM categories)     < 11 THEN RAISE EXCEPTION 'FAIL: categories seed incomplete'; END IF;
    IF (SELECT count(*) FROM survey_aspects)  < 6 THEN RAISE EXCEPTION 'FAIL: survey_aspects seed incomplete'; END IF;
    RAISE NOTICE 'PASS 1.3: seed SoT populated (categories>=11, survey_aspects>=6)';
END $$;
