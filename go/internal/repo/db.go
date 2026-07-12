// Package repo は Go 日次バッチの唯一の DB アクセス点を提供する（design.md「Go / repo/*」)。
// 対象店舗・競合の読取、competitors の固定・churn 化、rating_snapshots/daily_summaries の
// 同日再実行安全な書込、30日超のパージを実装する。書込境界（db/write-boundary.md）に従い、
// 本パッケージが書くのは competitors・rating_snapshots・daily_summaries のみ。
package repo

import (
	"context"
	"fmt"
	"net"

	"cloud.google.com/go/cloudsqlconn"
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
// DBModeDatabaseURL（ローカル/テスト。native postgres の unix socket も可）は
// cfg.DSN() をそのまま pgxpool.New に渡す。
// DBModeCloudSQLIAM（本番）は Cloud SQL Go Connector（cloudsqlconn、公式ライブラリ）に
// よる IAM 認証ダイヤラを配線する（gcp-infra-foundation design.md「DB 認証」＝
// 「IAM データベース認証（ランタイム）...アプリは Language Connector + auto-IAM-authn
// 前提」）。
func NewPool(ctx context.Context, cfg config.Config) (*pgxpool.Pool, error) {
	switch cfg.DBMode {
	case config.DBModeDatabaseURL:
		return newPoolFromDatabaseURL(ctx, cfg)
	case config.DBModeCloudSQLIAM:
		return newPoolFromCloudSQLIAM(ctx, cfg)
	default:
		return nil, fmt.Errorf("repo: unknown DB mode %q", cfg.DBMode)
	}
}

func newPoolFromDatabaseURL(ctx context.Context, cfg config.Config) (*pgxpool.Pool, error) {
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

// newPoolFromCloudSQLIAM は cloudsqlconn.Dialer（WithIAMAuthN・パスワードレス）を
// pgxpool.Config.ConnConfig.DialFunc に配線して pgxpool.Pool を確立する。
// 到達経路は gcp-infra-foundation design.md「接続境界（3.4）」の想定通りランタイム SA の
// Language Connector のみであり、生の TCP:5432 直結は行わない（sslmode=disable は
// cloudsqlconn が既に mTLS で暗号化した通信路を pgx に渡すための指定であり、平文化では
// ない。公式ドキュメントの標準的な pgxpool 統合パターンに従う）。
//
// user には batch-job Terraform モジュールが作成する IAM DB ユーザー名
// （job SA のメールアドレスから ".gserviceaccount.com" サフィックスを除いたもの、
// infra/modules/batch-job/main.tf の google_sql_user.job_iam.name 参照）を
// DB_IAM_USER 経由でそのまま渡す。トリム等の加工はここでは行わない
// （Terraform 側の命名規約と一致させるのは env の供給元の責務）。
func newPoolFromCloudSQLIAM(ctx context.Context, cfg config.Config) (*pgxpool.Pool, error) {
	dialer, err := cloudsqlconn.NewDialer(ctx, cloudsqlconn.WithIAMAuthN())
	if err != nil {
		return nil, fmt.Errorf("repo: build cloud sql dialer: %w", err)
	}

	dsn := fmt.Sprintf("user=%s dbname=%s sslmode=disable", cfg.DBIAMUser, cfg.DBName)
	poolConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		_ = dialer.Close()
		return nil, fmt.Errorf("repo: parse cloud sql pool config: %w", err)
	}

	instanceConnName := cfg.CloudSQLConnectionName
	poolConfig.ConnConfig.DialFunc = func(ctx context.Context, _ /* network */, _ /* addr */ string) (net.Conn, error) {
		return dialer.Dial(ctx, instanceConnName)
	}

	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		_ = dialer.Close()
		return nil, fmt.Errorf("repo: open cloud sql pool: %w", err)
	}
	return pool, nil
}
