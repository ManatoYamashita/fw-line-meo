// Package places は Google Places API (New) への唯一の外部取得点を提供する。
// design.md「Go / places/client」契約に従い、Nearby Search（競合抽出）と
// Place Details（自店/競合の指標取得）を実装する。本パッケージ以外から
// Places API を呼び出してはならない（Requirement 2.2 のスクレイピング禁止の
// 機械的担保点でもある）。
package places

import "time"

// LatLng は緯度経度の組。
type LatLng struct {
	Lat float64
	Lng float64
}

// PlaceLite は Nearby Search (New) が返す近隣店舗の最小情報。
// 自店除外・上位5件固定などの抽出ロジックは competitor/extract（task 3.4）の責務であり、
// 本パッケージは生の検索結果を距離昇順（rankPreference=DISTANCE）のまま返すのみ。
type PlaceLite struct {
	PlaceID     string
	DisplayName string
	Location    LatLng
	PrimaryType string
}

// Review はクチコミ1件の表示用抜粋。Place Details (New) の reviews は
// 最大5件・関連度順固定（newest ソート不可）であり、新着の取りこぼしが起こり得る。
// 新着「件数」の正は review_count の差分（呼出元 summary/compute の責務）。
type Review struct {
	AuthorName  string
	PublishTime time.Time
	Rating      float64
	Text        string
}

// SelfMetrics は自店用フィールドマスク（rating,userRatingCount,businessStatus,reviews）の取得結果。
type SelfMetrics struct {
	Rating          float64
	UserRatingCount int
	BusinessStatus  string
	Reviews         []Review
}

// CompetitorMetrics は競合用フィールドマスク（rating,userRatingCount,businessStatus,displayName）の取得結果。
// reviews を含まないため Enterprise（Atmosphere 無し）SKU に収まる（research.md コスト分離の根拠）。
type CompetitorMetrics struct {
	DisplayName     string
	Rating          float64
	UserRatingCount int
	BusinessStatus  string
}

// businessStatus 列挙値（Places API (New) 契約）。
const (
	BusinessStatusOperational       = "OPERATIONAL"
	BusinessStatusClosedTemporarily = "CLOSED_TEMPORARILY"
	BusinessStatusClosedPermanently = "CLOSED_PERMANENTLY"
	BusinessStatusFutureOpening     = "FUTURE_OPENING"
)

// --- Places API (New) との REST 契約用 DTO（非公開） ---

// nearbySearchRequest は POST places:searchNearby のリクエストボディ。
type nearbySearchRequest struct {
	LocationRestriction  nearbyLocationRestriction `json:"locationRestriction"`
	IncludedPrimaryTypes []string                  `json:"includedPrimaryTypes"`
	RankPreference       string                    `json:"rankPreference"`
	MaxResultCount       int                       `json:"maxResultCount"`
}

type nearbyLocationRestriction struct {
	Circle nearbyCircle `json:"circle"`
}

type nearbyCircle struct {
	Center latLngDTO `json:"center"`
	Radius float64   `json:"radius"`
}

type latLngDTO struct {
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
}

type displayNameDTO struct {
	Text         string `json:"text"`
	LanguageCode string `json:"languageCode"`
}

// nearbySearchResponse は searchNearby のレスポンスボディ。
type nearbySearchResponse struct {
	Places []nearbyPlaceDTO `json:"places"`
}

type nearbyPlaceDTO struct {
	ID          string         `json:"id"`
	DisplayName displayNameDTO `json:"displayName"`
	Location    latLngDTO      `json:"location"`
	PrimaryType string         `json:"primaryType"`
}

// placeDetailsResponse は GET places/{id} のレスポンスボディ（自店・競合共通の受け皿。
// フィールドマスクにより実際に埋まるフィールドは呼出ごとに異なる）。
type placeDetailsResponse struct {
	Rating          float64        `json:"rating"`
	UserRatingCount int            `json:"userRatingCount"`
	BusinessStatus  string         `json:"businessStatus"`
	DisplayName     displayNameDTO `json:"displayName"`
	Reviews         []reviewDTO    `json:"reviews"`
}

type reviewDTO struct {
	Rating            float64                 `json:"rating"`
	PublishTime       string                  `json:"publishTime"` // RFC3339
	Text              reviewTextDTO           `json:"text"`
	AuthorAttribution reviewAuthorAttribution `json:"authorAttribution"`
}

type reviewTextDTO struct {
	Text         string `json:"text"`
	LanguageCode string `json:"languageCode"`
}

type reviewAuthorAttribution struct {
	DisplayName string `json:"displayName"`
}

// apiErrorResponse は Google Places API (New) のエラーレスポンス契約。
// { "error": { "code": 404, "message": "...", "status": "NOT_FOUND" } }
type apiErrorResponse struct {
	Error apiErrorBody `json:"error"`
}

type apiErrorBody struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Status  string `json:"status"`
}
