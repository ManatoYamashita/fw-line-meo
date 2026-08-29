// Package testdb はテスト用の postgres 接続を提供する。
//
// # なぜ必要か（Issue #163）
//
// `go test ./...` は**パッケージ単位でテストバイナリを並列実行**する。従来はどのパッケージも
// `DATABASE_URL` が指す単一のデータベースへ直接つないでおり、しかも seed ヘルパーが挿入した行を
// 片付けていなかった。その結果:
//
//   - `batch.Run` は「全 confirmed 店舗を無制限にクエリする」という**本番どおりの**設計であり、
//     `TestRun_EndToEnd_MixedStores` は `StoresTotal == 3` のようにグローバルな件数を厳密比較する。
//     同時に走る `internal/repo` や `internal/competitor` が挿入した店舗を数えてしまい落ちる。
//   - `-p 1`（パッケージ逐次）は**回避策にすらならない**。緑になるのは `internal/batch` が
//     `internal/repo` よりアルファベット順で先に走るという偶然に依存しているだけで、順序を
//     入れ替えると `StoresTotal = 16` で落ちる（Issue #163 に実測を記録）。
//
// したがって「並列度を下げる」のではなく、**グローバルな状態を共有しないこと**で根治する。
//
// # 2 つの入口
//
//   - [Isolated] — テストごとに専用のデータベースを作り、`db/migrations/*.sql` を適用して返す。
//     他パッケージが何を挿入しようと影響を受けない。**既定はこちら。**
//   - [Shared] — `DATABASE_URL` が指すデータベースへそのままつなぐ。**言語をまたいで同じ行を
//     見る必要がある場合のみ**使う（cross-runtime 契約テストは Go が書いた行を TS が読むため、
//     隔離してはならない）。
//
// どちらも `DATABASE_URL` 未設定なら `t.Skip` する。ts 側の
// `describe.skipIf(!process.env.DATABASE_URL)` と同じ「DB が無ければ自動スキップ」の思想。
package testdb

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// dbSeq は同一プロセス内で作るデータベース名を一意にする。プロセス間は pid で分かれるため、
// 並列実行されるテストバイナリ同士が同じ名前を要求することはない。
var dbSeq atomic.Int64

// Shared は DATABASE_URL が指すデータベースへの接続プールを返す。
//
// **隔離しないことが要件である場合にだけ使う。** 現状の唯一の正当な利用者は cross-runtime
// 契約テストで、Go が書いた daily_summaries を後続の TS 配信ジョブが同じデータベースから
// 読む必要がある。それ以外は [Isolated] を使うこと。
func Shared(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := requireDSN(t)
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pgxpool.New(shared): %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// Isolated はこのテスト専用のデータベースを作成し、db/migrations/*.sql を適用したうえで
// 接続プールを返す。テスト終了時にプールを閉じてデータベースを破棄する。
//
// 名前は `fwlm_t_<pid>_<連番>`。DATABASE_URL のデータベース名だけを差し替えて接続するので、
// unix socket 形式（with-test-db.sh）でも TCP 形式（CI の service container）でも動く。
func Isolated(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := requireDSN(t)
	ctx := context.Background()

	name := fmt.Sprintf("fwlm_t_%d_%d", os.Getpid(), dbSeq.Add(1))

	admin, err := pgxpool.New(ctx, withDatabase(t, dsn, "postgres"))
	if err != nil {
		t.Fatalf("pgxpool.New(admin): %v", err)
	}
	defer admin.Close()

	// CREATE DATABASE はトランザクション内で実行できないため、識別子を直接埋め込む。
	// name は上で組み立てた固定書式（数字と英小文字のみ）なので注入の余地は無い。
	if _, err := admin.Exec(ctx, `CREATE DATABASE "`+name+`"`); err != nil {
		t.Fatalf("CREATE DATABASE %s: %v", name, err)
	}

	pool, err := pgxpool.New(ctx, withDatabase(t, dsn, name))
	if err != nil {
		dropDatabase(t, dsn, name)
		t.Fatalf("pgxpool.New(%s): %v", name, err)
	}

	// **後片付けは登録順の逆で走る。** プールを閉じてから DROP しないと接続が残って失敗する。
	t.Cleanup(func() { dropDatabase(t, dsn, name) })
	t.Cleanup(pool.Close)

	applyMigrations(t, ctx, pool)
	return pool
}

func requireDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping DB-backed test (see ts/scripts/with-test-db.sh)")
	}
	return dsn
}

// withDatabase は DSN のデータベース名だけを差し替える。クエリ文字列（unix socket の host= 等）は
// そのまま保つ。
func withDatabase(t *testing.T, dsn, database string) string {
	t.Helper()
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("DATABASE_URL を URL として解釈できません: %v", err)
	}
	u.Path = "/" + database
	return u.String()
}

func dropDatabase(t *testing.T, dsn, name string) {
	t.Helper()
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, withDatabase(t, dsn, "postgres"))
	if err != nil {
		t.Errorf("DROP のための接続に失敗しました（%s が残ります）: %v", name, err)
		return
	}
	defer admin.Close()
	// WITH (FORCE) は PostgreSQL 13 以降。本リポジトリはローカル・CI とも 16 系。
	if _, err := admin.Exec(ctx, `DROP DATABASE IF EXISTS "`+name+`" WITH (FORCE)`); err != nil {
		t.Errorf("DROP DATABASE %s: %v", name, err)
	}
}

// applyMigrations は db/migrations/*.sql を辞書順に適用する。
//
// **simple protocol を使う。** 各ファイルは複数ステートメントを含むが、pgx の既定（extended
// protocol）は 1 リクエスト 1 ステートメントしか受け付けない。PgConn().Exec は simple query
// protocol でまとめて送るのでファイルをそのまま流せる。
func applyMigrations(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()

	dir := migrationsDir(t)
	entries, err := filepath.Glob(filepath.Join(dir, "*.sql"))
	if err != nil {
		t.Fatalf("migrations の走査に失敗しました: %v", err)
	}
	// **0 件は「適用すべきものが無い」ではなく「走査の前提が崩れている」である。**
	if len(entries) == 0 {
		t.Fatalf("%s に *.sql が 1 件もありません（走査の前提が崩れています）", dir)
	}
	sort.Strings(entries)

	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("migrations 適用用の接続取得に失敗しました: %v", err)
	}
	defer conn.Release()

	for _, path := range entries {
		sqlBytes, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%s の読み込みに失敗しました: %v", path, err)
		}
		if _, err := conn.Conn().PgConn().Exec(ctx, string(sqlBytes)).ReadAll(); err != nil {
			t.Fatalf("%s の適用に失敗しました: %v", filepath.Base(path), err)
		}
	}
}

// migrationsDir はテストの作業ディレクトリから上位へ辿って db/migrations を探す。
// go/ 配下のどのパッケージから呼ばれても同じ場所に解決される。
func migrationsDir(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("作業ディレクトリを取得できません: %v", err)
	}
	for {
		candidate := filepath.Join(dir, "db", "migrations")
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("db/migrations が見つかりません（作業ディレクトリから上位を走査しました）")
		}
		dir = parent
	}
}
