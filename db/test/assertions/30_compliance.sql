-- assertions 5.3: コンプライアンス（匿名性の構造保証）
-- 顧客/個別回答テーブル不在・PII カラム不在・集計はカウンタのみ。
-- 書込境界の単一所有（Req 9.1, 9.4）は db/test/check_docs.sh が機械検証する。
DO $$
DECLARE bad text;
BEGIN
    -- 顧客/個別回答を示すテーブルが存在しない
    SELECT string_agg(table_name, ', ') INTO bad
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('customers','customer','visitors','survey_responses','responses','answers','survey_answers');
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'FAIL: forbidden table(s): %', bad; END IF;
    RAISE NOTICE 'PASS 5.3a: no customer/individual-response table';

    -- 来店客 PII を匂わすカラムが存在しない（owners.line_user_id はオーナー識別子で対象外）
    SELECT string_agg(table_name || '.' || column_name, ', ') INTO bad
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name IN ('email','phone','phone_number','tel','address','ip_address','device_id','customer_id','customer_name');
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'FAIL: PII-bearing column(s): %', bad; END IF;
    RAISE NOTICE 'PASS 5.3b: no customer PII columns';

    -- アンケート集計表は自由記述（個別回答）カラムを持たない＝カウンタのみ
    SELECT string_agg(table_name || '.' || column_name, ', ') INTO bad
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('survey_rating_tallies','survey_aspect_tallies')
      AND column_name IN ('comment','free_text','text','body','message','note','answer');
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'FAIL: survey tally free-text column(s): %', bad; END IF;
    RAISE NOTICE 'PASS 5.3c: survey tallies are anonymous counters only';
END $$;
