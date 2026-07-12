package places

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"time"
)

const (
	defaultBaseURL         = "https://places.googleapis.com"
	nearbySearchPath       = "/v1/places:searchNearby"
	placeDetailsPathPrefix = "/v1/places/"

	// フィールドマスクは2種のみ（design.md: SKU 分離・research.md コスト最適化）。
	nearbyFieldMask     = "places.id,places.displayName,places.location,places.primaryType"
	selfFieldMask       = "rating,userRatingCount,businessStatus,reviews"
	competitorFieldMask = "rating,userRatingCount,businessStatus,displayName"

	rankPreferenceDistance = "DISTANCE"

	defaultBackoffBase = 100 * time.Millisecond
	defaultBackoffMax  = 5 * time.Second
	defaultMaxRetries  = 5
)

// ErrPlaceNotFound は Place Details / Nearby Search が NOT_FOUND を返した場合の型付きエラー。
// errors.Is(err, ErrPlaceNotFound) で判別可能（呼出元がラップしたエラーにも %w で伝播する）。
var ErrPlaceNotFound = errors.New("places: place not found")

// ErrPlaceClosedPermanently は Place Details の businessStatus が CLOSED_PERMANENTLY の場合の型付きエラー。
// errors.Is(err, ErrPlaceClosedPermanently) で判別可能。
var ErrPlaceClosedPermanently = errors.New("places: place closed permanently")

// PlacesClient は Places API (New) への唯一の呼出口（design.md: Go / places/client）。
type PlacesClient interface {
	// NearbyCompetitors は自店を中心に同一 primaryType の近隣店舗を距離昇順で返す（自店を含み得る）。
	NearbyCompetitors(ctx context.Context, center LatLng, primaryType string, radiusM float64, maxCount int) ([]PlaceLite, error)
	// FetchSelfMetrics は自店の指標とレビュー（最大5件・関連度順）を返す。
	FetchSelfMetrics(ctx context.Context, placeID string) (SelfMetrics, error)
	// FetchCompetitorMetrics は競合の指標のみを返す。
	FetchCompetitorMetrics(ctx context.Context, placeID string) (CompetitorMetrics, error)
}

// Client は PlacesClient の標準 net/http 実装。beta の公式 Go クライアント
// （cloud.google.com/go/maps/places/apiv1）は使わず plain REST で実装する（research.md Decision）。
type Client struct {
	apiKey      string
	baseURL     string
	httpClient  *http.Client
	backoffBase time.Duration
	backoffMax  time.Duration
	maxRetries  int
}

var _ PlacesClient = (*Client)(nil)

// Option は Client の構築時オプション。
type Option func(*Client)

// WithBaseURL は接続先ベース URL を差し替える（テストでは httptest サーバーを指す）。
func WithBaseURL(baseURL string) Option {
	return func(c *Client) { c.baseURL = baseURL }
}

// WithHTTPClient は内部で使う *http.Client を差し替える。
func WithHTTPClient(hc *http.Client) Option {
	return func(c *Client) { c.httpClient = hc }
}

// WithBackoff は 429/5xx 再試行時の指数バックオフパラメータを差し替える
// （テストでは base/max を小さくして実時間を消費しないようにする）。
func WithBackoff(base, max time.Duration, maxRetries int) Option {
	return func(c *Client) {
		c.backoffBase = base
		c.backoffMax = max
		c.maxRetries = maxRetries
	}
}

// NewClient は apiKey（Secret Manager 由来の env 値）を用いて Client を構築する。
func NewClient(apiKey string, opts ...Option) *Client {
	c := &Client{
		apiKey:      apiKey,
		baseURL:     defaultBaseURL,
		httpClient:  &http.Client{Timeout: 30 * time.Second},
		backoffBase: defaultBackoffBase,
		backoffMax:  defaultBackoffMax,
		maxRetries:  defaultMaxRetries,
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// NearbyCompetitors implements PlacesClient.
func (c *Client) NearbyCompetitors(ctx context.Context, center LatLng, primaryType string, radiusM float64, maxCount int) ([]PlaceLite, error) {
	reqBody := nearbySearchRequest{
		LocationRestriction: nearbyLocationRestriction{
			Circle: nearbyCircle{
				Center: latLngDTO{Latitude: center.Lat, Longitude: center.Lng},
				Radius: radiusM,
			},
		},
		IncludedPrimaryTypes: []string{primaryType},
		RankPreference:       rankPreferenceDistance,
		MaxResultCount:       maxCount,
	}
	payload, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("places: marshal nearby search request: %w", err)
	}

	respBody, err := c.executeWithRetry(ctx, http.MethodPost, c.baseURL+nearbySearchPath, payload, nearbyFieldMask)
	if err != nil {
		return nil, err
	}

	var parsed nearbySearchResponse
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return nil, fmt.Errorf("places: decode nearby search response: %w", err)
	}

	result := make([]PlaceLite, 0, len(parsed.Places))
	for _, p := range parsed.Places {
		result = append(result, PlaceLite{
			PlaceID:     p.ID,
			DisplayName: p.DisplayName.Text,
			Location:    LatLng{Lat: p.Location.Latitude, Lng: p.Location.Longitude},
			PrimaryType: p.PrimaryType,
		})
	}
	return result, nil
}

// FetchSelfMetrics implements PlacesClient.
func (c *Client) FetchSelfMetrics(ctx context.Context, placeID string) (SelfMetrics, error) {
	respBody, err := c.executeWithRetry(ctx, http.MethodGet, c.placeDetailsURL(placeID), nil, selfFieldMask)
	if err != nil {
		return SelfMetrics{}, wrapPlaceError(placeID, err)
	}

	var parsed placeDetailsResponse
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return SelfMetrics{}, fmt.Errorf("places: decode place details response for %s: %w", placeID, err)
	}

	if parsed.BusinessStatus == BusinessStatusClosedPermanently {
		return SelfMetrics{}, fmt.Errorf("places: place %s is closed permanently: %w", placeID, ErrPlaceClosedPermanently)
	}

	return SelfMetrics{
		Rating:          parsed.Rating,
		UserRatingCount: parsed.UserRatingCount,
		BusinessStatus:  parsed.BusinessStatus,
		Reviews:         convertReviews(parsed.Reviews),
	}, nil
}

// FetchCompetitorMetrics implements PlacesClient.
func (c *Client) FetchCompetitorMetrics(ctx context.Context, placeID string) (CompetitorMetrics, error) {
	respBody, err := c.executeWithRetry(ctx, http.MethodGet, c.placeDetailsURL(placeID), nil, competitorFieldMask)
	if err != nil {
		return CompetitorMetrics{}, wrapPlaceError(placeID, err)
	}

	var parsed placeDetailsResponse
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return CompetitorMetrics{}, fmt.Errorf("places: decode place details response for %s: %w", placeID, err)
	}

	if parsed.BusinessStatus == BusinessStatusClosedPermanently {
		return CompetitorMetrics{}, fmt.Errorf("places: place %s is closed permanently: %w", placeID, ErrPlaceClosedPermanently)
	}

	return CompetitorMetrics{
		DisplayName:     parsed.DisplayName.Text,
		Rating:          parsed.Rating,
		UserRatingCount: parsed.UserRatingCount,
		BusinessStatus:  parsed.BusinessStatus,
	}, nil
}

func (c *Client) placeDetailsURL(placeID string) string {
	return c.baseURL + placeDetailsPathPrefix + url.PathEscape(placeID)
}

func wrapPlaceError(placeID string, err error) error {
	if errors.Is(err, ErrPlaceNotFound) {
		return fmt.Errorf("places: place %s not found: %w", placeID, ErrPlaceNotFound)
	}
	return err
}

func convertReviews(dtos []reviewDTO) []Review {
	reviews := make([]Review, 0, len(dtos))
	for _, r := range dtos {
		// publishTime のパース失敗はベストエフォート方針（research.md: reviews はベストエフォート）。
		// パース不能な場合はゼロ値の time.Time を用い、レビュー自体は破棄しない。
		publishTime, _ := time.Parse(time.RFC3339, r.PublishTime)
		reviews = append(reviews, Review{
			AuthorName:  r.AuthorAttribution.DisplayName,
			PublishTime: publishTime,
			Rating:      r.Rating,
			Text:        r.Text.Text,
		})
	}
	return reviews
}

// retryableError は 429/5xx・トランスポート層エラーなど再試行してよいエラーを示すマーカー型。
// errors.As で判別し、非該当（NOT_FOUND・400系など）は即座に呼出元へ返す。
type retryableError struct {
	err error
}

func (r *retryableError) Error() string { return r.err.Error() }
func (r *retryableError) Unwrap() error { return r.err }

// executeWithRetry は 429/5xx を指数バックオフで再試行しつつ1回の Places API 呼出を実行する。
// 非再試行対象（NOT_FOUND・400系など）は即座にエラーを返す（Requirement 2.1, 2.7: 無駄な呼出を増やさない）。
func (c *Client) executeWithRetry(ctx context.Context, method, url string, body []byte, fieldMask string) ([]byte, error) {
	var lastErr error
	for attempt := 0; ; attempt++ {
		respBody, err := c.doOnce(ctx, method, url, body, fieldMask)
		if err == nil {
			return respBody, nil
		}

		var retryable *retryableError
		if !errors.As(err, &retryable) {
			return nil, err
		}
		lastErr = retryable.err

		if attempt >= c.maxRetries {
			return nil, fmt.Errorf("places: exceeded max retries (%d): %w", c.maxRetries, lastErr)
		}

		delay := backoffDelay(c.backoffBase, c.backoffMax, attempt)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(delay):
		}
	}
}

func backoffDelay(base, max time.Duration, attempt int) time.Duration {
	if base <= 0 {
		return 0
	}
	d := time.Duration(float64(base) * math.Pow(2, float64(attempt)))
	if d <= 0 || d > max {
		return max
	}
	return d
}

// doOnce は Places API (New) へ1回だけ HTTP リクエストを送り、結果を分類する。
//   - 200: レスポンスボディをそのまま返す
//   - 404 / status=NOT_FOUND: ErrPlaceNotFound をラップした非再試行エラー
//   - 429 / 5xx / トランスポートエラー: retryableError でラップ（呼出元が再試行を判断）
//   - その他 4xx（INVALID_REQUEST 等）: 非再試行の通常エラー
func (c *Client) doOnce(ctx context.Context, method, targetURL string, body []byte, fieldMask string) ([]byte, error) {
	var bodyReader io.Reader
	if body != nil {
		bodyReader = bytes.NewReader(body)
	}

	httpReq, err := http.NewRequestWithContext(ctx, method, targetURL, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("places: build request: %w", err)
	}
	httpReq.Header.Set("X-Goog-Api-Key", c.apiKey)
	httpReq.Header.Set("X-Goog-FieldMask", fieldMask)
	if body != nil {
		httpReq.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, &retryableError{fmt.Errorf("places: request failed: %w", err)}
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, &retryableError{fmt.Errorf("places: read response body: %w", err)}
	}

	if resp.StatusCode == http.StatusOK {
		return respBody, nil
	}

	apiErr := parseAPIError(respBody, resp.StatusCode)

	if resp.StatusCode == http.StatusNotFound || apiErr.Status == "NOT_FOUND" {
		return nil, fmt.Errorf("places: %s (status %d): %w", apiErr.Message, resp.StatusCode, ErrPlaceNotFound)
	}

	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= http.StatusInternalServerError {
		return nil, &retryableError{fmt.Errorf("places: transient error (status %d, api status %s): %s", resp.StatusCode, apiErr.Status, apiErr.Message)}
	}

	return nil, fmt.Errorf("places: request failed (status %d, api status %s): %s", resp.StatusCode, apiErr.Status, apiErr.Message)
}

func parseAPIError(body []byte, statusCode int) apiErrorBody {
	var wrapper apiErrorResponse
	if err := json.Unmarshal(body, &wrapper); err != nil || wrapper.Error.Message == "" {
		return apiErrorBody{Code: statusCode, Message: string(body)}
	}
	return wrapper.Error
}
