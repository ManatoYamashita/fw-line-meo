// db/migrations/0001_four_tier_baseline.sql・0003_line_onboarding.sql・
// 0004_competitive_daily_summary.sql の DDL に厳密一致する列挙・行型。
// review-acquisition（機能3）・line-onboarding（LINE基盤）・competitive-daily-summary（機能1）が
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
//
// rating/starDiff は number（string ではない）: go/internal/repo/summaries.go の
// SummaryCompetitor は Rating/StarDiff を float64 で保持し encoding/json でそのまま JSON数値と
// して書き込む（go/internal/batch/run.go の書込元も同様、フォーマット処理を挟まない）。これは
// daily_summaries.rating のような「テーブル直下の numeric 列は pg ドライバが精度保持のため
// 文字列で返す」という規約（このファイル冒頭コメント）とは無関係で、jsonb 内にネストされた
// 数値は Go の json.Marshal → jsonb パーサ経由であり pg の numeric 文字列化は適用されない。
// task 7.1（クロスランタイム契約検証）で発見: 修正前は `string | null` と誤って宣言されていた
// （実行時の値は常に number で null にもならない。詳細は
// ts/apps/delivery-job/test/cross-runtime.e2e.test.ts のコメント参照）。
export interface DailySummaryCompetitor {
  name: string;
  rating: number;
  reviewCount: number;
  starDiff: number;
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

// --- agency-dashboard（ダッシュボード一覧・作成アクセサの戻り型・camelCase）---
// DAL の行→camelCase 写像規約に従う。書込は TS 層所有テーブルのみ（competitors は read のみ）。

// 店舗一覧の 1 行（stores×owners×agencies JOIN＋competitors(active) EXISTS）。
export interface StoreListItem {
  id: string;
  name: string;
  placeStatus: PlaceStatus;
  competitorConfigured: boolean; // EXISTS competitors WHERE store_id=... AND active
  ownerId: string;
  ownerDisplayName: string | null;
  agencyId: string;
  agencyName: string;
  createdAt: Date;
}

// 代理店配下オーナー一覧の 1 行。
export interface OwnerListItem {
  id: string;
  displayName: string | null;
  onboardingStatus: OnboardingStatus;
  createdAt: Date;
}

// 招待コード一覧・作成・無効化の戻り型（disabled = disabled_at IS NOT NULL）。
export interface InviteCodeItem {
  id: string;
  agencyId: string;
  code: string;
  disabled: boolean;
  createdAt: Date;
}

// 代理店の作成・一覧の戻り型。
export interface AgencyItem {
  id: string;
  operatorId: string;
  name: string;
  createdAt: Date;
}

// ダッシュボード利用者の管理（運営）向け戻り型（作成・一覧・無効化）。
// design.md は本型の形状を明示していないため dashboard_users DDL＋consumer 需要から派生:
// disabled_at → disabled boolean に写像し、email/display_name は保留行/既存行で NULL があり得るため nullable。
export interface DashboardUserItem {
  id: string;
  role: DashboardRole;
  operatorId: string;
  agencyId: string | null;
  email: string | null;
  displayName: string | null;
  disabled: boolean;
  createdAt: Date;
}
