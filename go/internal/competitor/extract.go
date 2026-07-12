// Package competitor は競合の自動抽出・固定ロジックを提供する
// （design.md「Go / competitor/extract」＝ File Structure Plan の
// competitor/extract.go「競合抽出ロジック（自店除外・上位5件・R1）」）。
//
// 本パッケージは places（task 3.1）と repo（task 3.3）の間の業務ロジックであり、
// 「競合未固定の確定済み店舗」を日次バッチの先頭で処理する自己修復型抽出
// （research.md Decision）の中核を成す。日次バッチ全体のオーケストレーション
// （どの店舗を対象にするか・ワーカープール等）は task 3.5 の責務であり、本パッケージは
// 「店舗1件を渡されたら抽出して固定する」関数を提供するのみ。
package competitor

import (
	"context"
	"errors"
	"fmt"

	"github.com/ManatoYamashita/fw-line-meo/go/internal/places"
	"github.com/ManatoYamashita/fw-line-meo/go/internal/repo"
)

const (
	// RadiusMeters は競合抽出の検索半径（Requirement 1.1: 半径1km）。
	RadiusMeters = 1000.0

	// nearbySearchMaxResultCount は Nearby Search への要求件数。自店除外パラメータが
	// Places API に存在しないため（research.md）、自店を含み得る前提で 5+1=6 件取得し、
	// クライアント側で自店を除外してもなお上位5件を確保できるようにする。
	nearbySearchMaxResultCount = 6

	// MaxCompetitors は固定する競合の上限（Requirement 1.1: 上位5店）。
	MaxCompetitors = 5

	// defaultPrimaryType は category_code が nil または未知のコードの場合に使う
	// Places API (New) Table A のフォールバック主カテゴリ。
	defaultPrimaryType = "restaurant"
)

// ErrMissingLocation は店舗に緯度経度が設定されておらず Nearby Search の中心点を
// 構築できない場合に返す（confirmed 店舗は通常オンボーディング時に確定済みだが、
// 0001 の CHECK 制約は place_id の有無のみを強制しており lat/lng の NOT NULL までは
// 強制していないため、実行時に防御的に検査する）。
var ErrMissingLocation = errors.New("competitor: store missing latitude/longitude for extraction")

// categoryToPrimaryType は stores.category_code（db/migrations/0002_reference_seed.sql が
// SoT の自社カテゴリコード）を Places API (New) の Nearby Search `includedPrimaryTypes` に
// 使う Table A primaryType へ対応付ける。
//
// 判断メモ（このタスク時点で db/migrations 配下・コードベースのどこにもこの対応表は
// 存在しなかったため、本タスクの境界内で最小限のものを新設した）:
//   - ramen/sushi/italian/chinese/cafe/bakery は Table A に同名の細粒度タイプが存在するため
//     そのまま対応付ける（research.md が言及する ramen_restaurant もこれに含まれる）。
//   - izakaya（居酒屋）・washoku（和食）・curry（カレー）には Table A に専用タイプが無い。
//     3つとも和食業態であるため、包括的な japanese_restaurant にフォールバックする。
//   - yakiniku（焼肉）も専用タイプは無いが、性質上もっとも近い barbecue_restaurant に
//     フォールバックする。
//   - other・未知のコード・nil は、抽出そのものが失敗しないよう汎用的な restaurant
//     （defaultPrimaryType）にフォールバックする。
var categoryToPrimaryType = map[string]string{
	"ramen":    "ramen_restaurant",
	"sushi":    "sushi_restaurant",
	"italian":  "italian_restaurant",
	"chinese":  "chinese_restaurant",
	"cafe":     "cafe",
	"bakery":   "bakery",
	"izakaya":  "japanese_restaurant",
	"washoku":  "japanese_restaurant",
	"curry":    "japanese_restaurant",
	"yakiniku": "barbecue_restaurant",
	"other":    defaultPrimaryType,
}

// primaryTypeForCategory は categoryCode を Places primaryType へ解決する。
// nil または categoryToPrimaryType に無いコードは defaultPrimaryType にフォールバックする。
func primaryTypeForCategory(categoryCode *string) string {
	if categoryCode == nil {
		return defaultPrimaryType
	}
	if pt, ok := categoryToPrimaryType[*categoryCode]; ok {
		return pt
	}
	return defaultPrimaryType
}

// ExtractAndFix は1店舗分の競合自動抽出・固定を行う（design.md「競合抽出ロジック
// （自店除外・上位5件・R1）」）。
//
// 手順:
//  1. store の緯度経度を中心に、store.CategoryCode から解決した primaryType で
//     半径 RadiusMeters・最大 nearbySearchMaxResultCount 件を Nearby Search する。
//  2. 結果（Places API が距離昇順で返す。NearbyCompetitors の実装コメント参照）から
//     自店の place_id を除外し、残りの近い順上位 MaxCompetitors 件を採用する。
//  3. repo.FixCompetitors で採用リストを固定する。
//
// 戻り値は実際に固定を試みた競合リスト（0〜5件）。0件は Requirement 1.3 の
// 「競合なし」状態に対応するが、その状態を daily_summaries.status='no_competitors' として
// メッセージに反映するのは summary/compute・flex.ts（task 3.5 以降）の責務であり、本関数は
// repo.FixCompetitors が空リストに対して安全に no-op で成功することのみを保証する
// （見つかった競合が0件でもエラーにはしない — 1.3 の「競合なし」は異常系ではない）。
//
// 5店未満しか見つからない場合（Requirement 1.2）は、見つかった分のみを固定する
// （自店除外後の残数がそのまま採用件数の上限になるため、追加のロジックは不要）。
func ExtractAndFix(ctx context.Context, client places.PlacesClient, db repo.DBTX, store repo.Store) ([]repo.NewCompetitor, error) {
	if store.Latitude == nil || store.Longitude == nil {
		return nil, fmt.Errorf("%w: store_id=%s", ErrMissingLocation, store.ID)
	}

	primaryType := primaryTypeForCategory(store.CategoryCode)
	center := places.LatLng{Lat: *store.Latitude, Lng: *store.Longitude}

	results, err := client.NearbyCompetitors(ctx, center, primaryType, RadiusMeters, nearbySearchMaxResultCount)
	if err != nil {
		return nil, fmt.Errorf("competitor: nearby search for store_id=%s: %w", store.ID, err)
	}

	selected := selectCompetitors(results, store.PlaceID)

	if err := repo.FixCompetitors(ctx, db, store.ID, selected); err != nil {
		return nil, fmt.Errorf("competitor: fix competitors for store_id=%s: %w", store.ID, err)
	}

	return selected, nil
}

// selectCompetitors は Nearby Search の結果から自店（selfPlaceID）を除外し、残りの
// 近い順上位 MaxCompetitors 件を repo.NewCompetitor へ変換する。
//
// NearbyCompetitors は rankPreference=DISTANCE で呼び出されており、results は既に
// 中心点からの距離昇順で返る（places/types.go のコメント参照）。したがって本関数は
// 単純なフィルタ＋先頭 N 件切り出しでよく、独自の距離計算・再ソートは行わない。
func selectCompetitors(results []places.PlaceLite, selfPlaceID string) []repo.NewCompetitor {
	selected := make([]repo.NewCompetitor, 0, MaxCompetitors)
	for _, p := range results {
		if p.PlaceID == selfPlaceID {
			continue
		}
		lat, lng := p.Location.Lat, p.Location.Lng
		selected = append(selected, repo.NewCompetitor{
			PlaceID:   p.PlaceID,
			Name:      p.DisplayName,
			Latitude:  &lat,
			Longitude: &lng,
		})
		if len(selected) == MaxCompetitors {
			break
		}
	}
	return selected
}
