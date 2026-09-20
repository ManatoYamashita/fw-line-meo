package batch

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ManatoYamashita/fw-line-meo/go/internal/repo"
)

// Issue #303: 店舗の口コミ一覧を Google Maps で開く URL（Places の googleMapsLinks.reviewsUri）を
// daily_summaries.google_maps_reviews_uri へ書く。
//
// Places API は口コミを関連度順に最大 5 件しか返さず、新着順へ並べ替える手段を持たない。そのため
// 口コミ数の多い店では「新着口コミの内容」が構造的に取れず、レポートが行き止まりになる。この URL は
// その行き先（Google Maps の口コミ一覧。そこでは新着順に読める）を保持する。
//
// 応答に無い店もあるので、欠落は NULL のまま残す（空文字を書かない。空文字の href を読み手に
// 描かせないため）。書かれた生の値を SQL で直接読んで確かめる。

// readReviewsURI は daily_summaries.google_maps_reviews_uri を、NULL と空文字を区別できる形で読む。
func readReviewsURI(t *testing.T, ctx context.Context, db *pgxpool.Pool, storeID string, summaryDate time.Time) (value string, isNull bool) {
	t.Helper()
	var got *string
	if err := db.QueryRow(ctx, `
		SELECT google_maps_reviews_uri FROM daily_summaries
		 WHERE store_id = $1 AND summary_date = $2
	`, storeID, summaryDate).Scan(&got); err != nil {
		t.Fatalf("read google_maps_reviews_uri: %v", err)
	}
	if got == nil {
		return "", true
	}
	return *got, false
}

// TestRun_ReviewsURI_WrittenWhenPresentAndNullWhenAbsent: 応答が reviewsUri を持つ店は値を書き、
// 持たない店は NULL のままにする。自店の取得は 1 回のまま（URL のために取得を増やさない）。
func TestRun_ReviewsURI_WrittenWhenPresentAndNullWhenAbsent(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)

	const reviewsURI = "https://www.google.com/maps/place//data=test-reviews-uri"

	withLink := "reviews-uri-with-link"
	withoutLink := "reviews-uri-without-link"
	storeWith := seedConfirmedStore(t, ctx, pool, "U-batch-reviews-uri-1", withLink, 35.5, 139.5)
	storeWithout := seedConfirmedStore(t, ctx, pool, "U-batch-reviews-uri-2", withoutLink, 35.6, 139.6)
	seedFixedCompetitor(t, ctx, pool, storeWith, "reviews-uri-comp-1", "競合A")
	seedFixedCompetitor(t, ctx, pool, storeWithout, "reviews-uri-comp-2", "競合B")

	now := time.Date(2026, 7, 12, 6, 0, 0, 0, jst)
	today := jstDateAsUTC(now)

	server := newFakePlacesServer(t)
	server.details[withLink] = withReviewsURI(operational(4.2, 12, "自店1"), reviewsURI)
	// 応答に googleMapsLinks のキーそのものが無い形（withReviewsURI を通さない）。
	server.details[withoutLink] = operational(4.1, 8, "自店2")
	server.details["reviews-uri-comp-1"] = operational(4.0, 30, "競合A")
	server.details["reviews-uri-comp-2"] = operational(3.9, 20, "競合B")

	if _, err := Run(ctx, newDeps(t, pool, server, now)); err != nil {
		t.Fatalf("Run returned error: %v", err)
	}

	gotWith, isNullWith := readReviewsURI(t, ctx, pool, storeWith, today)
	if isNullWith || gotWith != reviewsURI {
		t.Errorf("google_maps_reviews_uri (with link) = %q null=%v, want %q", gotWith, isNullWith, reviewsURI)
	}

	// **空文字ではなく NULL であること。** 空文字を書くと「URL が無い」と区別できず、読み手が
	// 空の href を描く側へ倒れる。
	gotWithout, isNullWithout := readReviewsURI(t, ctx, pool, storeWithout, today)
	if !isNullWithout {
		t.Errorf("google_maps_reviews_uri (without link) = %q, want NULL", gotWithout)
	}

	// URL のために自店の取得を増やさない（フィールドマスクへ足すだけで済んでいること）。
	if got := server.totalDetailsCalls(withLink); got != 1 {
		t.Errorf("self details call count = %d, want 1 (the reviews URL must not cost an extra call)", got)
	}
}

// TestRun_NewReviewsWithoutExcerpts_CountsStoresWithCountButNoExcerpt: 「新着の件数は 1 以上なのに
// 内容を出せる抜粋が 0 件」の店舗数を実行サマリーへ数える（Issue #303 の観測）。
//
// この状態はエラーにならず status も ready のままなので、数えていないと本番で続いていることを
// 誰も観測できない（実際に 30 日間気づかれなかった）。
func TestRun_NewReviewsWithoutExcerpts_CountsStoresWithCountButNoExcerpt(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)

	now := time.Date(2026, 7, 12, 6, 0, 0, 0, jst)
	today := jstDateAsUTC(now)
	yesterday := today.AddDate(0, 0, -1)

	// 3 店舗を置く。
	//   A: 新着 2 件・抜粋 1 件（出せる）        → 数えない
	//   B: 新着 2 件・抜粋 0 件（古い口コミだけ） → 数える
	//   C: 新着 0 件                             → 数えない
	placeA, placeB, placeC := "excerpt-gap-a", "excerpt-gap-b", "excerpt-gap-c"
	storeA := seedConfirmedStore(t, ctx, pool, "U-batch-excerpt-a", placeA, 35.1, 139.1)
	storeB := seedConfirmedStore(t, ctx, pool, "U-batch-excerpt-b", placeB, 35.2, 139.2)
	seedConfirmedStore(t, ctx, pool, "U-batch-excerpt-c", placeC, 35.3, 139.3)
	seedFixedCompetitor(t, ctx, pool, storeA, "excerpt-gap-comp-a", "競合A")
	seedFixedCompetitor(t, ctx, pool, storeB, "excerpt-gap-comp-b", "競合B")

	for _, s := range []struct {
		store string
		place string
		count int
	}{{storeA, placeA, 10}, {storeB, placeB, 10}} {
		if err := repo.WriteSelfSnapshot(ctx, pool, s.store, repo.SnapshotWrite{
			PlaceID: s.place, CapturedOn: yesterday, Rating: f64(4.0), ReviewCount: s.count, Rank: intPtr(1),
		}); err != nil {
			t.Fatalf("seed yesterday self snapshot: %v", err)
		}
	}

	// 前日の集計基準は 2026-07-11T00:00:00Z。それより後なら抜粋に入る。
	fresh := fakeReview{
		Rating:      5,
		PublishTime: "2026-07-11T09:00:00Z",
		Text:        fakeReviewText{Text: "新しい口コミ"},
		AuthorAttribution: fakeAuthorAttribution{
			DisplayName: "テスト太郎",
			URI:         "https://www.google.com/maps/contrib/test-author-1/reviews",
			PhotoURI:    "https://lh3.googleusercontent.com/a/test-photo-1",
		},
		GoogleMapsURI: "https://www.google.com/maps/reviews/data=test-review-1",
	}
	// 本番で起きている形: 新着はあるのに、返るのは数か月前の口コミだけ。
	stale := fakeReview{
		Rating:            4,
		PublishTime:       "2026-04-01T09:00:00Z",
		Text:              fakeReviewText{Text: "古い口コミ"},
		AuthorAttribution: fakeAuthorAttribution{DisplayName: "テスト花子"},
		GoogleMapsURI:     "https://www.google.com/maps/reviews/data=test-review-2",
	}

	server := newFakePlacesServer(t)
	server.details[placeA] = operational(4.2, 12, "自店A", fresh)
	server.details[placeB] = operational(4.2, 12, "自店B", stale)
	server.details[placeC] = operational(4.2, 10, "自店C", stale)
	server.details["excerpt-gap-comp-a"] = operational(4.0, 30, "競合A")
	server.details["excerpt-gap-comp-b"] = operational(3.9, 20, "競合B")

	result, err := Run(ctx, newDeps(t, pool, server, now))
	if err != nil {
		t.Fatalf("Run returned error: %v", err)
	}

	if result.NewReviewsWithoutExcerpts != 1 {
		t.Errorf("NewReviewsWithoutExcerpts = %d, want 1 (only the store whose new reviews are all stale)",
			result.NewReviewsWithoutExcerpts)
	}
	// 空振りの防止: 数える母数が実在すること（3 店舗とも処理されている）。
	if result.StoresTotal != 3 {
		t.Fatalf("StoresTotal = %d, want 3", result.StoresTotal)
	}
}
