// db/migrations/0001_four_tier_baseline.sql の DDL に厳密一致する列挙・行型。
// review-acquisition（機能3）が触れるテーブルのみを対象とする。
// pg 既定のパーサに従う: uuid/text = string, numeric = string（精度保持のため文字列）,
// smallint/integer = number, timestamptz/date = Date。

// --- enum 型（0001 冒頭の CREATE TYPE と 1:1）---
export type DashboardRole = 'operator' | 'agency';
export type OnboardingStatus = 'pending' | 'store_identified' | 'active';
export type PlaceStatus = 'pending' | 'confirmed';

// --- 4 階層テナント ---
export interface OperatorRow {
  id: string;
  name: string;
  created_at: Date;
}

export interface AgencyRow {
  id: string;
  operator_id: string;
  name: string;
  created_at: Date;
}

export interface OwnerRow {
  id: string;
  agency_id: string;
  line_user_id: string;
  display_name: string | null;
  onboarding_status: OnboardingStatus;
  created_at: Date;
}

export interface StoreRow {
  id: string;
  owner_id: string;
  category_code: string | null;
  name: string;
  latitude: string | null;
  longitude: string | null;
  place_id: string | null;
  place_status: PlaceStatus;
  created_at: Date;
}

export interface DashboardUserRow {
  id: string;
  role: DashboardRole;
  operator_id: string;
  agency_id: string | null;
  auth_subject: string;
  display_name: string | null;
  created_at: Date;
}

// --- 共有定数（seed が SoT・runtime は read のみ）---
export interface SurveyAspectRow {
  code: string;
  label: string;
}

// --- 匿名集計カウンタ（TS リアルタイム応答層が書込）---
export interface SurveyRatingTallyRow {
  id: string;
  store_id: string;
  period_month: Date;
  star: number;
  count: number;
}

export interface SurveyAspectTallyRow {
  id: string;
  store_id: string;
  period_month: Date;
  aspect_code: string;
  count: number;
}

// db/migrations/0003_line_onboarding.sql の DDL に厳密一致する列挙・行型。
// LINE オンボーディング（line-onboarding spec）が書込責任を持つ 3 表を対象とする。

// --- 会話段階 ENUM（0003 冒頭の CREATE TYPE と 1:1）---
export type OnboardingStage =
  | 'await_invite_code'
  | 'await_store_name'
  | 'await_confirmation'
  | 'completed';

// Google Places 由来の店舗候補（onboarding_sessions.candidates jsonb の要素型）。
// stores テーブルには address/types の格納列が無いため、確定時は name/lat/lng/place_id のみ永続化する。
export interface StoreCandidate {
  placeId: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  types: readonly string[];
}

export interface AgencyInviteCodeRow {
  id: string;
  agency_id: string;
  code: string;
  disabled_at: Date | null;
  created_at: Date;
}

export interface OnboardingSessionRow {
  line_user_id: string;
  stage: OnboardingStage;
  owner_id: string | null;
  candidates: StoreCandidate[] | null;
  selected_index: number | null;
  invite_failures: number;
  locked_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

// updateSession のパッチ入力。未指定キーは既存値を変更しない（undefined=不変・null=NULL に設定）。
export interface SessionPatch {
  stage?: OnboardingStage;
  ownerId?: string | null;
  candidates?: StoreCandidate[] | null;
  selectedIndex?: number | null;
  inviteFailures?: number;
  lockedUntil?: Date | null;
}

export interface WebhookEventRow {
  webhook_event_id: string;
  received_at: Date;
}
