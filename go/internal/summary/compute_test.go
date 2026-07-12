package summary

import (
	"testing"
	"time"
)

// --- Rank ---

func TestRank_TieBreaksByReviewCountDescending(t *testing.T) {
	// 星評価が同率の場合、クチコミ総数の降順で決着する（R2.4）。
	self := Metrics{Rating: 4.0, ReviewCount: 50}
	competitors := []Metrics{
		{Rating: 4.0, ReviewCount: 100}, // 同率星・クチコミ数多い → 自店より上位
		{Rating: 4.0, ReviewCount: 30},  // 同率星・クチコミ数少ない → 自店より下位
		{Rating: 3.5, ReviewCount: 999}, // 星が低い → クチコミ数に関わらず自店より下位
	}

	rank, total := Rank(self, competitors)

	if total != 4 {
		t.Fatalf("total = %d, want 4", total)
	}
	// 並び: competitor(4.0,100) > self(4.0,50) > competitor(4.0,30) > competitor(3.5,999)
	if rank != 2 {
		t.Fatalf("rank = %d, want 2", rank)
	}
}

func TestRank_ExactTieDoesNotDemoteSelf(t *testing.T) {
	// 星評価・クチコミ総数の両方が同率の場合、安定ソートにより自店を競合より
	// 下位に置かない（design.md Invariant）。
	self := Metrics{Rating: 4.2, ReviewCount: 80}
	competitors := []Metrics{
		{Rating: 4.2, ReviewCount: 80}, // 完全同率
		{Rating: 4.2, ReviewCount: 80}, // 完全同率（複数）
	}

	rank, total := Rank(self, competitors)

	if total != 3 {
		t.Fatalf("total = %d, want 3", total)
	}
	if rank != 1 {
		t.Fatalf("rank = %d, want 1 (self must not be demoted on exact ties)", rank)
	}
}

func TestRank_SelfOnlyWhenNoCompetitors(t *testing.T) {
	// 競合0件（R1.3）: 自店のみで rank=1, total=1。
	self := Metrics{Rating: 3.8, ReviewCount: 12}

	rank, total := Rank(self, nil)

	if rank != 1 {
		t.Fatalf("rank = %d, want 1", rank)
	}
	if total != 1 {
		t.Fatalf("total = %d, want 1", total)
	}
}

func TestRank_SelfLastPlace(t *testing.T) {
	self := Metrics{Rating: 2.0, ReviewCount: 5}
	competitors := []Metrics{
		{Rating: 4.5, ReviewCount: 10},
		{Rating: 4.0, ReviewCount: 10},
		{Rating: 3.0, ReviewCount: 10},
	}

	rank, total := Rank(self, competitors)

	if total != 4 {
		t.Fatalf("total = %d, want 4", total)
	}
	if rank != 4 {
		t.Fatalf("rank = %d, want 4", rank)
	}
}

// --- Diff ---

func TestDiff_NoYesterdayRecordOmitsComparison(t *testing.T) {
	// 前日レコードが無い場合（初回配信等）、各 *Prev は nil（R3.7）。
	today := Metrics{Rating: 4.0, ReviewCount: 20}

	diff := Diff(today, nil)

	if diff.RatingPrev != nil {
		t.Fatalf("RatingPrev = %v, want nil", diff.RatingPrev)
	}
	if diff.ReviewCountPrev != nil {
		t.Fatalf("ReviewCountPrev = %v, want nil", diff.ReviewCountPrev)
	}
}

func TestDiff_WithYesterdayRecordReturnsPrevValues(t *testing.T) {
	today := Metrics{Rating: 4.2, ReviewCount: 25}
	yesterday := &Metrics{Rating: 4.0, ReviewCount: 20}

	diff := Diff(today, yesterday)

	if diff.RatingPrev == nil || *diff.RatingPrev != 4.0 {
		t.Fatalf("RatingPrev = %v, want 4.0", diff.RatingPrev)
	}
	if diff.ReviewCountPrev == nil || *diff.ReviewCountPrev != 20 {
		t.Fatalf("ReviewCountPrev = %v, want 20", diff.ReviewCountPrev)
	}
}

// --- NewReviews ---

func TestNewReviews_ExcerptFallthrough_CountCorrectDespiteNoMatchingExcerpt(t *testing.T) {
	// review_count 差分は正だが、関連度上位5件（reviews 引数）の中に
	// publishTime > lastBatchDate のレビューが1件も無いケース（取りこぼし）。
	// 件数は正しく報告し、抜粋は空（またはpartial）でエラーにしない。
	lastBatchDate := mustParseTime(t, "2026-07-10T00:00:00Z")
	reviews := []Review{
		{AuthorName: "A", PublishTime: mustParseTime(t, "2026-06-01T00:00:00Z"), Rating: 5, Text: "old review"},
		{AuthorName: "B", PublishTime: mustParseTime(t, "2026-05-01T00:00:00Z"), Rating: 4, Text: "older review"},
	}

	info := NewReviews(3, reviews, lastBatchDate)

	if info.Count != 3 {
		t.Fatalf("Count = %d, want 3", info.Count)
	}
	if len(info.Excerpts) != 0 {
		t.Fatalf("Excerpts = %v, want empty (fallthrough case)", info.Excerpts)
	}
}

func TestNewReviews_MatchingPublishTimeIncludedInExcerpts(t *testing.T) {
	lastBatchDate := mustParseTime(t, "2026-07-10T00:00:00Z")
	reviews := []Review{
		{AuthorName: "New1", PublishTime: mustParseTime(t, "2026-07-11T09:00:00Z"), Rating: 5, Text: "new review"},
		{AuthorName: "Old1", PublishTime: mustParseTime(t, "2026-06-01T00:00:00Z"), Rating: 3, Text: "old review"},
	}

	info := NewReviews(1, reviews, lastBatchDate)

	if info.Count != 1 {
		t.Fatalf("Count = %d, want 1", info.Count)
	}
	if len(info.Excerpts) != 1 {
		t.Fatalf("Excerpts len = %d, want 1", len(info.Excerpts))
	}
	if info.Excerpts[0].AuthorName != "New1" {
		t.Fatalf("Excerpts[0].AuthorName = %q, want New1", info.Excerpts[0].AuthorName)
	}
}

func TestNewReviews_PartialExcerptWhenSomeReviewsPredateLastBatch(t *testing.T) {
	lastBatchDate := mustParseTime(t, "2026-07-10T00:00:00Z")
	reviews := []Review{
		{AuthorName: "New1", PublishTime: mustParseTime(t, "2026-07-11T09:00:00Z"), Rating: 5, Text: "new review"},
		{AuthorName: "Old1", PublishTime: mustParseTime(t, "2026-06-01T00:00:00Z"), Rating: 3, Text: "old review"},
	}

	// countDelta=2 だが、抜粋候補（上位5件の関連度枠）には新着1件しか見つからない
	// = 取りこぼしケース。件数は countDelta を正として報告する。
	info := NewReviews(2, reviews, lastBatchDate)

	if info.Count != 2 {
		t.Fatalf("Count = %d, want 2", info.Count)
	}
	if len(info.Excerpts) != 1 {
		t.Fatalf("Excerpts len = %d, want 1 (partial)", len(info.Excerpts))
	}
}

func TestNewReviews_ZeroOrNegativeDeltaMeansNoNewReviews(t *testing.T) {
	lastBatchDate := mustParseTime(t, "2026-07-10T00:00:00Z")
	reviews := []Review{
		{AuthorName: "A", PublishTime: mustParseTime(t, "2026-07-11T00:00:00Z"), Rating: 5, Text: "x"},
	}

	for _, delta := range []int{0, -1} {
		info := NewReviews(delta, reviews, lastBatchDate)
		if info.Count != 0 {
			t.Fatalf("delta=%d: Count = %d, want 0", delta, info.Count)
		}
		if len(info.Excerpts) != 0 {
			t.Fatalf("delta=%d: Excerpts = %v, want empty", delta, info.Excerpts)
		}
	}
}

func mustParseTime(t *testing.T, s string) time.Time {
	t.Helper()
	tm, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatalf("failed to parse time %q: %v", s, err)
	}
	return tm
}
