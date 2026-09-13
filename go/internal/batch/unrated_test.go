package batch

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

// Issue #255: Google に評価が無い店（クチコミ 0 件）。
//
// Google の星評価は 1.0〜5.0 で定義され、クチコミ 0 件の店は Place Details の応答に rating を
// 持たない。この欠落を 0 として記録すると、評価の無い店が比較集合の最下位に数えられて
// 「近隣 N 店中」の N を水増しし、星差も「自店 − 0」になる。評価なしは 0 で代替せず NULL
// （jsonb は null）で記録し、比較集合から外すことを実 postgres で固定する。

// summaryCompetitorJSON は daily_summaries.competitors の要素を「null と 0 を区別できる形」で読む。
// repo.SummaryCompetitor へ Unmarshal すると、型によっては null が 0 に化けて区別できない。
type summaryCompetitorJSON struct {
	Name        string   `json:"name"`
	Rating      *float64 `json:"rating"`
	ReviewCount int      `json:"reviewCount"`
	StarDiff    *float64 `json:"starDiff"`
}

func readSummaryCompetitors(t *testing.T, raw []byte) []summaryCompetitorJSON {
	t.Helper()
	var got []summaryCompetitorJSON
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal competitors %s: %v", raw, err)
	}
	return got
}

func floatPtrString(v *float64) string {
	if v == nil {
		return "null"
	}
	b, _ := json.Marshal(*v)
	return string(b)
}

func assertCompetitor(t *testing.T, got summaryCompetitorJSON, name string, rating, starDiff *float64, reviewCount int) {
	t.Helper()
	if got.Name != name || got.ReviewCount != reviewCount ||
		floatPtrString(got.Rating) != floatPtrString(rating) || floatPtrString(got.StarDiff) != floatPtrString(starDiff) {
		t.Errorf("competitor = {%s rating=%s reviewCount=%d starDiff=%s}, want {%s rating=%s reviewCount=%d starDiff=%s}",
			got.Name, floatPtrString(got.Rating), got.ReviewCount, floatPtrString(got.StarDiff),
			name, floatPtrString(rating), reviewCount, floatPtrString(starDiff))
	}
}

func f64(v float64) *float64 { return &v }

// TestRun_UnratedCompetitor_ExcludedFromRankAndWrittenAsNull: 評価の無い競合は比較集合に入らず
// （rank_total に数えない・スナップショットの rank は NULL）、jsonb には rating・starDiff とも null で、
// 評価のある競合の後ろに並ぶ（R2.8, R2.9, R3.13）。
func TestRun_UnratedCompetitor_ExcludedFromRankAndWrittenAsNull(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)

	store := seedConfirmedStore(t, ctx, pool, "U-batch-unrated-comp", "unrated-comp-self", 35.4, 139.4)
	compA := seedFixedCompetitor(t, ctx, pool, store, "unrated-comp-a", "競合A")
	compB := seedFixedCompetitor(t, ctx, pool, store, "unrated-comp-b", "競合B")
	compC := seedFixedCompetitor(t, ctx, pool, store, "unrated-comp-c", "競合C")

	now := time.Date(2026, 7, 12, 6, 0, 0, 0, jst)
	today := jstDateAsUTC(now)

	server := newFakePlacesServer(t)
	server.details["unrated-comp-self"] = operational(4.3, 50, "自店")
	server.details["unrated-comp-a"] = operational(4.5, 100, "競合A")
	server.details["unrated-comp-b"] = unrated("競合B")
	server.details["unrated-comp-c"] = operational(4.0, 30, "競合C")

	if _, err := Run(ctx, newDeps(t, pool, server, now)); err != nil {
		t.Fatalf("Run: %v", err)
	}

	var status string
	var rank, rankTotal *int
	var rating *float64
	var competitorsJSON []byte
	if err := pool.QueryRow(ctx, `
		SELECT status, rank, rank_total, rating, competitors
		FROM daily_summaries WHERE store_id = $1 AND summary_date = $2
	`, store, today).Scan(&status, &rank, &rankTotal, &rating, &competitorsJSON); err != nil {
		t.Fatalf("select daily_summary: %v", err)
	}

	if status != "ready" {
		t.Errorf("status = %q, want ready", status)
	}
	// 評価のある店だけで並べる: 競合A 4.5 > 自店 4.3 > 競合C 4.0。競合B は数えない。
	if rank == nil || *rank != 2 || rankTotal == nil || *rankTotal != 3 {
		t.Errorf("rank/rank_total = %v/%v, want 2/3 (the unrated competitor must not be counted)", deref(rank), deref(rankTotal))
	}
	if rating == nil || *rating != 4.3 {
		t.Errorf("rating = %v, want 4.3", floatPtrString(rating))
	}

	got := readSummaryCompetitors(t, competitorsJSON)
	if len(got) != 3 {
		t.Fatalf("competitors = %s, want 3 entries", competitorsJSON)
	}
	assertCompetitor(t, got[0], "競合A", f64(4.5), f64(-0.2), 100)
	assertCompetitor(t, got[1], "競合C", f64(4.0), f64(0.3), 30)
	assertCompetitor(t, got[2], "競合B", nil, nil, 0)

	// スナップショット: 評価の無い競合は rating・rank とも NULL。評価のある店の rank は通し順位。
	wantSnapshots := map[string]struct {
		ratingNull bool
		rank       *int
	}{
		compA: {false, intPtr(1)},
		compB: {true, nil},
		compC: {false, intPtr(3)},
	}
	for competitorID, want := range wantSnapshots {
		var ratingIsNull bool
		var snapRank *int
		if err := pool.QueryRow(ctx, `
			SELECT rating IS NULL, rank FROM rating_snapshots
			WHERE store_id = $1 AND competitor_id = $2 AND captured_on = $3
		`, store, competitorID, today).Scan(&ratingIsNull, &snapRank); err != nil {
			t.Fatalf("select competitor snapshot %s: %v", competitorID, err)
		}
		if ratingIsNull != want.ratingNull || deref(snapRank) != deref(want.rank) {
			t.Errorf("snapshot %s: rating IS NULL=%v rank=%v, want %v/%v", competitorID, ratingIsNull, deref(snapRank), want.ratingNull, deref(want.rank))
		}
	}
	var selfRank *int
	if err := pool.QueryRow(ctx, `
		SELECT rank FROM rating_snapshots WHERE store_id = $1 AND subject_kind = 'self' AND captured_on = $2
	`, store, today).Scan(&selfRank); err != nil {
		t.Fatalf("select self snapshot: %v", err)
	}
	if deref(selfRank) != 2 {
		t.Errorf("self snapshot rank = %v, want 2", deref(selfRank))
	}
}

// TestRun_UnratedSelf_HasNoRankAndNoStarDiff: 自店に評価が無い日は順位を記録しない（rank・rank_total が
// NULL）。取得失敗ではないので status は ready のまま。競合の評価は記録し、自店と比べられない星差は
// null にする（R2.8, R2.9, R3.14）。
func TestRun_UnratedSelf_HasNoRankAndNoStarDiff(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)

	store := seedConfirmedStore(t, ctx, pool, "U-batch-unrated-self", "unrated-self-self", 35.4, 139.4)
	seedFixedCompetitor(t, ctx, pool, store, "unrated-self-a", "競合A")
	seedFixedCompetitor(t, ctx, pool, store, "unrated-self-c", "競合C")

	now := time.Date(2026, 7, 12, 6, 0, 0, 0, jst)
	today := jstDateAsUTC(now)

	server := newFakePlacesServer(t)
	server.details["unrated-self-self"] = unrated("自店")
	server.details["unrated-self-a"] = operational(4.5, 100, "競合A")
	server.details["unrated-self-c"] = operational(4.0, 30, "競合C")

	if _, err := Run(ctx, newDeps(t, pool, server, now)); err != nil {
		t.Fatalf("Run: %v", err)
	}

	var status string
	var rank, rankTotal, reviewCount *int
	var rating *float64
	var competitorsJSON []byte
	if err := pool.QueryRow(ctx, `
		SELECT status, rank, rank_total, rating, review_count, competitors
		FROM daily_summaries WHERE store_id = $1 AND summary_date = $2
	`, store, today).Scan(&status, &rank, &rankTotal, &rating, &reviewCount, &competitorsJSON); err != nil {
		t.Fatalf("select daily_summary: %v", err)
	}

	if status != "ready" {
		t.Errorf("status = %q, want ready (an unrated store is not a fetch failure)", status)
	}
	if rank != nil || rankTotal != nil {
		t.Errorf("rank/rank_total = %v/%v, want NULL/NULL (an unrated store has no position)", deref(rank), deref(rankTotal))
	}
	if rating != nil {
		t.Errorf("rating = %s, want NULL (do not substitute 0 for a missing rating)", floatPtrString(rating))
	}
	if deref(reviewCount) != 0 {
		t.Errorf("review_count = %v, want 0", deref(reviewCount))
	}

	got := readSummaryCompetitors(t, competitorsJSON)
	if len(got) != 2 {
		t.Fatalf("competitors = %s, want 2 entries", competitorsJSON)
	}
	assertCompetitor(t, got[0], "競合A", f64(4.5), nil, 100)
	assertCompetitor(t, got[1], "競合C", f64(4.0), nil, 30)

	var selfRatingIsNull bool
	var selfRank *int
	if err := pool.QueryRow(ctx, `
		SELECT rating IS NULL, rank FROM rating_snapshots
		WHERE store_id = $1 AND subject_kind = 'self' AND captured_on = $2
	`, store, today).Scan(&selfRatingIsNull, &selfRank); err != nil {
		t.Fatalf("select self snapshot: %v", err)
	}
	if !selfRatingIsNull || selfRank != nil {
		t.Errorf("self snapshot rating IS NULL=%v rank=%v, want true/NULL", selfRatingIsNull, deref(selfRank))
	}
}

// TestRun_FirstReviewAfterUnratedDay_CountsNewReview: 前日の自店が評価なし（クチコミ 0 件）で、当日に
// 初めてクチコミが付いた日も、新着件数（review_count の差分）を失わない。前日に順位は無いので
// rank_prev・rating_prev は NULL（R3.5, R3.7）。前日のスナップショットが NULL で書かれた行と、
// 旧コードがゼロ値 0 で書いた行の両方で確かめる。
func TestRun_FirstReviewAfterUnratedDay_CountsNewReview(t *testing.T) {
	cases := []struct {
		name            string
		yesterdayRating any // nil = NULL（新しい書き方）、0 = 旧コードのゼロ値
		yesterdayRank   any
	}{
		{name: "前日の評価が NULL", yesterdayRating: nil, yesterdayRank: nil},
		{name: "前日の評価が旧コードの 0", yesterdayRating: 0, yesterdayRank: 2},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			pool := testPool(t)

			selfPlace := "first-review-self"
			store := seedConfirmedStore(t, ctx, pool, "U-batch-first-review", selfPlace, 35.4, 139.4)
			compA := seedFixedCompetitor(t, ctx, pool, store, "first-review-a", "競合A")

			now := time.Date(2026, 7, 12, 6, 0, 0, 0, jst)
			today := jstDateAsUTC(now)
			yesterday := today.AddDate(0, 0, -1)

			// 前日のスナップショットは生の SQL で撒く（評価の NULL を型に依存せず表すため）。
			if _, err := pool.Exec(ctx, `
				INSERT INTO rating_snapshots (store_id, subject_kind, competitor_id, place_id, captured_on, rating, review_count, rank)
				VALUES ($1, 'self', NULL, $2, $3, $4, 0, $5)
			`, store, selfPlace, yesterday, tc.yesterdayRating, tc.yesterdayRank); err != nil {
				t.Fatalf("seed yesterday self snapshot: %v", err)
			}
			if _, err := pool.Exec(ctx, `
				INSERT INTO rating_snapshots (store_id, subject_kind, competitor_id, place_id, captured_on, rating, review_count, rank)
				VALUES ($1, 'competitor', $2, 'first-review-a', $3, 4.5, 100, 1)
			`, store, compA, yesterday); err != nil {
				t.Fatalf("seed yesterday competitor snapshot: %v", err)
			}

			server := newFakePlacesServer(t)
			server.details[selfPlace] = operational(5.0, 1, "自店", fakeReview{
				Rating:            5,
				PublishTime:       "2026-07-11T12:00:00Z", // 前日の集計基準（2026-07-11T00:00:00Z）より後 → 新着
				Text:              fakeReviewText{Text: "初めてのクチコミです"},
				AuthorAttribution: fakeAuthorAttribution{DisplayName: "テスト花子"},
			})
			server.details["first-review-a"] = operational(4.5, 100, "競合A")

			if _, err := Run(ctx, newDeps(t, pool, server, now)); err != nil {
				t.Fatalf("Run: %v", err)
			}

			var rank, rankTotal, rankPrev, reviewCountPrev *int
			var ratingPrev *float64
			var newReviewCount int
			if err := pool.QueryRow(ctx, `
				SELECT rank, rank_total, rank_prev, rating_prev, review_count_prev, new_review_count
				FROM daily_summaries WHERE store_id = $1 AND summary_date = $2
			`, store, today).Scan(&rank, &rankTotal, &rankPrev, &ratingPrev, &reviewCountPrev, &newReviewCount); err != nil {
				t.Fatalf("select daily_summary: %v", err)
			}

			if newReviewCount != 1 {
				t.Errorf("new_review_count = %d, want 1 (review_count 0 → 1)", newReviewCount)
			}
			if deref(reviewCountPrev) != 0 || reviewCountPrev == nil {
				t.Errorf("review_count_prev = %v, want 0", deref(reviewCountPrev))
			}
			if rankPrev != nil || ratingPrev != nil {
				t.Errorf("rank_prev/rating_prev = %v/%s, want NULL/NULL (the store had no rating yesterday)", deref(rankPrev), floatPtrString(ratingPrev))
			}
			if deref(rank) != 1 || deref(rankTotal) != 2 {
				t.Errorf("rank/rank_total = %v/%v, want 1/2 (self 5.0 > 競合A 4.5)", deref(rank), deref(rankTotal))
			}
		})
	}
}

func intPtr(v int) *int { return &v }

// deref は NULL 許容の整数を失敗メッセージ用に読む（NULL は -1）。
func deref(v *int) int {
	if v == nil {
		return -1
	}
	return *v
}
