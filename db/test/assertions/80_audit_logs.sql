-- assertions 8.0: 監査記録の主体・追記契約
DO $$
DECLARE
    actor_type_name text;
BEGIN
    SELECT udt_name INTO actor_type_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'audit_logs'
       AND column_name = 'actor_type';
    IF actor_type_name <> 'audit_actor_type' THEN
        RAISE EXCEPTION 'FAIL 8.0a: actor_type が audit_actor_type ではありません';
    END IF;

    BEGIN
        INSERT INTO audit_logs (actor_type, actor_id, action, target_type, target_id)
        VALUES ('customer', gen_random_uuid(), 'onboarding_completed', 'store', gen_random_uuid());
        RAISE EXCEPTION 'FAIL 8.0b: customer が監査主体として受理されました';
    EXCEPTION WHEN invalid_text_representation THEN
        RAISE NOTICE 'PASS 8.0b: customer actor is rejected by enum';
    END;

    INSERT INTO audit_logs (actor_type, actor_id, action, target_type, target_id)
    VALUES ('owner', gen_random_uuid(), 'onboarding_completed', 'store', gen_random_uuid());
    RAISE NOTICE 'PASS 8.0a: audit_logs accepts only the defined actor types and records writes';
END $$;
