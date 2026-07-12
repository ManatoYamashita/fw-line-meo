package config

import "testing"

// clearBatchEnv は各テストで env をクリーンな状態から組み立てるためのヘルパー。
// t.Setenv は他の env に触れないため、前提となる必須変数を明示的に未設定へ倒す。
func clearBatchEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"PLACES_API_KEY",
		"DATABASE_URL",
		"CLOUDSQL_CONNECTION_NAME",
		"DB_IAM_USER",
		"DB_NAME",
		"BATCH_WORKER_POOL_SIZE",
		"BATCH_JITTER_MAX_SECONDS",
	} {
		t.Setenv(key, "")
	}
}

func TestLoad_MissingPlacesAPIKey_ReturnsError(t *testing.T) {
	clearBatchEnv(t)
	t.Setenv("DATABASE_URL", "postgres://user@localhost:5432/fwlm?sslmode=disable")

	_, err := Load()

	if err == nil {
		t.Fatal("expected error when PLACES_API_KEY is missing, got nil")
	}
}

func TestLoad_DatabaseURLMode_MissingRequiredDBVars_ReturnsError(t *testing.T) {
	clearBatchEnv(t)
	t.Setenv("PLACES_API_KEY", "test-places-key")
	// DATABASE_URL も CLOUDSQL_CONNECTION_NAME も未設定 → Cloud SQL IAM モードへ倒れ、
	// CLOUDSQL_CONNECTION_NAME 欠如でエラーになるはず。

	_, err := Load()

	if err == nil {
		t.Fatal("expected error when neither DATABASE_URL nor CLOUDSQL_CONNECTION_NAME is set, got nil")
	}
}

func TestLoad_CloudSQLIAMMode_MissingDBIAMUser_ReturnsError(t *testing.T) {
	clearBatchEnv(t)
	t.Setenv("PLACES_API_KEY", "test-places-key")
	t.Setenv("CLOUDSQL_CONNECTION_NAME", "proj:region:instance")
	t.Setenv("DB_NAME", "fwlm")
	// DB_IAM_USER が未設定

	_, err := Load()

	if err == nil {
		t.Fatal("expected error when DB_IAM_USER is missing in cloud-sql-iam mode, got nil")
	}
}

func TestLoad_DatabaseURLMode_AllRequiredVarsSet_ReturnsCorrectConfig(t *testing.T) {
	clearBatchEnv(t)
	t.Setenv("PLACES_API_KEY", "test-places-key")
	t.Setenv("DATABASE_URL", "postgres://user@localhost:5432/fwlm?sslmode=disable")

	cfg, err := Load()

	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if cfg.DBMode != DBModeDatabaseURL {
		t.Errorf("DBMode = %q, want %q", cfg.DBMode, DBModeDatabaseURL)
	}
	if cfg.DatabaseURL != "postgres://user@localhost:5432/fwlm?sslmode=disable" {
		t.Errorf("DatabaseURL = %q, unexpected value", cfg.DatabaseURL)
	}
	if cfg.PlacesAPIKey != "test-places-key" {
		t.Errorf("PlacesAPIKey = %q, want %q", cfg.PlacesAPIKey, "test-places-key")
	}
	if cfg.WorkerPoolSize != DefaultWorkerPoolSize {
		t.Errorf("WorkerPoolSize = %d, want default %d", cfg.WorkerPoolSize, DefaultWorkerPoolSize)
	}
	if cfg.JitterMaxSeconds != DefaultJitterMaxSeconds {
		t.Errorf("JitterMaxSeconds = %d, want default %d", cfg.JitterMaxSeconds, DefaultJitterMaxSeconds)
	}

	dsn, err := cfg.DSN()
	if err != nil {
		t.Fatalf("DSN() error = %v, want nil in database-url mode", err)
	}
	if dsn != cfg.DatabaseURL {
		t.Errorf("DSN() = %q, want %q", dsn, cfg.DatabaseURL)
	}
}

func TestLoad_CloudSQLIAMMode_AllRequiredVarsSet_ReturnsCorrectConfig(t *testing.T) {
	clearBatchEnv(t)
	t.Setenv("PLACES_API_KEY", "test-places-key")
	t.Setenv("CLOUDSQL_CONNECTION_NAME", "proj:region:instance")
	t.Setenv("DB_IAM_USER", "sa-daily-batch")
	t.Setenv("DB_NAME", "fwlm")

	cfg, err := Load()

	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if cfg.DBMode != DBModeCloudSQLIAM {
		t.Errorf("DBMode = %q, want %q", cfg.DBMode, DBModeCloudSQLIAM)
	}
	if cfg.CloudSQLConnectionName != "proj:region:instance" {
		t.Errorf("CloudSQLConnectionName = %q, unexpected value", cfg.CloudSQLConnectionName)
	}
	if cfg.DBIAMUser != "sa-daily-batch" {
		t.Errorf("DBIAMUser = %q, unexpected value", cfg.DBIAMUser)
	}
	if cfg.DBName != "fwlm" {
		t.Errorf("DBName = %q, unexpected value", cfg.DBName)
	}

	if _, err := cfg.DSN(); err == nil {
		t.Error("DSN() expected error in cloud-sql-iam mode, got nil")
	}
}

func TestLoad_CustomWorkerPoolAndJitter_AreParsed(t *testing.T) {
	clearBatchEnv(t)
	t.Setenv("PLACES_API_KEY", "test-places-key")
	t.Setenv("DATABASE_URL", "postgres://user@localhost:5432/fwlm?sslmode=disable")
	t.Setenv("BATCH_WORKER_POOL_SIZE", "8")
	t.Setenv("BATCH_JITTER_MAX_SECONDS", "60")

	cfg, err := Load()

	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if cfg.WorkerPoolSize != 8 {
		t.Errorf("WorkerPoolSize = %d, want 8", cfg.WorkerPoolSize)
	}
	if cfg.JitterMaxSeconds != 60 {
		t.Errorf("JitterMaxSeconds = %d, want 60", cfg.JitterMaxSeconds)
	}
}

func TestLoad_InvalidWorkerPoolSize_ReturnsError(t *testing.T) {
	clearBatchEnv(t)
	t.Setenv("PLACES_API_KEY", "test-places-key")
	t.Setenv("DATABASE_URL", "postgres://user@localhost:5432/fwlm?sslmode=disable")
	t.Setenv("BATCH_WORKER_POOL_SIZE", "0")

	_, err := Load()

	if err == nil {
		t.Fatal("expected error for BATCH_WORKER_POOL_SIZE=0, got nil")
	}
}

func TestLoad_InvalidJitterMaxSeconds_ReturnsError(t *testing.T) {
	clearBatchEnv(t)
	t.Setenv("PLACES_API_KEY", "test-places-key")
	t.Setenv("DATABASE_URL", "postgres://user@localhost:5432/fwlm?sslmode=disable")
	t.Setenv("BATCH_JITTER_MAX_SECONDS", "-1")

	_, err := Load()

	if err == nil {
		t.Fatal("expected error for negative BATCH_JITTER_MAX_SECONDS, got nil")
	}
}
