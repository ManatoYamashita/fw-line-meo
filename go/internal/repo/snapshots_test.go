package repo

import (
	"context"
	"testing"
	"time"
)

func TestWriteSelfSnapshot_SameDayTwice_DoesNotDuplicate(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	storeID := seedStore(t, ctx, pool, "U-self-snapshot-rerun", "place-self-rerun")

	today := dateOnly(t, "2026-07-12")

	if err := WriteSelfSnapshot(ctx, pool, storeID, SnapshotWrite{
		PlaceID: "place-self-rerun", CapturedOn: today, Rating: 4.2, ReviewCount: 100, Rank: 2,
	}); err != nil {
		t.Fatalf("WriteSelfSnapshot (1st): %v", err)
	}
	if err := WriteSelfSnapshot(ctx, pool, storeID, SnapshotWrite{
		PlaceID: "place-self-rerun", CapturedOn: today, Rating: 4.3, ReviewCount: 105, Rank: 1,
	}); err != nil {
		t.Fatalf("WriteSelfSnapshot (2nd, same day): %v", err)
	}

	var n int
	err := pool.QueryRow(ctx, `SELECT count(*) FROM rating_snapshots WHERE store_id = $1 AND captured_on = $2 AND subject_kind = 'self'`, storeID, today).Scan(&n)
	if err != nil {
		t.Fatalf("count query: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected exactly 1 row after same-day re-run, got %d", n)
	}

	snaps, err := SnapshotsOn(ctx, pool, storeID, today)
	if err != nil {
		t.Fatalf("SnapshotsOn: %v", err)
	}
	if len(snaps) != 1 {
		t.Fatalf("expected 1 snapshot, got %d", len(snaps))
	}
	got := snaps[0]
	if got.Rating == nil || *got.Rating != 4.3 {
		t.Fatalf("expected value fully replaced by 2nd write (rating=4.3), got %+v", got.Rating)
	}
	if got.Rank == nil || *got.Rank != 1 {
		t.Fatalf("expected rank fully replaced by 2nd write (rank=1), got %+v", got.Rank)
	}
}

func TestWriteCompetitorSnapshot_SameDayTwice_DoesNotDuplicate(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	storeID := seedStore(t, ctx, pool, "U-comp-snapshot-rerun", "place-self-comp-rerun")

	if err := FixCompetitors(ctx, pool, storeID, []NewCompetitor{{PlaceID: "place-comp-rerun"}}); err != nil {
		t.Fatalf("FixCompetitors: %v", err)
	}
	competitors, err := ActiveCompetitors(ctx, pool, storeID)
	if err != nil || len(competitors) != 1 {
		t.Fatalf("ActiveCompetitors: %v (len=%d)", err, len(competitors))
	}
	competitorID := competitors[0].ID

	today := dateOnly(t, "2026-07-12")

	write := func(rating float64, reviewCount, rank int) {
		t.Helper()
		if err := WriteCompetitorSnapshot(ctx, pool, storeID, competitorID, SnapshotWrite{
			PlaceID: "place-comp-rerun", CapturedOn: today, Rating: rating, ReviewCount: reviewCount, Rank: rank,
		}); err != nil {
			t.Fatalf("WriteCompetitorSnapshot: %v", err)
		}
	}
	write(3.8, 40, 2)
	write(3.9, 42, 2) // same-day re-run

	var n int
	err = pool.QueryRow(ctx, `SELECT count(*) FROM rating_snapshots WHERE store_id = $1 AND competitor_id = $2 AND captured_on = $3`, storeID, competitorID, today).Scan(&n)
	if err != nil {
		t.Fatalf("count query: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected exactly 1 row after same-day re-run, got %d", n)
	}

	snaps, err := SnapshotsOn(ctx, pool, storeID, today)
	if err != nil {
		t.Fatalf("SnapshotsOn: %v", err)
	}
	var compSnap *Snapshot
	for i := range snaps {
		if snaps[i].SubjectKind == "competitor" {
			compSnap = &snaps[i]
		}
	}
	if compSnap == nil {
		t.Fatal("expected a competitor snapshot")
	}
	if compSnap.ReviewCount == nil || *compSnap.ReviewCount != 42 {
		t.Fatalf("expected review_count fully replaced by 2nd write (42), got %+v", compSnap.ReviewCount)
	}
}

func TestSnapshotsOn_DifferentDatesDoNotCollide(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	storeID := seedStore(t, ctx, pool, "U-snapshot-different-dates", "place-self-diff-dates")

	day1 := dateOnly(t, "2026-07-10")
	day2 := dateOnly(t, "2026-07-11")

	if err := WriteSelfSnapshot(ctx, pool, storeID, SnapshotWrite{PlaceID: "place-self-diff-dates", CapturedOn: day1, Rating: 4.0, ReviewCount: 10, Rank: 1}); err != nil {
		t.Fatalf("WriteSelfSnapshot day1: %v", err)
	}
	if err := WriteSelfSnapshot(ctx, pool, storeID, SnapshotWrite{PlaceID: "place-self-diff-dates", CapturedOn: day2, Rating: 4.1, ReviewCount: 11, Rank: 1}); err != nil {
		t.Fatalf("WriteSelfSnapshot day2: %v", err)
	}

	snapsDay1, err := SnapshotsOn(ctx, pool, storeID, day1)
	if err != nil {
		t.Fatalf("SnapshotsOn day1: %v", err)
	}
	if len(snapsDay1) != 1 || snapsDay1[0].ReviewCount == nil || *snapsDay1[0].ReviewCount != 10 {
		t.Fatalf("expected day1 snapshot with review_count=10, got %+v", snapsDay1)
	}

	snapsDay2, err := SnapshotsOn(ctx, pool, storeID, day2)
	if err != nil {
		t.Fatalf("SnapshotsOn day2: %v", err)
	}
	if len(snapsDay2) != 1 || snapsDay2[0].ReviewCount == nil || *snapsDay2[0].ReviewCount != 11 {
		t.Fatalf("expected day2 snapshot with review_count=11, got %+v", snapsDay2)
	}
}

func dateOnly(t *testing.T, s string) time.Time {
	t.Helper()
	d, err := time.Parse(time.DateOnly, s)
	if err != nil {
		t.Fatalf("dateOnly(%q): %v", s, err)
	}
	return d
}
