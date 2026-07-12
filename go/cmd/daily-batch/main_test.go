package main

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"cloud.google.com/go/cloudsqlconn/errtype"
	"github.com/ManatoYamashita/fw-line-meo/go/internal/config"
)

// TestBuildPool_UnknownMode は未知の DBMode が明示的なエラーになることを確認する
// （default 分岐の回帰防止）。
func TestBuildPool_UnknownMode(t *testing.T) {
	_, err := buildPool(context.Background(), config.Config{DBMode: "bogus-mode"})
	if err == nil {
		t.Fatal("expected error for unknown DB mode")
	}
}

// TestBuildPool_DatabaseURLMode は buildPool の DATABASE_URL 経路が、
// task 3.6 の Cloud SQL IAM 配線追加後も従来通り repo.NewPool 経由で機能することを
// 確認する（DATABASE_URL 未設定時はスキップ）。
func TestBuildPool_DatabaseURLMode(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping cmd/daily-batch integration test (see ts/scripts/with-test-db.sh)")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := buildPool(ctx, config.Config{
		DBMode:      config.DBModeDatabaseURL,
		DatabaseURL: dsn,
	})
	if err != nil {
		t.Fatalf("buildPool (database-url mode): %v", err)
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("pool.Ping (database-url mode): %v", err)
	}
}

// TestBuildPool_CloudSQLIAMMode_DispatchesToRealWiring は buildPool が
// DBModeCloudSQLIAM を repo.NewPool の実配線（cloudsqlconn ダイヤラ）へ実際に渡すことを
// 検証する（task 3.6 の観察可能な完了条件）。
//
// task 3.5 までの buildPool は本モードで「Cloud SQL IAM dialer wiring not yet
// implemented」という固定文言を即座に返すだけのスタブだった。本テストは、実在しない
// 接続名に対して pgxpool 確立が dial 段階まで進み実インフラ起因のエラーで失敗すること
// （＝スタブではなく本物の配線に到達したこと）を確認する。
func TestBuildPool_CloudSQLIAMMode_DispatchesToRealWiring(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	cfg := config.Config{
		DBMode:                 config.DBModeCloudSQLIAM,
		CloudSQLConnectionName: "nonexistent-fake-project-xyz123:asia-northeast1:nonexistent-instance",
		DBIAMUser:              "sa-daily-batch",
		DBName:                 "fwlm",
	}

	pool, err := buildPool(ctx, cfg)
	if err != nil {
		assertBuildPoolErrorIsNotStub(t, err)
		assertBuildPoolCloudSQLConnEvidence(t, err)
		return
	}
	defer pool.Close()

	pingErr := pool.Ping(ctx)
	if pingErr == nil {
		t.Fatal("expected pool.Ping against a nonexistent Cloud SQL instance connection name to fail, got nil error")
	}
	assertBuildPoolErrorIsNotStub(t, pingErr)
	assertBuildPoolCloudSQLConnEvidence(t, pingErr)
}

// assertBuildPoolErrorIsNotStub 単独では偽陽性（false-green）のリスクがある: DialFunc の
// 配線が退行して pgx が既定のダイヤラにフォールバックしても、テスト実行環境（本リポジトリの
// ts/scripts/with-test-db.sh が export する PGHOST/PGUSER/PGDATABASE 等の周辺 env）に起因
// する「別の非スタブ文言のエラー」がこのチェックだけをすり抜けてしまう可能性があるため、
// assertBuildPoolCloudSQLConnEvidence による陽性チェックと必ず併用する。
func assertBuildPoolErrorIsNotStub(t *testing.T, err error) {
	t.Helper()
	msg := err.Error()
	for _, stub := range []string{"not yet implemented", "not wired", "wiring not"} {
		if strings.Contains(msg, stub) {
			t.Fatalf("buildPool still returns a stub/unimplemented-shaped error for Cloud SQL IAM mode: %v", err)
		}
	}
}

// assertBuildPoolCloudSQLConnEvidence は、buildPool が返した err のエラーチェーンに
// cloudsqlconn が実際に呼び出されたことの陽性証拠が含まれることを確認する
// （internal/repo/db_test.go の assertCloudSQLConnEvidence と同じ根拠。cmd/daily-batch は
// internal/repo の非公開実装に依存できないため、同等のロジックをここでも保持する）。
//
// 最優先の証拠は cloudsqlconn/errtype が公開する型付きエラー（*errtype.RefreshError /
// *errtype.DialError / *errtype.ConfigError）への errors.As マッチ。実測でも
// nonexistent-fake-project-xyz123 への dial が *errtype.RefreshError（"refresh error:
// failed to get instance metadata (...): googleapi: Error 400: Project specified in the
// request is invalid., errorInvalidProject" を含む）として errors.As で検出できることを
// 確認済み。cloudsqlconn.NewDialer 自体が失敗する経路では errtype の型が生じない場合が
// あるため、その場合は NewDialer 内部が返す文言に固有の部分文字列でフォールバック判定する。
func assertBuildPoolCloudSQLConnEvidence(t *testing.T, err error) {
	t.Helper()

	var refreshErr *errtype.RefreshError
	var dialErr *errtype.DialError
	var configErr *errtype.ConfigError
	if errors.As(err, &refreshErr) || errors.As(err, &dialErr) || errors.As(err, &configErr) {
		return
	}

	msg := err.Error()
	cloudSQLConnOnlySubstrings := []string{
		"googleapi",
		"cloudsqlconn",
		"failed to get instance",
		"refresh error",
		"failed to create default credentials",
		"failed to create scoped credentials",
		"failed to create auth client",
		"failed to create sqladmin client",
	}
	for _, s := range cloudSQLConnOnlySubstrings {
		if strings.Contains(msg, s) {
			return
		}
	}

	t.Fatalf("error does not contain positive cloudsqlconn/Cloud SQL Admin API evidence "+
		"(no errtype.{RefreshError,DialError,ConfigError} in chain, no known cloudsqlconn-only "+
		"substring); this could be a coincidental local-Postgres connection failure masking a "+
		"DialFunc wiring regression: %v", err)
}
