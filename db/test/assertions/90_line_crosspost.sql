-- assertions（line-crosspost・0019・Issue #494）: crosspost_drafts / crosspost_media / crosspost_deliveries
-- 作成中の下書きは owner あたり 1 つ・承認の整合・入力モードの整合・写真は 1 下書き 1 枚・
-- 投稿先は下書きあたり投稿先ごとに 1 行・状態と付随列の整合・CASCADE を検証する。
-- 各拒否は DO ブロック + EXCEPTION で捕捉。期待通り拒否されなければ FAIL を RAISE（非ゼロ終了）。
BEGIN;
DO $$
DECLARE op uuid; ag uuid; ow uuid; s uuid; d1 uuid; d2 uuid; v uuid; m uuid;
BEGIN
    INSERT INTO operators(name) VALUES ('op90') RETURNING id INTO op;
    INSERT INTO agencies(operator_id, name) VALUES (op, 'ag90') RETURNING id INTO ag;
    INSERT INTO owners(agency_id, line_user_id) VALUES (ag, 'U_90_a') RETURNING id INTO ow;
    INSERT INTO stores(owner_id, name, place_id, place_status) VALUES (ow, 's90', 'P_90', 'confirmed') RETURNING id INTO s;

    -- 既定値: collecting・none・版 0・素材は空
    INSERT INTO crosspost_drafts(owner_id, store_id, expires_at, purge_after)
        VALUES (ow, s, now() + interval '1 day', now() + interval '30 day') RETURNING id INTO d1;
    PERFORM 1 FROM crosspost_drafts
        WHERE id = d1 AND status = 'collecting' AND input_mode = 'none' AND revision = 0 AND material_text = '';
    IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: crosspost_drafts defaults not applied'; END IF;

    -- 作成中の下書きは owner あたり 1 つ（部分一意索引）
    BEGIN INSERT INTO crosspost_drafts(owner_id, store_id, expires_at, purge_after)
            VALUES (ow, s, now() + interval '1 day', now() + interval '30 day');
        RAISE EXCEPTION 'FAIL: second open draft accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;

    -- 承認済み・取り消し済みは作成中に数えない（同じ owner でも並べて持てる）
    UPDATE crosspost_drafts SET status = 'canceled' WHERE id = d1;
    INSERT INTO crosspost_drafts(owner_id, store_id, expires_at, purge_after, status, instagram_text, google_text)
        VALUES (ow, s, now() + interval '1 day', now() + interval '30 day', 'reviewing', 'IG', 'GG') RETURNING id INTO d2;

    -- 入力モードと投稿先は揃って有無が決まる。確認中でなければ none
    BEGIN UPDATE crosspost_drafts SET input_mode = 'manual' WHERE id = d2;
        RAISE EXCEPTION 'FAIL: input_mode without destination accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN UPDATE crosspost_drafts SET input_mode = 'ai_revision', input_destination = 'google', status = 'collecting' WHERE id = d2;
        RAISE EXCEPTION 'FAIL: input_mode outside reviewing accepted'; EXCEPTION WHEN check_violation THEN NULL; END;

    -- 承認は approved_at と approved_revision を伴う
    BEGIN UPDATE crosspost_drafts SET status = 'approved' WHERE id = d2;
        RAISE EXCEPTION 'FAIL: approved without approved_at accepted'; EXCEPTION WHEN check_violation THEN NULL; END;

    -- 文の上限（Google 1,500 字）
    BEGIN UPDATE crosspost_drafts SET google_text = repeat('あ', 1501) WHERE id = d2;
        RAISE EXCEPTION 'FAIL: google_text over 1500 accepted'; EXCEPTION WHEN check_violation THEN NULL; END;

    -- 写真は 1 下書き 1 枚・JPEG のみ
    INSERT INTO crosspost_media(draft_id, line_message_id, line_sent_at, storage_key, content_type, width, height, byte_size, sha256)
        VALUES (d2, 'L1', now(), 'k90-1', 'image/jpeg', 1080, 1080, 100000, repeat('a', 64)) RETURNING id INTO m;
    BEGIN INSERT INTO crosspost_media(draft_id, line_message_id, line_sent_at, storage_key, content_type, width, height, byte_size, sha256)
            VALUES (d2, 'L2', now(), 'k90-2', 'image/jpeg', 1080, 1080, 100000, repeat('b', 64));
        RAISE EXCEPTION 'FAIL: second media accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;
    BEGIN INSERT INTO crosspost_media(draft_id, line_message_id, line_sent_at, storage_key, content_type, width, height, byte_size, sha256)
            VALUES (d1, 'L3', now(), 'k90-3', 'image/png', 1080, 1080, 100000, repeat('c', 64));
        RAISE EXCEPTION 'FAIL: png media accepted'; EXCEPTION WHEN check_violation THEN NULL; END;

    UPDATE crosspost_drafts SET status = 'approved', approved_at = now(), approved_revision = revision WHERE id = d2;

    -- 投稿先は下書きあたり投稿先ごとに 1 行
    INSERT INTO crosspost_deliveries(draft_id, destination, body_text, with_media, media_id)
        VALUES (d2, 'google', 'GG', true, m) RETURNING id INTO v;
    BEGIN INSERT INTO crosspost_deliveries(draft_id, destination, body_text, with_media)
            VALUES (d2, 'google', 'GG2', false);
        RAISE EXCEPTION 'FAIL: duplicate destination accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;

    -- 状態と付随列の整合
    BEGIN UPDATE crosspost_deliveries SET status = 'failed', last_attempt_at = now(), finished_at = now() WHERE id = v;
        RAISE EXCEPTION 'FAIL: failed without reason accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN UPDATE crosspost_deliveries SET status = 'unknown', last_attempt_at = now(), finished_at = now() WHERE id = v;
        RAISE EXCEPTION 'FAIL: unknown without reason accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN UPDATE crosspost_deliveries SET status = 'succeeded', retryable = true, last_attempt_at = now(), finished_at = now() WHERE id = v;
        RAISE EXCEPTION 'FAIL: retryable succeeded accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN UPDATE crosspost_deliveries SET status = 'in_progress', last_attempt_at = now(), finished_at = now() WHERE id = v;
        RAISE EXCEPTION 'FAIL: in_progress with finished_at accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN UPDATE crosspost_deliveries SET status = 'failed', failure_reason = 'made_up', last_attempt_at = now(), finished_at = now() WHERE id = v;
        RAISE EXCEPTION 'FAIL: unknown failure_reason accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
    UPDATE crosspost_deliveries
       SET status = 'failed', failure_reason = 'rate_limited', retryable = true, attempt_count = 1,
           last_attempt_at = now(), finished_at = now()
     WHERE id = v;

    -- 写真の行を消すと投稿先の media_id は NULL（承認時の with_media は残る）
    DELETE FROM crosspost_media WHERE id = m;
    PERFORM 1 FROM crosspost_deliveries WHERE id = v AND media_id IS NULL AND with_media = true;
    IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: media_id not set null on media delete'; END IF;

    -- 店舗の削除で下書き・投稿先は CASCADE
    DELETE FROM stores WHERE id = s;
    PERFORM 1 FROM crosspost_drafts WHERE owner_id = ow;
    IF FOUND THEN RAISE EXCEPTION 'FAIL: crosspost_drafts not cascaded on store delete'; END IF;
    PERFORM 1 FROM crosspost_deliveries WHERE id = v;
    IF FOUND THEN RAISE EXCEPTION 'FAIL: crosspost_deliveries not cascaded'; END IF;
END $$;
ROLLBACK;
