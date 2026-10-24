-- assertions 4.1: オーナーの LINE 連携状態（owner-line-unlink・Issue #487・migration 0017）
-- owners の連携状態は 3 列（line_unlinked_at・menu_pending_line_user_id・taken_over_by_owner_id）と
-- line_user_id の組で表し、次の 3 つの CHECK が不変条件を構造で保証する。
--   ck_owner_line_link    … 解除時刻が無いこと ⇔ LINE ユーザー ID があること
--   ck_owner_menu_pending … メニュー未解除の元の ID を持てるのは解除済みのオーナーだけ
--   ck_owner_taken_over   … 引継ぎ先を持てるのは解除済みのオーナーだけで、自分自身を指さない
-- ここでは (a) 列と制約の形、(b) 正しい 4 状態（連携中・解除済み・メニュー未解除・引継ぎ済み）を
-- 受け付けること、(c) 不正な組み合わせを**期待した名前の CHECK が**拒否すること（別の制約の発火と
-- 取り違えないよう GET STACKED DIAGNOSTICS で名前まで見る）、(d) 監査の action に解除・引継ぎの
-- 3 値が足され、既存の 25 値も受け付けたままであること（Req 7.4）を固定する。
-- 監査の action の件数（28）と TS の正典 AUDIT_LOG_ACTIONS との集合の一致は
-- ts/packages/db/test/audit-logs.db.test.ts が見る。
BEGIN;
DO $$
DECLARE
    op      uuid;
    ag      uuid;
    o_link  uuid;
    o_menu  uuid;
    o_done  uuid;
    o_taken uuid;
    o_heir  uuid;
    t       text;
    n       integer;
    cname   text;
BEGIN
    -- (a) 列と制約の形
    SELECT data_type INTO t
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'owners' AND column_name = 'line_user_id'
       AND is_nullable = 'YES';
    IF t IS NULL THEN
        RAISE EXCEPTION 'FAIL 4.1a: owners.line_user_id が NULL を許していません';
    END IF;

    SELECT count(*) INTO n
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'owners' AND is_nullable = 'YES'
       AND (column_name, data_type) IN (
           ('line_unlinked_at', 'timestamp with time zone'),
           ('menu_pending_line_user_id', 'text'),
           ('taken_over_by_owner_id', 'uuid'));
    IF n <> 3 THEN
        RAISE EXCEPTION 'FAIL 4.1a: owners の連携状態の 3 列が % 列しか期待の型・NULL 許容で存在しません', n;
    END IF;

    -- 引継ぎ先は owners を参照し、参照されている行の削除を拒む（ON DELETE RESTRICT = confdeltype 'r'）
    SELECT count(*) INTO n
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.conrelid = 'owners'::regclass
       AND c.contype = 'f'
       AND c.confrelid = 'owners'::regclass
       AND c.confdeltype = 'r'
       AND a.attname = 'taken_over_by_owner_id';
    IF n <> 1 THEN
        RAISE EXCEPTION 'FAIL 4.1a: taken_over_by_owner_id の owners への RESTRICT 外部キーが % 個です（期待 1）', n;
    END IF;

    SELECT count(*) INTO n
      FROM pg_constraint
     WHERE conrelid = 'owners'::regclass
       AND contype = 'c'
       AND conname IN ('ck_owner_line_link', 'ck_owner_menu_pending', 'ck_owner_taken_over');
    IF n <> 3 THEN
        RAISE EXCEPTION 'FAIL 4.1a: owners の連携状態の CHECK が % 個しかありません（期待 3）', n;
    END IF;
    RAISE NOTICE 'PASS 4.1a: owners の連携状態の 3 列・外部キー・3 つの CHECK がある';

    -- (b) 正しい 4 状態を受け付ける
    INSERT INTO operators(name) VALUES ('op_41') RETURNING id INTO op;
    INSERT INTO agencies(operator_id, name) VALUES (op, 'ag_41') RETURNING id INTO ag;
    -- 連携中
    INSERT INTO owners(agency_id, line_user_id) VALUES (ag, 'U_41_link') RETURNING id INTO o_link;
    -- 解除済み・メニュー未解除
    INSERT INTO owners(agency_id, line_user_id, line_unlinked_at, menu_pending_line_user_id)
    VALUES (ag, NULL, now(), 'U_41_menu') RETURNING id INTO o_menu;
    -- 解除済み（ID を持たない行は複数あってよい。UNIQUE は NULL を重複とみなさない）
    INSERT INTO owners(agency_id, line_user_id, line_unlinked_at)
    VALUES (ag, NULL, now()) RETURNING id INTO o_done;
    -- 引継ぎ済み（解除済みで、引き継いだ連携中のオーナーを指す）
    INSERT INTO owners(agency_id, line_user_id) VALUES (ag, 'U_41_heir') RETURNING id INTO o_heir;
    INSERT INTO owners(agency_id, line_user_id, line_unlinked_at, taken_over_by_owner_id)
    VALUES (ag, NULL, now(), o_heir) RETURNING id INTO o_taken;
    -- 連携中から解除済みへの遷移（解除の書込と同じ形の UPDATE）
    UPDATE owners
       SET line_user_id = NULL, line_unlinked_at = now(), menu_pending_line_user_id = 'U_41_link'
     WHERE id = o_link;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN
        RAISE EXCEPTION 'FAIL 4.1b: 連携中から解除済みへの更新が % 行でした（期待 1）', n;
    END IF;
    -- メニューを外せたので未解除の印を消す
    UPDATE owners SET menu_pending_line_user_id = NULL WHERE id = o_link;
    SELECT count(*) INTO n FROM owners WHERE agency_id = ag AND line_user_id IS NULL;
    IF n <> 4 THEN
        RAISE EXCEPTION 'FAIL 4.1b: 解除済みのオーナーが % 行です（期待 4）', n;
    END IF;
    RAISE NOTICE 'PASS 4.1b: 連携中・解除済み・メニュー未解除・引継ぎ済みの状態と解除の遷移を受け付ける';

    -- (c) 不正な組み合わせは、期待した名前の CHECK が拒否する
    -- ID も解除時刻も無い（連携中から ID だけを消す）
    BEGIN
        UPDATE owners SET line_user_id = NULL WHERE id = o_heir;
        RAISE EXCEPTION 'FAIL 4.1c: ID も解除時刻も無いオーナーが受理されました';
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
        IF cname IS DISTINCT FROM 'ck_owner_line_link' THEN
            RAISE EXCEPTION 'FAIL 4.1c: ID も解除時刻も無い行を別の CHECK が拒否しました: %', cname;
        END IF;
    END;
    -- ID と解除時刻の両方を持つ（連携中のまま解除時刻だけを入れる）
    BEGIN
        UPDATE owners SET line_unlinked_at = now() WHERE id = o_heir;
        RAISE EXCEPTION 'FAIL 4.1c: ID と解除時刻の両方を持つオーナーが受理されました';
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
        IF cname IS DISTINCT FROM 'ck_owner_line_link' THEN
            RAISE EXCEPTION 'FAIL 4.1c: ID と解除時刻の両方を持つ行を別の CHECK が拒否しました: %', cname;
        END IF;
    END;
    -- 解除済みから ID だけを戻す（解除済みから連携中へは戻らない）
    BEGIN
        UPDATE owners SET line_user_id = 'U_41_back' WHERE id = o_done;
        RAISE EXCEPTION 'FAIL 4.1c: 解除時刻を残したまま ID を戻す更新が受理されました';
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
        IF cname IS DISTINCT FROM 'ck_owner_line_link' THEN
            RAISE EXCEPTION 'FAIL 4.1c: 解除時刻と ID を併せ持つ行を別の CHECK が拒否しました: %', cname;
        END IF;
    END;
    -- 連携中のオーナーがメニュー未解除の印を持つ
    BEGIN
        UPDATE owners SET menu_pending_line_user_id = 'U_41_heir' WHERE id = o_heir;
        RAISE EXCEPTION 'FAIL 4.1c: 連携中のオーナーのメニュー未解除の印が受理されました';
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
        IF cname IS DISTINCT FROM 'ck_owner_menu_pending' THEN
            RAISE EXCEPTION 'FAIL 4.1c: 連携中のメニュー未解除の印を別の CHECK が拒否しました: %', cname;
        END IF;
    END;
    -- 連携中のオーナーが引継ぎ先を持つ
    BEGIN
        UPDATE owners SET taken_over_by_owner_id = o_done WHERE id = o_heir;
        RAISE EXCEPTION 'FAIL 4.1c: 連携中のオーナーの引継ぎ先が受理されました';
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
        IF cname IS DISTINCT FROM 'ck_owner_taken_over' THEN
            RAISE EXCEPTION 'FAIL 4.1c: 連携中の引継ぎ先を別の CHECK が拒否しました: %', cname;
        END IF;
    END;
    -- 解除済みのオーナーが自分自身を引継ぎ先に持つ
    BEGIN
        UPDATE owners SET taken_over_by_owner_id = o_done WHERE id = o_done;
        RAISE EXCEPTION 'FAIL 4.1c: 自分自身を指す引継ぎ先が受理されました';
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
        IF cname IS DISTINCT FROM 'ck_owner_taken_over' THEN
            RAISE EXCEPTION 'FAIL 4.1c: 自分自身を指す引継ぎ先を別の CHECK が拒否しました: %', cname;
        END IF;
    END;
    -- 存在しないオーナーを引継ぎ先に持つ
    BEGIN
        UPDATE owners SET taken_over_by_owner_id = gen_random_uuid() WHERE id = o_done;
        RAISE EXCEPTION 'FAIL 4.1c: 存在しない引継ぎ先が受理されました';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    -- 引継ぎ先として参照されているオーナーは削除できない
    BEGIN
        DELETE FROM owners WHERE id = o_heir;
        RAISE EXCEPTION 'FAIL 4.1c: 引継ぎ先として参照されているオーナーの削除が受理されました';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    -- 連携中の 2 人が同じ ID を持つことは従来どおり拒否する
    BEGIN
        INSERT INTO owners(agency_id, line_user_id) VALUES (ag, 'U_41_heir');
        RAISE EXCEPTION 'FAIL 4.1c: 連携中の 2 人が同じ LINE ユーザー ID を持てました';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    -- 拒否された更新の後も、各行は元の状態のまま残っている
    PERFORM 1 FROM owners
     WHERE id = o_heir AND line_user_id = 'U_41_heir' AND line_unlinked_at IS NULL
       AND menu_pending_line_user_id IS NULL AND taken_over_by_owner_id IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'FAIL 4.1c: 拒否された更新の後に連携中のオーナーの状態が変わっています';
    END IF;
    PERFORM 1 FROM owners
     WHERE id = o_done AND line_user_id IS NULL AND line_unlinked_at IS NOT NULL
       AND taken_over_by_owner_id IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'FAIL 4.1c: 拒否された更新の後に解除済みのオーナーの状態が変わっています';
    END IF;
    RAISE NOTICE 'PASS 4.1c: 不正な連携状態の組み合わせを ck_owner_line_link・ck_owner_menu_pending・ck_owner_taken_over が拒否する';
END $$;
ROLLBACK;

-- assertions 4.1d: 監査の action に解除・引継ぎの 3 値が足され、既存の 25 値も受け付けたまま（Req 7.4）
-- 既存の値が 1 つでも落ちると、その値を書く既存の監査が CHECK 違反で欠ける。全 28 値を 1 件ずつ
-- INSERT し、件数まで数えてループの空回りも見る。
BEGIN;
DO $$
DECLARE
    actor uuid := gen_random_uuid();
    v     text;
    n     integer;
BEGIN
    FOREACH v IN ARRAY ARRAY[
        -- 0016 までの 25 値
        'owner_created',
        'onboarding_completed',
        'store_registered',
        'store_category_updated',
        'rich_menu_linked',
        'rich_menu_link_failed',
        'invite_code_issued',
        'invite_code_disabled',
        'agency_created',
        'dashboard_user_created',
        'dashboard_user_disabled',
        'dashboard_user_enabled',
        'dashboard_user_promoted_to_operator',
        'dashboard_user_demoted_to_agency',
        'dashboard_user_agency_updated',
        'dashboard_user_display_name_updated',
        'store_suspended',
        'store_resumed',
        'survey_target_added',
        'survey_target_renamed',
        'survey_target_updated',
        'survey_target_disabled',
        'survey_target_enabled',
        'survey_targets_reordered',
        'survey_category_visibility_updated',
        -- owner-line-unlink（Issue #487・0017）
        'owner_line_unlinked',
        'owner_stores_taken_over',
        'store_taken_over'
    ] LOOP
        BEGIN
            INSERT INTO audit_logs (actor_type, actor_id, action, target_type, target_id)
            VALUES ('operator', actor, v, 'owner', gen_random_uuid());
        EXCEPTION WHEN check_violation THEN
            RAISE EXCEPTION 'FAIL 4.1d: % が CHECK で拒否されました', v;
        END;
    END LOOP;
    SELECT count(*) INTO n FROM audit_logs WHERE actor_id = actor;
    IF n <> 28 THEN
        RAISE EXCEPTION 'FAIL 4.1d: 監査の action が % 行しか記録されていません（期待 28）', n;
    END IF;
    RAISE NOTICE 'PASS 4.1d: 監査の action は既存の 25 値と解除・引継ぎの 3 値を受け付ける';
END $$;
ROLLBACK;
