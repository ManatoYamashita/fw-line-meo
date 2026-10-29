package batch

import (
	"context"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/ManatoYamashita/fw-line-meo/go/internal/repo"
	"github.com/ManatoYamashita/fw-line-meo/go/internal/testdb"
	"github.com/jackc/pgx/v5"
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
//     status='no_competitors' and an EMPTY `competitors` array — the R1.3 branch that the TS side
//     must read as [] (not null) and treat as "not comparable" rather than crashing on an
//     unexpected shape.
//   - unratedStoreID（line-on-demand-report tasks 4.5）: 競合はいるが 1 店も評価を持たない。
//     rank_total は自店だけの 1 になり、競合は rating・starDiff とも null で書かれる。TS の配信は
//     この行を「比較可能でない」と読み、新着があっても通知を出さずに理由つきで記録する。
//   - suspendedStoreID（store-suspension tasks 7.1・Requirements 3.1, 3.3, 3.4, 4.3, 4.5）: 確定済みだが
//     停止中の店舗。競合の固定・前日の自店スナップショット・Places の応答をすべて揃え、停止の述語が
//     無ければ当日の集計が作られる状態にしたうえで、Run の後に当日のスナップショットも集計も無く、
//     対象店舗数に数えられないことを確かめる。TS の配信の段は、同じ店舗に通知記録（送信も見送りも）が
//     無いことを確かめる。取得と配信が同じ `stores.suspended_at` を参照していることを 2 言語で固定する。
//   - unlinkedStoreID（owner-line-unlink tasks 9.1・Requirements 5.1, 5.2, 5.3）: LINE の紐づけを解除した
//     オーナー（line_user_id が NULL・line_unlinked_at あり）の、確定済みで停止中でない店舗。日次取得は
//     オーナーの連携状態を見ないので、この店舗も通常どおり取得し、比較可能で新着のある当日の集計を作る
//     ことをここで確かめる。TS の配信の段は、同じ店舗へ送らず、通知記録（送信・失敗・見送り）を 1 行も
//     残さないことを確かめる。集計が「送れば通知が出る」形なので、配信の述語が解除を見ていなければ赤になる。
//
// line-on-demand-report（tasks 2.5）で、line-webhook のレポート用の読み出し
// （ts/apps/line-webhook/test/cross-runtime.e2e.test.ts）が読む 2 つの形を足した。
//   - 口コミの帰属 3 項目（Req 8.2・8.6・8.7）: readyStore の新着口コミを 2 件にし、1 件目は 3 つの URL を
//     持ち、2 件目は持たない（3 項目を足す前に書かれた行の要素と同じ形）。書かれた生の jsonb の形を
//     ここでも確かめる
//   - 30 日の窓（Req 6.7）: readyStore に、基準日の 29 日前（30 日目）と 30 日前（31 日目）の行を Run の
//     前に書いておく。Run の削除（repo.PurgeOlderThan）が 30 日目を残して 31 日目を消したことをここで
//     確かめ、TS の段は残った 30 日目の行を同じ基準日の窓の中で読む。30 という値は Go と TS の二重定義
//     で、Go が 30 日目の行まで消す食い違いはこの段で、TS の範囲の読み出しの窓が Go より狭くなる食い違いは
//     TS の段で赤になる（TS の窓の境界そのものは ts/packages/db/test/report-reads.db.test.ts が固定する）
func TestCrossRuntimeContract_GoWritesReadableSummaries(t *testing.T) {
	ctx := context.Background()
	// **ここだけは共有 DB（DATABASE_URL）である。** 直後に TS の配信ジョブが別プロセスとして
	// 同じデータベースからこの行を読む契約なので、隔離してはならない（Issue #163）。
	pool := testdb.Shared(t)

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

		// 競合はいるが 1 店も評価を持たない店舗（line-on-demand-report tasks 4.5）。TS の配信は
		// 「評価を持つ競合なし」を比較不能として扱い、通知を出さずに理由つきで記録する。
		unratedOwnerID = "c7000000-0000-0000-0000-000000000013"
		unratedStoreID = "c7100000-0000-0000-0000-000000000003"

		// 停止中の店舗（store-suspension tasks 7.1）。delivery-job の cross-runtime.e2e.test.ts が
		// 同じ識別子で通知記録の不在を確かめるので、変更する場合は両ファイルを揃える。
		suspendedOwnerID = "c7000000-0000-0000-0000-000000000014"
		suspendedStoreID = "c7100000-0000-0000-0000-000000000004"

		// LINE の紐づけを解除したオーナーの店舗（owner-line-unlink tasks 9.1）。delivery-job の
		// cross-runtime.e2e.test.ts が同じ識別子で通知記録の不在を確かめるので、変更する場合は両ファイルを揃える。
		unlinkedOwnerID = "c7000000-0000-0000-0000-000000000015"
		unlinkedStoreID = "c7100000-0000-0000-0000-000000000005"

		readyLineUserID     = "U-cross-runtime-ready"
		nocompLineUserID    = "U-cross-runtime-nocomp"
		unratedLineUserID   = "U-cross-runtime-unrated"
		suspendedLineUserID = "U-cross-runtime-suspended"
		// 解除済みオーナーの元の LINE ユーザー ID。line_user_id には無く、メニュー未解除の印
		// （menu_pending_line_user_id）にだけ残る。TS の段は、この ID へも送らないことを確かめる。
		unlinkedOriginalLineUserID = "U-cross-runtime-unlinked"

		// クロスランタイム契約テスト専用の配信時刻。task 4.4 の index.e2e.test.ts が hour=14 を、
		// targets.db.test.ts が hour=9/10 を使うため、本テストは衝突しない hour=17 を使う
		// （同一 postgres インスタンスを共有する ts-test-db 実行内でも targetsTotal 等の厳密件数
		// 比較を汚染しないための既存の流儀を踏襲）。TS 側（cross-runtime.e2e.test.ts）と一致させる。
		crossRuntimeDeliveryHour = 17

		// 新着口コミの帰属 3 項目の値（line-on-demand-report）。line-webhook の cross-runtime.e2e.test.ts が
		// 同じ値をそのまま読むことを確かめるので、変更する場合は両ファイルを揃える。
		crossRuntimeAuthorURI      = "https://www.google.com/maps/contrib/cross-runtime-author/reviews"
		crossRuntimeAuthorPhotoURI = "https://lh3.googleusercontent.com/a/cross-runtime-photo"
		crossRuntimeReviewMapsURI  = "https://www.google.com/maps/reviews/data=cross-runtime-review"

		// 店舗の口コミ一覧を Google Maps で開く URL（Issue #303）。TS 側が同じ値を読むので、
		// 変更する場合は両ファイルを揃える。
		crossRuntimeStoreReviewsURI = "https://www.google.com/maps/place//data=cross-runtime-reviews"
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
		storeIDs := []string{readyStoreID, nocompStoreID, unratedStoreID, suspendedStoreID, unlinkedStoreID}
		ownerIDs := []string{readyOwnerID, nocompOwnerID, unratedOwnerID, suspendedOwnerID, unlinkedOwnerID}
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
	mustExec(`INSERT INTO owners (id, agency_id, line_user_id, onboarding_status, delivery_hour) VALUES ($1, $2, $3, 'active', $4)`,
		unratedOwnerID, agencyID, unratedLineUserID, crossRuntimeDeliveryHour)
	// 停止中の店舗のオーナーも同じ配信時刻にする。TS の段で、停止の述語が無ければ見送りの記録
	// （skipped_no_summary）が残る状態にするためである。
	mustExec(`INSERT INTO owners (id, agency_id, line_user_id, onboarding_status, delivery_hour) VALUES ($1, $2, $3, 'active', $4)`,
		suspendedOwnerID, agencyID, suspendedLineUserID, crossRuntimeDeliveryHour)
	// 解除済みのオーナーも同じ配信時刻にする。TS の段で、解除の述語が無ければ通知が出る状態にするためである。
	// 解除の操作は dashboard-api の責務なので、ここでは解除後の行の形（line_user_id は NULL・解除時刻は
	// 固定日の前日・元の ID はメニュー未解除の印にだけ残る）を直接書く（ck_owner_line_link を満たす）。
	mustExec(`INSERT INTO owners (id, agency_id, line_user_id, onboarding_status, delivery_hour, line_unlinked_at, menu_pending_line_user_id)
		VALUES ($1, $2, NULL, 'active', $3, '2026-07-11T12:00:00+09:00', $4)`,
		unlinkedOwnerID, agencyID, crossRuntimeDeliveryHour, unlinkedOriginalLineUserID)

	mustExec(`INSERT INTO stores (id, owner_id, category_code, name, latitude, longitude, place_id, place_status)
		VALUES ($1, $2, 'ramen', 'クロスランタイム店舗（競合あり）', 35.5, 139.5, $3, 'confirmed')`,
		readyStoreID, readyOwnerID, "cross-runtime-ready-self")
	mustExec(`INSERT INTO stores (id, owner_id, category_code, name, latitude, longitude, place_id, place_status)
		VALUES ($1, $2, 'ramen', 'クロスランタイム店舗（競合なし）', 35.6, 139.6, $3, 'confirmed')`,
		nocompStoreID, nocompOwnerID, "cross-runtime-nocomp-self")
	mustExec(`INSERT INTO stores (id, owner_id, category_code, name, latitude, longitude, place_id, place_status)
		VALUES ($1, $2, 'ramen', 'クロスランタイム店舗（評価を持つ競合なし）', 35.7, 139.7, $3, 'confirmed')`,
		unratedStoreID, unratedOwnerID, "cross-runtime-unrated-self")
	// 停止中の店舗（store-suspension tasks 7.1）。停止時刻は固定日の前日にする（停止の操作は
	// dashboard-api の責務なので、ここでは列を直接立てる）。
	mustExec(`INSERT INTO stores (id, owner_id, category_code, name, latitude, longitude, place_id, place_status, suspended_at)
		VALUES ($1, $2, 'ramen', 'クロスランタイム店舗（停止中）', 35.8, 139.8, $3, 'confirmed', '2026-07-11T12:00:00+09:00')`,
		suspendedStoreID, suspendedOwnerID, "cross-runtime-suspended-self")
	mustExec(`INSERT INTO stores (id, owner_id, category_code, name, latitude, longitude, place_id, place_status)
		VALUES ($1, $2, 'ramen', 'クロスランタイム店舗（解除済みオーナー）', 35.9, 139.9, $3, 'confirmed')`,
		unlinkedStoreID, unlinkedOwnerID, "cross-runtime-unlinked-self")

	// readyStore: 競合3件を事前固定（extraction をバイパスし、決定的な place_id を確保する）。
	// 3件目は Google の評価が無い店（クチコミ 0 件・Issue #255）で、比較集合に入らず jsonb に null で
	// 書かれることを、TS の配信（Flex）と詳細画面の読込が「評価なし」として扱う契約を検証する。
	var comp1ID, comp2ID, comp3ID string
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
	if err := pool.QueryRow(ctx, `
		INSERT INTO competitors (store_id, place_id, name, latitude, longitude, active)
		VALUES ($1, $2, $3, 35.5003, 139.5003, true) RETURNING id
	`, readyStoreID, "cross-runtime-ready-comp-3", "競合サン").Scan(&comp3ID); err != nil {
		t.Fatalf("seed competitor 3: %v", err)
	}

	// unratedStore: 競合 1 件を事前固定する。この競合は Google の評価を持たないので、比較集合は
	// 自店だけ（rank_total = 1）になる。TS の配信はこの行を「比較可能でない」と読む。
	if _, err := pool.Exec(ctx, `
		INSERT INTO competitors (store_id, place_id, name, latitude, longitude, active)
		VALUES ($1, $2, $3, 35.7001, 139.7001, true)
	`, unratedStoreID, "cross-runtime-unrated-comp-1", "評価なし競合"); err != nil {
		t.Fatalf("seed unrated competitor: %v", err)
	}

	// suspendedStore: 競合 1 件を事前固定する。停止の述語が無ければ、この競合と自店を取得して当日の
	// 集計が作られる（比較可能な行になる）。述語があれば取得も集計も行わない。
	if _, err := pool.Exec(ctx, `
		INSERT INTO competitors (store_id, place_id, name, latitude, longitude, active)
		VALUES ($1, $2, $3, 35.8001, 139.8001, true)
	`, suspendedStoreID, "cross-runtime-suspended-comp-1", "停止店の競合"); err != nil {
		t.Fatalf("seed suspended competitor: %v", err)
	}

	// unlinkedStore: 評価を持つ競合 1 件を事前固定する。当日の集計は比較可能（rank_total = 2）になる。
	if _, err := pool.Exec(ctx, `
		INSERT INTO competitors (store_id, place_id, name, latitude, longitude, active)
		VALUES ($1, $2, $3, 35.9001, 139.9001, true)
	`, unlinkedStoreID, "cross-runtime-unlinked-comp-1", "解除店の競合"); err != nil {
		t.Fatalf("seed unlinked competitor: %v", err)
	}

	now := time.Date(2026, 7, 12, 6, 0, 0, 0, jst)
	today := jstDateAsUTC(now)
	yesterday := today.AddDate(0, 0, -1)

	// 前日スナップショット（自店のみ）を用意し、new_review_count/rating_prev/review_count_prev/
	// rank_prev の各非NULL分岐（R3.7 の「前日ありのとき値を返す」側）を実データで通す。
	if err := repo.WriteSelfSnapshot(ctx, pool, readyStoreID, repo.SnapshotWrite{
		PlaceID: "cross-runtime-ready-self", CapturedOn: yesterday, Rating: f64(4.0), ReviewCount: 90, Rank: intPtr(1),
	}); err != nil {
		t.Fatalf("seed yesterday self snapshot: %v", err)
	}

	// unratedStore にも前日の自店スナップショットを置く。これで当日の新着件数が 2 件になり、
	// TS の配信が「変化が無いから送らない」ではなく「比較可能でないから送らない」を選んだことを、
	// 記録された理由で見分けられる。
	if err := repo.WriteSelfSnapshot(ctx, pool, unratedStoreID, repo.SnapshotWrite{
		PlaceID: "cross-runtime-unrated-self", CapturedOn: yesterday, Rating: f64(4.2), ReviewCount: 18, Rank: intPtr(1),
	}); err != nil {
		t.Fatalf("seed unratedStore yesterday self snapshot: %v", err)
	}

	// suspendedStore にも前日の自店スナップショットを置く（停止前に取得していた店舗の形）。停止の述語が
	// 無ければ当日の集計は前日比と新着を持ち、TS の段で変化の通知まで出る状態になる。
	if err := repo.WriteSelfSnapshot(ctx, pool, suspendedStoreID, repo.SnapshotWrite{
		PlaceID: "cross-runtime-suspended-self", CapturedOn: yesterday, Rating: f64(4.1), ReviewCount: 40, Rank: intPtr(1),
	}); err != nil {
		t.Fatalf("seed suspendedStore yesterday self snapshot: %v", err)
	}

	// unlinkedStore にも前日の自店スナップショットを置く。当日の集計は新着 3 件を持ち、配信の述語が解除を
	// 見ていなければ変化の通知が出る形になる（TS の段の不在の表明が空振りしないようにする）。
	if err := repo.WriteSelfSnapshot(ctx, pool, unlinkedStoreID, repo.SnapshotWrite{
		PlaceID: "cross-runtime-unlinked-self", CapturedOn: yesterday, Rating: f64(4.0), ReviewCount: 60, Rank: intPtr(1),
	}); err != nil {
		t.Fatalf("seed unlinkedStore yesterday self snapshot: %v", err)
	}

	// 30 日の窓（line-on-demand-report・Req 6.7）: 基準日の 29 日前（30 日目）と 30 日前（31 日目）の行を、
	// Run の前に Go の書込（repo.WriteDailySummary）で書いておく。Run の削除は 30 日目を残し、31 日目を消す。
	// 口コミ総数は、TS の段が行の取り違えを見分けるための値である（TS 側の DAY_30_REVIEW_COUNT と揃える）。
	day30 := today.AddDate(0, 0, -29) // 2026-06-13
	day31 := today.AddDate(0, 0, -30) // 2026-06-12
	for _, seed := range []struct {
		date        time.Time
		reviewCount int
	}{{day30, 80}, {day31, 79}} {
		if err := repo.WriteDailySummary(ctx, pool, repo.DailySummaryInput{
			StoreID:     readyStoreID,
			SummaryDate: seed.date,
			Status:      "ready",
			Rank:        intPtr(1),
			RankTotal:   intPtr(2),
			Rating:      f64(4.3),
			ReviewCount: intPtr(seed.reviewCount),
			Competitors: []repo.SummaryCompetitor{
				{Name: "競合イチ", Rating: f64(4.0), ReviewCount: 45, StarDiff: f64(0.3)},
			},
		}); err != nil {
			t.Fatalf("seed daily summary on %s: %v", seed.date.Format(time.DateOnly), err)
		}
	}

	server := newFakePlacesServer(t)
	// nocompStore は競合未固定のため extraction が走る。Nearby Search はサーバー全体で共有の
	// 応答であり、readyStore は既に競合固定済み（Nearby Search を経由しない）ため、
	// 空リストのままで両立できる（0件ヒット→no_competitors・R1.1-R1.3 の実データ検証）。
	server.nearbyPlaces = nil

	// 新着口コミは 2 件。1 件目は帰属の URL を 3 つとも持ち、2 件目は持たない（応答にキーそのものが無い）。
	// 1 件目の 4 項目は既存の TS の段（delivery-job）が new_reviews[0] として読むので変えない。
	server.details["cross-runtime-ready-self"] = withReviewsURI(operational(4.5, 95, "クロスランタイム店舗（競合あり）",
		fakeReview{
			Rating:      5,
			PublishTime: "2026-07-12T01:00:00Z", // yesterday(2026-07-11T00:00:00Z) より後 → 抜粋対象
			Text:        fakeReviewText{Text: "とても美味しかったです、また来ます"},
			AuthorAttribution: fakeAuthorAttribution{
				DisplayName: "テスト太郎",
				URI:         crossRuntimeAuthorURI,
				PhotoURI:    crossRuntimeAuthorPhotoURI,
			},
			GoogleMapsURI: crossRuntimeReviewMapsURI,
		},
		fakeReview{
			Rating:            4,
			PublishTime:       "2026-07-12T02:00:00Z",
			Text:              fakeReviewText{Text: "落ち着いて食事ができました"},
			AuthorAttribution: fakeAuthorAttribution{DisplayName: "テスト花子"},
		},
	), crossRuntimeStoreReviewsURI)
	server.details["cross-runtime-ready-comp-1"] = operational(4.0, 50, "競合イチ")
	server.details["cross-runtime-ready-comp-2"] = operational(3.8, 40, "競合ニ")
	server.details["cross-runtime-ready-comp-3"] = unrated("競合サン")
	// 口コミ一覧の URL を持たない店。TS 側は導線ごと置かない（Issue #303）。
	server.details["cross-runtime-nocomp-self"] = operational(3.5, 10, "クロスランタイム店舗（競合なし）")
	server.details["cross-runtime-unrated-self"] = operational(4.2, 20, "クロスランタイム店舗（評価を持つ競合なし）")
	server.details["cross-runtime-unrated-comp-1"] = unrated("評価なし競合")
	// 停止中の店舗にも正常な応答を用意する。応答が無いことで取得が失敗して集計が作られない、という
	// 別の理由で緑にならないようにするためである。
	server.details["cross-runtime-suspended-self"] = operational(4.3, 44, "クロスランタイム店舗（停止中）")
	server.details["cross-runtime-suspended-comp-1"] = operational(3.9, 30, "停止店の競合")
	server.details["cross-runtime-unlinked-self"] = operational(4.2, 63, "クロスランタイム店舗（解除済みオーナー）")
	server.details["cross-runtime-unlinked-comp-1"] = operational(3.7, 25, "解除店の競合")

	deps := newDeps(t, pool, server, now)

	result, err := Run(ctx, deps)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.FetchOK < 4 {
		t.Errorf("FetchOK = %d, want >= 4 (the four unsuspended cross-runtime stores fetched, including the unlinked owner's store)", result.FetchOK)
	}

	// --- readyStore: status/rank/JSONB shape の直接検証（Go 側の自己整合性チェック。
	// TS 側が同じ行を正しく読めるかは cross-runtime.e2e.test.ts が別プロセスで検証する）---
	var status string
	var rank, rankTotal, rankPrev, reviewCount, reviewCountPrev, newReviewCount int
	var rating, ratingPrev float64
	var newReviewsJSON, competitorsJSON []byte
	var storeReviewsURI *string
	if err := pool.QueryRow(ctx, `
		SELECT status, rank, rank_total, rank_prev, rating, review_count, rating_prev, review_count_prev,
		       new_review_count, new_reviews, competitors, google_maps_reviews_uri
		FROM daily_summaries WHERE store_id = $1 AND summary_date = $2
	`, readyStoreID, today).Scan(&status, &rank, &rankTotal, &rankPrev, &rating, &reviewCount, &ratingPrev, &reviewCountPrev,
		&newReviewCount, &newReviewsJSON, &competitorsJSON, &storeReviewsURI); err != nil {
		t.Fatalf("select readyStore daily_summary: %v", err)
	}

	// 店舗の口コミ一覧の URL（Issue #303）。TS 側（line-webhook の cross-runtime.e2e.test.ts）が
	// 同じ値を読み、内容を出せないときの導線に使う。
	if storeReviewsURI == nil || *storeReviewsURI != crossRuntimeStoreReviewsURI {
		t.Errorf("google_maps_reviews_uri = %v, want %q", storeReviewsURI, crossRuntimeStoreReviewsURI)
	}

	if status != "ready" {
		t.Errorf("readyStore status = %q, want ready", status)
	}
	if rank != 1 || rankTotal != 3 {
		t.Errorf("readyStore rank/total = %d/%d, want 1/3 (self 4.5 > comp1 4.0 > comp2 3.8; the unrated comp3 is not counted)", rank, rankTotal)
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
		t.Fatalf("readyStore competitors is empty, want 3 entries; got %s", competitorsJSON)
	}

	// 評価の無い競合（Issue #255）: 評価のある競合の後ろに並び、rating・starDiff は JSON の null
	// （キーは省かない）。スナップショットも rating・rank とも NULL。TS 側がこの行を「評価なし」と描く。
	var nComp int
	var comp3Name, comp3RatingType, comp3StarDiffType string
	if err := pool.QueryRow(ctx, `
		SELECT jsonb_array_length(competitors), competitors->2->>'name',
		       jsonb_typeof(competitors->2->'rating'), jsonb_typeof(competitors->2->'starDiff')
		FROM daily_summaries WHERE store_id = $1 AND summary_date = $2
	`, readyStoreID, today).Scan(&nComp, &comp3Name, &comp3RatingType, &comp3StarDiffType); err != nil {
		t.Fatalf("select readyStore unrated competitor: %v", err)
	}
	if nComp != 3 || comp3Name != "競合サン" || comp3RatingType != "null" || comp3StarDiffType != "null" {
		t.Errorf("readyStore competitors[2] = {len=%d name=%s rating=%s starDiff=%s}, want {3 競合サン null null}",
			nComp, comp3Name, comp3RatingType, comp3StarDiffType)
	}
	var comp3RatingNull, comp3RankNull bool
	if err := pool.QueryRow(ctx, `
		SELECT rating IS NULL, rank IS NULL FROM rating_snapshots
		WHERE store_id = $1 AND competitor_id = $2 AND captured_on = $3
	`, readyStoreID, comp3ID, today).Scan(&comp3RatingNull, &comp3RankNull); err != nil {
		t.Fatalf("select unrated competitor snapshot: %v", err)
	}
	if !comp3RatingNull || !comp3RankNull {
		t.Errorf("unrated competitor snapshot rating IS NULL=%v rank IS NULL=%v, want true/true", comp3RatingNull, comp3RankNull)
	}

	// 口コミの帰属 3 項目（line-on-demand-report）: 書かれた生の jsonb を、キーの集合と値で確かめる。
	// TS の読込は 3 項目を任意項目として寛容に読むので、書込の回帰は TS の段だけでは見逃しうる。
	// readNewReviewElements・newReviewElement は review_attribution_test.go のもの。
	gotReviews := readNewReviewElements(t, ctx, pool, readyStoreID, today)
	wantReviews := []newReviewElement{
		{
			authorName:     "テスト太郎",
			keys:           "authorName,authorPhotoUri,authorUri,googleMapsUri,publishTime,rating,textExcerpt",
			authorURI:      crossRuntimeAuthorURI,
			authorPhotoURI: crossRuntimeAuthorPhotoURI,
			googleMapsURI:  crossRuntimeReviewMapsURI,
		},
		{
			authorName: "テスト花子",
			keys:       "authorName,publishTime,rating,textExcerpt",
		},
	}
	if len(gotReviews) != len(wantReviews) {
		t.Fatalf("readyStore new_reviews elements = %d, want %d: %+v", len(gotReviews), len(wantReviews), gotReviews)
	}
	for i := range wantReviews {
		if gotReviews[i] != wantReviews[i] {
			t.Errorf("readyStore new_reviews[%d] = %+v, want %+v", i, gotReviews[i], wantReviews[i])
		}
	}

	// 30 日の窓（line-on-demand-report・Req 6.7）: Run の削除の後に残る readyStore の行は、30 日目と当日だけ。
	// 31 日目の行は消えている。TS の段は、この 30 日目の行を同じ基準日（2026-07-12）の窓の中で読む。
	dateRows, err := pool.Query(ctx, `
		SELECT to_char(summary_date, 'YYYY-MM-DD') FROM daily_summaries
		WHERE store_id = $1 ORDER BY summary_date
	`, readyStoreID)
	if err != nil {
		t.Fatalf("select readyStore summary dates: %v", err)
	}
	keptDates, err := pgx.CollectRows(dateRows, pgx.RowTo[string])
	if err != nil {
		t.Fatalf("collect readyStore summary dates: %v", err)
	}
	wantDates := []string{day30.Format(time.DateOnly), today.Format(time.DateOnly)}
	if !slices.Equal(keptDates, wantDates) {
		t.Errorf("readyStore summary dates after purge = %v, want %v (the 30th day is kept and the 31st day %s is purged)",
			keptDates, wantDates, day31.Format(time.DateOnly))
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

	// --- unratedStore: 競合はいるが 1 店も評価を持たない（line-on-demand-report tasks 4.5）---
	// 比較集合は自店だけなので rank_total = 1 になり、競合は rating・starDiff とも null で書かれる。
	// TS の配信はこの行を「比較可能でない」と読み、通知を出さずに理由つきで記録する。
	var unratedStatus string
	var unratedRank, unratedRankTotal, unratedNewReviewCount, unratedReviewCountPrev int
	var unratedCompRatingType string
	if err := pool.QueryRow(ctx, `
		SELECT status, rank, rank_total, new_review_count, review_count_prev,
		       jsonb_typeof(competitors->0->'rating')
		FROM daily_summaries WHERE store_id = $1 AND summary_date = $2
	`, unratedStoreID, today).Scan(&unratedStatus, &unratedRank, &unratedRankTotal, &unratedNewReviewCount,
		&unratedReviewCountPrev, &unratedCompRatingType); err != nil {
		t.Fatalf("select unratedStore daily_summary: %v", err)
	}
	if unratedStatus != "ready" || unratedRank != 1 || unratedRankTotal != 1 {
		t.Errorf("unratedStore status/rank/total = %s/%d/%d, want ready/1/1 (the unrated competitor is not counted)",
			unratedStatus, unratedRank, unratedRankTotal)
	}
	if unratedCompRatingType != "null" {
		t.Errorf("unratedStore competitors[0].rating jsonb type = %s, want null", unratedCompRatingType)
	}
	// 新着があることまで固定する。TS の段が「変化が無いから送らない」と取り違えていないことを、
	// 記録された理由（skipped_not_comparable）で見分けられるようにするためである。
	if unratedNewReviewCount != 2 || unratedReviewCountPrev != 18 {
		t.Errorf("unratedStore new_review_count/review_count_prev = %d/%d, want 2/18",
			unratedNewReviewCount, unratedReviewCountPrev)
	}

	// --- suspendedStore: 停止中の店舗は取得も集計も行わず、対象店舗数に数えない（store-suspension 3.1, 3.3, 3.4）---
	// 前提の確認: 確定済みかつ停止中として残っていること（ここが崩れると以下の不在の表明が空振りする）。
	if n := countRows(t, ctx, pool, `SELECT count(*) FROM stores WHERE id = $1 AND place_status = 'confirmed' AND suspended_at IS NOT NULL`,
		suspendedStoreID); n != 1 {
		t.Fatalf("suspendedStore confirmed & suspended rows = %d, want 1", n)
	}
	if n := countRows(t, ctx, pool, `SELECT count(*) FROM rating_snapshots WHERE store_id = $1 AND captured_on = $2`,
		suspendedStoreID, today); n != 0 {
		t.Errorf("suspendedStore rating_snapshots on %s = %d, want 0 (a suspended store must not be fetched)", today.Format(time.DateOnly), n)
	}
	if n := countRows(t, ctx, pool, `SELECT count(*) FROM daily_summaries WHERE store_id = $1`, suspendedStoreID); n != 0 {
		t.Errorf("suspendedStore daily_summaries = %d, want 0 (no summary is created while suspended)", n)
	}
	// 対象店舗数は、確定済みで停止中でない店舗の数に等しく、停止中の店舗の分だけ確定済みの店舗の総数より
	// 小さい。共有 DB に他の行があっても成り立つ形で表明する。
	confirmedTotal := countRows(t, ctx, pool, `SELECT count(*) FROM stores WHERE place_status = 'confirmed'`)
	suspendedConfirmed := countRows(t, ctx, pool, `SELECT count(*) FROM stores WHERE place_status = 'confirmed' AND suspended_at IS NOT NULL`)
	if result.StoresTotal != confirmedTotal-suspendedConfirmed {
		t.Errorf("StoresTotal = %d, want %d (confirmed %d - suspended %d; the suspended store must not be counted)",
			result.StoresTotal, confirmedTotal-suspendedConfirmed, confirmedTotal, suspendedConfirmed)
	}

	// --- unlinkedStore: 解除済みオーナーの店舗も取得を続け、当日の集計を作る（owner-line-unlink 5.1）---
	// 前提の確認: オーナーが解除済みのまま（line_user_id は NULL・解除時刻あり）で、店舗は確定済みかつ
	// 停止中でないこと。ここが崩れると、以下の表明は「連携中の店舗を取得した」ことの確認に化ける。
	if n := countRows(t, ctx, pool, `
		SELECT count(*) FROM stores s JOIN owners o ON o.id = s.owner_id
		 WHERE s.id = $1 AND s.place_status = 'confirmed' AND s.suspended_at IS NULL
		   AND o.line_user_id IS NULL AND o.line_unlinked_at IS NOT NULL`, unlinkedStoreID); n != 1 {
		t.Fatalf("unlinkedStore confirmed & unsuspended rows owned by an unlinked owner = %d, want 1", n)
	}
	if n := countRows(t, ctx, pool, `SELECT count(*) FROM rating_snapshots WHERE store_id = $1 AND captured_on = $2`,
		unlinkedStoreID, today); n != 2 {
		t.Errorf("unlinkedStore rating_snapshots on %s = %d, want 2 (self + 1 competitor; the unlinked owner's store keeps being fetched)",
			today.Format(time.DateOnly), n)
	}
	var unlinkedStatus string
	var unlinkedRank, unlinkedRankTotal, unlinkedNewReviewCount int
	if err := pool.QueryRow(ctx, `
		SELECT status, rank, rank_total, new_review_count
		FROM daily_summaries WHERE store_id = $1 AND summary_date = $2
	`, unlinkedStoreID, today).Scan(&unlinkedStatus, &unlinkedRank, &unlinkedRankTotal, &unlinkedNewReviewCount); err != nil {
		t.Fatalf("select unlinkedStore daily_summary (the unlinked owner's store must still get a summary): %v", err)
	}
	// 比較可能（母数 2）で新着 3 件（63 - 60）。配信の段が「比較できない・変化が無い」という別の理由で
	// 送らないのではなく、解除を理由に送らないことを見分けるための形である。
	if unlinkedStatus != "ready" || unlinkedRank != 1 || unlinkedRankTotal != 2 || unlinkedNewReviewCount != 3 {
		t.Errorf("unlinkedStore status/rank/total/new = %s/%d/%d/%d, want ready/1/2/3",
			unlinkedStatus, unlinkedRank, unlinkedRankTotal, unlinkedNewReviewCount)
	}

	t.Logf("cross-runtime Go half complete: readyStoreID=%s nocompStoreID=%s unratedStoreID=%s suspendedStoreID=%s unlinkedStoreID=%s summary_date=%s delivery_hour=%d",
		readyStoreID, nocompStoreID, unratedStoreID, suspendedStoreID, unlinkedStoreID, today.Format(time.DateOnly), crossRuntimeDeliveryHour)
}
