// Command daily-batch は競合日次サマリー機能の Go バッチ層エントリポイントである。
// 現時点（task 2.1）では骨格のみを提供する: 設定読取が成功することを確認し、
// 構造化ログで起動事実を1行出力して正常終了する。
// 競合抽出・Places 取得・順位算出などの実処理は task 3.1–3.5 で実装される。
package main

import (
	"log/slog"
	"os"

	"github.com/ManatoYamashita/fw-line-meo/go/internal/config"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	cfg, err := config.Load()
	if err != nil {
		logger.Error("daily-batch startup failed: config load error", "error", err.Error())
		os.Exit(1)
	}

	logger.Info("daily-batch skeleton booted",
		"status", "not_yet_implemented",
		"db_mode", string(cfg.DBMode),
		"worker_pool_size", cfg.WorkerPoolSize,
		"jitter_max_seconds", cfg.JitterMaxSeconds,
	)
}
