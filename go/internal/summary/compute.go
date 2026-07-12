// Package summary は日次サマリー配信素材（順位・前日比・新着差分）の算出を行う。
// design.md「Go / summary/compute」契約に従う純関数群のみで構成し、DB・HTTP・
// context.Context を一切扱わない（入力は既に取得済みの値、依存は無し）。
//
// 出力の意味論:
//   - Rank: {自店＋当日 active 競合} の比較集合における自店の順位・母数（daily_summaries.rank/rank_total）
//   - Diff: 前日スナップショットとの比較用の前日値（daily_summaries.rating_prev/review_count_prev）。
//     rank_prev はこのパッケージの Rank を前日データに対して呼び出すことで別途算出する（呼出元の責務）。
//   - NewReviews: 新着クチコミの件数と抜粋（daily_summaries.new_review_count/new_reviews）
package summary

import (
	"sort"
	"time"
)

// Metrics は順位算出・前日比較に必要な指標の最小集合（自店・競合で共通の形）。
type Metrics struct {
	Rating      float64
	ReviewCount int
}

// MetricsDiff は前日スナップショットとの比較用の前日値。
// yesterday が nil で渡された場合（前日レコード無し = R3.7）、全フィールドが nil になる。
type MetricsDiff struct {
	RatingPrev      *float64
	ReviewCountPrev *int
}

// Review はクチコミ1件の表示用抜粋（帰属情報付き）。
// Place Details (New) の reviews は最大5件・関連度順固定（newest ソート不可）であり、
// 新着クチコミがこの枠に入らない場合は抜粋として拾えないことがある（取りこぼし。research.md 参照）。
type Review struct {
	AuthorName  string
	PublishTime time.Time
	Rating      float64
	Text        string
}

// NewReviewInfo は新着クチコミの件数（正）と抜粋（ベストエフォート）。
type NewReviewInfo struct {
	Count    int
	Excerpts []Review
}

// Rank は {自店＋active競合} を星評価降順（同率は reviewCount 降順）で順位付けし、
// 自店順位（1始まり）と比較集合の母数を返す。competitors が空（nil を含む）の場合は
// 自店単独で rank=1, total=1 を返す（R1.3: 競合0件時の自店のみサマリー）。
//
// Invariant（design.md）: rank 定義は four-tier design の確定定義（星評価降順→同率は
// クチコミ総数降順・point-in-time 固定）と一致する。星評価・クチコミ総数の両方が
// 同率の場合、安定ソートにより自店を競合より下位に置かない
// （自店を比較集合の先頭要素として並べたうえで安定ソートすることで保証する）。
func Rank(self Metrics, competitors []Metrics) (rank, total int) {
	// 自店を値だけで再識別できない（競合と完全同率のケースがある）ため、
	// (Metrics, 元が自店か) のペアで比較集合を管理し、自店を先頭要素として
	// 投入したうえで安定ソートする。
	type entry struct {
		metrics Metrics
		isSelf  bool
	}

	entries := make([]entry, 0, len(competitors)+1)
	entries = append(entries, entry{metrics: self, isSelf: true})
	for _, c := range competitors {
		entries = append(entries, entry{metrics: c})
	}

	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].metrics.Rating != entries[j].metrics.Rating {
			return entries[i].metrics.Rating > entries[j].metrics.Rating
		}
		return entries[i].metrics.ReviewCount > entries[j].metrics.ReviewCount
	})

	for i, e := range entries {
		if e.isSelf {
			return i + 1, len(entries)
		}
	}
	// entries は必ず自店（isSelf=true）を含むため到達しない。
	return len(entries), len(entries)
}

// Diff は前日スナップショット（nil 許容）との比較用の前日値を返す。
// yesterday が nil の場合（前日の記録が存在しない = R3.7: 初回配信等）、
// 各 *Prev フィールドは nil となり、呼出元は前日比の表示を省略する。
func Diff(today Metrics, yesterday *Metrics) MetricsDiff {
	if yesterday == nil {
		return MetricsDiff{}
	}
	rating := yesterday.Rating
	reviewCount := yesterday.ReviewCount
	return MetricsDiff{
		RatingPrev:      &rating,
		ReviewCountPrev: &reviewCount,
	}
}

// NewReviews は review_count の差分（countDelta）を新着件数の正とし、
// publishTime が lastBatchDate より後のレビューを reviews（関連度順上位5件）から
// 抜粋として添える。
//
// countDelta が 0 以下の場合は新着なしとして Count=0・Excerpts=空を返す
// （R3.6: 新着クチコミが無い場合は「新着なし」表示）。
//
// reviews は Places API (New) の仕様上「関連度順・最大5件」に固定されており
// newest ソートは提供されない（research.md）。そのため countDelta が正でも
// publishTime > lastBatchDate に該当するレビューが reviews 中に見つからない、
// または一部しか見つからないことがある（取りこぼし）。本関数はその場合も
// エラーにせず、Count は countDelta を正として報告し、Excerpts は
// 見つかった分（空も含む）のみを返す（ベストエフォート）。
func NewReviews(countDelta int, reviews []Review, lastBatchDate time.Time) NewReviewInfo {
	if countDelta <= 0 {
		return NewReviewInfo{Count: 0, Excerpts: []Review{}}
	}

	excerpts := make([]Review, 0, len(reviews))
	for _, r := range reviews {
		if r.PublishTime.After(lastBatchDate) {
			excerpts = append(excerpts, r)
		}
	}

	return NewReviewInfo{Count: countDelta, Excerpts: excerpts}
}
