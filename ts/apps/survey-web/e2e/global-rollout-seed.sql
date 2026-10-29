-- 全店公開（SURVEY_FORCE_STRUCTURED=1・Issue #441）の E2E 用の seed。seed.sql・structured-seed.sql の後に当てる
-- （運営・代理店・オーナーを共有する）。
--
-- 全店公開で新アンケートに切り替わるのは、structured を個別に有効にしていない店舗である。その 2 つの状態を作る:
--   - 設定行なし（store_survey_configs の行が無い。既存店舗・新規店舗の大半がこれ）
--   - 個別 OFF（設定行はあるが structured_enabled = false。料理名は登録済み）
-- どちらも、フラグの無いサーバーでは legacy の画面になる店舗である。本番の店舗はこのファイルの影響を受けない。
-- 冪等（何度当ててもよい）。E2E の fixture（e2e/fixtures/global-rollout.ts）はこのファイルから店舗の id と店名を読む。
INSERT INTO stores (id, owner_id, name, place_id, place_status)
  VALUES ('66666666-6666-4666-8666-666666666601', '33333333-3333-3333-3333-333333333333', '全店公開 設定なしの店（E2E）', 'ChIJ_e2e_global_rollout_no_config', 'confirmed')
  ON CONFLICT DO NOTHING;
INSERT INTO stores (id, owner_id, name, place_id, place_status)
  VALUES ('66666666-6666-4666-8666-666666666602', '33333333-3333-3333-3333-333333333333', '全店公開 個別OFFの店（E2E）', 'ChIJ_e2e_global_rollout_disabled', 'confirmed')
  ON CONFLICT DO NOTHING;
INSERT INTO store_survey_configs (store_id, structured_enabled)
  VALUES ('66666666-6666-4666-8666-666666666602', false)
  ON CONFLICT (store_id) DO UPDATE SET structured_enabled = false;
INSERT INTO store_survey_targets (id, store_id, category_code, label, sort_order) VALUES
  ('66666666-0000-4000-8000-0000000000a1', '66666666-6666-4666-8666-666666666602', 'food', '日替わり定食', 0)
  ON CONFLICT DO NOTHING;
