package repo

import (
	"context"
	"fmt"
)

// Store は日次バッチが処理する対象店舗の最小情報（design.md: 対象 = place_status='confirmed'）。
// PlaceID は confirmed 店舗では常に非 NULL（0001: ck_place_confirmed）。
type Store struct {
	ID           string
	OwnerID      string
	PlaceID      string
	CategoryCode *string
	Latitude     *float64
	Longitude    *float64
}

// ConfirmedStores は place_status='confirmed' の全店舗を返す（design.md 日次バッチ Flow:
// 「確定済み店舗と競合リストを読取」の対象抽出）。
func ConfirmedStores(ctx context.Context, db DBTX) ([]Store, error) {
	rows, err := db.Query(ctx, `
		SELECT id, owner_id, place_id, category_code, latitude, longitude
		FROM stores
		WHERE place_status = 'confirmed'
		ORDER BY id
	`)
	if err != nil {
		return nil, fmt.Errorf("repo: query confirmed stores: %w", err)
	}
	defer rows.Close()

	var stores []Store
	for rows.Next() {
		var s Store
		if err := rows.Scan(&s.ID, &s.OwnerID, &s.PlaceID, &s.CategoryCode, &s.Latitude, &s.Longitude); err != nil {
			return nil, fmt.Errorf("repo: scan confirmed store: %w", err)
		}
		stores = append(stores, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("repo: iterate confirmed stores: %w", err)
	}
	return stores, nil
}

// StoresWithoutFixedCompetitors は確定済みかつ competitors 行が1つも無い店舗を返す
// （research.md Decision「競合抽出は日次バッチ内で自己修復型」: 毎朝バッチ冒頭で
// 「place 確定済みかつ競合未固定」の店舗を検出する対象抽出）。
func StoresWithoutFixedCompetitors(ctx context.Context, db DBTX) ([]Store, error) {
	rows, err := db.Query(ctx, `
		SELECT s.id, s.owner_id, s.place_id, s.category_code, s.latitude, s.longitude
		FROM stores s
		WHERE s.place_status = 'confirmed'
		  AND NOT EXISTS (SELECT 1 FROM competitors c WHERE c.store_id = s.id)
		ORDER BY s.id
	`)
	if err != nil {
		return nil, fmt.Errorf("repo: query stores without fixed competitors: %w", err)
	}
	defer rows.Close()

	var stores []Store
	for rows.Next() {
		var s Store
		if err := rows.Scan(&s.ID, &s.OwnerID, &s.PlaceID, &s.CategoryCode, &s.Latitude, &s.Longitude); err != nil {
			return nil, fmt.Errorf("repo: scan store without fixed competitors: %w", err)
		}
		stores = append(stores, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("repo: iterate stores without fixed competitors: %w", err)
	}
	return stores, nil
}

// ActiveCompetitors は指定店舗の active な（churn していない）固定済み競合を返す
// （R1.5: churn 済み競合は当日の比較対象・取得対象から除外）。
func ActiveCompetitors(ctx context.Context, db DBTX, storeID string) ([]Competitor, error) {
	rows, err := db.Query(ctx, `
		SELECT id, store_id, place_id, COALESCE(name, ''), latitude, longitude, active
		FROM competitors
		WHERE store_id = $1 AND active = true
		ORDER BY id
	`, storeID)
	if err != nil {
		return nil, fmt.Errorf("repo: query active competitors for store_id=%s: %w", storeID, err)
	}
	defer rows.Close()

	var competitors []Competitor
	for rows.Next() {
		var c Competitor
		if err := rows.Scan(&c.ID, &c.StoreID, &c.PlaceID, &c.Name, &c.Latitude, &c.Longitude, &c.Active); err != nil {
			return nil, fmt.Errorf("repo: scan active competitor: %w", err)
		}
		competitors = append(competitors, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("repo: iterate active competitors for store_id=%s: %w", storeID, err)
	}
	return competitors, nil
}
