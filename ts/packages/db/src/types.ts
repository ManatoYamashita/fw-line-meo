// db/migrations/0001_four_tier_baseline.sql・0003_line_onboarding.sql・
// 0004_competitive_daily_summary.sql（summary_deliveries.status の CHECK は
// 0010_summary_notification_statuses.sql で作り直した）の DDL に厳密一致する列挙・行型。
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

// --- enum 相当（CHECK 制約と 1:1）---
// DailySummaryStatus は 0004 の列 CHECK、SummaryDeliveryStatus は 0010 の ck_summary_deliveries_status
// （0004 の無名の列 CHECK を 7 値で作り直したもの）と一致させる。
export type DailySummaryStatus = 'ready' | 'no_competitors' | 'failed';

/**
 * 通知記録（summary_deliveries）の status。店舗×日の 1 行が「通知を送ったか、送らなかったならなぜか」を表す。
 * 先頭の 4 値は 0004 からの値で、意味を変えない。後ろの 3 値は line-on-demand-report（0010）で足した
 * 「送らなかった理由」である。
 */
export type SummaryDeliveryStatus =
  /** 通知を push し、LINE が受理した。 */
  | 'delivered'
  /** push に失敗した、または予約した後に結果を記録できなかった。 */
  | 'failed'
  /** 当日の集計が無い。 */
  | 'skipped_no_summary'
  /** 月間の上限に達して送れなかった。 */
  | 'quota_exceeded'
  /** 比較可能だが、新着も順位変動も無い（前日の集計が無い場合を含む）。 */
  | 'skipped_no_change'
  /** 当日の集計が比較可能でない（取得失敗・評価を持つ競合なし・自店が未評価）。 */
  | 'skipped_not_comparable'
  /** 完了後メニューが準備されていない、またはオーナーへ張れなかった。 */
  | 'skipped_menu_unavailable';

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
  // 0005: 保留（未ログイン）行を email のみで表現するため NULL 許容。
  // ck_dashboard_users_identity により auth_subject / email の少なくとも一方は非 NULL。
  auth_subject: string | null;
  // 0005: Google ログイン用のスタッフ識別子（小文字正規化保存・lower(email) 部分一意）。
  email: string | null;
  display_name: string | null;
  // 0005: 無効化時刻（非 NULL = ログイン拒否・Req 6.4）。
  disabled_at: Date | null;
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
//
// 後ろの 3 項目は line-on-demand-report で足した口コミの帰属情報で、Go が空でないときだけ書く。
// 足す前に書かれた行の要素は 3 項目を持たない（null ではなくキーが無い）。行は 30 日で入れ替わる。
// line-on-demand-report の新着口コミのレポートは、項目の有無で「導線を取得できているか」を判定する
// （Google Maps 上の URL が無い口コミは内容を表示しない）。
export interface DailySummaryNewReview {
  authorName: string;
  publishTime: string;
  rating: number;
  textExcerpt: string;
  /** 投稿者のプロフィールの URL（Places API の authorAttribution.uri）。 */
  authorUri?: string;
  /** 投稿者のプロフィール画像の URL（Places API の authorAttribution.photoUri）。 */
  authorPhotoUri?: string;
  /** その口コミを Google Maps 上で表示する URL（Places API の Review.googleMapsUri）。 */
  googleMapsUri?: string;
}

// jsonb 列 competitors の要素形。表示順は rank 順（評価の無い店は末尾）。
//
// rating/starDiff は number（string ではない）: go/internal/repo/summaries.go の
// SummaryCompetitor は Rating/StarDiff を JSON 数値としてそのまま書き込む（フォーマット処理を
// 挟まない）。これは daily_summaries.rating のような「テーブル直下の numeric 列は pg ドライバが
// 精度保持のため文字列で返す」という規約（このファイル冒頭コメント）とは無関係で、jsonb 内に
// ネストされた数値は Go の json.Marshal → jsonb パーサ経由であり pg の numeric 文字列化は
// 適用されない（task 7.1 のクロスランタイム契約検証で発見・ts/apps/delivery-job/test/
// cross-runtime.e2e.test.ts のコメント参照）。
//
// null になりうる（Issue #255）: Google に評価が無い店（クチコミ 0 件で Places API が rating を
// 返さない）は rating が null、自店と競合のどちらかが評価なしなら starDiff も null。旧 Go は
// 評価の欠落をゼロ値 0 として書いていたため、読込側は必ず `@fwlm/db/daily-summary` の
// normalizeSummaryRatings を通してから使うこと（0 を null として読み、母数も補正する）。
export interface DailySummaryCompetitor {
  name: string;
  /** Google の星評価（1.0〜5.0）。評価の無い店は null。 */
  rating: number | null;
  reviewCount: number;
  /** 自店 − 競合（小数 1 桁）。自店と競合のどちらかが評価なしなら null。 */
  starDiff: number | null;
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
  /** その店舗の口コミ一覧を Google Maps で開く URL。取得できない日は NULL（Issue #303）。 */
  google_maps_reviews_uri: string | null;
  created_at: Date;
}

/**
 * daily_summaries の読み出し用の行（line-on-demand-report のレポート用の読み出しが返す）。
 *
 * summary_date は `to_char(summary_date, 'YYYY-MM-DD')` で読んだ文字列である（pg 既定の Date への
 * 変換は実行環境の TZ に依存するため使わない）。id・store_id・created_at は持たない。
 * 値は正規化の前の生の値なので、呼出元は必ず `@fwlm/db/daily-summary` の normalizeSummaryRatings を
 * 通してから使う。
 */
export interface DailySummaryReadRow {
  readonly summary_date: string;
  readonly status: DailySummaryStatus;
  readonly rank: number | null;
  readonly rank_total: number | null;
  readonly rank_prev: number | null;
  readonly rating: string | null; // numeric(2,1)
  readonly review_count: number | null;
  readonly rating_prev: string | null; // numeric(2,1)
  readonly review_count_prev: number | null;
  readonly new_review_count: number;
  readonly new_reviews: readonly DailySummaryNewReview[];
  readonly competitors: readonly DailySummaryCompetitor[];
  /**
   * その店舗の口コミ一覧を Google Maps で開く URL（Issue #303）。取得できない日は null。
   *
   * Places API は口コミを関連度順に最大 5 件しか返さず、新着順へ並べ替える手段を持たない。そのため
   * 口コミ数の多い店では新着の内容がここに届かない（本番では 30 日間 22 件の新着に対し抜粋 0 件だった）。
   * 内容を出せない新着があるとき、この URL が唯一の行き先になる（一覧の側なら新着順に読める）。
   */
  readonly google_maps_reviews_uri: string | null;
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
  suspendedAt: Date | null; // 停止時刻（Issue #252）。null は利用中
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
