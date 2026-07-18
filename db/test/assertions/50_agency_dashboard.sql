-- assertions 50: agency-dashboard スキーマ拡張（dashboard_users への email / disabled_at 追加・migration 0005）
-- ck_dashboard_users_identity（両方 NULL 拒否）・ux_dashboard_users_email（大文字小文字を無視した部分一意）・
-- auth_subject NULL の保留行作成可・原子的リンク UPDATE の二重リンク不可（0 行）・無効化行のリンク拒否を検証。
-- Requirements 6.2（保留→リンクでログイン可能化）/ 6.4（無効化でログイン拒否）の構造保証。
BEGIN;
DO $$
DECLARE
    op    uuid;
    ag    uuid;
    du    uuid;
    n     integer;
    cname text;
BEGIN
    -- フィクスチャ: operator と、その配下の agency（agency ロール行の FK/スコープ検証用）
    INSERT INTO operators(name) VALUES ('op50') RETURNING id INTO op;
    INSERT INTO agencies(operator_id, name) VALUES (op, 'ag50') RETURNING id INTO ag;

    -- (a) ck_dashboard_users_identity: auth_subject と email が両方 NULL の行は拒否。
    --     operator ロール + agency_id NULL は ck_dashboard_role_scope を満たすため、
    --     ここで発火し得る CHECK は identity のみ。CONSTRAINT 名まで確認して取り違えを防ぐ。
    BEGIN
        INSERT INTO dashboard_users(role, operator_id, auth_subject, email)
            VALUES ('operator', op, NULL, NULL);
        RAISE EXCEPTION 'FAIL(a): auth_subject と email 両方 NULL の行が受理された';
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
        IF cname IS DISTINCT FROM 'ck_dashboard_users_identity' THEN
            RAISE EXCEPTION 'FAIL(a): 別の CHECK が発火した: %', cname;
        END IF;
    END;
    RAISE NOTICE 'PASS 50a: ck_dashboard_users_identity が両方 NULL を拒否';

    -- (c) 保留行（auth_subject NULL・email のみ）は作成可能（Req 6.2 の保留状態）。
    INSERT INTO dashboard_users(role, operator_id, email)
        VALUES ('operator', op, 'pending@example.com') RETURNING id INTO du;
    PERFORM 1 FROM dashboard_users
        WHERE id = du AND auth_subject IS NULL AND email = 'pending@example.com';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'FAIL(c): auth_subject NULL の保留行が作成できていない';
    END IF;
    RAISE NOTICE 'PASS 50c: auth_subject NULL の保留行を作成できる';

    -- (b) ux_dashboard_users_email: email は lower(email) で一意（大文字小文字を無視）。
    INSERT INTO dashboard_users(role, operator_id, email)
        VALUES ('operator', op, 'Owner@Example.com');
    BEGIN
        INSERT INTO dashboard_users(role, operator_id, email)
            VALUES ('operator', op, 'owner@example.com');
        RAISE EXCEPTION 'FAIL(b): 大文字小文字違いの email 重複が受理された';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    RAISE NOTICE 'PASS 50b: ux_dashboard_users_email が大文字小文字を無視して重複を拒否';

    -- (d) 原子的リンク UPDATE: 保留行を 1 件だけ確定し、二重リンク（2 回目）は 0 行。
    INSERT INTO dashboard_users(role, operator_id, email)
        VALUES ('operator', op, 'link@example.com');
    -- 1 回目のリンク（大文字小文字を無視して照合）はちょうど 1 行
    UPDATE dashboard_users SET auth_subject = 'uid-link-1'
        WHERE lower(email) = lower('Link@Example.com')
          AND auth_subject IS NULL
          AND disabled_at IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN
        RAISE EXCEPTION 'FAIL(d): 1 回目のリンクが % 行に影響（期待 1）', n;
    END IF;
    -- 2 回目の同一リンク（別 uid の乗っ取り試行）は 0 行（auth_subject 既設のため WHERE に合致しない）
    UPDATE dashboard_users SET auth_subject = 'uid-link-2'
        WHERE lower(email) = lower('Link@Example.com')
          AND auth_subject IS NULL
          AND disabled_at IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN
        RAISE EXCEPTION 'FAIL(d): 2 回目のリンクが % 行に影響（期待 0 = 二重リンク不可）', n;
    END IF;
    RAISE NOTICE 'PASS 50d: 原子的リンク UPDATE は保留行を 1 件のみ確定し二重リンクを許さない';

    -- (e) 無効化行のリンク拒否（Req 6.4）: disabled_at 設定済みの保留行は同じ UPDATE で確定されない。
    --     agency ロール行で FK（operator_id, agency_id）とスコープ制約も併せて成立することを確認。
    INSERT INTO dashboard_users(role, operator_id, agency_id, email, disabled_at)
        VALUES ('agency', op, ag, 'disabled@example.com', now());
    UPDATE dashboard_users SET auth_subject = 'uid-should-not-link'
        WHERE lower(email) = lower('disabled@example.com')
          AND auth_subject IS NULL
          AND disabled_at IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN
        RAISE EXCEPTION 'FAIL(e): 無効化された保留行がリンクされた（期待 0）';
    END IF;
    RAISE NOTICE 'PASS 50e: 無効化（disabled_at）済みの保留行はリンクされない';

    RAISE NOTICE 'PASS 50: agency-dashboard schema (dashboard_users identity / email uniqueness / atomic link) held';
END $$;
ROLLBACK;
