// Package batch は日次バッチのオーケストレーション（design.md「Go / batch/run」契約）を実装する。
// 「確定済み店舗の抽出（競合未固定店舗はまず抽出）→ 店舗単位ワーカープールでの取得・算出・記録
// → 30日超のパージ → 実行サマリーの集計」を統合する。本パッケージ自身は集計値（Summary）を
// 返すのみで、その最終ログ出力は cmd/daily-batch/main.go の責務（design.md File Structure Plan:
// cmd/daily-batch/main.go = 「エントリポイント・DI 配線・実行サマリーの構造化ログ出力」）。
// 店舗単位のエラーはこのパッケージ内でログし、他店舗の処理には波及させない
// （design.md「店舗単位のエラー隔離: 1店舗の失敗は他店舗に波及させない」）。
package batch

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"math/rand"
	"sort"
	"sync"
	"time"

	"github.com/ManatoYamashita/fw-line-meo/go/internal/competitor"
	"github.com/ManatoYamashita/fw-line-meo/go/internal/config"
	"github.com/ManatoYamashita/fw-line-meo/go/internal/places"
	"github.com/ManatoYamashita/fw-line-meo/go/internal/repo"
	"github.com/ManatoYamashita/fw-line-meo/go/internal/summary"
	"github.com/jackc/pgx/v5"
)

// jst は日次バッチの「当日」を判定するための固定オフセット（常に+9:00・DST無し）。
// time.LoadLocation("Asia/Tokyo") はコンテナに tzdata が無いと失敗し得るため、
// 依存を増やさず確実に動く固定オフセットを用いる。
var jst = time.FixedZone("JST", 9*60*60)

// defaultIntraStoreJitterMaxMillis は店舗内の6コール間に挟む「軽ジッター」の既定上限
// （design.md「店舗内の6コールは順次＋軽ジッター」。具体的な上限値は design.md 未規定のため
// 本パッケージ内で妥当な小さい値として定義する）。
const defaultIntraStoreJitterMaxMillis = 300

// Pool は batch パッケージが要求する DB サーフェス。repo.DBTX に加え、店舗単位のトランザクション
// （design.md「Consistency: 店舗単位でトランザクション（snapshots＋summary を同一 Tx で確定）」）
// を張るための Begin を要求する。*pgxpool.Pool がこれを満たす。
type Pool interface {
	repo.DBTX
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Deps は Run の実行に必要な依存一式（DI）。テストではフェイク Places・実 postgres の Pool・
// ジッターを無効化した値を注入する。
type Deps struct {
	Pool   Pool
	Places places.PlacesClient

	// WorkerPoolSize は店舗単位ワーカープールのサイズ（design.md: 既定5・env で調整）。
	// 0以下の場合は config.DefaultWorkerPoolSize を使う。
	WorkerPoolSize int

	// JitterMaxSeconds は起動時ジッターの上限秒数（design.md: 開始時に 0–120 秒のジッター）。
	// テストでは 0 を渡すことで起動ジッターを完全にスキップできる（0 は「実行しない」の意味であり
	// デフォルト値へのフォールバックはしない — テストの実行時間を確実に守るための意図的な設計）。
	JitterMaxSeconds int

	// IntraStoreJitter は店舗内の6コール間に呼ぶ「軽ジッター」の待機時間を返す関数。
	// nil の場合は defaultIntraStoreJitterMaxMillis 以内のランダムな待機を行う。
	// テストでは `func() time.Duration { return 0 }` を渡すことで実待機を完全に排除できる
	// （これが本タスクにおけるジッターのテスト制御可能性の実現方法）。
	IntraStoreJitter func() time.Duration

	// Now は「当日」判定に使う時刻源（既定 time.Now）。テストで固定日時を注入できる。
	Now func() time.Time

	// Logger は構造化ログの出力先（既定 slog.Default()）。
	Logger *slog.Logger
}

// Summary は日次バッチ1回分の実行結果集計（design.md「Output/destination: ...終了時に実行サマリー
// （対象店舗数・抽出実行数・取得成功/失敗数・summary 生成数・パージ行数）を構造化ログで1行出力」）。
// ログ出力そのものは cmd/daily-batch/main.go が行う（本パッケージは値の集計のみを担う）。
type Summary struct {
	// StoresTotal は対象（place_status='confirmed'）の全店舗数。
	StoresTotal int
	// ExtractRan は「競合未固定」のため今回抽出を実行した店舗数（成功・失敗を問わず実行数）。
	ExtractRan int
	// FetchOK は自店 Places 指標の取得に成功した店舗数。
	FetchOK int
	// FetchFailed は自店 Places 指標の取得に失敗した店舗数（daily_summaries.status='failed'）。
	FetchFailed int
	// SummariesWritten は daily_summaries 行を書き込めた店舗数（status を問わない）。
	SummariesWritten int
	// SnapshotsPurged / SummariesPurged は30日超パージで削除された行数。
	SnapshotsPurged int64
	SummariesPurged int64
}

// RowsPurged は snapshots・summaries 双方のパージ行数の合計（design.md の「パージ行数」1項目に対応）。
func (s Summary) RowsPurged() int64 {
	return s.SnapshotsPurged + s.SummariesPurged
}

// Run は日次バッチ本体を実行する。
//
// 手順（design.md「日次バッチ（06:00 JST）」System Flow に対応）:
//  1. 起動ジッター（0–JitterMaxSeconds 秒）
//  2. 確定済み店舗・競合未固定店舗を読取
//  3. 競合未固定店舗をまず抽出・固定（逐次・自己修復型 — research.md Decision）
//  4. 店舗単位ワーカープールで自店＋競合の指標取得・順位算出・記録（店舗単位のエラー隔離）
//  5. 30日超の snapshots/summaries をパージ
//  6. 実行結果を Summary として返す（ログ出力は呼出元 cmd/daily-batch の責務）
//
// 戻り値の error は「バッチ全体が実行不能だった」ことを示す致命的エラーのみを表す
// （例: 対象店舗の読取自体が失敗した）。個々の店舗の失敗は Summary.FetchFailed に
// 反映され、error としては返らない（店舗単位のエラー隔離 — design.md）。
func Run(ctx context.Context, deps Deps) (Summary, error) {
	deps = applyDefaults(deps)

	sleepJitter(ctx, deps)

	confirmedStores, err := repo.ConfirmedStores(ctx, deps.Pool)
	if err != nil {
		return Summary{}, fmt.Errorf("batch: read confirmed stores: %w", err)
	}

	unfixedStores, err := repo.StoresWithoutFixedCompetitors(ctx, deps.Pool)
	if err != nil {
		return Summary{}, fmt.Errorf("batch: read stores without fixed competitors: %w", err)
	}

	result := Summary{StoresTotal: len(confirmedStores)}

	for _, store := range unfixedStores {
		result.ExtractRan++
		if _, err := competitor.ExtractAndFix(ctx, deps.Places, deps.Pool, store); err != nil {
			deps.Logger.Error("batch: competitor extraction failed for store",
				"store_id", store.ID, "error", err.Error())
		}
	}

	today := jstDateAsUTC(deps.Now())
	yesterday := today.AddDate(0, 0, -1)

	storeResults := runWorkerPool(ctx, deps, confirmedStores, today, yesterday)
	for _, r := range storeResults {
		if r.fetchOK {
			result.FetchOK++
		} else {
			result.FetchFailed++
		}
		if r.summaryWritten {
			result.SummariesWritten++
		}
	}

	purge, err := repo.PurgeOlderThan(ctx, deps.Pool, today)
	if err != nil {
		// パージ失敗はバッチ全体の失敗にはしない（当日分のデータ確定は既に完了している）。
		// 運用ログに残し、次回実行時の再パージに委ねる。
		deps.Logger.Error("batch: purge older-than-30-day rows failed", "error", err.Error())
	} else {
		result.SnapshotsPurged = purge.SnapshotsDeleted
		result.SummariesPurged = purge.SummariesDeleted
	}

	return result, nil
}

func applyDefaults(deps Deps) Deps {
	if deps.WorkerPoolSize <= 0 {
		deps.WorkerPoolSize = config.DefaultWorkerPoolSize
	}
	if deps.Now == nil {
		deps.Now = time.Now
	}
	if deps.Logger == nil {
		deps.Logger = slog.Default()
	}
	if deps.IntraStoreJitter == nil {
		deps.IntraStoreJitter = defaultIntraStoreJitter
	}
	return deps
}

func defaultIntraStoreJitter() time.Duration {
	return time.Duration(rand.Intn(defaultIntraStoreJitterMaxMillis+1)) * time.Millisecond
}

// jstDateAsUTC は t を JST（+9:00 固定）の暦日に変換し、その日付を time.UTC の 0時0分として
// 返す（rating_snapshots.captured_on / daily_summaries.summary_date は DATE 型であり、
// 既存コード（repo の各テスト）は time.Parse(time.DateOnly, ...) による UTC 0時表現を一貫して
// 使っているため、その表現に揃える）。
func jstDateAsUTC(t time.Time) time.Time {
	local := t.In(jst)
	return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC)
}

// sleepJitter は起動時ジッター（design.md: 開始時に 0–JitterMaxSeconds 秒）を実行する。
// JitterMaxSeconds<=0 の場合は待機しない（テストでの明示的スキップに使う）。
func sleepJitter(ctx context.Context, deps Deps) {
	if deps.JitterMaxSeconds <= 0 {
		return
	}
	d := time.Duration(rand.Intn(deps.JitterMaxSeconds+1)) * time.Second
	waitContext(ctx, d)
}

// sleepCallJitter は店舗内の6コール間の「軽ジッター」を実行する。
func sleepCallJitter(ctx context.Context, deps Deps) {
	d := deps.IntraStoreJitter()
	waitContext(ctx, d)
}

func waitContext(ctx context.Context, d time.Duration) {
	if d <= 0 {
		return
	}
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

// storeResult は1店舗分の処理結果（ワーカープールの集計用）。
type storeResult struct {
	storeID        string
	fetchOK        bool
	summaryWritten bool
}

// competitorOutcome は1競合分の取得成功結果（repo.Competitor と当日取得した指標の組）。
type competitorOutcome struct {
	competitor repo.Competitor
	metrics    places.CompetitorMetrics
}

// runWorkerPool は店舗単位ワーカープール（design.md: 既定5・env で調整）で confirmedStores を
// 処理する。各店舗の処理は processStoreSafely でパニックからも保護され、1店舗の失敗
// （エラー・パニックいずれも）が他店舗の処理を止めない。
func runWorkerPool(ctx context.Context, deps Deps, stores []repo.Store, today, yesterday time.Time) []storeResult {
	if len(stores) == 0 {
		return nil
	}

	poolSize := deps.WorkerPoolSize
	if poolSize > len(stores) {
		poolSize = len(stores)
	}
	if poolSize <= 0 {
		poolSize = 1
	}

	storeCh := make(chan repo.Store)
	resultCh := make(chan storeResult, len(stores))

	var wg sync.WaitGroup
	for i := 0; i < poolSize; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for store := range storeCh {
				resultCh <- processStoreSafely(ctx, deps, store, today, yesterday)
			}
		}()
	}

	go func() {
		defer close(storeCh)
		for _, s := range stores {
			select {
			case <-ctx.Done():
				return
			case storeCh <- s:
			}
		}
	}()

	wg.Wait()
	close(resultCh)

	results := make([]storeResult, 0, len(stores))
	for r := range resultCh {
		results = append(results, r)
	}
	return results
}

// processStoreSafely は processStore をパニックからも保護するラッパー（店舗単位のエラー隔離を
// Go の panic/recover レベルでも徹底する — 1店舗の想定外エラーがワーカープール全体を
// クラッシュさせないことを保証する）。
func processStoreSafely(ctx context.Context, deps Deps, store repo.Store, today, yesterday time.Time) (result storeResult) {
	result.storeID = store.ID
	defer func() {
		if p := recover(); p != nil {
			deps.Logger.Error("batch: store processing panicked (isolated from other stores)",
				"store_id", store.ID, "panic", fmt.Sprintf("%v", p))
			result = storeResult{storeID: store.ID}
		}
	}()
	return processStore(ctx, deps, store, today, yesterday)
}

// processStore は1店舗分の「自店＋競合の取得 → 順位・前日比・新着差分の算出 → 記録」を行う
// （design.md「日次バッチ」System Flow のワーカープールループ本体）。
func processStore(ctx context.Context, deps Deps, store repo.Store, today, yesterday time.Time) storeResult {
	result := storeResult{storeID: store.ID}
	logger := deps.Logger.With("store_id", store.ID)

	activeCompetitors, err := repo.ActiveCompetitors(ctx, deps.Pool, store.ID)
	if err != nil {
		logger.Error("batch: read active competitors failed", "error", err.Error())
		return result
	}

	// 自店 Place Details（reviews込みマスク）— 6コールのうち1コール目。
	sleepCallJitter(ctx, deps)
	selfMetrics, err := deps.Places.FetchSelfMetrics(ctx, store.PlaceID)
	if err != nil {
		// design.md: 「自店の Place Details が NOT_FOUND の場合は当該店舗を failed とし
		// 運用ログに記録」。NOT_FOUND 以外（バックオフ上限到達等）も同様に当該店舗を
		// failed として扱う（自店データが無ければ順位算出そのものが不能なため）。
		logger.Error("batch: fetch self metrics failed; marking store failed",
			"place_id", store.PlaceID, "not_found", errors.Is(err, places.ErrPlaceNotFound), "error", err.Error())

		if writeErr := repo.WriteDailySummary(ctx, deps.Pool, repo.DailySummaryInput{
			StoreID:     store.ID,
			SummaryDate: today,
			Status:      "failed",
		}); writeErr != nil {
			logger.Error("batch: write failed-status summary failed", "error", writeErr.Error())
			return result
		}
		result.summaryWritten = true
		return result
	}
	result.fetchOK = true

	// 競合 Place Details（指標のみマスク）— 最大5コール。取得不能（NOT_FOUND/CLOSED_PERMANENTLY）は
	// active=false 化して当日の比較集合・以後の取得対象から除外する（R1.5）。それ以外の失敗
	// （バックオフ上限到達等の一時的エラー）は履歴を保持したまま当日のみ比較集合から除外する
	// （恒久的な判別可能エラーではないため active=false 化はしない — design.md R1.5 の
	// 「取得不能」は確定的な判別エラーを指すと解釈。CONCERNS 参照）。
	successful := make([]competitorOutcome, 0, len(activeCompetitors))
	var toDeactivate []string

	for _, c := range activeCompetitors {
		sleepCallJitter(ctx, deps)
		metrics, err := deps.Places.FetchCompetitorMetrics(ctx, c.PlaceID)
		if err != nil {
			if errors.Is(err, places.ErrPlaceNotFound) || errors.Is(err, places.ErrPlaceClosedPermanently) {
				logger.Warn("batch: competitor unreachable, deactivating",
					"competitor_id", c.ID, "place_id", c.PlaceID, "error", err.Error())
				toDeactivate = append(toDeactivate, c.ID)
				continue
			}
			logger.Error("batch: competitor metrics fetch failed (transient; excluded from today only)",
				"competitor_id", c.ID, "place_id", c.PlaceID, "error", err.Error())
			continue
		}
		successful = append(successful, competitorOutcome{competitor: c, metrics: metrics})
	}

	todaySelf := summary.Metrics{Rating: selfMetrics.Rating, ReviewCount: selfMetrics.UserRatingCount}

	// 表示順・スナップショットの rank は「星評価降順・同率はクチコミ総数降順」で自店＋成功競合
	// 全体を並べた通し順位とする（summary.Rank と同じ比較基準。自店を先頭要素として安定ソートし、
	// 同率時に自店が競合より下位に落ちないことを保証する点も summary.Rank と揃える）。
	selfRank, total, competitorRanks := rankAll(todaySelf, successful)

	// 前日比較（rank_prev・rating_prev・review_count_prev・新着件数）。
	yesterdaySnapshots, err := repo.SnapshotsOn(ctx, deps.Pool, store.ID, yesterday)
	if err != nil {
		logger.Error("batch: read yesterday snapshots failed; proceeding without prior-day comparison", "error", err.Error())
		yesterdaySnapshots = nil
	}

	var yesterdaySelf *summary.Metrics
	yesterdayCompetitorByID := make(map[string]summary.Metrics, len(yesterdaySnapshots))
	for _, snap := range yesterdaySnapshots {
		if snap.Rating == nil || snap.ReviewCount == nil {
			continue
		}
		m := summary.Metrics{Rating: *snap.Rating, ReviewCount: *snap.ReviewCount}
		switch {
		case snap.SubjectKind == "self":
			ym := m
			yesterdaySelf = &ym
		case snap.CompetitorID != nil:
			yesterdayCompetitorByID[*snap.CompetitorID] = m
		}
	}

	var rankPrev *int
	if yesterdaySelf != nil {
		// Implementation Notes: 前日の active 競合集合を用意し Rank を再適用して rank_prev を得る。
		// 「as of yesterday」の競合 churn の扱いは design.md 未規定のため、今日の active 競合集合
		// （＝ successful に採用された競合）を両日の比較集合として使う。ただし前日のスナップショットが
		// 存在しない競合（本日新規固定など）は前日側の比較対象に含めない（前日には存在し得ないため）。
		yesterdayCompareMetrics := make([]summary.Metrics, 0, len(successful))
		for _, s := range successful {
			if m, ok := yesterdayCompetitorByID[s.competitor.ID]; ok {
				yesterdayCompareMetrics = append(yesterdayCompareMetrics, m)
			}
		}
		rp, _ := summary.Rank(*yesterdaySelf, yesterdayCompareMetrics)
		rankPrev = &rp
	}

	diff := summary.Diff(todaySelf, yesterdaySelf)

	countDelta := 0
	if yesterdaySelf != nil {
		countDelta = todaySelf.ReviewCount - yesterdaySelf.ReviewCount
	}
	newReviews := summary.NewReviews(countDelta, convertToSummaryReviews(selfMetrics.Reviews), yesterday)

	status := "ready"
	if len(successful) == 0 {
		status = "no_competitors"
	}

	// competitors 表示リスト（表示順=rank順）。
	displayOrder := append([]competitorOutcome(nil), successful...)
	sort.SliceStable(displayOrder, func(i, j int) bool {
		return competitorRanks[displayOrder[i].competitor.ID] < competitorRanks[displayOrder[j].competitor.ID]
	})

	summaryCompetitors := make([]repo.SummaryCompetitor, 0, len(displayOrder))
	for _, s := range displayOrder {
		summaryCompetitors = append(summaryCompetitors, repo.SummaryCompetitor{
			Name:        s.metrics.DisplayName,
			Rating:      s.metrics.Rating,
			ReviewCount: s.metrics.UserRatingCount,
			// starDiff は「自店 - 競合」（正なら自店が優位）。
			StarDiff: roundToOneDecimal(todaySelf.Rating - s.metrics.Rating),
		})
	}

	newReviewExcerpts := make([]repo.NewReviewExcerpt, 0, len(newReviews.Excerpts))
	for _, r := range newReviews.Excerpts {
		newReviewExcerpts = append(newReviewExcerpts, repo.NewReviewExcerpt{
			AuthorName:  r.AuthorName,
			PublishTime: r.PublishTime,
			Rating:      r.Rating,
			TextExcerpt: r.Text,
		})
	}

	rankVal, totalVal := selfRank, total
	ratingVal, reviewCountVal := todaySelf.Rating, todaySelf.ReviewCount

	// snapshots + daily_summaries + competitors の active=false 化を店舗単位の単一トランザクションで
	// 確定する（design.md「Consistency: 店舗単位でトランザクション（snapshots＋summary を同一 Tx
	// で確定）」）。
	tx, err := deps.Pool.Begin(ctx)
	if err != nil {
		logger.Error("batch: begin per-store transaction failed", "error", err.Error())
		return result
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()

	if err := repo.WriteSelfSnapshot(ctx, tx, store.ID, repo.SnapshotWrite{
		PlaceID: store.PlaceID, CapturedOn: today, Rating: todaySelf.Rating, ReviewCount: todaySelf.ReviewCount, Rank: selfRank,
	}); err != nil {
		logger.Error("batch: write self snapshot failed", "error", err.Error())
		return result
	}

	for _, s := range successful {
		if err := repo.WriteCompetitorSnapshot(ctx, tx, store.ID, s.competitor.ID, repo.SnapshotWrite{
			PlaceID:     s.competitor.PlaceID,
			CapturedOn:  today,
			Rating:      s.metrics.Rating,
			ReviewCount: s.metrics.UserRatingCount,
			Rank:        competitorRanks[s.competitor.ID],
		}); err != nil {
			logger.Error("batch: write competitor snapshot failed", "competitor_id", s.competitor.ID, "error", err.Error())
			return result
		}
	}

	if err := repo.DeactivateCompetitors(ctx, tx, toDeactivate); err != nil {
		logger.Error("batch: deactivate unreachable competitors failed", "error", err.Error())
		return result
	}

	if err := repo.WriteDailySummary(ctx, tx, repo.DailySummaryInput{
		StoreID:     store.ID,
		SummaryDate: today,
		Status:      status,
		Rank:        &rankVal,
		RankTotal:   &totalVal,
		RankPrev:    rankPrev,

		Rating:      &ratingVal,
		ReviewCount: &reviewCountVal,

		RatingPrev:      diff.RatingPrev,
		ReviewCountPrev: diff.ReviewCountPrev,

		NewReviewCount: newReviews.Count,
		NewReviews:     newReviewExcerpts,
		Competitors:    summaryCompetitors,
	}); err != nil {
		logger.Error("batch: write daily summary failed", "error", err.Error())
		return result
	}

	if err := tx.Commit(ctx); err != nil {
		logger.Error("batch: commit per-store transaction failed", "error", err.Error())
		return result
	}
	committed = true
	result.summaryWritten = true

	return result
}

// rankAll は自店＋成功取得できた競合を summary.Rank と同じ比較基準（星評価降順・同率は
// クチコミ総数降順・自店を先頭要素とした安定ソート）で通し順位付けし、自店の順位・母数に加え、
// 各競合自身の順位（rating_snapshots.rank・表示順に使う）を返す。
//
// summary.Rank は自店の順位・母数のみを返し競合個々の順位は返さないため、rating_snapshots への
// 競合行書込み（各競合の rank 列）に必要な粒度をここで別途算出する。tie-break ロジックは
// summary.Rank と完全に一致させている（同じ比較関数）。
func rankAll(self summary.Metrics, competitors []competitorOutcome) (selfRank, total int, competitorRanks map[string]int) {
	type entry struct {
		id      string // 空文字は自店
		isSelf  bool
		rating  float64
		reviews int
	}

	entries := make([]entry, 0, len(competitors)+1)
	entries = append(entries, entry{isSelf: true, rating: self.Rating, reviews: self.ReviewCount})
	for _, c := range competitors {
		entries = append(entries, entry{id: c.competitor.ID, rating: c.metrics.Rating, reviews: c.metrics.UserRatingCount})
	}

	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].rating != entries[j].rating {
			return entries[i].rating > entries[j].rating
		}
		return entries[i].reviews > entries[j].reviews
	})

	competitorRanks = make(map[string]int, len(competitors))
	for i, e := range entries {
		rank := i + 1
		if e.isSelf {
			selfRank = rank
		} else {
			competitorRanks[e.id] = rank
		}
	}
	total = len(entries)
	return selfRank, total, competitorRanks
}

func convertToSummaryReviews(reviews []places.Review) []summary.Review {
	out := make([]summary.Review, 0, len(reviews))
	for _, r := range reviews {
		out = append(out, summary.Review{
			AuthorName:  r.AuthorName,
			PublishTime: r.PublishTime,
			Rating:      r.Rating,
			Text:        r.Text,
		})
	}
	return out
}

func roundToOneDecimal(v float64) float64 {
	return math.Round(v*10) / 10
}
