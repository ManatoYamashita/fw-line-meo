package batch

import (
	"context"
	"testing"
	"time"

	"github.com/ManatoYamashita/fw-line-meo/go/internal/repo"
)

// line-on-demand-report（Req 8.2・8.6・8.7）: 口コミの帰属 3 項目。
//
// 自店の Place Details の応答が持つ、投稿者のプロフィールの URL と画像の URL、口コミを Google Maps で開く
// URL を、places → summary → repo と運んで daily_summaries.new_reviews の要素へ書く。空の項目はキーごと
// 書かない。TS の読込は 3 項目を任意項目として寛容に読むので、この変換で項目が落ちても表示の試験は緑の
// まま残る。書かれた生の jsonb を、キーの集合と値で直接確かめる。

// TestRun_NewReviewAttribution_WrittenOnlyWhenPresent: 帰属の URL を持つ新着口コミは 3 項目を書き、持たない
// 新着口コミはキーを書かない。既存の 4 項目は変えない。自店の取得は 1 回のまま。
func TestRun_NewReviewAttribution_WrittenOnlyWhenPresent(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)

	selfPlace := "review-attribution-self"
	store := seedConfirmedStore(t, ctx, pool, "U-batch-review-attribution", selfPlace, 35.4, 139.4)
	seedFixedCompetitor(t, ctx, pool, store, "review-attribution-comp", "競合A")

	now := time.Date(2026, 7, 12, 6, 0, 0, 0, jst)
	today := jstDateAsUTC(now)
	yesterday := today.AddDate(0, 0, -1)

	// 前日の自店は 10 件。当日は 12 件なので、新着は 2 件になる。
	if err := repo.WriteSelfSnapshot(ctx, pool, store, repo.SnapshotWrite{
		PlaceID: selfPlace, CapturedOn: yesterday, Rating: f64(4.0), ReviewCount: 10, Rank: intPtr(1),
	}); err != nil {
		t.Fatalf("seed yesterday self snapshot: %v", err)
	}

	server := newFakePlacesServer(t)
	server.details[selfPlace] = operational(4.2, 12, "自店",
		// 新着で、帰属の URL を 3 つとも持つ口コミ。
		fakeReview{
			Rating:      5,
			PublishTime: "2026-07-11T09:00:00Z", // 前日の集計基準（2026-07-11T00:00:00Z）より後 → 新着
			Text:        fakeReviewText{Text: "美味しかったです"},
			AuthorAttribution: fakeAuthorAttribution{
				DisplayName: "テスト太郎",
				URI:         "https://www.google.com/maps/contrib/test-author-1/reviews",
				PhotoURI:    "https://lh3.googleusercontent.com/a/test-photo-1",
			},
			GoogleMapsURI: "https://www.google.com/maps/reviews/data=test-review-1",
		},
		// 新着で、帰属の URL を持たない口コミ（応答にキーそのものが無い）。
		fakeReview{
			Rating:            4,
			PublishTime:       "2026-07-11T10:00:00Z",
			Text:              fakeReviewText{Text: "また来ます"},
			AuthorAttribution: fakeAuthorAttribution{DisplayName: "テスト花子"},
		},
		// 前日の集計基準より前の口コミ（抜粋に入らない）。
		fakeReview{
			Rating:      3,
			PublishTime: "2026-07-01T09:00:00Z",
			Text:        fakeReviewText{Text: "以前の口コミです"},
			AuthorAttribution: fakeAuthorAttribution{
				DisplayName: "テスト次郎",
				URI:         "https://www.google.com/maps/contrib/test-author-3/reviews",
				PhotoURI:    "https://lh3.googleusercontent.com/a/test-photo-3",
			},
			GoogleMapsURI: "https://www.google.com/maps/reviews/data=test-review-3",
		},
	)
	server.details["review-attribution-comp"] = operational(4.0, 30, "競合A")

	if _, err := Run(ctx, newDeps(t, pool, server, now)); err != nil {
		t.Fatalf("Run: %v", err)
	}

	// 帰属 3 項目のために自店の取得を増やさない（フィールドマスクは places の試験が固定する）。
	if got := server.totalDetailsCalls(selfPlace); got != 1 {
		t.Errorf("self Place Details calls = %d, want 1", got)
	}

	got := readNewReviewElements(t, ctx, pool, store, today)
	if len(got) != 2 {
		t.Fatalf("new_reviews elements = %d, want 2 (the two reviews published after the previous day's cutoff)", len(got))
	}

	want := []newReviewElement{
		{
			authorName:     "テスト太郎",
			keys:           "authorName,authorPhotoUri,authorUri,googleMapsUri,publishTime,rating,textExcerpt",
			authorURI:      "https://www.google.com/maps/contrib/test-author-1/reviews",
			authorPhotoURI: "https://lh3.googleusercontent.com/a/test-photo-1",
			googleMapsURI:  "https://www.google.com/maps/reviews/data=test-review-1",
		},
		{
			authorName: "テスト花子",
			keys:       "authorName,publishTime,rating,textExcerpt",
		},
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("new_reviews[%d] = %+v, want %+v", i, got[i], want[i])
		}
	}
}

// newReviewElement は new_reviews の 1 要素を生の jsonb から読んだ形（go/internal/repo/summaries_test.go と
// 同じ。batch パッケージは他パッケージの非公開テストヘルパーを参照できないため複製する）。keys はキーを
// 辞書順（バイト順）に「,」で連ねたもの。3 項目の値は、キーが無ければ空文字として読む（有無は keys で区別する）。
type newReviewElement struct {
	authorName     string
	keys           string
	authorURI      string
	authorPhotoURI string
	googleMapsURI  string
}

// readNewReviewElements は daily_summaries.new_reviews を要素の順に読む。Go の構造体へ Unmarshal すると
// 「キーが無い」と「空文字」の区別が消えるので、キーの集合は SQL の jsonb_object_keys で取る。
func readNewReviewElements(t *testing.T, ctx context.Context, db repo.DBTX, storeID string, summaryDate time.Time) []newReviewElement {
	t.Helper()
	rows, err := db.Query(ctx, `
		SELECT e->>'authorName',
		       (SELECT string_agg(k, ',' ORDER BY k COLLATE "C") FROM jsonb_object_keys(e) AS k),
		       coalesce(e->>'authorUri', ''), coalesce(e->>'authorPhotoUri', ''), coalesce(e->>'googleMapsUri', '')
		FROM daily_summaries AS ds
		CROSS JOIN LATERAL jsonb_array_elements(ds.new_reviews) WITH ORDINALITY AS elements(e, position)
		WHERE ds.store_id = $1 AND ds.summary_date = $2
		ORDER BY elements.position
	`, storeID, summaryDate)
	if err != nil {
		t.Fatalf("select new_reviews elements: %v", err)
	}
	defer rows.Close()

	var got []newReviewElement
	for rows.Next() {
		var e newReviewElement
		if err := rows.Scan(&e.authorName, &e.keys, &e.authorURI, &e.authorPhotoURI, &e.googleMapsURI); err != nil {
			t.Fatalf("scan new_reviews element: %v", err)
		}
		got = append(got, e)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate new_reviews elements: %v", err)
	}
	return got
}
