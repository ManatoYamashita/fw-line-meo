package repo

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// NewReviewExcerpt は daily_summaries.new_reviews の1要素（帰属表示用・design.md Physical Data Model）。
type NewReviewExcerpt struct {
	AuthorName  string    `json:"authorName"`
	PublishTime time.Time `json:"publishTime"`
	Rating      float64   `json:"rating"`
	TextExcerpt string    `json:"textExcerpt"`
}

// SummaryCompetitor は daily_summaries.competitors の1要素（表示順は rank 順・design.md）。
type SummaryCompetitor struct {
	Name        string  `json:"name"`
	Rating      float64 `json:"rating"`
	ReviewCount int     `json:"reviewCount"`
	StarDiff    float64 `json:"starDiff"`
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

	_, err = db.Exec(ctx, `
		INSERT INTO daily_summaries (
			store_id, summary_date, status,
			rank, rank_total, rank_prev,
			rating, review_count, rating_prev, review_count_prev,
			new_review_count, new_reviews, competitors
		) VALUES (
			$1, $2, $3,
			$4, $5, $6,
			$7, $8, $9, $10,
			$11, $12, $13
		)
		ON CONFLICT (store_id, summary_date) DO UPDATE SET
			status             = EXCLUDED.status,
			rank               = EXCLUDED.rank,
			rank_total         = EXCLUDED.rank_total,
			rank_prev          = EXCLUDED.rank_prev,
			rating             = EXCLUDED.rating,
			review_count       = EXCLUDED.review_count,
			rating_prev        = EXCLUDED.rating_prev,
			review_count_prev  = EXCLUDED.review_count_prev,
			new_review_count   = EXCLUDED.new_review_count,
			new_reviews        = EXCLUDED.new_reviews,
			competitors        = EXCLUDED.competitors
	`,
		in.StoreID, in.SummaryDate, in.Status,
		in.Rank, in.RankTotal, in.RankPrev,
		in.Rating, in.ReviewCount, in.RatingPrev, in.ReviewCountPrev,
		in.NewReviewCount, newReviewsJSON, competitorsJSON,
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
