package repo

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

// TestNewPool_DatabaseURLMode は DBModeDatabaseURL 経由の NewPool が、
// task 3.6 の Cloud SQL IAM 配線追加後も従来通り機能することを確認する
// （DATABASE_URL 未設定時はスキップ。既存 testdb_test.go の思想を踏襲）。
func TestNewPool_DatabaseURLMode(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping repo integration test (see ts/scripts/with-test-db.sh)")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := NewPool(ctx, config.Config{
		DBMode:      config.DBModeDatabaseURL,
		DatabaseURL: dsn,
	})
	if err != nil {
		t.Fatalf("NewPool (database-url mode): %v", err)
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("pool.Ping (database-url mode): %v", err)
	}
}

// TestNewPool_CloudSQLIAMMode_WiresRealDialer は DBModeCloudSQLIAM 指定時に
// cloudsqlconn.Dialer が実際に構築・使用され、pgxpool が接続確立を試みることを検証する
// （task 3.6 の観察可能な完了条件: 「ダイヤラが呼ばれ pgxpool 確立を試みることをユニット
// テストで検証する」）。
//
// 実 Cloud SQL インスタンスへの到達確認は task 7.1/7.2 の範囲外・本テストの対象外。
// 代わりに実在しない接続名を渡し、pgxpool.NewWithConfig 自体は遅延接続のため即座に
// 成功する一方、pool.Ping が dial 段階（cloudsqlconn の Cloud SQL Admin API 呼び出しや
// 認証情報検出）で実インフラ起因のエラーを返すことを「配線が本物である証拠」として使う。
// かつて config.go(2.1)→repo/db.go(3.3)→main.go(3.5) と3タスクにわたり先送りされてきた
// "not yet implemented" 系のスタブ文言が返っていないことも明示的にアサートする。
func TestNewPool_CloudSQLIAMMode_WiresRealDialer(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	cfg := config.Config{
		DBMode:                 config.DBModeCloudSQLIAM,
		CloudSQLConnectionName: "nonexistent-fake-project-xyz123:asia-northeast1:nonexistent-instance",
		DBIAMUser:              "sa-daily-batch",
		DBName:                 "fwlm",
	}

	pool, err := NewPool(ctx, cfg)
	if err != nil {
		// cloudsqlconn.NewDialer 自体が失敗するケース（ネットワーク遮断・認証情報検出不能な
		// CI 環境等）。この場合も「実インフラ起因のエラーで失敗した」ことに変わりはなく、
		// かつてのスタブ実装（固定文言を即返すだけ）とは明確に区別できる。
		assertNotStubDBError(t, err)
		assertCloudSQLConnEvidence(t, err)
		return
	}
	defer pool.Close()

	pingErr := pool.Ping(ctx)
	if pingErr == nil {
		t.Fatal("expected pool.Ping against a nonexistent Cloud SQL instance connection name to fail, got nil error")
	}
	assertNotStubDBError(t, pingErr)
	assertCloudSQLConnEvidence(t, pingErr)
}

// assertNotStubDBError は、task 3.5 までの buildPool が返していた
// 「Cloud SQL IAM dialer wiring not yet implemented」系の固定文言スタブエラーが
// もはや発生しないことを確認する。
//
// これ単独では偽陽性（false-green）のリスクがある: DialFunc の配線が何らかの理由で
// 退行し pgx が既定のダイヤラにフォールバックしても、テスト実行環境（本リポジトリの
// ts/scripts/with-test-db.sh が export する PGHOST/PGUSER/PGDATABASE 等の周辺 env）に
// 起因する「別の非スタブ文言のエラー」（例: ローカル postgres への誤接続によるロール/DB
// 不存在エラー）が発生した場合もこのチェックだけでは通ってしまう。そのため
// assertCloudSQLConnEvidence による陽性チェックと必ず併用する。
func assertNotStubDBError(t *testing.T, err error) {
	t.Helper()
	msg := err.Error()
	for _, stub := range []string{"not yet implemented", "not wired", "wiring not"} {
		if strings.Contains(msg, stub) {
			t.Fatalf("got stub/unimplemented-shaped error, Cloud SQL IAM dialer wiring appears missing: %v", err)
		}
	}
}

// assertCloudSQLConnEvidence は、err のエラーチェーンに cloudsqlconn が実際に呼び出された
// ことの陽性証拠が含まれることを確認する（assertNotStubDBError の「スタブ文言ではない」
// という消極的チェックだけでは、DialFunc 配線が退行してもテスト環境由来の別のローカル
// postgres エラーがすり抜けてしまう false-green リスクがあるため、その穴を塞ぐ）。
//
// 最優先の証拠は cloudsqlconn/errtype が公開する型付きエラー（*errtype.RefreshError /
// *errtype.DialError / *errtype.ConfigError）への errors.As マッチ。これらは cloudsqlconn
// パッケージ内部でしか生成されないため、マッチした時点で cloudsqlconn の Dialer.Dial が
// 実際に（Cloud SQL Admin API へのリフレッシュ処理まで含めて）実行されたことの動かぬ証拠になる
// （実測: nonexistent-fake-project-xyz123 に対する dial で
// "refresh error: failed to get instance metadata (...): googleapi: Error 400:
// Project specified in the request is invalid., errorInvalidProject" を含む
// *errtype.RefreshError が errors.As で検出できることを確認済み）。
//
// cloudsqlconn.NewDialer 自体が失敗する経路（認証情報検出不能など）では errtype の型が
// 生じない場合があるため、その場合は NewDialer 内部が返す文言に固有の部分文字列
// （"failed to create default credentials" 等、cloudsqlconn/dialer.go 由来）でフォール
// バック判定する。
func assertCloudSQLConnEvidence(t *testing.T, err error) {
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
