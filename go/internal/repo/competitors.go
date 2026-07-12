package repo

import (
	"context"
	"fmt"
)

// Competitor は competitors テーブルの1行（design.md/0001: churn は active=false・ハード削除しない）。
type Competitor struct {
	ID        string
	StoreID   string
	PlaceID   string
	Name      string
	Latitude  *float64
	Longitude *float64
	Active    bool
}

// NewCompetitor は競合リスト固定時の投入値（id/active/created_at は DB 側で確定する）。
type NewCompetitor struct {
	PlaceID   string
	Name      string
	Latitude  *float64
	Longitude *float64
}

// FixCompetitors は店舗の競合リストを固定する（design.md: 1.1 の抽出結果を投入する書込点）。
// R1.4「固定した競合リストの再抽出・追加・削除の手段を MVP では提供しない」の運用は
// 呼出元（competitor/extract・task 3.4）が「競合未固定の店舗にのみ呼ぶ」ことで担保する。
// 本関数自身は (store_id, place_id) の一意制約に ON CONFLICT DO NOTHING で守られており、
// 誤って同一店舗×place_idで再度呼ばれても重複行は作られない（防御的冪等性）。
//
// competitors が空の場合は何もせず成功を返す（R1.3: 競合0件は日次バッチ側で
// no_competitors 状態のサマリーとして扱う。競合ゼロは book-keeping 上の異常ではない）。
func FixCompetitors(ctx context.Context, db DBTX, storeID string, competitors []NewCompetitor) error {
	if len(competitors) == 0 {
		return nil
	}
	for _, c := range competitors {
		_, err := db.Exec(ctx, `
			INSERT INTO competitors (store_id, place_id, name, latitude, longitude, active)
			VALUES ($1, $2, $3, $4, $5, true)
			ON CONFLICT (store_id, place_id) DO NOTHING
		`, storeID, c.PlaceID, nullIfEmpty(c.Name), c.Latitude, c.Longitude)
		if err != nil {
			return fmt.Errorf("repo: fix competitor store_id=%s place_id=%s: %w", storeID, c.PlaceID, err)
		}
	}
	return nil
}

// DeactivateCompetitors は指定 ID の競合を active=false にする（R1.5: 取得不能競合の
// 除外・履歴保持）。競合行はハード削除しない — rating_snapshots からの参照
// （fk_snapshot_competitor_store）が過去の時系列を自立させたまま保持できるようにするため。
// ids が空の場合は何もしない。
func DeactivateCompetitors(ctx context.Context, db DBTX, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := db.Exec(ctx, `
		UPDATE competitors SET active = false WHERE id = ANY($1)
	`, ids)
	if err != nil {
		return fmt.Errorf("repo: deactivate competitors %v: %w", ids, err)
	}
	return nil
}

// nullIfEmpty は空文字列を SQL NULL として渡すためのヘルパー（competitors.name は nullable）。
func nullIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
