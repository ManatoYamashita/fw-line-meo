// Package repo は Go 日次バッチの唯一の DB アクセス点を提供する（design.md「Go / repo/*」)。
// 対象店舗・競合の読取、competitors の固定・churn 化、rating_snapshots/daily_summaries の
// 同日再実行安全な書込、30日超のパージを実装する。書込境界（db/write-boundary.md）に従い、
// 本パッケージが書くのは competitors・rating_snapshots・daily_summaries のみ。
package repo

import (
	"context"
	"fmt"

	"github.com/ManatoYamashita/fw-line-meo/go/internal/config"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DBTX は repo パッケージの各関数が依存する pgx の最小サーフェス。
// *pgxpool.Pool と pgx.Tx の両方がこれを満たすため、呼出元（batch/run・task 3.5）は
// 店舗単位のトランザクション境界（design.md「Consistency: 店舗単位でトランザクション
// （snapshots＋summary を同一 Tx で確定）」）を自由に選べる。repo 自体はトランザクション
// 境界に関知しない。
type DBTX interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

var (
	_ DBTX = (*pgxpool.Pool)(nil)
	_ DBTX = (pgx.Tx)(nil)
)

// NewPool は config.Config から pgx コネクションプールを構築する。
//
// DBModeDatabaseURL（ローカル/テスト。native postgres の unix socket も可）のみを直接扱う。
// Cloud SQL IAM モード（cloudsql-go-connector によるダイヤラ配線）は本タスクの境界外の
// 実行時配線（cmd/daily-batch・task 3.5）の責務であり、cfg.DSN() が非対応モードで
// エラーを返すため本関数もそれをそのまま伝播する。
func NewPool(ctx context.Context, cfg config.Config) (*pgxpool.Pool, error) {
	dsn, err := cfg.DSN()
	if err != nil {
		return nil, fmt.Errorf("repo: build pool: %w", err)
	}
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("repo: open pool: %w", err)
	}
	return pool, nil
}
