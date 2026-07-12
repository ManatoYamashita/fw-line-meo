package repo

import (
	"context"
	"testing"
)

func TestFixCompetitors_InsertsRows(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	storeID := seedStore(t, ctx, pool, "U-fix-competitors", "place-self-fix")

	lat, lng := 35.68, 139.76
	err := FixCompetitors(ctx, pool, storeID, []NewCompetitor{
		{PlaceID: "place-comp-1", Name: "競合1", Latitude: &lat, Longitude: &lng},
		{PlaceID: "place-comp-2", Name: "競合2"},
	})
	if err != nil {
		t.Fatalf("FixCompetitors: %v", err)
	}

	got, err := ActiveCompetitors(ctx, pool, storeID)
	if err != nil {
		t.Fatalf("ActiveCompetitors: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 active competitors, got %d (%+v)", len(got), got)
	}
	for _, c := range got {
		if !c.Active {
			t.Fatalf("expected competitor to be active, got %+v", c)
		}
	}
}

func TestFixCompetitors_CalledTwice_DoesNotDuplicate(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	storeID := seedStore(t, ctx, pool, "U-fix-competitors-twice", "place-self-fix-twice")

	input := []NewCompetitor{{PlaceID: "place-comp-dup", Name: "競合"}}

	if err := FixCompetitors(ctx, pool, storeID, input); err != nil {
		t.Fatalf("FixCompetitors (1st): %v", err)
	}
	if err := FixCompetitors(ctx, pool, storeID, input); err != nil {
		t.Fatalf("FixCompetitors (2nd): %v", err)
	}

	got, err := ActiveCompetitors(ctx, pool, storeID)
	if err != nil {
		t.Fatalf("ActiveCompetitors: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected FixCompetitors to be idempotent (ON CONFLICT DO NOTHING), got %d rows: %+v", len(got), got)
	}
}

func TestDeactivateCompetitors_SetsActiveFalse_NeverHardDeletes(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	storeID := seedStore(t, ctx, pool, "U-deactivate-competitors", "place-self-deactivate")

	if err := FixCompetitors(ctx, pool, storeID, []NewCompetitor{
		{PlaceID: "place-comp-churn", Name: "閉店した競合"},
		{PlaceID: "place-comp-alive", Name: "存続している競合"},
	}); err != nil {
		t.Fatalf("FixCompetitors: %v", err)
	}

	before, err := ActiveCompetitors(ctx, pool, storeID)
	if err != nil {
		t.Fatalf("ActiveCompetitors (before): %v", err)
	}
	if len(before) != 2 {
		t.Fatalf("expected 2 active competitors before churn, got %d", len(before))
	}

	var churnID string
	for _, c := range before {
		if c.PlaceID == "place-comp-churn" {
			churnID = c.ID
		}
	}
	if churnID == "" {
		t.Fatal("could not find churn competitor id")
	}

	if err := DeactivateCompetitors(ctx, pool, []string{churnID}); err != nil {
		t.Fatalf("DeactivateCompetitors: %v", err)
	}

	after, err := ActiveCompetitors(ctx, pool, storeID)
	if err != nil {
		t.Fatalf("ActiveCompetitors (after): %v", err)
	}
	if len(after) != 1 {
		t.Fatalf("expected 1 active competitor after churn, got %d", len(after))
	}
	if after[0].PlaceID != "place-comp-alive" {
		t.Fatalf("expected remaining active competitor to be place-comp-alive, got %q", after[0].PlaceID)
	}

	// R1.5: 履歴保持 — ハード削除されず、行としては引き続き存在すること（active=false のみ）。
	var stillExists bool
	var active bool
	err = pool.QueryRow(ctx, `SELECT true, active FROM competitors WHERE id = $1`, churnID).Scan(&stillExists, &active)
	if err != nil {
		t.Fatalf("expected churned competitor row to still exist (soft delete only), query failed: %v", err)
	}
	if active {
		t.Fatalf("expected churned competitor active=false, got active=true")
	}
}
