// Package config は日次バッチ（cmd/daily-batch）の起動に必要な設定を環境変数から読み取る。
// env 読取の唯一の窓口とし、他パッケージは os.Getenv を直接呼ばない（design.md: internal/config/config.go）。
package config

import (
	"fmt"
	"os"
	"strconv"
)

const (
	// DefaultWorkerPoolSize は店舗単位ワーカープールの既定サイズ（design.md: 並行度は既定5・env で調整）。
	DefaultWorkerPoolSize = 5
	// DefaultJitterMaxSeconds は起動時ジッターの上限秒数（design.md: 開始時に 0–120 秒のジッター）。
	DefaultJitterMaxSeconds = 120
)

// DBMode は DB 接続方式を表す。ts/packages/db の resolvePoolMode と同じ二系統をとる。
type DBMode string

const (
	// DBModeDatabaseURL はローカル/テスト用の pgx DSN 直指定（native postgres・unix socket も可）。
	DBModeDatabaseURL DBMode = "database-url"
	// DBModeCloudSQLIAM は本番の Cloud SQL IAM 認証（パスワードレス・batch-job モジュールの IAM DB ユーザーに対応）。
	DBModeCloudSQLIAM DBMode = "cloud-sql-iam"
)

// Config は日次バッチが必要とする設定一式。
type Config struct {
	// DB 接続。DBMode に応じて片方の系統のみが埋まる。
	DBMode                 DBMode
	DatabaseURL            string // DBMode=database-url のときのみ設定
	CloudSQLConnectionName string // DBMode=cloud-sql-iam のときのみ設定
	DBIAMUser              string // DBMode=cloud-sql-iam のときのみ設定
	DBName                 string // DBMode=cloud-sql-iam のときのみ設定

	// Places API (New) の呼出キー。
	PlacesAPIKey string

	// 並行度・ジッター（design.md: batch/run のオーケストレーション契約）。
	WorkerPoolSize   int
	JitterMaxSeconds int
}

// Load は環境変数から Config を読み取り、必須項目の欠如や不正な値をエラーとして返す。
//
// DB 接続は次の二系統のいずれか（ts/packages/db の resolvePoolMode と揃える）:
//   - DATABASE_URL が設定されていればそれを使う（ローカル/テスト。native postgres の unix socket も可）
//   - 未設定なら CLOUDSQL_CONNECTION_NAME・DB_IAM_USER・DB_NAME を必須として Cloud SQL IAM 認証を使う
//     （実際のダイヤラ配線・pgx への接続確立は repo 層 (task 3.3) の責務。ここでは値の検証のみ行う）
//
// PLACES_API_KEY は常に必須。BATCH_WORKER_POOL_SIZE・BATCH_JITTER_MAX_SECONDS は任意（既定値あり）。
func Load() (Config, error) {
	var cfg Config

	placesKey, err := requireEnv("PLACES_API_KEY")
	if err != nil {
		return Config{}, err
	}
	cfg.PlacesAPIKey = placesKey

	if dbURL := os.Getenv("DATABASE_URL"); dbURL != "" {
		cfg.DBMode = DBModeDatabaseURL
		cfg.DatabaseURL = dbURL
	} else {
		cfg.DBMode = DBModeCloudSQLIAM

		connName, err := requireEnv("CLOUDSQL_CONNECTION_NAME")
		if err != nil {
			return Config{}, err
		}
		iamUser, err := requireEnv("DB_IAM_USER")
		if err != nil {
			return Config{}, err
		}
		dbName, err := requireEnv("DB_NAME")
		if err != nil {
			return Config{}, err
		}
		cfg.CloudSQLConnectionName = connName
		cfg.DBIAMUser = iamUser
		cfg.DBName = dbName
	}

	poolSize, err := optionalPositiveInt("BATCH_WORKER_POOL_SIZE", DefaultWorkerPoolSize)
	if err != nil {
		return Config{}, err
	}
	cfg.WorkerPoolSize = poolSize

	jitterMax, err := optionalNonNegativeInt("BATCH_JITTER_MAX_SECONDS", DefaultJitterMaxSeconds)
	if err != nil {
		return Config{}, err
	}
	cfg.JitterMaxSeconds = jitterMax

	return cfg, nil
}

// DSN は pgx が受け付ける接続文字列を返す（DBMode=database-url のときのみ有効）。
// Cloud SQL IAM モードのダイヤラ配線・接続確立は repo 層（task 3.3）の責務であり、
// このメソッドは値の受け渡し以上のことを行わない。
func (c Config) DSN() (string, error) {
	if c.DBMode != DBModeDatabaseURL {
		return "", fmt.Errorf("config: DSN is only available in %s mode (current mode: %s)", DBModeDatabaseURL, c.DBMode)
	}
	return c.DatabaseURL, nil
}

func requireEnv(key string) (string, error) {
	v := os.Getenv(key)
	if v == "" {
		return "", fmt.Errorf("config: missing required env var %s", key)
	}
	return v, nil
}

func optionalPositiveInt(key string, def int) (int, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return def, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil || v <= 0 {
		return 0, fmt.Errorf("config: env var %s must be a positive integer, got %q", key, raw)
	}
	return v, nil
}

func optionalNonNegativeInt(key string, def int) (int, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return def, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil || v < 0 {
		return 0, fmt.Errorf("config: env var %s must be a non-negative integer, got %q", key, raw)
	}
	return v, nil
}
