package repo

import (
	"context"
	"testing"
)

func TestConfirmedStores_ReturnsSeededStore(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	storeID := seedStore(t, ctx, pool, "U-confirmed-stores", "place-confirmed-read")

	stores, err := ConfirmedStores(ctx, pool)
	if err != nil {
		t.Fatalf("ConfirmedStores: %v", err)
	}

	var found *Store
	for i := range stores {
		if stores[i].ID == storeID {
			found = &stores[i]
		}
	}
	if found == nil {
		t.Fatalf("expected seeded store %s in ConfirmedStores result (got %d stores)", storeID, len(stores))
	}
	if found.PlaceID != "place-confirmed-read" {
		t.Fatalf("expected place_id=place-confirmed-read, got %q", found.PlaceID)
	}
	if found.CategoryCode == nil || *found.CategoryCode != "ramen" {
		t.Fatalf("expected category_code=ramen, got %+v", found.CategoryCode)
	}
}

func TestStoresWithoutFixedCompetitors_ExcludesFixedStores(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	unfixedID := seedStore(t, ctx, pool, "U-unfixed-competitors", "place-unfixed")
	fixedID := seedStore(t, ctx, pool, "U-fixed-competitors", "place-fixed")

	if err := FixCompetitors(ctx, pool, fixedID, []NewCompetitor{{PlaceID: "place-comp-for-fixed"}}); err != nil {
		t.Fatalf("FixCompetitors: %v", err)
	}

	stores, err := StoresWithoutFixedCompetitors(ctx, pool)
	if err != nil {
		t.Fatalf("StoresWithoutFixedCompetitors: %v", err)
	}

	var hasUnfixed, hasFixed bool
	for _, s := range stores {
		if s.ID == unfixedID {
			hasUnfixed = true
		}
		if s.ID == fixedID {
			hasFixed = true
		}
	}
	if !hasUnfixed {
		t.Fatalf("expected unfixed store %s to be returned", unfixedID)
	}
	if hasFixed {
		t.Fatalf("expected fixed store %s to be excluded", fixedID)
	}
}

func TestActiveCompetitors_ExcludesChurned(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	storeID := seedStore(t, ctx, pool, "U-active-competitors-read", "place-active-comp-read")

	if err := FixCompetitors(ctx, pool, storeID, []NewCompetitor{
		{PlaceID: "place-comp-active"},
		{PlaceID: "place-comp-to-churn"},
	}); err != nil {
		t.Fatalf("FixCompetitors: %v", err)
	}

	all, err := ActiveCompetitors(ctx, pool, storeID)
	if err != nil {
		t.Fatalf("ActiveCompetitors: %v", err)
	}
	var churnID string
	for _, c := range all {
		if c.PlaceID == "place-comp-to-churn" {
			churnID = c.ID
		}
	}
	if err := DeactivateCompetitors(ctx, pool, []string{churnID}); err != nil {
		t.Fatalf("DeactivateCompetitors: %v", err)
	}

	active, err := ActiveCompetitors(ctx, pool, storeID)
	if err != nil {
		t.Fatalf("ActiveCompetitors (after churn): %v", err)
	}
	if len(active) != 1 || active[0].PlaceID != "place-comp-active" {
		t.Fatalf("expected only place-comp-active to remain active, got %+v", active)
	}
}

// setSuspended は停止時刻を SQL で直接立てる・外す（suspended=false で再開）。停止の操作は
// dashboard-api の責務なので、Go の抽出の試験はその操作に依存しない。
func setSuspended(t *testing.T, ctx context.Context, db DBTX, storeID string, suspended bool) {
	t.Helper()
	query := `UPDATE stores SET suspended_at = NULL WHERE id = $1`
	if suspended {
		query = `UPDATE stores SET suspended_at = now() WHERE id = $1`
	}
	tag, err := db.Exec(ctx, query, storeID)
	if err != nil {
		t.Fatalf("set suspended=%v for store_id=%s: %v", suspended, storeID, err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("set suspended=%v for store_id=%s: rows affected = %d, want 1", suspended, storeID, tag.RowsAffected())
	}
}

func containsStore(stores []Store, id string) bool {
	for _, s := range stores {
		if s.ID == id {
			return true
		}
	}
	return false
}

// TestConfirmedStores_ExcludesSuspendedStoreUntilResumed は、停止中の確定店舗が取得対象から外れ、
// 再開後は対象へ戻ることを検証する（store-suspension Requirements 3.1, 3.3, 3.4, 3.5）。
// 停止中の店舗は確定済みなので、停止の述語が無ければ結果に出る。
func TestConfirmedStores_ExcludesSuspendedStoreUntilResumed(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	activeID := seedStore(t, ctx, pool, "U-confirmed-active", "place-confirmed-active")
	suspendedID := seedStore(t, ctx, pool, "U-confirmed-suspended", "place-confirmed-suspended")
	setSuspended(t, ctx, pool, suspendedID, true)

	stores, err := ConfirmedStores(ctx, pool)
	if err != nil {
		t.Fatalf("ConfirmedStores: %v", err)
	}
	if !containsStore(stores, activeID) {
		t.Fatalf("expected active store %s in ConfirmedStores result", activeID)
	}
	if containsStore(stores, suspendedID) {
		t.Fatalf("expected suspended store %s to be excluded from ConfirmedStores", suspendedID)
	}
	if len(stores) != 1 {
		t.Fatalf("ConfirmedStores returned %d stores, want 1 (suspended store must not be counted)", len(stores))
	}

	setSuspended(t, ctx, pool, suspendedID, false)

	stores, err = ConfirmedStores(ctx, pool)
	if err != nil {
		t.Fatalf("ConfirmedStores (after resume): %v", err)
	}
	if !containsStore(stores, suspendedID) {
		t.Fatalf("expected resumed store %s to return to ConfirmedStores", suspendedID)
	}
	if len(stores) != 2 {
		t.Fatalf("ConfirmedStores (after resume) returned %d stores, want 2", len(stores))
	}
}

// TestStoresWithoutFixedCompetitors_ExcludesSuspendedStoreUntilResumed は、競合が未固定でも停止中の
// 店舗は抽出の対象に出ず、再開後は出ることを検証する（store-suspension Requirements 3.2, 3.5）。
func TestStoresWithoutFixedCompetitors_ExcludesSuspendedStoreUntilResumed(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	activeID := seedStore(t, ctx, pool, "U-unfixed-active", "place-unfixed-active")
	suspendedID := seedStore(t, ctx, pool, "U-unfixed-suspended", "place-unfixed-suspended")
	setSuspended(t, ctx, pool, suspendedID, true)

	stores, err := StoresWithoutFixedCompetitors(ctx, pool)
	if err != nil {
		t.Fatalf("StoresWithoutFixedCompetitors: %v", err)
	}
	if !containsStore(stores, activeID) {
		t.Fatalf("expected active unfixed store %s to be returned", activeID)
	}
	if containsStore(stores, suspendedID) {
		t.Fatalf("expected suspended unfixed store %s to be excluded", suspendedID)
	}

	setSuspended(t, ctx, pool, suspendedID, false)

	stores, err = StoresWithoutFixedCompetitors(ctx, pool)
	if err != nil {
		t.Fatalf("StoresWithoutFixedCompetitors (after resume): %v", err)
	}
	if !containsStore(stores, suspendedID) {
		t.Fatalf("expected resumed unfixed store %s to be returned", suspendedID)
	}
}
