// Command daily-batch は競合日次サマリー機能の Go バッチ層エントリポイントである。
// 設定読取・DB プール／Places クライアントの DI 配線・batch.Run の実行・実行サマリーの
// 構造化ログ出力を担う（design.md File Structure Plan: cmd/daily-batch/main.go =
// 「エントリポイント・DI 配線・実行サマリーの構造化ログ出力」）。
// 実処理（抽出・取得・算出・記録・パージ）は internal/batch（task 3.5）に委ねる。
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"

	"github.com/ManatoYamashita/fw-line-meo/go/internal/batch"
	"github.com/ManatoYamashita/fw-line-meo/go/internal/config"
	"github.com/ManatoYamashita/fw-line-meo/go/internal/places"
	"github.com/ManatoYamashita/fw-line-meo/go/internal/repo"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	ctx := context.Background()

	cfg, err := config.Load()
	if err != nil {
		logger.Error("daily-batch startup failed: config load error", "error", err.Error())
		os.Exit(1)
	}

	pool, err := buildPool(ctx, cfg)
	if err != nil {
		logger.Error("daily-batch startup failed: db pool build error", "error", err.Error())
		os.Exit(1)
	}
	defer pool.Close()

	placesClient := places.NewClient(cfg.PlacesAPIKey)

	result, err := batch.Run(ctx, batch.Deps{
		Pool:             pool,
		Places:           placesClient,
		WorkerPoolSize:   cfg.WorkerPoolSize,
		JitterMaxSeconds: cfg.JitterMaxSeconds,
		Logger:           logger,
	})
	if err != nil {
		// バッチ全体が実行不能だった致命的エラー（例: 対象店舗の読取自体が失敗）。
		// 店舗単位の失敗（result.FetchFailed）とは異なるシグナルとして扱い、
		// Cloud Run Job を非0終了させて guardrails の実行履歴ベースアラートに乗せる（R5.1）。
		logger.Error("daily-batch run failed fatally", "error", err.Error())
		os.Exit(1)
	}

	// design.md「Output/destination: ...終了時に実行サマリー（対象店舗数・抽出実行数・
	// 取得成功/失敗数・summary 生成数・パージ行数）を構造化ログで1行出力」（R5.2）。
	// フィールド名は Monitoring 節（「両ジョブとも終了時に固定フィールドの構造化ログ1行
	// （stores_total / fetch_ok / fetch_failed / summaries_written / ... / purged）」）に揃える。
	logger.Info("daily-batch execution summary",
		"stores_total", result.StoresTotal,
		"extract_ran", result.ExtractRan,
		"fetch_ok", result.FetchOK,
		"fetch_failed", result.FetchFailed,
		"summaries_written", result.SummariesWritten,
		"snapshots_purged", result.SnapshotsPurged,
		"summaries_purged", result.SummariesPurged,
		"purged", result.RowsPurged(),
	)

	// 全体失敗の当日検知（R5.1）: 対象店舗が存在するにもかかわらず1店舗も自店指標を
	// 取得できなかった場合は、個々の店舗障害ではなくシステム的な異常（Places API 全断・
	// キー失効等）を疑い、Job を非0終了させて guardrails に検知させる。1店舗のみの失敗は
	// 「店舗単位のエラー隔離」の対象であり、この基準には該当しない（意図的に exit 0 のまま）。
	if result.StoresTotal > 0 && result.FetchOK == 0 && result.FetchFailed > 0 {
		logger.Error("daily-batch: all target stores failed self-metrics fetch; treating as total failure")
		os.Exit(1)
	}
}

// buildPool は config.Config から実行時の DB プールを構築する。
//
// DBModeDatabaseURL（ローカル/テスト。native postgres の unix socket も可）は
// repo.NewPool にそのまま委ねる。
//
// DBModeCloudSQLIAM（本番の Cloud SQL IAM 認証・cloudsql-go-connector によるダイヤラ配線）は
// 本タスクの境界では未配線。config.go・repo/db.go の両コメントが「実際のダイヤラ配線は
// 別タスクの責務」とだけ記し実装元を確定していなかったため、本関数で明確なエラーとして
// 停止させる（無断で新規外部依存 cloud.google.com/go/cloudsqlconn を追加しない — 実配線は
// tasks.md task 6.x「各イメージの push と既設ジョブの実体化手順を確立する」の境界で
// 改めて設計・実装すべき判断とする。CONCERNS 参照）。
func buildPool(ctx context.Context, cfg config.Config) (*pgxpool.Pool, error) {
	switch cfg.DBMode {
	case config.DBModeDatabaseURL:
		return repo.NewPool(ctx, cfg)
	case config.DBModeCloudSQLIAM:
		return nil, fmt.Errorf("daily-batch: Cloud SQL IAM dialer wiring not yet implemented (mode=%s); "+
			"use DATABASE_URL for local/staging runs until task 6.x wires the production connector", cfg.DBMode)
	default:
		return nil, errors.New("daily-batch: unknown DB mode")
	}
}
