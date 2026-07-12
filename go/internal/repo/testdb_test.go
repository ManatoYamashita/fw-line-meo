package repo

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// testPool は DATABASE_URL 相手の pgx プールを返す。DATABASE_URL 未設定時はテストを
// スキップする — ts/scripts/with-test-db.sh・ts の describe.skipIf(!process.env.DATABASE_URL)
// と同じ「DB が無ければ自動スキップ、渡されたら実 DB で検証する」思想を Go 側でも踏襲する。
func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping repo integration test (see ts/scripts/with-test-db.sh)")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
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
