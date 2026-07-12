package batch

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ManatoYamashita/fw-line-meo/go/internal/places"
	"github.com/ManatoYamashita/fw-line-meo/go/internal/repo"
	"github.com/jackc/pgx/v5/pgxpool"
)

// --- DB テストヘルパー（go/internal/repo/testdb_test.go・go/internal/competitor/extract_test.go と
// 同じ思想。batch パッケージは他パッケージの非公開テストヘルパーを参照できないためローカルに複製する）---

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping batch integration test (see ts/scripts/with-test-db.sh)")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedConfirmedStore(t *testing.T, ctx context.Context, pool *pgxpool.Pool, lineUserID, placeID string, lat, lng float64) string {
	t.Helper()

	var operatorID string
	err := pool.QueryRow(ctx, `INSERT INTO operators (name) VALUES ($1) RETURNING id`, "batch-test-operator-"+lineUserID).Scan(&operatorID)
	if err != nil {
		t.Fatalf("seed operator: %v", err)
	}

	var agencyID string
	err = pool.QueryRow(ctx, `INSERT INTO agencies (operator_id, name) VALUES ($1, $2) RETURNING id`, operatorID, "batch-test-agency-"+lineUserID).Scan(&agencyID)
	if err != nil {
		t.Fatalf("seed agency: %v", err)
	}

	var ownerID string
	err = pool.QueryRow(ctx, `INSERT INTO owners (agency_id, line_user_id, onboarding_status) VALUES ($1, $2, 'active') RETURNING id`, agencyID, lineUserID).Scan(&ownerID)
	if err != nil {
		t.Fatalf("seed owner: %v", err)
	}

	var storeID string
	err = pool.QueryRow(ctx, `
		INSERT INTO stores (owner_id, category_code, name, latitude, longitude, place_id, place_status)
		VALUES ($1, 'ramen', $2, $3, $4, $5, 'confirmed')
		RETURNING id
	`, ownerID, "batch-test-store-"+lineUserID, lat, lng, placeID).Scan(&storeID)
	if err != nil {
		t.Fatalf("seed store: %v", err)
	}
	return storeID
}

// seedFixedCompetitor は既に固定済みの競合を1件直接 INSERT する（extraction を経由せず
// 「既に競合固定済みの店舗」という前提を作るためのテストヘルパー）。
func seedFixedCompetitor(t *testing.T, ctx context.Context, pool *pgxpool.Pool, storeID, placeID, name string) string {
	t.Helper()
	var id string
	err := pool.QueryRow(ctx, `
		INSERT INTO competitors (store_id, place_id, name, latitude, longitude, active)
		VALUES ($1, $2, $3, 35.0, 139.0, true)
		RETURNING id
	`, storeID, placeID, name).Scan(&id)
	if err != nil {
		t.Fatalf("seed fixed competitor: %v", err)
	}
	return id
}

// --- フェイク Places サーバー（Nearby Search・Place Details 両対応。呼出回数を place_id 別に計上する）---

type fakeDisplayName struct {
	Text string `json:"text"`
}
type fakeLatLng struct {
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
}
type fakeNearbyPlace struct {
	ID          string          `json:"id"`
	DisplayName fakeDisplayName `json:"displayName"`
	Location    fakeLatLng      `json:"location"`
	PrimaryType string          `json:"primaryType"`
}
type fakeNearbyResponse struct {
	Places []fakeNearbyPlace `json:"places"`
}
type fakeReviewText struct {
	Text string `json:"text"`
}
type fakeAuthorAttribution struct {
	DisplayName string `json:"displayName"`
}
type fakeReview struct {
	Rating            float64               `json:"rating"`
	PublishTime       string                `json:"publishTime"`
	Text              fakeReviewText        `json:"text"`
	AuthorAttribution fakeAuthorAttribution `json:"authorAttribution"`
}
type fakeDetailsResponse struct {
	Rating          float64         `json:"rating"`
	UserRatingCount int             `json:"userRatingCount"`
	BusinessStatus  string          `json:"businessStatus"`
	DisplayName     fakeDisplayName `json:"displayName"`
	Reviews         []fakeReview    `json:"reviews"`
}
type fakeErrorBody struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Status  string `json:"status"`
}
type fakeErrorResponse struct {
	Error fakeErrorBody `json:"error"`
}

func operational(rating float64, reviewCount int, displayName string, reviews ...fakeReview) fakeDetailsResponse {
	return fakeDetailsResponse{
		Rating: rating, UserRatingCount: reviewCount, BusinessStatus: "OPERATIONAL",
		DisplayName: fakeDisplayName{Text: displayName}, Reviews: reviews,
	}
}

// fakePlacesServer は Nearby Search を固定リストで、Place Details を place_id 別の canned
// レスポンスで応答する httptest サーバー。呼出回数を method/place_id 別に計上し、テストの
// アサーション（1店舗あたり約6コールの数え上げ・per-store 呼出の検証）に使う。
type fakePlacesServer struct {
	mu sync.Mutex

	baseURL          string
	nearbyCallCount  int
	detailsCallCount map[string]int

	nearbyPlaces []fakeNearbyPlace
	details      map[string]fakeDetailsResponse
	notFound     map[string]bool
}

func newFakePlacesServer(t *testing.T) *fakePlacesServer {
	f := &fakePlacesServer{
		detailsCallCount: map[string]int{},
		details:          map[string]fakeDetailsResponse{},
		notFound:         map[string]bool{},
	}
	server := httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(server.Close)
	f.baseURL = server.URL
	return f
}

func (f *fakePlacesServer) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()

	if r.Method == http.MethodPost && r.URL.Path == "/v1/places:searchNearby" {
		f.nearbyCallCount++
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(fakeNearbyResponse{Places: f.nearbyPlaces})
		return
	}

	placeID := strings.TrimPrefix(r.URL.Path, "/v1/places/")
	f.detailsCallCount[placeID]++

	if f.notFound[placeID] {
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(fakeErrorResponse{Error: fakeErrorBody{Code: 404, Message: "not found", Status: "NOT_FOUND"}})
		return
	}

	d, ok := f.details[placeID]
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(fakeErrorResponse{Error: fakeErrorBody{Code: 404, Message: "unconfigured place in test", Status: "NOT_FOUND"}})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(d)
}

func (f *fakePlacesServer) totalDetailsCalls(placeIDs ...string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	total := 0
	for _, id := range placeIDs {
		total += f.detailsCallCount[id]
	}
	return total
}

func newDeps(t *testing.T, pool *pgxpool.Pool, server *fakePlacesServer, now time.Time) Deps {
	t.Helper()
	client := places.NewClient("test-api-key", places.WithBaseURL(server.baseURL), places.WithBackoff(1*time.Millisecond, 2*time.Millisecond, 1))
	return Deps{
		Pool:             pool,
		Places:           client,
		WorkerPoolSize:   2,
		JitterMaxSeconds: 0,                                 // 起動ジッターを完全にスキップ（テストの実行時間制御）
		IntraStoreJitter: func() time.Duration { return 0 }, // 店舗内コール間の軽ジッターも完全にスキップ
		Now:              func() time.Time { return now },
		Logger:           slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

// --- エンドツーエンドテスト（フェイク Places ＋実 postgres）---

// TestRun_EndToEnd_MixedStores は「確定済み店舗の抽出→ワーカープールでの取得・記録→
// 店舗単位のエラー隔離→再実行の冪等性→1店舗あたり約6コール」を一気通貫で検証する
// （design.md 日次バッチ System Flow・Requirements 1.5, 2.1, 2.5, 2.6, 2.7, 5.1, 5.2）。
func TestRun_EndToEnd_MixedStores(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)

	// storeA: 競合5件が既に固定済みの定常状態店舗（1店舗あたり約6コールの数え上げに使う）。
	storeA := seedConfirmedStore(t, ctx, pool, "U-batch-a", "storeA-self", 35.0, 139.0)
	competitorAIDs := make([]string, 0, 5)
	for i := 1; i <= 5; i++ {
		placeID := fmt.Sprintf("storeA-comp-%d", i)
		seedFixedCompetitor(t, ctx, pool, storeA, placeID, fmt.Sprintf("競合A%d", i))
		competitorAIDs = append(competitorAIDs, placeID)
	}

	// storeB: 競合未固定（このバッチ実行で抽出が走る）。
	storeB := seedConfirmedStore(t, ctx, pool, "U-batch-b", "storeB-self", 35.1, 139.1)

	// storeC: 自店 Place Details が NOT_FOUND（店舗単位のエラー隔離を検証する）。
	// 競合は固定済みにしておく（未固定だと ExtractRan の数え上げに storeC も混入してしまうため）。
	storeC := seedConfirmedStore(t, ctx, pool, "U-batch-c", "storeC-self", 35.2, 139.2)
	seedFixedCompetitor(t, ctx, pool, storeC, "storeC-comp-1", "storeC競合")

	server := newFakePlacesServer(t)
	server.nearbyPlaces = []fakeNearbyPlace{
		{ID: "storeB-comp-1", DisplayName: fakeDisplayName{Text: "storeB競合1"}, Location: fakeLatLng{Latitude: 35.1001, Longitude: 139.1001}, PrimaryType: "ramen_restaurant"},
		{ID: "storeB-comp-2", DisplayName: fakeDisplayName{Text: "storeB競合2"}, Location: fakeLatLng{Latitude: 35.1002, Longitude: 139.1002}, PrimaryType: "ramen_restaurant"},
	}
	server.details["storeA-self"] = operational(4.5, 100, "storeA")
	for _, id := range competitorAIDs {
		server.details[id] = operational(4.0, 50, "competitor-"+id)
	}
	server.details["storeB-self"] = operational(4.2, 20, "storeB")
	server.details["storeB-comp-1"] = operational(3.9, 15, "storeB競合1")
	server.details["storeB-comp-2"] = operational(4.1, 25, "storeB競合2")
	server.notFound["storeC-self"] = true

	now := time.Date(2026, 7, 12, 6, 0, 0, 0, jst)
	deps := newDeps(t, pool, server, now)

	result, err := Run(ctx, deps)
	if err != nil {
		t.Fatalf("Run (1st): %v", err)
	}

	if result.StoresTotal != 3 {
		t.Errorf("StoresTotal = %d, want 3", result.StoresTotal)
	}
	if result.ExtractRan != 1 {
		t.Errorf("ExtractRan = %d, want 1 (only storeB is unfixed)", result.ExtractRan)
	}
	if result.FetchOK != 2 {
		t.Errorf("FetchOK = %d, want 2 (storeA, storeB)", result.FetchOK)
	}
	if result.FetchFailed != 1 {
		t.Errorf("FetchFailed = %d, want 1 (storeC self NOT_FOUND)", result.FetchFailed)
	}
	if result.SummariesWritten != 3 {
		t.Errorf("SummariesWritten = %d, want 3 (all stores get a daily_summaries row, incl. failed)", result.SummariesWritten)
	}

	// --- 1店舗あたり約6コール（自店1＋競合最大5）の数え上げ（Requirement 2.7）---
	storeACalls := server.totalDetailsCalls(append([]string{"storeA-self"}, competitorAIDs...)...)
	if storeACalls != 6 {
		t.Errorf("storeA Places Details calls = %d, want 6 (1 self + 5 competitors)", storeACalls)
	}

	// --- DB 状態の検証 ---
	assertSnapshotCount(t, ctx, pool, storeA, now, 6) // self + 5 competitors
	assertSnapshotCount(t, ctx, pool, storeB, now, 3) // self + 2 newly-extracted competitors
	assertSnapshotCount(t, ctx, pool, storeC, now, 0) // self fetch failed: no snapshot written

	assertSummaryStatus(t, ctx, pool, storeA, now, "ready")
	assertSummaryStatus(t, ctx, pool, storeB, now, "ready")
	assertSummaryStatus(t, ctx, pool, storeC, now, "failed")

	var storeBCompetitorCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM competitors WHERE store_id = $1 AND active = true`, storeB).Scan(&storeBCompetitorCount); err != nil {
		t.Fatalf("count storeB competitors: %v", err)
	}
	if storeBCompetitorCount != 2 {
		t.Fatalf("storeB fixed competitors = %d, want 2 (extraction ran this batch)", storeBCompetitorCount)
	}

	// --- 再実行の冪等性（Requirement 2.6）: 同一 Now（同日）で再実行しても行数が増えない ---
	result2, err := Run(ctx, deps)
	if err != nil {
		t.Fatalf("Run (2nd, same day): %v", err)
	}
	if result2.ExtractRan != 0 {
		t.Errorf("2nd run ExtractRan = %d, want 0 (storeB now has fixed competitors)", result2.ExtractRan)
	}

	assertSnapshotCount(t, ctx, pool, storeA, now, 6)
	assertSnapshotCount(t, ctx, pool, storeB, now, 3)
	assertSnapshotCount(t, ctx, pool, storeC, now, 0)

	var totalSummaries int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM daily_summaries WHERE store_id = ANY($1) AND summary_date = $2`,
		[]string{storeA, storeB, storeC}, now).Scan(&totalSummaries); err != nil {
		t.Fatalf("count daily_summaries after 2nd run: %v", err)
	}
	if totalSummaries != 3 {
		t.Fatalf("daily_summaries rows after 2nd run = %d, want 3 (no duplication)", totalSummaries)
	}
}

// TestRun_CompetitorNotFound_DeactivatesAndExcludesFromToday は取得不能競合の無効化
// （Requirement 1.5）を検証する: NOT_FOUND を返す競合は active=false 化され、当日の
// 比較集合・スナップショットから除外される一方、履歴（competitors 行自体）は保持される。
func TestRun_CompetitorNotFound_DeactivatesAndExcludesFromToday(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)

	storeD := seedConfirmedStore(t, ctx, pool, "U-batch-d", "storeD-self", 35.3, 139.3)
	seedFixedCompetitor(t, ctx, pool, storeD, "storeD-comp-alive", "生存競合")
	deadCompetitorID := seedFixedCompetitor(t, ctx, pool, storeD, "storeD-comp-dead", "消滅競合")

	server := newFakePlacesServer(t)
	server.details["storeD-self"] = operational(4.0, 30, "storeD")
	server.details["storeD-comp-alive"] = operational(3.8, 20, "生存競合")
	server.notFound["storeD-comp-dead"] = true

	now := time.Date(2026, 7, 12, 6, 0, 0, 0, jst)
	deps := newDeps(t, pool, server, now)

	result, err := Run(ctx, deps)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.FetchOK != 1 {
		t.Errorf("FetchOK = %d, want 1", result.FetchOK)
	}

	var active bool
	if err := pool.QueryRow(ctx, `SELECT active FROM competitors WHERE id = $1`, deadCompetitorID).Scan(&active); err != nil {
		t.Fatalf("select competitor active: %v", err)
	}
	if active {
		t.Errorf("expected storeD-comp-dead to be deactivated (active=false), got active=%v", active)
	}

	assertSnapshotCount(t, ctx, pool, storeD, now, 2) // self + alive competitor only

	var rankTotal int
	var competitorsJSON []byte
	if err := pool.QueryRow(ctx, `SELECT rank_total, competitors FROM daily_summaries WHERE store_id = $1 AND summary_date = $2`, storeD, now).
		Scan(&rankTotal, &competitorsJSON); err != nil {
		t.Fatalf("select daily_summary: %v", err)
	}
	if rankTotal != 2 {
		t.Errorf("rank_total = %d, want 2 (self + 1 alive competitor)", rankTotal)
	}
	var competitors []repo.SummaryCompetitor
	if err := json.Unmarshal(competitorsJSON, &competitors); err != nil {
		t.Fatalf("unmarshal competitors json: %v", err)
	}
	if len(competitors) != 1 || competitors[0].Name != "生存競合" {
		t.Fatalf("expected exactly the alive competitor in daily_summaries.competitors, got %+v", competitors)
	}
}

// TestRun_RankPrev_ComputedFromYesterdaySnapshots は Implementation Notes が指示する
// rank_prev の算出（前日の active 競合集合を用意し Rank を再適用する）を検証する
// （task 3.2 で summary.Rank に rank_prev 専用関数が無いため task 3.5 側で解決する責務）。
func TestRun_RankPrev_ComputedFromYesterdaySnapshots(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)

	storeE := seedConfirmedStore(t, ctx, pool, "U-batch-e", "storeE-self", 35.4, 139.4)
	comp1ID := seedFixedCompetitor(t, ctx, pool, storeE, "storeE-comp-1", "競合1")
	comp2ID := seedFixedCompetitor(t, ctx, pool, storeE, "storeE-comp-2", "競合2")

	now := time.Date(2026, 7, 12, 6, 0, 0, 0, jst)
	today := jstDateAsUTC(now)
	yesterday := today.AddDate(0, 0, -1)

	// 前日: 自店 3.5(20件) は 競合1 4.0(30件) の下・競合2 3.0(10件) の上で2位。
	if err := repo.WriteSelfSnapshot(ctx, pool, storeE, repo.SnapshotWrite{PlaceID: "storeE-self", CapturedOn: yesterday, Rating: 3.5, ReviewCount: 20, Rank: 2}); err != nil {
		t.Fatalf("seed yesterday self snapshot: %v", err)
	}
	if err := repo.WriteCompetitorSnapshot(ctx, pool, storeE, comp1ID, repo.SnapshotWrite{PlaceID: "storeE-comp-1", CapturedOn: yesterday, Rating: 4.0, ReviewCount: 30, Rank: 1}); err != nil {
		t.Fatalf("seed yesterday comp1 snapshot: %v", err)
	}
	if err := repo.WriteCompetitorSnapshot(ctx, pool, storeE, comp2ID, repo.SnapshotWrite{PlaceID: "storeE-comp-2", CapturedOn: yesterday, Rating: 3.0, ReviewCount: 10, Rank: 3}); err != nil {
		t.Fatalf("seed yesterday comp2 snapshot: %v", err)
	}

	// 当日: 自店が 4.5(40件) に躍進し、競合1(4.0/30)・競合2(3.0/10) を上回って1位になる想定。
	server := newFakePlacesServer(t)
	server.details["storeE-self"] = operational(4.5, 40, "storeE")
	server.details["storeE-comp-1"] = operational(4.0, 30, "競合1")
	server.details["storeE-comp-2"] = operational(3.0, 10, "競合2")

	deps := newDeps(t, pool, server, now)

	if _, err := Run(ctx, deps); err != nil {
		t.Fatalf("Run: %v", err)
	}

	var rank, rankPrev, rankTotal int
	var rating, ratingPrev float64
	var reviewCount, reviewCountPrev int
	var newReviewCount int
	if err := pool.QueryRow(ctx, `
		SELECT rank, rank_prev, rank_total, rating, rating_prev, review_count, review_count_prev, new_review_count
		FROM daily_summaries WHERE store_id = $1 AND summary_date = $2
	`, storeE, today).Scan(&rank, &rankPrev, &rankTotal, &rating, &ratingPrev, &reviewCount, &reviewCountPrev, &newReviewCount); err != nil {
		t.Fatalf("select daily_summary: %v", err)
	}

	if rank != 1 {
		t.Errorf("rank = %d, want 1 (self jumped to 4.5)", rank)
	}
	if rankPrev != 2 {
		t.Errorf("rank_prev = %d, want 2 (self was between comp1 and comp2 yesterday)", rankPrev)
	}
	if rankTotal != 3 {
		t.Errorf("rank_total = %d, want 3", rankTotal)
	}
	if ratingPrev != 3.5 {
		t.Errorf("rating_prev = %v, want 3.5", ratingPrev)
	}
	if reviewCountPrev != 20 {
		t.Errorf("review_count_prev = %d, want 20", reviewCountPrev)
	}
	if newReviewCount != 20 {
		t.Errorf("new_review_count = %d, want 20 (40 today - 20 yesterday)", newReviewCount)
	}
}

// --- アサーションヘルパー ---

func assertSnapshotCount(t *testing.T, ctx context.Context, pool *pgxpool.Pool, storeID string, capturedOn time.Time, want int) {
	t.Helper()
	var got int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM rating_snapshots WHERE store_id = $1 AND captured_on = $2`, storeID, capturedOn).Scan(&got); err != nil {
		t.Fatalf("count rating_snapshots for store_id=%s: %v", storeID, err)
	}
	if got != want {
		t.Errorf("rating_snapshots count for store_id=%s = %d, want %d", storeID, got, want)
	}
}

func assertSummaryStatus(t *testing.T, ctx context.Context, pool *pgxpool.Pool, storeID string, summaryDate time.Time, want string) {
	t.Helper()
	var got string
	if err := pool.QueryRow(ctx, `SELECT status FROM daily_summaries WHERE store_id = $1 AND summary_date = $2`, storeID, summaryDate).Scan(&got); err != nil {
		t.Fatalf("select daily_summaries.status for store_id=%s: %v", storeID, err)
	}
	if got != want {
		t.Errorf("daily_summaries.status for store_id=%s = %q, want %q", storeID, got, want)
	}
}
