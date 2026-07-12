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
