-- structured survey（Issue #438）の E2E・ローカル確認用の seed。seed.sql の後に当てる（運営・代理店・オーナーを共有する）。
--
-- seed.sql の確定店舗（legacy のまま・4 箇所で storeId を一致させる正典）とは **別の店舗** を作り、その店舗だけ
-- structured survey を有効にする。structured の有効化は店舗オーナーの操作に無い（Issue #437 の Stage 1）ので、
-- ローカル・テストの fixture として設定行を直接作る。本番の店舗はこのファイルの影響を受けない。
--
-- Target（料理名・ドリンク名）は、店舗詳細のアンケート設定画面と同じ形（store_survey_targets・active・並び）で置く。
-- 設定画面から追加・変更した Target も、この店舗のアンケートにそのまま現れる。
-- 冪等（何度当ててもよい）。E2E の fixture（e2e/fixtures/structured.ts）はこのファイルから店舗の id を読む。
INSERT INTO stores (id, owner_id, name, place_id, place_status)
  VALUES ('55555555-5555-4555-8555-555555555555', '33333333-3333-3333-3333-333333333333', '海鮮酒場 うみのて（構造化アンケート）', 'ChIJ_e2e_structured_survey_store', 'confirmed')
  ON CONFLICT DO NOTHING;
INSERT INTO store_survey_configs (store_id, structured_enabled)
  VALUES ('55555555-5555-4555-8555-555555555555', true)
  ON CONFLICT (store_id) DO UPDATE SET structured_enabled = true;
INSERT INTO store_survey_targets (id, store_id, category_code, label, sort_order) VALUES
  ('55555555-0000-4000-8000-0000000000a1', '55555555-5555-4555-8555-555555555555', 'food', '刺身盛り合わせ', 0),
  ('55555555-0000-4000-8000-0000000000a2', '55555555-5555-4555-8555-555555555555', 'food', '焼き鳥5種盛り', 1),
  ('55555555-0000-4000-8000-0000000000b1', '55555555-5555-4555-8555-555555555555', 'drink', '自家製レモンサワー', 0)
  ON CONFLICT DO NOTHING;
