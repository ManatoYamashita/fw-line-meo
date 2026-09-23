package batch

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// setStoreSuspended は停止時刻を SQL で直接立てる・外す（suspended=false で再開）。停止の操作は
// dashboard-api の責務なので、日次バッチの試験はその操作に依存しない。
func setStoreSuspended(t *testing.T, ctx context.Context, pool *pgxpool.Pool, storeID string, suspended bool) {
	t.Helper()
	query := `UPDATE stores SET suspended_at = NULL WHERE id = $1`
	if suspended {
		query = `UPDATE stores SET suspended_at = now() WHERE id = $1`
	}
	tag, err := pool.Exec(ctx, query, storeID)
	if err != nil {
		t.Fatalf("set suspended=%v for store_id=%s: %v", suspended, storeID, err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("set suspended=%v for store_id=%s: rows affected = %d, want 1", suspended, storeID, tag.RowsAffected())
	}
}

func countRows(t *testing.T, ctx context.Context, pool *pgxpool.Pool, query string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, query, args...).Scan(&n); err != nil {
		t.Fatalf("count rows (%s): %v", query, err)
	}
	return n
}

// TestRun_SuspendedStore_SkippedThenFirstSummaryAfterResumeHasNoPriorDay は、停止中の店舗が
// 日次取得の対象から外れ（取得・抽出・集計のどれも行わず、対象店舗数にも数えない）、再開後の
// 最初の集計が前日の集計を持たないため前日比を持たず新着を 0 とすることを検証する
// （store-suspension Requirements 3.1–3.6）。
//
// 停止前（2 日前）のスナップショットを置き、停止中の日（前日）には Places が口コミを 30 件と返す
// ように構えておく。停止の述語が無ければ前日の行が作られ、再開後の集計が前日比と新着 10 件を持つ。
func TestRun_SuspendedStore_SkippedThenFirstSummaryAfterResumeHasNoPriorDay(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)

	activeStore := seedConfirmedStore(t, ctx, pool, "U-batch-suspension-active", "suspension-active-self", 35.5, 139.5)
	seedFixedCompetitor(t, ctx, pool, activeStore, "suspension-active-comp", "利用中の競合")

	// 停止する店舗は競合を未固定のままにし、競合の抽出（Nearby Search）の対象からも外れることを見る。
	suspendedStore := seedConfirmedStore(t, ctx, pool, "U-batch-suspension-target", "suspension-target-self", 35.6, 139.6)

	dayAfterResume := time.Date(2026, 7, 12, 6, 0, 0, 0, jst)
	daySuspended := dayAfterResume.AddDate(0, 0, -1)
	today := jstDateAsUTC(dayAfterResume)
	yesterday := jstDateAsUTC(daySuspended)
	twoDaysAgo := today.AddDate(0, 0, -2)

	// 停止前の最後のスナップショット（2 日前）。再開後の集計はこれを前日として参照してはならない。
	if _, err := pool.Exec(ctx, `
		INSERT INTO rating_snapshots (store_id, subject_kind, competitor_id, place_id, captured_on, rating, review_count, rank)
		VALUES ($1, 'self', NULL, 'suspension-target-self', $2, 4.0, 20, 1)
	`, suspendedStore, twoDaysAgo); err != nil {
		t.Fatalf("seed pre-suspension snapshot: %v", err)
	}

	setStoreSuspended(t, ctx, pool, suspendedStore, true)

	// --- 停止中の日 ---
	serverSuspended := newFakePlacesServer(t)
	serverSuspended.details["suspension-active-self"] = operational(3.8, 50, "利用中の店舗")
	serverSuspended.details["suspension-active-comp"] = operational(4.1, 70, "利用中の競合")
	serverSuspended.details["suspension-target-self"] = operational(4.2, 30, "停止する店舗")
	serverSuspended.nearbyPlaces = []fakeNearbyPlace{{
		ID: "suspension-target-comp", DisplayName: fakeDisplayName{Text: "停止店の競合"},
		Location: fakeLatLng{Latitude: 35.6, Longitude: 139.6}, PrimaryType: "ramen_restaurant",
	}}
	serverSuspended.details["suspension-target-comp"] = operational(4.5, 90, "停止店の競合")

	resultSuspended, err := Run(ctx, newDeps(t, pool, serverSuspended, daySuspended))
	if err != nil {
		t.Fatalf("Run (suspended day): %v", err)
	}
	if resultSuspended.StoresTotal != 1 {
		t.Errorf("StoresTotal on suspended day = %d, want 1 (suspended store must not be counted)", resultSuspended.StoresTotal)
	}
	if resultSuspended.ExtractRan != 0 {
		t.Errorf("ExtractRan on suspended day = %d, want 0 (suspended store must not be extracted)", resultSuspended.ExtractRan)
	}
	if got := serverSuspended.totalDetailsCalls("suspension-target-self", "suspension-target-comp"); got != 0 {
		t.Errorf("Place Details calls for suspended store = %d, want 0", got)
	}
	if n := countRows(t, ctx, pool, `SELECT count(*) FROM competitors WHERE store_id = $1`, suspendedStore); n != 0 {
		t.Errorf("competitors rows for suspended store = %d, want 0", n)
	}
	assertSnapshotCount(t, ctx, pool, suspendedStore, yesterday, 0)
	if n := countRows(t, ctx, pool, `SELECT count(*) FROM daily_summaries WHERE store_id = $1`, suspendedStore); n != 0 {
		t.Errorf("daily_summaries rows for suspended store = %d, want 0", n)
	}
	assertSummaryStatus(t, ctx, pool, activeStore, yesterday, "ready")

	setStoreSuspended(t, ctx, pool, suspendedStore, false)

	// --- 再開後の最初の日 ---
	serverResumed := newFakePlacesServer(t)
	serverResumed.details["suspension-active-self"] = operational(3.8, 51, "利用中の店舗")
	serverResumed.details["suspension-active-comp"] = operational(4.1, 70, "利用中の競合")
	serverResumed.details["suspension-target-self"] = operational(4.3, 40, "停止する店舗", fakeReview{
		Rating:            5,
		PublishTime:       "2026-07-11T12:00:00Z", // 前日の集計基準より後。前日比の無い日には新着に数えない
		Text:              fakeReviewText{Text: "停止中に投稿されたクチコミ"},
		AuthorAttribution: fakeAuthorAttribution{DisplayName: "テスト太郎"},
	})
	serverResumed.nearbyPlaces = serverSuspended.nearbyPlaces
	serverResumed.details["suspension-target-comp"] = operational(4.5, 90, "停止店の競合")

	resultResumed, err := Run(ctx, newDeps(t, pool, serverResumed, dayAfterResume))
	if err != nil {
		t.Fatalf("Run (after resume): %v", err)
	}
	if resultResumed.StoresTotal != 2 {
		t.Errorf("StoresTotal after resume = %d, want 2 (resumed store must return)", resultResumed.StoresTotal)
	}
	if resultResumed.ExtractRan != 1 {
		t.Errorf("ExtractRan after resume = %d, want 1 (resumed store is extracted again)", resultResumed.ExtractRan)
	}
	assertSnapshotCount(t, ctx, pool, suspendedStore, today, 2)
	assertSummaryStatus(t, ctx, pool, suspendedStore, today, "ready")

	var rankPrev, reviewCountPrev *int
	var ratingPrev *float64
	var newReviewCount int
	var newReviewsLen int
	if err := pool.QueryRow(ctx, `
		SELECT rank_prev, rating_prev, review_count_prev, new_review_count, jsonb_array_length(new_reviews)
		FROM daily_summaries WHERE store_id = $1 AND summary_date = $2
	`, suspendedStore, today).Scan(&rankPrev, &ratingPrev, &reviewCountPrev, &newReviewCount, &newReviewsLen); err != nil {
		t.Fatalf("select daily_summary after resume: %v", err)
	}
	if rankPrev != nil || ratingPrev != nil || reviewCountPrev != nil {
		t.Errorf("rank_prev/rating_prev/review_count_prev = %v/%s/%v, want NULL/NULL/NULL (no summary on the suspended day)",
			deref(rankPrev), floatPtrString(ratingPrev), deref(reviewCountPrev))
	}
	if newReviewCount != 0 {
		t.Errorf("new_review_count = %d, want 0 (reviews added while suspended are not counted as new)", newReviewCount)
	}
	if newReviewsLen != 0 {
		t.Errorf("new_reviews length = %d, want 0", newReviewsLen)
	}
	// 停止中に欠けた日は遡って作らない。
	assertSnapshotCount(t, ctx, pool, suspendedStore, yesterday, 0)
	if n := countRows(t, ctx, pool, `SELECT count(*) FROM daily_summaries WHERE store_id = $1`, suspendedStore); n != 1 {
		t.Errorf("daily_summaries rows for resumed store = %d, want 1 (no backfill of suspended days)", n)
	}
}
