-- smoke 1.2: 5 ENUM 型と 2 参照テーブルの存在
DO $$
BEGIN
    IF to_regclass('public.categories') IS NULL OR to_regclass('public.survey_aspects') IS NULL THEN
        RAISE EXCEPTION 'FAIL: reference tables missing';
    END IF;
    IF (SELECT count(*) FROM pg_type
        WHERE typname IN ('dashboard_role','onboarding_status','place_status','snapshot_subject','oauth_provider')) <> 5 THEN
        RAISE EXCEPTION 'FAIL: not all 5 enum types present';
    END IF;
    RAISE NOTICE 'PASS 1.2: 5 enums + 2 reference tables exist';
END $$;
