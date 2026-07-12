package repo

import (
	"context"
	"fmt"
	"time"
)

// Snapshot は rating_snapshots テーブルの1行の読取用表現。
type Snapshot struct {
	StoreID      string
	SubjectKind  string // "self" | "competitor"
	CompetitorID *string
	PlaceID      string
	CapturedOn   time.Time
	Rating       *float64
	ReviewCount  *int
	Rank         *int
}

// SnapshotWrite は自店/競合いずれかの当日スナップショット書込値。
type SnapshotWrite struct {
	PlaceID     string
	CapturedOn  time.Time
	Rating      float64
	ReviewCount int
	Rank        int
}

// WriteSelfSnapshot は自店の当日スナップショットを書き込む。R2.6（同日再実行で重複させない）
// を rating_snapshots の部分一意 index ux_rs_self (store_id, captured_on) WHERE subject_kind='self'
// への ON CONFLICT で担保する — 同日 2 回書込は 1 行に収束し、値は最新の呼出で全置換される。
func WriteSelfSnapshot(ctx context.Context, db DBTX, storeID string, w SnapshotWrite) error {
	_, err := db.Exec(ctx, `
		INSERT INTO rating_snapshots (store_id, subject_kind, competitor_id, place_id, captured_on, rating, review_count, rank)
		VALUES ($1, 'self', NULL, $2, $3, $4, $5, $6)
		ON CONFLICT (store_id, captured_on) WHERE subject_kind = 'self'
		DO UPDATE SET place_id = EXCLUDED.place_id,
		              rating = EXCLUDED.rating,
		              review_count = EXCLUDED.review_count,
		              rank = EXCLUDED.rank
	`, storeID, w.PlaceID, w.CapturedOn, w.Rating, w.ReviewCount, w.Rank)
	if err != nil {
		return fmt.Errorf("repo: write self snapshot store_id=%s captured_on=%s: %w", storeID, w.CapturedOn.Format(time.DateOnly), err)
	}
	return nil
}

// WriteCompetitorSnapshot は競合1店の当日スナップショットを書き込む。R2.6 は部分一意 index
// ux_rs_comp (store_id, competitor_id, captured_on) WHERE subject_kind='competitor' への
// ON CONFLICT で担保する（WriteSelfSnapshot と同様、同日再実行は重複せず全置換）。
func WriteCompetitorSnapshot(ctx context.Context, db DBTX, storeID, competitorID string, w SnapshotWrite) error {
	_, err := db.Exec(ctx, `
		INSERT INTO rating_snapshots (store_id, subject_kind, competitor_id, place_id, captured_on, rating, review_count, rank)
		VALUES ($1, 'competitor', $2, $3, $4, $5, $6, $7)
		ON CONFLICT (store_id, competitor_id, captured_on) WHERE subject_kind = 'competitor'
		DO UPDATE SET place_id = EXCLUDED.place_id,
		              rating = EXCLUDED.rating,
		              review_count = EXCLUDED.review_count,
		              rank = EXCLUDED.rank
	`, storeID, competitorID, w.PlaceID, w.CapturedOn, w.Rating, w.ReviewCount, w.Rank)
	if err != nil {
		return fmt.Errorf("repo: write competitor snapshot store_id=%s competitor_id=%s captured_on=%s: %w", storeID, competitorID, w.CapturedOn.Format(time.DateOnly), err)
	}
	return nil
}

// SnapshotsOn は指定店舗の指定日（自店＋競合すべて）のスナップショットを返す。
// 前日データが無い場合（R3.7: 初回配信等）は空スライスを返す — 呼出元（batch/run・task 3.5）は
// これを空/自店なしと判定して rank_prev・前日比を省略する。
func SnapshotsOn(ctx context.Context, db DBTX, storeID string, capturedOn time.Time) ([]Snapshot, error) {
	rows, err := db.Query(ctx, `
		SELECT store_id, subject_kind, competitor_id, place_id, captured_on, rating, review_count, rank
		FROM rating_snapshots
		WHERE store_id = $1 AND captured_on = $2
		ORDER BY subject_kind, competitor_id
	`, storeID, capturedOn)
	if err != nil {
		return nil, fmt.Errorf("repo: query snapshots store_id=%s captured_on=%s: %w", storeID, capturedOn.Format(time.DateOnly), err)
	}
	defer rows.Close()

	var snapshots []Snapshot
	for rows.Next() {
		var s Snapshot
		if err := rows.Scan(&s.StoreID, &s.SubjectKind, &s.CompetitorID, &s.PlaceID, &s.CapturedOn, &s.Rating, &s.ReviewCount, &s.Rank); err != nil {
			return nil, fmt.Errorf("repo: scan snapshot: %w", err)
		}
		snapshots = append(snapshots, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("repo: iterate snapshots store_id=%s captured_on=%s: %w", storeID, capturedOn.Format(time.DateOnly), err)
	}
	return snapshots, nil
}
