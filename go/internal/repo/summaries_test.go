package repo

import (
	"context"
	"testing"
	"time"
)

func TestWriteDailySummary_SameDayTwice_DoesNotDuplicate_FullReplace(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	storeID := seedStore(t, ctx, pool, "U-summary-rerun", "place-self-summary-rerun")

	today := dateOnly(t, "2026-07-12")
	rank1, total1, rating1, reviews1 := 2, 3, 4.1, 50

	if err := WriteDailySummary(ctx, pool, DailySummaryInput{
		StoreID: storeID, SummaryDate: today, Status: "ready",
		Rank: &rank1, RankTotal: &total1, Rating: &rating1, ReviewCount: &reviews1,
		NewReviewCount: 0,
	}); err != nil {
		t.Fatalf("WriteDailySummary (1st): %v", err)
	}

	rank2, total2, rating2, reviews2 := 1, 3, 4.5, 55
	if err := WriteDailySummary(ctx, pool, DailySummaryInput{
		StoreID: storeID, SummaryDate: today, Status: "ready",
		Rank: &rank2, RankTotal: &total2, Rating: &rating2, ReviewCount: &reviews2,
		NewReviewCount: 2,
		NewReviews: []NewReviewExcerpt{
			{AuthorName: "Aさん", PublishTime: today, Rating: 5, TextExcerpt: "美味しかった"},
		},
		Competitors: []SummaryCompetitor{
			{Name: "競合A", Rating: f64p(4.0), ReviewCount: 30, StarDiff: f64p(0.5)},
		},
	}); err != nil {
		t.Fatalf("WriteDailySummary (2nd, same day): %v", err)
	}

	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM daily_summaries WHERE store_id = $1 AND summary_date = $2`, storeID, today).Scan(&n); err != nil {
		t.Fatalf("count query: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected exactly 1 row after same-day re-run, got %d", n)
	}

	var gotRank, gotTotal, gotNewCount int
	var gotRating float64
	var newReviewsJSON, competitorsJSON []byte
	err := pool.QueryRow(ctx, `
		SELECT rank, rank_total, rating, new_review_count, new_reviews, competitors
		FROM daily_summaries WHERE store_id = $1 AND summary_date = $2
	`, storeID, today).Scan(&gotRank, &gotTotal, &gotRating, &gotNewCount, &newReviewsJSON, &competitorsJSON)
	if err != nil {
		t.Fatalf("select after 2nd write: %v", err)
	}
	if gotRank != 1 || gotRating != 4.5 || gotNewCount != 2 {
		t.Fatalf("expected full replace by 2nd write (rank=1, rating=4.5, new_review_count=2), got rank=%d rating=%v new_review_count=%d", gotRank, gotRating, gotNewCount)
	}
	if string(newReviewsJSON) == "[]" {
		t.Fatalf("expected new_reviews to be replaced with non-empty JSON, got %s", newReviewsJSON)
	}
	if string(competitorsJSON) == "[]" {
		t.Fatalf("expected competitors to be replaced with non-empty JSON, got %s", competitorsJSON)
	}
}

func TestWriteDailySummary_NoCompetitors_DefaultsToEmptyJSONArrays(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	storeID := seedStore(t, ctx, pool, "U-summary-no-competitors", "place-self-no-comp")

	today := dateOnly(t, "2026-07-12")
	rank, total, rating, reviews := 1, 1, 4.0, 10

	if err := WriteDailySummary(ctx, pool, DailySummaryInput{
		StoreID: storeID, SummaryDate: today, Status: "no_competitors",
		Rank: &rank, RankTotal: &total, Rating: &rating, ReviewCount: &reviews,
	}); err != nil {
		t.Fatalf("WriteDailySummary: %v", err)
	}

	var status string
	var newReviewsJSON, competitorsJSON []byte
	err := pool.QueryRow(ctx, `SELECT status, new_reviews, competitors FROM daily_summaries WHERE store_id = $1 AND summary_date = $2`, storeID, today).
		Scan(&status, &newReviewsJSON, &competitorsJSON)
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	if status != "no_competitors" {
		t.Fatalf("expected status=no_competitors, got %q", status)
	}
	if string(newReviewsJSON) != "[]" || string(competitorsJSON) != "[]" {
		t.Fatalf("expected empty JSON arrays for nil slices, got new_reviews=%s competitors=%s", newReviewsJSON, competitorsJSON)
	}
}

func TestPurgeOlderThan_30DayBoundary(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	storeID := seedStore(t, ctx, pool, "U-purge-boundary", "place-self-purge")

	asOf := dateOnly(t, "2026-07-12")
	cutoff := asOf.AddDate(0, 0, -30)     // 2026-06-12 — 境界ちょうど（パージ対象）
	justInside := cutoff.AddDate(0, 0, 1) // 2026-06-13 — 30日目（保持対象）
	wellInside := asOf.AddDate(0, 0, -1)  // 2026-07-11 — 明らかに保持対象

	for _, d := range []time.Time{cutoff, justInside, wellInside} {
		if err := WriteSelfSnapshot(ctx, pool, storeID, SnapshotWrite{
			PlaceID: "place-self-purge", CapturedOn: d, Rating: f64p(4.0), ReviewCount: 1, Rank: intp(1),
		}); err != nil {
			t.Fatalf("WriteSelfSnapshot(%s): %v", d.Format(time.DateOnly), err)
		}
		rank, total, rating, reviews := 1, 1, 4.0, 1
		if err := WriteDailySummary(ctx, pool, DailySummaryInput{
			StoreID: storeID, SummaryDate: d, Status: "ready",
			Rank: &rank, RankTotal: &total, Rating: &rating, ReviewCount: &reviews,
		}); err != nil {
			t.Fatalf("WriteDailySummary(%s): %v", d.Format(time.DateOnly), err)
		}
	}

	result, err := PurgeOlderThan(ctx, pool, asOf)
	if err != nil {
		t.Fatalf("PurgeOlderThan: %v", err)
	}
	if result.SnapshotsDeleted != 1 {
		t.Fatalf("expected exactly 1 snapshot purged (the cutoff-boundary row), got %d", result.SnapshotsDeleted)
	}
	if result.SummariesDeleted != 1 {
		t.Fatalf("expected exactly 1 summary purged (the cutoff-boundary row), got %d", result.SummariesDeleted)
	}

	remainingSnapshot, err := SnapshotsOn(ctx, pool, storeID, cutoff)
	if err != nil {
		t.Fatalf("SnapshotsOn(cutoff): %v", err)
	}
	if len(remainingSnapshot) != 0 {
		t.Fatalf("expected cutoff-boundary snapshot to be purged, still found %+v", remainingSnapshot)
	}

	remainingJustInside, err := SnapshotsOn(ctx, pool, storeID, justInside)
	if err != nil {
		t.Fatalf("SnapshotsOn(justInside): %v", err)
	}
	if len(remainingJustInside) != 1 {
		t.Fatalf("expected just-inside-30-days snapshot to be retained, got %d rows", len(remainingJustInside))
	}

	var summaryStillExists bool
	err = pool.QueryRow(ctx, `SELECT true FROM daily_summaries WHERE store_id = $1 AND summary_date = $2`, storeID, justInside).Scan(&summaryStillExists)
	if err != nil {
		t.Fatalf("expected just-inside-30-days summary to be retained, query failed: %v", err)
	}

	var cutoffSummaryExists bool
	err = pool.QueryRow(ctx, `SELECT true FROM daily_summaries WHERE store_id = $1 AND summary_date = $2`, storeID, cutoff).Scan(&cutoffSummaryExists)
	if err == nil {
		t.Fatalf("expected cutoff-boundary summary to be purged, but it still exists")
	}
}

// Issue #255: 評価の無い競合は rating・starDiff を JSON の null として書く（キーを省かない）。
// TS 側の DailySummaryCompetitor は `number | null` のキーの存在を前提にし、0 を書くと「★0」に化ける。
// 自店が評価なしの日は rating・rank・rank_total を NULL で書く（取得失敗ではないので status は ready）。
func TestWriteDailySummary_UnratedWritesNullsNotZeros(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	storeID := seedStore(t, ctx, pool, "U-summary-unrated", "place-self-summary-unrated")

	today := dateOnly(t, "2026-07-12")
	reviews := 0
	if err := WriteDailySummary(ctx, pool, DailySummaryInput{
		StoreID: storeID, SummaryDate: today, Status: "ready",
		Rank: nil, RankTotal: nil, Rating: nil, ReviewCount: &reviews,
		Competitors: []SummaryCompetitor{
			{Name: "競合A", Rating: f64p(4.5), ReviewCount: 100, StarDiff: nil},
			{Name: "競合B", Rating: nil, ReviewCount: 0, StarDiff: nil},
		},
	}); err != nil {
		t.Fatalf("WriteDailySummary: %v", err)
	}

	var status string
	var rankNull, totalNull, ratingNull bool
	var aRating, aStarDiff, bRating, bStarDiff, bHasRatingKey string
	if err := pool.QueryRow(ctx, `
		SELECT status, rank IS NULL, rank_total IS NULL, rating IS NULL,
		       jsonb_typeof(competitors->0->'rating'), jsonb_typeof(competitors->0->'starDiff'),
		       jsonb_typeof(competitors->1->'rating'), jsonb_typeof(competitors->1->'starDiff'),
		       (competitors->1 ? 'rating')::text
		FROM daily_summaries WHERE store_id = $1 AND summary_date = $2
	`, storeID, today).Scan(&status, &rankNull, &totalNull, &ratingNull, &aRating, &aStarDiff, &bRating, &bStarDiff, &bHasRatingKey); err != nil {
		t.Fatalf("select: %v", err)
	}

	if status != "ready" || !rankNull || !totalNull || !ratingNull {
		t.Errorf("status=%s rank IS NULL=%v rank_total IS NULL=%v rating IS NULL=%v, want ready/true/true/true", status, rankNull, totalNull, ratingNull)
	}
	if aRating != "number" || aStarDiff != "null" {
		t.Errorf("競合A rating/starDiff types = %s/%s, want number/null", aRating, aStarDiff)
	}
	if bRating != "null" || bStarDiff != "null" || bHasRatingKey != "true" {
		t.Errorf("競合B rating/starDiff types = %s/%s (key present=%s), want null/null (key present=true)", bRating, bStarDiff, bHasRatingKey)
	}
}
