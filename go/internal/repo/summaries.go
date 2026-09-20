package repo

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// NewReviewExcerpt は daily_summaries.new_reviews の1要素（帰属表示用・design.md Physical Data Model）。
//
// 後ろの 3 項目は口コミの帰属情報（line-on-demand-report Req 8.2・8.6・8.7）で、空のときはキーごと
// 書かない（omitempty。空文字も null も書かない）。line-on-demand-report の新着口コミのレポート
// （TS・DailySummaryNewReview の任意項目）は、googleMapsUri のキーがあり https の絶対 URL であるときに
// 「Google Maps への導線を取得できている」とし、導線の無い口コミは内容を表示しない。
// 3 項目を足す前に書かれた行の要素も、キーを持たない同じ形になる。
type NewReviewExcerpt struct {
	AuthorName  string    `json:"authorName"`
	PublishTime time.Time `json:"publishTime"`
	Rating      float64   `json:"rating"`
	TextExcerpt string    `json:"textExcerpt"`

	// AuthorURI は投稿者のプロフィールの URL。
	AuthorURI string `json:"authorUri,omitempty"`
	// AuthorPhotoURI は投稿者のプロフィール画像の URL。
	AuthorPhotoURI string `json:"authorPhotoUri,omitempty"`
	// GoogleMapsURI はその口コミを Google Maps で開く URL。
	GoogleMapsURI string `json:"googleMapsUri,omitempty"`
}

// SummaryCompetitor は daily_summaries.competitors の1要素（表示順は rank 順・評価なしは末尾・design.md）。
//
// Rating は Google の星評価、StarDiff は「自店 − 競合」。評価の無い店（クチコミ 0 件）は Rating が、
// 自店と競合のどちらかが評価なしなら StarDiff が nil で、JSON では null として書く（キーは省かない。
// TS 側の DailySummaryCompetitor は `number | null` のキーの存在を前提にする・Issue #255）。
type SummaryCompetitor struct {
	Name        string   `json:"name"`
	Rating      *float64 `json:"rating"`
	ReviewCount int      `json:"reviewCount"`
	StarDiff    *float64 `json:"starDiff"`
}

// DailySummaryInput は daily_summaries への確定書込値（design.md Domain Model:
// 「生成後は不変（再実行時は全置換）」）。
type DailySummaryInput struct {
	StoreID     string
	SummaryDate time.Time
	Status      string // "ready" | "no_competitors" | "failed"

	Rank      *int
	RankTotal *int
	RankPrev  *int

	Rating      *float64
	ReviewCount *int

	RatingPrev      *float64
	ReviewCountPrev *int

	NewReviewCount int
	NewReviews     []NewReviewExcerpt
	Competitors    []SummaryCompetitor

	// GoogleMapsReviewsURI はその店舗の口コミ一覧を Google Maps で開く URL（Issue #303）。
	// 空文字のときは NULL を書く（空文字の href を読み手に描かせないため。0011 のヘッダを参照）。
	GoogleMapsReviewsURI string
}

// WriteDailySummary は店舗×日付の daily_summaries 行を確定する。R2.6（同日再実行で
// 重複させない）と design.md「生成後は不変（再実行時は全置換）」を UNIQUE(store_id,
// summary_date) への ON CONFLICT DO UPDATE（全カラム置換）で担保する。
func WriteDailySummary(ctx context.Context, db DBTX, in DailySummaryInput) error {
	newReviews := in.NewReviews
	if newReviews == nil {
		newReviews = []NewReviewExcerpt{}
	}
	competitors := in.Competitors
	if competitors == nil {
		competitors = []SummaryCompetitor{}
	}

	newReviewsJSON, err := json.Marshal(newReviews)
	if err != nil {
		return fmt.Errorf("repo: marshal new_reviews store_id=%s: %w", in.StoreID, err)
	}
	competitorsJSON, err := json.Marshal(competitors)
	if err != nil {
		return fmt.Errorf("repo: marshal competitors store_id=%s: %w", in.StoreID, err)
	}

	// 空文字は NULL として書く（列は NULL 許容。0011 のヘッダに理由がある）。
	var reviewsURI any
	if in.GoogleMapsReviewsURI != "" {
		reviewsURI = in.GoogleMapsReviewsURI
	}

	_, err = db.Exec(ctx, `
		INSERT INTO daily_summaries (
			store_id, summary_date, status,
			rank, rank_total, rank_prev,
			rating, review_count, rating_prev, review_count_prev,
			new_review_count, new_reviews, competitors,
			google_maps_reviews_uri
		) VALUES (
			$1, $2, $3,
			$4, $5, $6,
			$7, $8, $9, $10,
			$11, $12, $13,
			$14
		)
		ON CONFLICT (store_id, summary_date) DO UPDATE SET
			status                  = EXCLUDED.status,
			rank                    = EXCLUDED.rank,
			rank_total              = EXCLUDED.rank_total,
			rank_prev               = EXCLUDED.rank_prev,
			rating                  = EXCLUDED.rating,
			review_count            = EXCLUDED.review_count,
			rating_prev             = EXCLUDED.rating_prev,
			review_count_prev       = EXCLUDED.review_count_prev,
			new_review_count        = EXCLUDED.new_review_count,
			new_reviews             = EXCLUDED.new_reviews,
			competitors             = EXCLUDED.competitors,
			google_maps_reviews_uri = EXCLUDED.google_maps_reviews_uri
	`,
		in.StoreID, in.SummaryDate, in.Status,
		in.Rank, in.RankTotal, in.RankPrev,
		in.Rating, in.ReviewCount, in.RatingPrev, in.ReviewCountPrev,
		in.NewReviewCount, newReviewsJSON, competitorsJSON,
		reviewsURI,
	)
	if err != nil {
		return fmt.Errorf("repo: write daily summary store_id=%s summary_date=%s: %w", in.StoreID, in.SummaryDate.Format(time.DateOnly), err)
	}
	return nil
}

// PurgeResult は30日超パージの結果件数（design.md 5.2: 実行サマリーの purged フィールド）。
type PurgeResult struct {
	SnapshotsDeleted int64
	SummariesDeleted int64
}

// PurgeOlderThan は rating_snapshots・daily_summaries の両方から、asOf を基準に
// 30日を超えて古い行を削除する（research.md Decision「Places データの保持は30日ローリング」）。
//
// 境界の定義: 「直近30日を asOf 含めて保持」＝保持対象は captured_on/summary_date が
// [asOf-29日, asOf] の範囲（30個の日付）。カットオフを cutoff = asOf の日付部分から30日
// 前の日付とし、captured_on/summary_date <= cutoff の行を削除する
// （cutoff ちょうど＝31日目の記録はパージ対象、cutoff+1日＝30日目の記録は保持対象）。
func PurgeOlderThan(ctx context.Context, db DBTX, asOf time.Time) (PurgeResult, error) {
	cutoff := asOf.AddDate(0, 0, -30)

	var result PurgeResult

	snapTag, err := db.Exec(ctx, `DELETE FROM rating_snapshots WHERE captured_on <= $1`, cutoff)
	if err != nil {
		return PurgeResult{}, fmt.Errorf("repo: purge rating_snapshots cutoff=%s: %w", cutoff.Format(time.DateOnly), err)
	}
	result.SnapshotsDeleted = snapTag.RowsAffected()

	summaryTag, err := db.Exec(ctx, `DELETE FROM daily_summaries WHERE summary_date <= $1`, cutoff)
	if err != nil {
		return PurgeResult{}, fmt.Errorf("repo: purge daily_summaries cutoff=%s: %w", cutoff.Format(time.DateOnly), err)
	}
	result.SummariesDeleted = summaryTag.RowsAffected()

	return result, nil
}
