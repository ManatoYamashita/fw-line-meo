package summary

import (
	"testing"
	"time"
)

// --- RankAll ---

func rated(v float64, reviewCount int) Metrics { return Metrics{Rating: &v, ReviewCount: reviewCount} }

func unratedMetrics() Metrics { return Metrics{ReviewCount: 0} }

func intOrNil(v *int) any {
	if v == nil {
		return nil
	}
	return *v
}

func TestRankAll(t *testing.T) {
	zero := 0.0
	cases := []struct {
		name            string
		self            Metrics
		competitors     []Metrics
		wantSelfRank    any // int か nil
		wantTotal       int
		wantCompetitors []any
	}{
		{
			// 星評価が同率の場合、クチコミ総数の降順で決着する（R2.4）。
			// 並び: competitor(4.0,100) > self(4.0,50) > competitor(4.0,30) > competitor(3.5,999)
			name:            "同率はクチコミ総数の降順で決着する",
			self:            rated(4.0, 50),
			competitors:     []Metrics{rated(4.0, 100), rated(4.0, 30), rated(3.5, 999)},
			wantSelfRank:    2,
			wantTotal:       4,
			wantCompetitors: []any{1, 3, 4},
		},
		{
			// 星評価・クチコミ総数の両方が同率の場合、安定ソートにより自店を競合より下位に置かない
			// （design.md Invariant）。
			name:            "完全同率でも自店を下位に置かない",
			self:            rated(4.2, 80),
			competitors:     []Metrics{rated(4.2, 80), rated(4.2, 80)},
			wantSelfRank:    1,
			wantTotal:       3,
			wantCompetitors: []any{2, 3},
		},
		{
			// 競合0件（R1.3）: 自店のみで rank=1, total=1。
			name:            "競合なしは自店のみで 1 店中 1 位",
			self:            rated(3.8, 12),
			competitors:     nil,
			wantSelfRank:    1,
			wantTotal:       1,
			wantCompetitors: []any{},
		},
		{
			name:            "自店が最下位",
			self:            rated(2.0, 5),
			competitors:     []Metrics{rated(4.5, 10), rated(4.0, 10), rated(3.0, 10)},
			wantSelfRank:    4,
			wantTotal:       4,
			wantCompetitors: []any{1, 2, 3},
		},
		{
			// Issue #255: 評価の無い競合は比較集合に入らず、順位も母数も持たない（R2.9）。
			// 最下位に数えると「近隣 N 店中」の N が水増しされる。
			name:            "評価の無い競合は比較集合に入らない",
			self:            rated(4.3, 50),
			competitors:     []Metrics{rated(4.5, 100), unratedMetrics(), rated(4.0, 30)},
			wantSelfRank:    2,
			wantTotal:       3,
			wantCompetitors: []any{1, nil, 3},
		},
		{
			// 自店に評価が無い日は順位を持たない。評価のある競合どうしの順位と母数は付ける。
			name:            "自店が評価なしなら自店の順位は無い",
			self:            unratedMetrics(),
			competitors:     []Metrics{rated(4.0, 30), rated(4.5, 100)},
			wantSelfRank:    nil,
			wantTotal:       2,
			wantCompetitors: []any{2, 1},
		},
		{
			// 全競合が評価なしなら、評価のある店は自店だけ（1 店中 1 位）。
			name:            "全競合が評価なしなら 1 店中 1 位",
			self:            rated(3.9, 20),
			competitors:     []Metrics{unratedMetrics(), unratedMetrics()},
			wantSelfRank:    1,
			wantTotal:       1,
			wantCompetitors: []any{nil, nil},
		},
		{
			// 旧コードがゼロ値 0 で書いたスナップショット（前日の値として再適用される）も評価なしとして扱う。
			name:            "評価 0 は評価の定義域の外なので評価なし",
			self:            rated(4.0, 10),
			competitors:     []Metrics{{Rating: &zero, ReviewCount: 0}, rated(3.0, 5)},
			wantSelfRank:    1,
			wantTotal:       2,
			wantCompetitors: []any{nil, 2},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := RankAll(tc.self, tc.competitors)
			if intOrNil(got.SelfRank) != tc.wantSelfRank {
				t.Errorf("SelfRank = %v, want %v", intOrNil(got.SelfRank), tc.wantSelfRank)
			}
			if got.Total != tc.wantTotal {
				t.Errorf("Total = %d, want %d", got.Total, tc.wantTotal)
			}
			if len(got.CompetitorRanks) != len(tc.wantCompetitors) {
				t.Fatalf("CompetitorRanks len = %d, want %d", len(got.CompetitorRanks), len(tc.wantCompetitors))
			}
			for i, want := range tc.wantCompetitors {
				if intOrNil(got.CompetitorRanks[i]) != want {
					t.Errorf("CompetitorRanks[%d] = %v, want %v", i, intOrNil(got.CompetitorRanks[i]), want)
				}
			}
		})
	}
}

// --- Diff ---

func TestDiff_NoYesterdayRecordOmitsComparison(t *testing.T) {
	// 前日レコードが無い場合（初回配信等）、各 *Prev は nil（R3.7）。
	today := rated(4.0, 20)

	diff := Diff(today, nil)

	if diff.RatingPrev != nil {
		t.Fatalf("RatingPrev = %v, want nil", diff.RatingPrev)
	}
	if diff.ReviewCountPrev != nil {
		t.Fatalf("ReviewCountPrev = %v, want nil", diff.ReviewCountPrev)
	}
}

func TestDiff_WithYesterdayRecordReturnsPrevValues(t *testing.T) {
	today := rated(4.2, 25)
	yesterday := rated(4.0, 20)

	diff := Diff(today, &yesterday)

	if diff.RatingPrev == nil || *diff.RatingPrev != 4.0 {
		t.Fatalf("RatingPrev = %v, want 4.0", diff.RatingPrev)
	}
	if diff.ReviewCountPrev == nil || *diff.ReviewCountPrev != 20 {
		t.Fatalf("ReviewCountPrev = %v, want 20", diff.ReviewCountPrev)
	}
	// 呼出元の値とポインタを共有しない（前日の値を後から書き換えても結果が変わらない）。
	*yesterday.Rating = 1.0
	if *diff.RatingPrev != 4.0 {
		t.Fatalf("RatingPrev shares the caller's pointer: got %v after mutating the input", *diff.RatingPrev)
	}
}

func TestDiff_UnratedYesterdayKeepsReviewCountOnly(t *testing.T) {
	// Issue #255: 前日の自店が評価なし（クチコミ 0 件）なら、評価の前日値は無いが件数の前日値は残す
	// （0 件→1 件の日の新着件数を失わないため）。旧コードのゼロ値 0 も評価なしとして読む。
	zero := 0.0
	for _, yesterday := range []Metrics{unratedMetrics(), {Rating: &zero, ReviewCount: 0}} {
		diff := Diff(rated(5.0, 1), &yesterday)
		if diff.RatingPrev != nil {
			t.Errorf("RatingPrev = %v, want nil", *diff.RatingPrev)
		}
		if diff.ReviewCountPrev == nil || *diff.ReviewCountPrev != 0 {
			t.Errorf("ReviewCountPrev = %v, want 0", diff.ReviewCountPrev)
		}
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

// line-on-demand-report（Req 8.2・8.6・8.7）: 抜粋は口コミの帰属 3 項目をそのまま持ち運ぶ。ここで落とすと
// 日次集計へ書かれず、レポートはその口コミの内容を表示できない。
func TestNewReviews_ExcerptKeepsAttribution(t *testing.T) {
	lastBatchDate := mustParseTime(t, "2026-07-10T00:00:00Z")
	reviews := []Review{
		{
			AuthorName: "New1", PublishTime: mustParseTime(t, "2026-07-11T09:00:00Z"), Rating: 5, Text: "new review",
			AuthorURI:      "https://www.google.com/maps/contrib/test-author-1/reviews",
			AuthorPhotoURI: "https://lh3.googleusercontent.com/a/test-photo-1",
			GoogleMapsURI:  "https://www.google.com/maps/reviews/data=test-review-1",
		},
	}

	info := NewReviews(1, reviews, lastBatchDate)

	if len(info.Excerpts) != 1 {
		t.Fatalf("Excerpts len = %d, want 1", len(info.Excerpts))
	}
	got := info.Excerpts[0]
	if got.AuthorURI != reviews[0].AuthorURI || got.AuthorPhotoURI != reviews[0].AuthorPhotoURI || got.GoogleMapsURI != reviews[0].GoogleMapsURI {
		t.Fatalf("Excerpts[0] = %+v, want the attribution URLs of the input review", got)
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
