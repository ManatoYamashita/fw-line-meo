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

-- assertions 8.1: 監査 action の CHECK（migration 0009・dashboard-user-edit / Issue #259・Req 5.2）
-- 0007 の無名の列 CHECK（実名 audit_logs_action_check）を、0009 が明示名 ck_audit_logs_action として
-- 作り直した。ここでは次の 3 点を固定する。
--   (a) action 列に掛かる CHECK がちょうど 1 つで、その名前が ck_audit_logs_action であり、旧名が無いこと。
--       旧制約が別の名前で残ると新旧の CHECK が両方効き、新しい値だけが拒否される。名前の一致だけでは
--       その状態を見落とすので、action 列に掛かる CHECK の数も数える。
--   (b) 利用者の編集を表す 4 値を受け付けること。
--   (c) 未知の値を ck_audit_logs_action が拒否すること（別の CHECK の発火と取り違えないよう名前まで見る）。
-- TS の正典 AUDIT_LOG_ACTIONS と CHECK の集合の一致は ts/packages/db/test/audit-logs.db.test.ts が見る。
BEGIN;
DO $$
DECLARE
    action_attnum smallint;
    actor         uuid := gen_random_uuid();
    n             integer;
    cname         text;
    v             text;
BEGIN
    SELECT attnum INTO action_attnum
      FROM pg_attribute
     WHERE attrelid = 'audit_logs'::regclass
       AND attname = 'action'
       AND NOT attisdropped;
    IF action_attnum IS NULL THEN
        RAISE EXCEPTION 'FAIL 8.1a: audit_logs.action 列が見つかりません';
    END IF;

    -- (a) action 列に掛かる CHECK はちょうど 1 つで、明示名であり、旧名は残っていない
    SELECT count(*) INTO n
      FROM pg_constraint
     WHERE conrelid = 'audit_logs'::regclass
       AND contype = 'c'
       AND action_attnum = ANY (conkey);
    IF n <> 1 THEN
        RAISE EXCEPTION 'FAIL 8.1a: action 列に掛かる CHECK が % 個あります（期待 1）', n;
    END IF;
    PERFORM 1
       FROM pg_constraint
      WHERE conrelid = 'audit_logs'::regclass
        AND contype = 'c'
        AND conname = 'ck_audit_logs_action'
        AND action_attnum = ANY (conkey);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'FAIL 8.1a: action 列の CHECK が ck_audit_logs_action ではありません';
    END IF;
    PERFORM 1
       FROM pg_constraint
      WHERE conrelid = 'audit_logs'::regclass
        AND conname = 'audit_logs_action_check';
    IF FOUND THEN
        RAISE EXCEPTION 'FAIL 8.1a: 旧制約 audit_logs_action_check が残っています';
    END IF;
    RAISE NOTICE 'PASS 8.1a: action の CHECK は ck_audit_logs_action の 1 つだけで、旧名は無い';

    -- (b) 利用者の編集を表す 4 値を受け付ける。件数まで数え、ループが空回りしていないことも確かめる。
    FOREACH v IN ARRAY ARRAY[
        'dashboard_user_promoted_to_operator',
        'dashboard_user_demoted_to_agency',
        'dashboard_user_agency_updated',
        'dashboard_user_display_name_updated'
    ] LOOP
        BEGIN
            INSERT INTO audit_logs (actor_type, actor_id, action, target_type, target_id)
            VALUES ('operator', actor, v, 'dashboard_user', gen_random_uuid());
        EXCEPTION WHEN check_violation THEN
            RAISE EXCEPTION 'FAIL 8.1b: % が CHECK で拒否されました', v;
        END;
    END LOOP;
    SELECT count(*) INTO n FROM audit_logs WHERE actor_id = actor;
    IF n <> 4 THEN
        RAISE EXCEPTION 'FAIL 8.1b: 利用者の編集の action が % 行しか記録されていません（期待 4）', n;
    END IF;
    RAISE NOTICE 'PASS 8.1b: 利用者の編集を表す 4 値を受け付ける';

    -- (c) 未知の値は ck_audit_logs_action が拒否する
    BEGIN
        INSERT INTO audit_logs (actor_type, actor_id, action, target_type, target_id)
        VALUES ('operator', actor, 'dashboard_user_updated', 'dashboard_user', gen_random_uuid());
        RAISE EXCEPTION 'FAIL 8.1c: 未知の action dashboard_user_updated が受理されました';
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
        IF cname IS DISTINCT FROM 'ck_audit_logs_action' THEN
            RAISE EXCEPTION 'FAIL 8.1c: 別の CHECK が発火しました: %', cname;
        END IF;
    END;
    RAISE NOTICE 'PASS 8.1c: 未知の action は ck_audit_logs_action が拒否する';
END $$;
ROLLBACK;
