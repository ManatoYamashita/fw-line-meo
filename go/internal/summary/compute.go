// Package summary は日次サマリー配信素材（順位・前日比・新着差分）の算出を行う。
// design.md「Go / summary/compute」契約に従う純関数群のみで構成し、DB・HTTP・
// context.Context を一切扱わない（入力は既に取得済みの値、依存は無し）。
//
// 出力の意味論:
//   - RankAll: {自店＋当日 active 競合} のうち星評価のある店舗の比較集合における順位・母数
//     （daily_summaries.rank/rank_total・rating_snapshots.rank）。rank_prev も前日の値へ同じ関数を
//     適用して求める（呼出元の責務）
//   - Diff: 前日スナップショットとの比較用の前日値（daily_summaries.rating_prev/review_count_prev）
//   - NewReviews: 新着クチコミの件数と抜粋（daily_summaries.new_review_count/new_reviews）
package summary

import (
	"sort"
	"time"
)

// Metrics は順位算出・前日比較に必要な指標の最小集合（自店・競合で共通の形）。
//
// Rating は Google の星評価（1.0〜5.0）で、nil は評価の無い店舗（クチコミ 0 件で Places API が
// rating を返さない）を表す（Issue #255）。評価の無い店舗は順位の比較集合に入らない。
type Metrics struct {
	Rating      *float64
	ReviewCount int
}

// Rated は星評価を持つか。0 以下は評価の定義域（1.0〜5.0）の外であり、旧コードがゼロ値 0 で
// 書いたスナップショット（Issue #255 以前）も評価なしとして読む。
func (m Metrics) Rated() bool {
	return m.Rating != nil && *m.Rating > 0
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
//
// AuthorURI・AuthorPhotoURI・GoogleMapsURI は places.Review の同名の項目をそのまま運ぶ（空文字は
// 「取得できていない」の意味。line-on-demand-report Req 8.2・8.6・8.7）。
type Review struct {
	AuthorName  string
	PublishTime time.Time
	Rating      float64
	Text        string

	AuthorURI      string
	AuthorPhotoURI string
	GoogleMapsURI  string
}

// NewReviewInfo は新着クチコミの件数（正）と抜粋（ベストエフォート）。
type NewReviewInfo struct {
	Count    int
	Excerpts []Review
}

// Ranking は RankAll の結果。
type Ranking struct {
	// SelfRank は自店の順位（1 始まり）。自店が評価なしなら nil（評価の無い店舗は順位を持たない）。
	SelfRank *int
	// Total は比較集合の母数（評価のある自店・競合の数 N）。自店が評価なしでも、評価のある競合は数える。
	Total int
	// CompetitorRanks は competitors と同じ添字の各競合の順位（自店を含む通し順位）。評価なしは nil。
	CompetitorRanks []*int
}

// RankAll は {自店＋active競合} のうち星評価のある店舗を、星評価降順（同率は reviewCount 降順）で
// 順位付けする。評価の無い店舗（Rated が偽）は比較集合に入れず、順位も母数も持たない（R2.9）。
// competitors が空（nil を含む）で自店に評価があれば rank=1, total=1（R1.3: 競合0件時の自店のみ
// サマリー）。自店の順位・母数と各競合の順位（rating_snapshots.rank・表示順）を同じ比較関数から出す。
//
// Invariant（design.md）: rank 定義は four-tier design の確定定義（星評価降順→同率は
// クチコミ総数降順・point-in-time 固定）と一致する。星評価・クチコミ総数の両方が
// 同率の場合、安定ソートにより自店を競合より下位に置かない
// （自店を比較集合の先頭要素として並べたうえで安定ソートすることで保証する）。
func RankAll(self Metrics, competitors []Metrics) Ranking {
	// 自店を値だけで再識別できない（競合と完全同率のケースがある）ため、
	// (Metrics, 元の添字) のペアで比較集合を管理し、自店を先頭要素として
	// 投入したうえで安定ソートする。index は自店が -1、競合は competitors の添字。
	type entry struct {
		metrics Metrics
		index   int
	}

	entries := make([]entry, 0, len(competitors)+1)
	if self.Rated() {
		entries = append(entries, entry{metrics: self, index: -1})
	}
	for i, c := range competitors {
		if c.Rated() {
			entries = append(entries, entry{metrics: c, index: i})
		}
	}

	sort.SliceStable(entries, func(i, j int) bool {
		ri, rj := *entries[i].metrics.Rating, *entries[j].metrics.Rating
		if ri != rj {
			return ri > rj
		}
		return entries[i].metrics.ReviewCount > entries[j].metrics.ReviewCount
	})

	ranking := Ranking{Total: len(entries), CompetitorRanks: make([]*int, len(competitors))}
	for position, e := range entries {
		rank := position + 1
		if e.index < 0 {
			ranking.SelfRank = &rank
		} else {
			ranking.CompetitorRanks[e.index] = &rank
		}
	}
	return ranking
}

// Diff は前日スナップショット（nil 許容）との比較用の前日値を返す。
// yesterday が nil の場合（前日の記録が存在しない = R3.7: 初回配信等）、
// 各 *Prev フィールドは nil となり、呼出元は前日比の表示を省略する。
// 前日の自店が評価なしなら RatingPrev だけが nil になる（件数の前日値は残す）。
func Diff(today Metrics, yesterday *Metrics) MetricsDiff {
	if yesterday == nil {
		return MetricsDiff{}
	}
	var ratingPrev *float64
	if yesterday.Rated() {
		// 呼出元の値とポインタを共有しない。
		rating := *yesterday.Rating
		ratingPrev = &rating
	}
	reviewCount := yesterday.ReviewCount
	return MetricsDiff{
		RatingPrev:      ratingPrev,
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
