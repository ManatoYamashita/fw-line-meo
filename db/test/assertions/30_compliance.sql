-- assertions 5.3: コンプライアンス（匿名性の構造保証）
-- denylist ではなく allowlist で「未知のテーブル/列の増加」を検出する（patrons/remark 等の別名にも強い）。
-- テーブル allowlist は新テーブル追加時のレビューゲートを兼ねる（追加すると失敗 → 意図的に allowlist 更新が必要）。
-- 書込境界の単一所有（Req 9.1, 9.4）は db/test/check_docs.sh が機械検証する。
DO $$
DECLARE bad text;
BEGIN
    -- テーブル allowlist: public の BASE TABLE は既知 15 テーブルのみ（未知テーブルの混入＝匿名性リスクを検出）
    SELECT string_agg(table_name, ', ') INTO bad
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      AND table_name NOT IN (
        'operators','agencies','owners','stores','dashboard_users','categories',
        'competitors','rating_snapshots','survey_aspects','survey_rating_tallies',
        'survey_aspect_tallies','oauth_tokens',
        'daily_summaries','summary_deliveries',
        'agency_invite_codes','onboarding_sessions','line_webhook_events'
      );
    IF bad IS NOT NULL THEN
        RAISE EXCEPTION 'FAIL: allowlist 外のテーブル（顧客/個別回答の疑い・要レビュー）: %', bad;
    END IF;
    RAISE NOTICE 'PASS 5.3a: table allowlist holds (no unknown tables)';

    -- tally 列 allowlist: 集計表は固定のカウンタ列のみ（remark 等の自由記述列の追加を検出）
    SELECT string_agg(table_name || '.' || column_name, ', ') INTO bad
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'survey_rating_tallies'
      AND column_name NOT IN ('id','store_id','period_month','star','count');
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'FAIL: survey_rating_tallies に想定外の列: %', bad; END IF;

    SELECT string_agg(table_name || '.' || column_name, ', ') INTO bad
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'survey_aspect_tallies'
      AND column_name NOT IN ('id','store_id','period_month','aspect_code','count');
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'FAIL: survey_aspect_tallies に想定外の列: %', bad; END IF;
    RAISE NOTICE 'PASS 5.3b: survey tallies are fixed anonymous counters (allowlist)';

    -- 二次ガード: 来店客 PII を匂わす列名の denylist（owners.line_user_id はオーナー識別子で対象外）
    SELECT string_agg(table_name || '.' || column_name, ', ') INTO bad
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name IN ('email','phone','phone_number','tel','address','ip_address','device_id','customer_id','customer_name');
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'FAIL: PII-bearing column(s): %', bad; END IF;
    RAISE NOTICE 'PASS 5.3c: no customer PII columns (denylist secondary guard)';
END $$;
