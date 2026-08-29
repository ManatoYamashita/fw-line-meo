package repo

import (
	"context"
	"testing"

	"github.com/ManatoYamashita/fw-line-meo/go/internal/testdb"
	"github.com/jackc/pgx/v5/pgxpool"
)

// testPool は**このテスト専用**のデータベース（migrations 適用済み）を返す（Issue #163）。
// 従来は共有 DB へ直結し、seedStore が挿入した operator/agency/owner/store を片付けないまま
// 残していたため、同時に（あるいは後から）走る internal/batch の全件クエリを汚していた。
func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	return testdb.Isolated(t)
}

// seedStore は operator/agency/owner/confirmed store の最小チェーンを挿入し store id を返す。
// 各テストが固有の line_user_id を渡すことで、テスト間のデータ衝突を避ける。
func seedStore(t *testing.T, ctx context.Context, pool *pgxpool.Pool, lineUserID, placeID string) string {
	t.Helper()

	var operatorID string
	err := pool.QueryRow(ctx, `INSERT INTO operators (name) VALUES ($1) RETURNING id`, "repo-test-operator-"+lineUserID).Scan(&operatorID)
	if err != nil {
		t.Fatalf("seed operator: %v", err)
	}

	var agencyID string
	err = pool.QueryRow(ctx, `INSERT INTO agencies (operator_id, name) VALUES ($1, $2) RETURNING id`, operatorID, "repo-test-agency-"+lineUserID).Scan(&agencyID)
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
		VALUES ($1, 'ramen', $2, 35.681236, 139.767125, $3, 'confirmed')
		RETURNING id
	`, ownerID, "repo-test-store-"+lineUserID, placeID).Scan(&storeID)
	if err != nil {
		t.Fatalf("seed store: %v", err)
	}

	return storeID
}
