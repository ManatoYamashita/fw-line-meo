-- E2E 用の最小 seed（確定店舗）。CI が適用し、store の id を E2E_STORE_ID として Playwright に渡す。
-- 匿名集計テーブルには触れない（客の回答が実際に加算する）。
INSERT INTO operators (id, name)
  VALUES ('11111111-1111-1111-1111-111111111111', 'E2E運営') ON CONFLICT DO NOTHING;
INSERT INTO agencies (id, operator_id, name)
  VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'E2E代理店') ON CONFLICT DO NOTHING;
INSERT INTO owners (id, agency_id, line_user_id, onboarding_status)
  VALUES ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'U-e2e', 'active') ON CONFLICT DO NOTHING;
INSERT INTO stores (id, owner_id, name, place_id, place_status)
  VALUES ('44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', 'E2E店', 'ChIJ_e2e', 'confirmed') ON CONFLICT DO NOTHING;
