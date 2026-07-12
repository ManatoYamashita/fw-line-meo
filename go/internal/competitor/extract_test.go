package competitor

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/ManatoYamashita/fw-line-meo/go/internal/places"
	"github.com/ManatoYamashita/fw-line-meo/go/internal/repo"
	"github.com/jackc/pgx/v5/pgxpool"
)

// --- フェイク Places サーバー（task 3.1 のパターンに準拠。places パッケージ内部の DTO には
// アクセスできない＝package competitor からは非公開のため、Places API (New) のワイヤー形式を
// 直接 JSON として組み立てる）---

type fakeNearbyPlace struct {
	ID          string             `json:"id"`
	DisplayName fakeDisplayNameDTO `json:"displayName"`
	Location    fakeLatLngDTO      `json:"location"`
	PrimaryType string             `json:"primaryType"`
}

type fakeDisplayNameDTO struct {
	Text string `json:"text"`
}

type fakeLatLngDTO struct {
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
}

type fakeNearbySearchResponse struct {
	Places []fakeNearbyPlace `json:"places"`
}

// newFakeNearbyServer は指定された places 一覧をそのまま searchNearby のレスポンスとして返す
// httptest サーバーを構築する（距離昇順で渡すこと — NearbyCompetitors は rankPreference=DISTANCE
// を前提に呼び出し元が既にソート済みの結果として扱う）。
func newFakeNearbyServer(t *testing.T, resultPlaces []fakeNearbyPlace) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(fakeNearbySearchResponse{Places: resultPlaces})
	}))
	t.Cleanup(server.Close)
	return server
}

func newFakePlacesClient(t *testing.T, resultPlaces []fakeNearbyPlace) places.PlacesClient {
	t.Helper()
	server := newFakeNearbyServer(t, resultPlaces)
	return places.NewClient("test-api-key", places.WithBaseURL(server.URL))
}

// --- DB テストヘルパー（go/internal/repo/testdb_test.go・seedStore と同じ思想。
// competitor パッケージは repo の非公開テストヘルパーを参照できないためローカルに複製する）---

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping competitor integration test (see ts/scripts/with-test-db.sh)")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// seedConfirmedStore は operator/agency/owner/confirmed store の最小チェーンを挿入し、
// ExtractAndFix にそのまま渡せる repo.Store を返す。
func seedConfirmedStore(t *testing.T, ctx context.Context, pool *pgxpool.Pool, lineUserID, placeID string, lat, lng float64) repo.Store {
	t.Helper()

	var operatorID string
	err := pool.QueryRow(ctx, `INSERT INTO operators (name) VALUES ($1) RETURNING id`, "competitor-test-operator-"+lineUserID).Scan(&operatorID)
	if err != nil {
		t.Fatalf("seed operator: %v", err)
	}

	var agencyID string
	err = pool.QueryRow(ctx, `INSERT INTO agencies (operator_id, name) VALUES ($1, $2) RETURNING id`, operatorID, "competitor-test-agency-"+lineUserID).Scan(&agencyID)
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
	`, ownerID, "competitor-test-store-"+lineUserID, lat, lng, placeID).Scan(&storeID)
	if err != nil {
		t.Fatalf("seed store: %v", err)
	}

	catCode := "ramen"
	return repo.Store{
		ID:           storeID,
		OwnerID:      ownerID,
		PlaceID:      placeID,
		CategoryCode: &catCode,
		Latitude:     &lat,
		Longitude:    &lng,
	}
}

func placeAt(id, name string, lat, lng float64) fakeNearbyPlace {
	return fakeNearbyPlace{
		ID:          id,
		DisplayName: fakeDisplayNameDTO{Text: name},
		Location:    fakeLatLngDTO{Latitude: lat, Longitude: lng},
		PrimaryType: "ramen_restaurant",
	}
}

// --- ExtractAndFix テスト（Requirement 1.1–1.3）---

func TestExtractAndFix_SixHits_ExcludesSelfAndFixesTop5(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)

	selfLat, selfLng := 35.681236, 139.767125
	store := seedConfirmedStore(t, ctx, pool, "U-extract-6hit", "place-self-6hit", selfLat, selfLng)

	// 距離昇順で6件（うち1件は自店自身 — Places API に自店除外パラメータが無いため
	// 検索結果に混入し得る。research.md の想定どおり)。自店を除いた残り5件がそのまま
	// 「5店未満ではない」ケースの上位5件になる。
	results := []fakeNearbyPlace{
		placeAt("place-comp-1", "競合1", 35.6811, 139.7672),
		placeAt(store.PlaceID, "自店(検索結果に混入)", 35.681236, 139.767125),
		placeAt("place-comp-2", "競合2", 35.6813, 139.7674),
		placeAt("place-comp-3", "競合3", 35.6815, 139.7676),
		placeAt("place-comp-4", "競合4", 35.6817, 139.7678),
		placeAt("place-comp-5", "競合5", 35.6819, 139.7680),
	}
	client := newFakePlacesClient(t, results)

	selected, err := ExtractAndFix(ctx, client, pool, store)
	if err != nil {
		t.Fatalf("ExtractAndFix: %v", err)
	}

	if len(selected) != 5 {
		t.Fatalf("expected 5 competitors selected, got %d: %+v", len(selected), selected)
	}
	for _, c := range selected {
		if c.PlaceID == store.PlaceID {
			t.Fatalf("self place_id %q must not appear in selected competitors: %+v", store.PlaceID, selected)
		}
	}
	wantOrder := []string{"place-comp-1", "place-comp-2", "place-comp-3", "place-comp-4", "place-comp-5"}
	for i, want := range wantOrder {
		if selected[i].PlaceID != want {
			t.Errorf("selected[%d].PlaceID = %q, want %q (distance order must be preserved)", i, selected[i].PlaceID, want)
		}
	}

	active, err := repo.ActiveCompetitors(ctx, pool, store.ID)
	if err != nil {
		t.Fatalf("ActiveCompetitors: %v", err)
	}
	if len(active) != 5 {
		t.Fatalf("expected 5 active competitors fixed in DB, got %d: %+v", len(active), active)
	}
}

func TestExtractAndFix_FewerThanFiveHits_FixesOnlyFound(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)

	selfLat, selfLng := 35.7, 139.8
	store := seedConfirmedStore(t, ctx, pool, "U-extract-fewer", "place-self-fewer", selfLat, selfLng)

	// 自店除外後に3件しか残らないケース（Requirement 1.2: 5店未満はある分のみ）。
	results := []fakeNearbyPlace{
		placeAt("place-fewer-1", "競合A", 35.7001, 139.8001),
		placeAt("place-fewer-2", "競合B", 35.7002, 139.8002),
		placeAt(store.PlaceID, "自店", 35.7, 139.8),
		placeAt("place-fewer-3", "競合C", 35.7003, 139.8003),
	}
	client := newFakePlacesClient(t, results)

	selected, err := ExtractAndFix(ctx, client, pool, store)
	if err != nil {
		t.Fatalf("ExtractAndFix: %v", err)
	}

	if len(selected) != 3 {
		t.Fatalf("expected 3 competitors selected (fewer than 5 available), got %d: %+v", len(selected), selected)
	}

	active, err := repo.ActiveCompetitors(ctx, pool, store.ID)
	if err != nil {
		t.Fatalf("ActiveCompetitors: %v", err)
	}
	if len(active) != 3 {
		t.Fatalf("expected 3 active competitors fixed in DB, got %d: %+v", len(active), active)
	}
}

func TestExtractAndFix_ZeroHits_NoCompetitorsState(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)

	selfLat, selfLng := 35.5, 139.5
	store := seedConfirmedStore(t, ctx, pool, "U-extract-zero", "place-self-zero", selfLat, selfLng)

	// 検索結果が自店のみ、あるいは空の場合 = 条件を満たす競合が1店も無い（Requirement 1.3）。
	results := []fakeNearbyPlace{
		placeAt(store.PlaceID, "自店のみ", selfLat, selfLng),
	}
	client := newFakePlacesClient(t, results)

	selected, err := ExtractAndFix(ctx, client, pool, store)
	if err != nil {
		t.Fatalf("ExtractAndFix: %v", err)
	}

	if len(selected) != 0 {
		t.Fatalf("expected 0 competitors selected, got %d: %+v", len(selected), selected)
	}

	active, err := repo.ActiveCompetitors(ctx, pool, store.ID)
	if err != nil {
		t.Fatalf("ActiveCompetitors: %v", err)
	}
	if len(active) != 0 {
		t.Fatalf("expected 0 active competitors in DB (no_competitors state), got %d: %+v", len(active), active)
	}
}

func TestExtractAndFix_EmptyNearbyResult_NoCompetitorsState(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)

	selfLat, selfLng := 35.4, 139.4
	store := seedConfirmedStore(t, ctx, pool, "U-extract-empty", "place-self-empty", selfLat, selfLng)

	client := newFakePlacesClient(t, []fakeNearbyPlace{})

	selected, err := ExtractAndFix(ctx, client, pool, store)
	if err != nil {
		t.Fatalf("ExtractAndFix: %v", err)
	}
	if len(selected) != 0 {
		t.Fatalf("expected 0 competitors selected, got %d: %+v", len(selected), selected)
	}
}

// --- 純粋ロジックのユニットテスト（DB 不要・自店除外/上位5件切り出しの境界値）---

func TestSelectCompetitors_ExcludesSelfAndCapsAtFive(t *testing.T) {
	results := []places.PlaceLite{
		{PlaceID: "p1", DisplayName: "A", Location: places.LatLng{Lat: 1, Lng: 1}},
		{PlaceID: "self", DisplayName: "Self", Location: places.LatLng{Lat: 0, Lng: 0}},
		{PlaceID: "p2", DisplayName: "B", Location: places.LatLng{Lat: 2, Lng: 2}},
		{PlaceID: "p3", DisplayName: "C", Location: places.LatLng{Lat: 3, Lng: 3}},
		{PlaceID: "p4", DisplayName: "D", Location: places.LatLng{Lat: 4, Lng: 4}},
		{PlaceID: "p5", DisplayName: "E", Location: places.LatLng{Lat: 5, Lng: 5}},
	}

	got := selectCompetitors(results, "self")

	if len(got) != 5 {
		t.Fatalf("len(got) = %d, want 5", len(got))
	}
	for _, c := range got {
		if c.PlaceID == "self" {
			t.Fatalf("self must be excluded, got %+v", got)
		}
	}
}

func TestSelectCompetitors_EmptyInput_ReturnsEmptySlice(t *testing.T) {
	got := selectCompetitors(nil, "self")
	if len(got) != 0 {
		t.Fatalf("len(got) = %d, want 0", len(got))
	}
}

func TestPrimaryTypeForCategory_KnownAndFallback(t *testing.T) {
	ramen := "ramen"
	unknown := "not-a-real-category"

	cases := []struct {
		name string
		code *string
		want string
	}{
		{"known code", &ramen, "ramen_restaurant"},
		{"nil code falls back to restaurant", nil, defaultPrimaryType},
		{"unknown code falls back to restaurant", &unknown, defaultPrimaryType},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := primaryTypeForCategory(tc.code)
			if got != tc.want {
				t.Errorf("primaryTypeForCategory(%v) = %q, want %q", tc.code, got, tc.want)
			}
		})
	}
}
