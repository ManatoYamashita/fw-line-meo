// db/migrations/0001_four_tier_baseline.sql・0004_competitive_daily_summary.sql の DDL に
// 厳密一致する列挙・行型。review-acquisition（機能3）・competitive-daily-summary（機能1）が
// 触れるテーブルのみを対象とする。
// pg 既定のパーサに従う: uuid/text = string, numeric = string（精度保持のため文字列）,
// smallint/integer = number, bigint = string（int8 は精度保持のため文字列でパースされる）,
// timestamptz/date = Date, jsonb = パース済み値。

// --- 共通ユーティリティ型 ---
// 例外を投げず型付きエラーで失敗を表現する箇所（design.md の Service Interface 契約）向け。
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

// --- enum 型（0001 冒頭の CREATE TYPE と 1:1）---
export type DashboardRole = 'operator' | 'agency';
export type OnboardingStatus = 'pending' | 'store_identified' | 'active';
export type PlaceStatus = 'pending' | 'confirmed';

// --- enum 相当（0004 の CHECK 制約と 1:1）---
export type DailySummaryStatus = 'ready' | 'no_competitors' | 'failed';
export type SummaryDeliveryStatus = 'delivered' | 'failed' | 'skipped_no_summary' | 'quota_exceeded';

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
  // 0004: 配信時刻（JST・時単位・0-23・デフォルト 7）。
  delivery_hour: number;
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

// --- competitive-daily-summary（機能1・0004）---
// jsonb 列 new_reviews の要素形。帰属表示用（新着は自店のみ・Req 3.5）。
export interface DailySummaryNewReview {
  authorName: string;
  publishTime: string;
  rating: number;
  textExcerpt: string;
}

// jsonb 列 competitors の要素形。表示順は rank 順。
export interface DailySummaryCompetitor {
  name: string;
  rating: string | null;
  reviewCount: number | null;
  starDiff: string | null;
}

// 日次サマリー（Go 書込・店舗×日付で一意・生成後は不変）。
export interface DailySummaryRow {
  id: string; // bigint
  store_id: string;
  summary_date: Date;
  status: DailySummaryStatus;
  rank: number | null; // failed 時 NULL
  rank_total: number | null;
  rank_prev: number | null; // 前日なしは NULL（R3.7）
  rating: string | null; // numeric(2,1)
  review_count: number | null;
  rating_prev: string | null; // numeric(2,1)
  review_count_prev: number | null;
  new_review_count: number;
  new_reviews: DailySummaryNewReview[];
  competitors: DailySummaryCompetitor[];
  created_at: Date;
}

// 配信記録（TS 書込・店舗×日付で一意・retry_key で冪等再送）。
export interface SummaryDeliveryRow {
  id: string; // bigint
  store_id: string;
  summary_date: Date;
  line_user_id: string;
  status: SummaryDeliveryStatus;
  retry_key: string;
  line_request_id: string | null;
  error_detail: string | null;
  delivered_at: Date | null;
  created_at: Date;
}
