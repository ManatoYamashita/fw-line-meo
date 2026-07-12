package places

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// fastBackoff は実時間をほぼ消費しない再試行パラメータ（テスト専用）。
func fastBackoff() Option {
	return WithBackoff(1*time.Millisecond, 5*time.Millisecond, 5)
}

func TestNearbyCompetitors_RequestShapeAndFieldMask(t *testing.T) {
	var gotFieldMask, gotMethod, gotPath, gotAPIKey string
	var gotBody nearbySearchRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotFieldMask = r.Header.Get("X-Goog-FieldMask")
		gotAPIKey = r.Header.Get("X-Goog-Api-Key")
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("failed to decode request body: %v", err)
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(nearbySearchResponse{
			Places: []nearbyPlaceDTO{
				{
					ID:          "place-1",
					DisplayName: displayNameDTO{Text: "麺屋一号店"},
					Location:    latLngDTO{Latitude: 35.1, Longitude: 139.1},
					PrimaryType: "ramen_restaurant",
				},
				{
					ID:          "place-2",
					DisplayName: displayNameDTO{Text: "麺屋二号店"},
					Location:    latLngDTO{Latitude: 35.2, Longitude: 139.2},
					PrimaryType: "ramen_restaurant",
				},
			},
		})
	}))
	defer server.Close()

	client := NewClient("test-api-key", WithBaseURL(server.URL), fastBackoff())

	places, err := client.NearbyCompetitors(context.Background(), LatLng{Lat: 35.0, Lng: 139.0}, "ramen_restaurant", 1000, 6)
	if err != nil {
		t.Fatalf("NearbyCompetitors returned error: %v", err)
	}

	if gotMethod != http.MethodPost {
		t.Errorf("method = %q, want POST", gotMethod)
	}
	if gotPath != nearbySearchPath {
		t.Errorf("path = %q, want %q", gotPath, nearbySearchPath)
	}
	if gotFieldMask != nearbyFieldMask {
		t.Errorf("field mask = %q, want %q", gotFieldMask, nearbyFieldMask)
	}
	if gotAPIKey != "test-api-key" {
		t.Errorf("api key header = %q, want test-api-key", gotAPIKey)
	}

	if gotBody.LocationRestriction.Circle.Radius != 1000 {
		t.Errorf("radius = %v, want 1000", gotBody.LocationRestriction.Circle.Radius)
	}
	if gotBody.LocationRestriction.Circle.Center.Latitude != 35.0 || gotBody.LocationRestriction.Circle.Center.Longitude != 139.0 {
		t.Errorf("center = %+v, want {35.0 139.0}", gotBody.LocationRestriction.Circle.Center)
	}
	if len(gotBody.IncludedPrimaryTypes) != 1 || gotBody.IncludedPrimaryTypes[0] != "ramen_restaurant" {
		t.Errorf("includedPrimaryTypes = %v, want [ramen_restaurant]", gotBody.IncludedPrimaryTypes)
	}
	if gotBody.RankPreference != "DISTANCE" {
		t.Errorf("rankPreference = %q, want DISTANCE", gotBody.RankPreference)
	}
	if gotBody.MaxResultCount != 6 {
		t.Errorf("maxResultCount = %d, want 6", gotBody.MaxResultCount)
	}

	if len(places) != 2 {
		t.Fatalf("len(places) = %d, want 2", len(places))
	}
	if places[0].PlaceID != "place-1" || places[0].DisplayName != "麺屋一号店" {
		t.Errorf("places[0] = %+v, unexpected", places[0])
	}
	if places[1].Location.Lat != 35.2 || places[1].Location.Lng != 139.2 {
		t.Errorf("places[1].Location = %+v, unexpected", places[1].Location)
	}
}

func TestFetchSelfMetrics_UsesSelfFieldMaskAndDecodesReviews(t *testing.T) {
	var gotFieldMask, gotMethod, gotPath string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotFieldMask = r.Header.Get("X-Goog-FieldMask")

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(placeDetailsResponse{
			Rating:          4.5,
			UserRatingCount: 120,
			BusinessStatus:  BusinessStatusOperational,
			Reviews: []reviewDTO{
				{
					Rating:            5,
					PublishTime:       "2026-07-01T09:00:00Z",
					Text:              reviewTextDTO{Text: "美味しかったです"},
					AuthorAttribution: reviewAuthorAttribution{DisplayName: "田中太郎"},
				},
			},
		})
	}))
	defer server.Close()

	client := NewClient("test-api-key", WithBaseURL(server.URL), fastBackoff())

	metrics, err := client.FetchSelfMetrics(context.Background(), "self-place-id")
	if err != nil {
		t.Fatalf("FetchSelfMetrics returned error: %v", err)
	}

	if gotMethod != http.MethodGet {
		t.Errorf("method = %q, want GET", gotMethod)
	}
	if gotPath != placeDetailsPathPrefix+"self-place-id" {
		t.Errorf("path = %q, want %q", gotPath, placeDetailsPathPrefix+"self-place-id")
	}
	if gotFieldMask != selfFieldMask {
		t.Errorf("field mask = %q, want %q", gotFieldMask, selfFieldMask)
	}

	if metrics.Rating != 4.5 || metrics.UserRatingCount != 120 {
		t.Errorf("metrics = %+v, unexpected", metrics)
	}
	if len(metrics.Reviews) != 1 {
		t.Fatalf("len(Reviews) = %d, want 1", len(metrics.Reviews))
	}
	if metrics.Reviews[0].AuthorName != "田中太郎" || metrics.Reviews[0].Text != "美味しかったです" {
		t.Errorf("Reviews[0] = %+v, unexpected", metrics.Reviews[0])
	}
	wantTime, _ := time.Parse(time.RFC3339, "2026-07-01T09:00:00Z")
	if !metrics.Reviews[0].PublishTime.Equal(wantTime) {
		t.Errorf("Reviews[0].PublishTime = %v, want %v", metrics.Reviews[0].PublishTime, wantTime)
	}
}

func TestFetchCompetitorMetrics_UsesCompetitorFieldMaskDistinctFromSelf(t *testing.T) {
	var gotFieldMask string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotFieldMask = r.Header.Get("X-Goog-FieldMask")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(placeDetailsResponse{
			Rating:          3.8,
			UserRatingCount: 40,
			BusinessStatus:  BusinessStatusOperational,
			DisplayName:     displayNameDTO{Text: "競合ラーメン店"},
		})
	}))
	defer server.Close()

	client := NewClient("test-api-key", WithBaseURL(server.URL), fastBackoff())

	metrics, err := client.FetchCompetitorMetrics(context.Background(), "competitor-place-id")
	if err != nil {
		t.Fatalf("FetchCompetitorMetrics returned error: %v", err)
	}

	if gotFieldMask != competitorFieldMask {
		t.Errorf("field mask = %q, want %q", gotFieldMask, competitorFieldMask)
	}
	if gotFieldMask == selfFieldMask {
		t.Errorf("competitor field mask must differ from self field mask, both were %q", gotFieldMask)
	}
	if metrics.DisplayName != "競合ラーメン店" || metrics.Rating != 3.8 || metrics.UserRatingCount != 40 {
		t.Errorf("metrics = %+v, unexpected", metrics)
	}
}

func TestFetchSelfMetrics_RetriesOn429ThenSucceeds(t *testing.T) {
	var callCount int32

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&callCount, 1)
		if n <= 2 {
			w.WriteHeader(http.StatusTooManyRequests)
			_ = json.NewEncoder(w).Encode(apiErrorResponse{Error: apiErrorBody{Code: 429, Message: "quota exceeded", Status: "RESOURCE_EXHAUSTED"}})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(placeDetailsResponse{Rating: 4.0, UserRatingCount: 10, BusinessStatus: BusinessStatusOperational})
	}))
	defer server.Close()

	client := NewClient("test-api-key", WithBaseURL(server.URL), fastBackoff())

	start := time.Now()
	metrics, err := client.FetchSelfMetrics(context.Background(), "place-retry-429")
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("expected eventual success, got error: %v", err)
	}
	if metrics.Rating != 4.0 {
		t.Errorf("Rating = %v, want 4.0", metrics.Rating)
	}
	if got := atomic.LoadInt32(&callCount); got != 3 {
		t.Errorf("call count = %d, want 3 (2 failures + 1 success)", got)
	}
	if elapsed > 500*time.Millisecond {
		t.Errorf("test took %v, backoff should be fast in tests (small base/max)", elapsed)
	}
}

func TestFetchCompetitorMetrics_RetriesOn5xxThenSucceeds(t *testing.T) {
	var callCount int32

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&callCount, 1)
		if n <= 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			_ = json.NewEncoder(w).Encode(apiErrorResponse{Error: apiErrorBody{Code: 503, Message: "server unavailable", Status: "UNAVAILABLE"}})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(placeDetailsResponse{Rating: 3.5, UserRatingCount: 5, BusinessStatus: BusinessStatusOperational})
	}))
	defer server.Close()

	client := NewClient("test-api-key", WithBaseURL(server.URL), fastBackoff())

	metrics, err := client.FetchCompetitorMetrics(context.Background(), "place-retry-5xx")
	if err != nil {
		t.Fatalf("expected eventual success, got error: %v", err)
	}
	if metrics.Rating != 3.5 {
		t.Errorf("Rating = %v, want 3.5", metrics.Rating)
	}
	if got := atomic.LoadInt32(&callCount); got != 4 {
		t.Errorf("call count = %d, want 4 (3 failures + 1 success)", got)
	}
}

func TestFetchSelfMetrics_ExceedsMaxRetriesReturnsError(t *testing.T) {
	var callCount int32

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&callCount, 1)
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(apiErrorResponse{Error: apiErrorBody{Code: 500, Message: "internal error", Status: "INTERNAL"}})
	}))
	defer server.Close()

	client := NewClient("test-api-key", WithBaseURL(server.URL), WithBackoff(1*time.Millisecond, 2*time.Millisecond, 2))

	start := time.Now()
	_, err := client.FetchSelfMetrics(context.Background(), "place-always-500")
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected error after exceeding max retries, got nil")
	}
	if errors.Is(err, ErrPlaceNotFound) || errors.Is(err, ErrPlaceClosedPermanently) {
		t.Errorf("500 exhaustion should not map to NOT_FOUND/CLOSED_PERMANENTLY, got: %v", err)
	}
	// maxRetries=2 -> attempts 0,1,2 = 3 calls total.
	if got := atomic.LoadInt32(&callCount); got != 3 {
		t.Errorf("call count = %d, want 3 (maxRetries=2 -> 3 attempts)", got)
	}
	if elapsed > 500*time.Millisecond {
		t.Errorf("test took %v, backoff should be fast in tests (small base/max)", elapsed)
	}
}

func TestFetchSelfMetrics_NotFoundMapsToErrPlaceNotFound(t *testing.T) {
	var callCount int32

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&callCount, 1)
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(apiErrorResponse{Error: apiErrorBody{Code: 404, Message: "place not found", Status: "NOT_FOUND"}})
	}))
	defer server.Close()

	client := NewClient("test-api-key", WithBaseURL(server.URL), fastBackoff())

	_, err := client.FetchSelfMetrics(context.Background(), "missing-place-id")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !errors.Is(err, ErrPlaceNotFound) {
		t.Errorf("expected errors.Is(err, ErrPlaceNotFound) to be true, err = %v", err)
	}
	// NOT_FOUND is not retryable: exactly one call should have been made.
	if got := atomic.LoadInt32(&callCount); got != 1 {
		t.Errorf("call count = %d, want 1 (NOT_FOUND must not be retried)", got)
	}
}

func TestFetchCompetitorMetrics_NotFoundMapsToErrPlaceNotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(apiErrorResponse{Error: apiErrorBody{Code: 404, Message: "place not found", Status: "NOT_FOUND"}})
	}))
	defer server.Close()

	client := NewClient("test-api-key", WithBaseURL(server.URL), fastBackoff())

	_, err := client.FetchCompetitorMetrics(context.Background(), "missing-competitor-id")
	if !errors.Is(err, ErrPlaceNotFound) {
		t.Errorf("expected errors.Is(err, ErrPlaceNotFound) to be true, err = %v", err)
	}
}

func TestFetchCompetitorMetrics_ClosedPermanentlyMapsToErrPlaceClosedPermanently(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(placeDetailsResponse{
			BusinessStatus: BusinessStatusClosedPermanently,
			DisplayName:    displayNameDTO{Text: "閉店した店"},
		})
	}))
	defer server.Close()

	client := NewClient("test-api-key", WithBaseURL(server.URL), fastBackoff())

	_, err := client.FetchCompetitorMetrics(context.Background(), "closed-place-id")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !errors.Is(err, ErrPlaceClosedPermanently) {
		t.Errorf("expected errors.Is(err, ErrPlaceClosedPermanently) to be true, err = %v", err)
	}
}

func TestFetchSelfMetrics_ClosedPermanentlyMapsToErrPlaceClosedPermanently(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(placeDetailsResponse{
			BusinessStatus: BusinessStatusClosedPermanently,
		})
	}))
	defer server.Close()

	client := NewClient("test-api-key", WithBaseURL(server.URL), fastBackoff())

	_, err := client.FetchSelfMetrics(context.Background(), "self-closed-place-id")
	if !errors.Is(err, ErrPlaceClosedPermanently) {
		t.Errorf("expected errors.Is(err, ErrPlaceClosedPermanently) to be true, err = %v", err)
	}
}

func TestFetchSelfMetrics_NonRetryable4xxFailsImmediately(t *testing.T) {
	var callCount int32

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&callCount, 1)
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(apiErrorResponse{Error: apiErrorBody{Code: 400, Message: "invalid field mask", Status: "INVALID_ARGUMENT"}})
	}))
	defer server.Close()

	client := NewClient("test-api-key", WithBaseURL(server.URL), fastBackoff())

	_, err := client.FetchSelfMetrics(context.Background(), "bad-request-place-id")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if errors.Is(err, ErrPlaceNotFound) || errors.Is(err, ErrPlaceClosedPermanently) {
		t.Errorf("400 should not map to NOT_FOUND/CLOSED_PERMANENTLY sentinels, got: %v", err)
	}
	if got := atomic.LoadInt32(&callCount); got != 1 {
		t.Errorf("call count = %d, want 1 (non-retryable 4xx must not enter the retry loop)", got)
	}
}

func TestFetchSelfMetrics_ContextCancellationDuringBackoffReturnsPromptly(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(apiErrorResponse{Error: apiErrorBody{Code: 503, Message: "unavailable", Status: "UNAVAILABLE"}})
	}))
	defer server.Close()

	// Large backoff base so the context deadline fires while waiting, not the retry budget.
	client := NewClient("test-api-key", WithBaseURL(server.URL), WithBackoff(200*time.Millisecond, time.Second, 50))

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	start := time.Now()
	_, err := client.FetchSelfMetrics(ctx, "place-ctx-cancel")
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected error due to context cancellation, got nil")
	}
	if elapsed > 500*time.Millisecond {
		t.Errorf("context cancellation should return promptly, took %v", elapsed)
	}
}
