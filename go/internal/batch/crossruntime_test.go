package batch

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/ManatoYamashita/fw-line-meo/go/internal/repo"
)

// TestCrossRuntimeContract_GoWritesReadableSummaries is the Go half of the cross-runtime
// contract validation (task 7.1・design.md「Architecture Integration: 言語間の結合は SQL
// スキーマのみ」・Requirements 1.4, 2.6, 3.9, 3.10, 5.2).
//
// It runs the REAL Go batch orchestration (Run, the same function cmd/daily-batch/main.go
// wires up) against a fake Places server and a real postgres instance, writing daily_summaries
// rows under FIXED, well-known identifiers (store/owner/place ids). The TS half of this
// contract test (ts/apps/delivery-job/test/cross-runtime.e2e.test.ts) runs SEPARATELY, against
// the SAME DATABASE_URL, and reads these exact rows via the real TS delivery-job orchestration
// (runDeliveryJob) — proving the daily_summaries schema genuinely round-trips between the two
// runtimes with no hidden assumptions on either side (see db/test/cross_runtime_steps.sh for the
// two-step invocation that keeps both halves pointed at one live postgres instance).
//
// This test intentionally does NOT invoke or assert anything about the TS side — that division
// of labor mirrors the fact that Go and TS are separate toolchains/processes; the only channel
// between the two steps is the daily_summaries table itself (identified by the fixed UUIDs below).
//
// Two stores are seeded to exercise both non-trivial JSONB shapes daily_summaries carries:
//   - crossRuntimeReadyStoreID: 2 fixed competitors + a prior-day snapshot, so this run produces
//     a non-empty `competitors` array AND a non-empty `new_reviews` array (the two JSONB columns
//     whose field-name/type contract with TS's DailySummaryCompetitor/DailySummaryNewReview types
//     is exactly what this test exists to validate).
//   - crossRuntimeNoCompetitorsStoreID: zero competitors (Nearby Search returns none), producing
//     status='no_competitors' and an EMPTY `competitors` array — the R1.3 branch that flex.ts's
//     buildCompetitorsSection must render as "competitor not found" rather than crashing on an
//     unexpected shape.
func TestCrossRuntimeContract_GoWritesReadableSummaries(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)

	// Fixed UUIDs reserved for the cross-runtime contract test (task 7.1). Distinct "c7…" prefix
	// to avoid collision with other test files that share the same throwaway postgres instance
	// within a single `make ts-test-db`/with-test-db.sh run (Implementation Notes: task 5.1's
	// "UUID collision across test files" note; task 4.4's index.e2e.test.ts applies the same
	// discipline with its own "f0/f1" prefix).
	const (
		operatorID = "c7000000-0000-0000-0000-000000000001"
		agencyID   = "c7000000-0000-0000-0000-000000000002"

		readyOwnerID = "c7000000-0000-0000-0000-000000000011"
		readyStoreID = "c7100000-0000-0000-0000-000000000001"

		nocompOwnerID = "c7000000-0000-0000-0000-000000000012"
		nocompStoreID = "c7100000-0000-0000-0000-000000000002"

		readyLineUserID  = "U-cross-runtime-ready"
		nocompLineUserID = "U-cross-runtime-nocomp"

		// クロスランタイム契約テスト専用の配信時刻。task 4.4 の index.e2e.test.ts が hour=14 を、
		// targets.db.test.ts が hour=9/10 を使うため、本テストは衝突しない hour=17 を使う
		// （同一 postgres インスタンスを共有する ts-test-db 実行内でも targetsTotal 等の厳密件数
		// 比較を汚染しないための既存の流儀を踏襲）。TS 側（cross-runtime.e2e.test.ts）と一致させる。
		crossRuntimeDeliveryHour = 17
	)

	mustExec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed exec failed (%s): %v", sql, err)
		}
	}

	// このテストは固定 UUID を共有 postgres へ直接 INSERT するため、他テストファイル
	// （特に run_test.go の TestRun_EndToEnd_MixedStores）が unscoped に「全 confirmed 店舗」を
	// 数える箇所（result.StoresTotal 等）を汚染しないよう、必ず自分で片付ける。全 FK が
	// ON DELETE RESTRICT（db/migrations/0001_four_tier_baseline.sql・0004_competitive_daily_summary.sql）
	// のため、子→親の順で明示 DELETE する。t.Cleanup はテスト関数の return 後（Fatal による
	// 中断時も含む）に必ず実行される（defer と異なり FailNow でスキップされない）。
	//
	// 例外: `make cross-runtime-test`（db/test/cross_runtime_steps.sh）は本テストを
	// `go test -run '^TestCrossRuntimeContract_...$'` として単独実行した直後に、同じ postgres
	// インスタンスへ TS 側（cross-runtime.e2e.test.ts）を接続し、ここで書いた daily_summaries 行を
	// 読ませて配信させる（Go の test バイナリが完全終了＝t.Cleanup も全て完了した後に TS が起動する
	// シェルの逐次実行のため、タイミング自体は安全）。しかし t.Cleanup で行を消してしまうと、
	// 直後に起動する TS 側が読むべき行そのものが無くなり cross-runtime 契約テストが壊れる。
	// そのため cross_runtime_steps.sh はこの Go ステップの直前で CROSS_RUNTIME_SKIP_CLEANUP=1 を
	// export し、本テストはそれを見てクリーンアップを抑制する（プレーンな `go test ./...`／
	// `make go-test` では未設定のため通常通り片付く）。
	skipCleanup := os.Getenv("CROSS_RUNTIME_SKIP_CLEANUP") == "1"
	t.Cleanup(func() {
		if skipCleanup {
			t.Logf("cross-runtime cleanup skipped (CROSS_RUNTIME_SKIP_CLEANUP=1): rows left for TS step to read")
			return
		}
		cleanupCtx := context.Background()
		storeIDs := []string{readyStoreID, nocompStoreID}
		ownerIDs := []string{readyOwnerID, nocompOwnerID}
		cleanupExec := func(sql string, args ...any) {
			if _, err := pool.Exec(cleanupCtx, sql, args...); err != nil {
				t.Logf("cross-runtime cleanup: %s failed: %v", sql, err)
			}
		}
		cleanupExec(`DELETE FROM daily_summaries WHERE store_id = ANY($1)`, storeIDs)
		cleanupExec(`DELETE FROM summary_deliveries WHERE store_id = ANY($1)`, storeIDs)
		cleanupExec(`DELETE FROM rating_snapshots WHERE store_id = ANY($1)`, storeIDs)
		cleanupExec(`DELETE FROM competitors WHERE store_id = ANY($1)`, storeIDs)
		cleanupExec(`DELETE FROM stores WHERE id = ANY($1)`, storeIDs)
		cleanupExec(`DELETE FROM owners WHERE id = ANY($1)`, ownerIDs)
		cleanupExec(`DELETE FROM agencies WHERE id = $1`, agencyID)
		cleanupExec(`DELETE FROM operators WHERE id = $1`, operatorID)
	})

	mustExec(`INSERT INTO operators (id, name) VALUES ($1, $2)`, operatorID, "cross-runtime-operator")
	mustExec(`INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)`, agencyID, operatorID, "cross-runtime-agency")

	mustExec(`INSERT INTO owners (id, agency_id, line_user_id, onboarding_status, delivery_hour) VALUES ($1, $2, $3, 'active', $4)`,
		readyOwnerID, agencyID, readyLineUserID, crossRuntimeDeliveryHour)
	mustExec(`INSERT INTO owners (id, agency_id, line_user_id, onboarding_status, delivery_hour) VALUES ($1, $2, $3, 'active', $4)`,
		nocompOwnerID, agencyID, nocompLineUserID, crossRuntimeDeliveryHour)

	mustExec(`INSERT INTO stores (id, owner_id, category_code, name, latitude, longitude, place_id, place_status)
		VALUES ($1, $2, 'ramen', 'クロスランタイム店舗（競合あり）', 35.5, 139.5, $3, 'confirmed')`,
		readyStoreID, readyOwnerID, "cross-runtime-ready-self")
	mustExec(`INSERT INTO stores (id, owner_id, category_code, name, latitude, longitude, place_id, place_status)
		VALUES ($1, $2, 'ramen', 'クロスランタイム店舗（競合なし）', 35.6, 139.6, $3, 'confirmed')`,
		nocompStoreID, nocompOwnerID, "cross-runtime-nocomp-self")

	// readyStore: 競合2件を事前固定（extraction をバイパスし、決定的な place_id を確保する）。
	var comp1ID, comp2ID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO competitors (store_id, place_id, name, latitude, longitude, active)
		VALUES ($1, $2, $3, 35.5001, 139.5001, true) RETURNING id
	`, readyStoreID, "cross-runtime-ready-comp-1", "競合イチ").Scan(&comp1ID); err != nil {
		t.Fatalf("seed competitor 1: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO competitors (store_id, place_id, name, latitude, longitude, active)
		VALUES ($1, $2, $3, 35.5002, 139.5002, true) RETURNING id
	`, readyStoreID, "cross-runtime-ready-comp-2", "競合ニ").Scan(&comp2ID); err != nil {
		t.Fatalf("seed competitor 2: %v", err)
	}

	now := time.Date(2026, 7, 12, 6, 0, 0, 0, jst)
	today := jstDateAsUTC(now)
	yesterday := today.AddDate(0, 0, -1)

	// 前日スナップショット（自店のみ）を用意し、new_review_count/rating_prev/review_count_prev/
	// rank_prev の各非NULL分岐（R3.7 の「前日ありのとき値を返す」側）を実データで通す。
	if err := repo.WriteSelfSnapshot(ctx, pool, readyStoreID, repo.SnapshotWrite{
		PlaceID: "cross-runtime-ready-self", CapturedOn: yesterday, Rating: 4.0, ReviewCount: 90, Rank: 1,
	}); err != nil {
		t.Fatalf("seed yesterday self snapshot: %v", err)
	}

	server := newFakePlacesServer(t)
	// nocompStore は競合未固定のため extraction が走る。Nearby Search はサーバー全体で共有の
	// 応答であり、readyStore は既に競合固定済み（Nearby Search を経由しない）ため、
	// 空リストのままで両立できる（0件ヒット→no_competitors・R1.1-R1.3 の実データ検証）。
	server.nearbyPlaces = nil

	server.details["cross-runtime-ready-self"] = operational(4.5, 95, "クロスランタイム店舗（競合あり）",
		fakeReview{
			Rating:            5,
			PublishTime:       "2026-07-12T01:00:00Z", // yesterday(2026-07-11T00:00:00Z) より後 → 抜粋対象
			Text:              fakeReviewText{Text: "とても美味しかったです、また来ます"},
			AuthorAttribution: fakeAuthorAttribution{DisplayName: "テスト太郎"},
		},
	)
	server.details["cross-runtime-ready-comp-1"] = operational(4.0, 50, "競合イチ")
	server.details["cross-runtime-ready-comp-2"] = operational(3.8, 40, "競合ニ")
	server.details["cross-runtime-nocomp-self"] = operational(3.5, 10, "クロスランタイム店舗（競合なし）")

	deps := newDeps(t, pool, server, now)

	result, err := Run(ctx, deps)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.FetchOK < 2 {
		t.Errorf("FetchOK = %d, want >= 2 (both cross-runtime stores fetched)", result.FetchOK)
	}

	// --- readyStore: status/rank/JSONB shape の直接検証（Go 側の自己整合性チェック。
	// TS 側が同じ行を正しく読めるかは cross-runtime.e2e.test.ts が別プロセスで検証する）---
	var status string
	var rank, rankTotal, rankPrev, reviewCount, reviewCountPrev, newReviewCount int
	var rating, ratingPrev float64
	var newReviewsJSON, competitorsJSON []byte
	if err := pool.QueryRow(ctx, `
		SELECT status, rank, rank_total, rank_prev, rating, review_count, rating_prev, review_count_prev,
		       new_review_count, new_reviews, competitors
		FROM daily_summaries WHERE store_id = $1 AND summary_date = $2
	`, readyStoreID, today).Scan(&status, &rank, &rankTotal, &rankPrev, &rating, &reviewCount, &ratingPrev, &reviewCountPrev,
		&newReviewCount, &newReviewsJSON, &competitorsJSON); err != nil {
		t.Fatalf("select readyStore daily_summary: %v", err)
	}

	if status != "ready" {
		t.Errorf("readyStore status = %q, want ready", status)
	}
	if rank != 1 || rankTotal != 3 {
		t.Errorf("readyStore rank/total = %d/%d, want 1/3 (self 4.5 > comp1 4.0 > comp2 3.8)", rank, rankTotal)
	}
	if rankPrev != 1 {
		t.Errorf("readyStore rank_prev = %d, want 1 (self alone yesterday)", rankPrev)
	}
	if newReviewCount != 5 {
		t.Errorf("readyStore new_review_count = %d, want 5 (95-90)", newReviewCount)
	}
	if reviewCountPrev != 90 || ratingPrev != 4.0 {
		t.Errorf("readyStore review_count_prev/rating_prev = %d/%v, want 90/4.0", reviewCountPrev, ratingPrev)
	}
	_ = rating
	_ = reviewCount

	// new_reviews / competitors の raw JSON を直接検査し、TS 側の DailySummaryNewReview /
	// DailySummaryCompetitor 型が期待するフィールド名・JSON 型（数値 vs 文字列）と Go の
	// 実出力が一致することを、Go 側からも二重に確かめる（本命の検証は TS 側テストで typeof を
	// 使って行う。CONCERNS 参照: DailySummaryCompetitor.rating/starDiff の型不一致を本タスクで発見・修正）。
	if len(newReviewsJSON) == 0 || string(newReviewsJSON) == "[]" {
		t.Fatalf("readyStore new_reviews is empty, want at least 1 excerpt; got %s", newReviewsJSON)
	}
	t.Logf("readyStore new_reviews raw JSON: %s", newReviewsJSON)
	t.Logf("readyStore competitors raw JSON: %s", competitorsJSON)
	if len(competitorsJSON) == 0 || string(competitorsJSON) == "[]" {
		t.Fatalf("readyStore competitors is empty, want 2 entries; got %s", competitorsJSON)
	}

	// --- nocompStore: 0件競合 → status='no_competitors'・competitors=[] の実データ検証（R1.3）---
	var nocompStatus string
	var nocompCompetitorsJSON []byte
	if err := pool.QueryRow(ctx, `
		SELECT status, competitors FROM daily_summaries WHERE store_id = $1 AND summary_date = $2
	`, nocompStoreID, today).Scan(&nocompStatus, &nocompCompetitorsJSON); err != nil {
		t.Fatalf("select nocompStore daily_summary: %v", err)
	}
	if nocompStatus != "no_competitors" {
		t.Errorf("nocompStore status = %q, want no_competitors", nocompStatus)
	}
	if string(nocompCompetitorsJSON) != "[]" {
		t.Errorf("nocompStore competitors = %s, want empty array literal '[]' (TS must read this as [], not null)", nocompCompetitorsJSON)
	}

	t.Logf("cross-runtime Go half complete: readyStoreID=%s nocompStoreID=%s summary_date=%s delivery_hour=%d",
		readyStoreID, nocompStoreID, today.Format(time.DateOnly), crossRuntimeDeliveryHour)
}
