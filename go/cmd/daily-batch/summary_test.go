package main

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"testing"

	"github.com/ManatoYamashita/fw-line-meo/go/internal/batch"
	"github.com/ManatoYamashita/fw-line-meo/go/internal/logging"
)

// TestLogExecutionSummary_EventAndNumericFields は、実行サマリー行がログベース指標の数える形で
// 出ることを固定する（Issue #139）。
//
// 指標 places_fetch_ok_runs / places_fetch_eligible_runs の filter は
// `jsonPayload.event = "daily-batch.run" AND jsonPayload.fetch_ok > 0` の形で行を数える。
// 事象名が変わる、または数値が文字列で出ると、指標は静かに 0 になり Places の生死判定が
// 「未観測」へ落ちる。
func TestLogExecutionSummary_EventAndNumericFields(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(logging.NewJSONHandler(&buf))

	logExecutionSummary(logger, batch.Summary{StoresTotal: 3, FetchOK: 2, FetchFailed: 1})

	var line map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &line); err != nil {
		t.Fatalf("summary line is not a single JSON object: %v (%q)", err, buf.String())
	}
	if got := line["event"]; got != "daily-batch.run" {
		t.Errorf("event = %v, want %q", got, "daily-batch.run")
	}
	for key, want := range map[string]float64{"stores_total": 3, "fetch_ok": 2, "fetch_failed": 1} {
		got, ok := line[key].(float64)
		if !ok {
			t.Errorf("%s = %#v, want a JSON number", key, line[key])
			continue
		}
		if got != want {
			t.Errorf("%s = %v, want %v", key, got, want)
		}
	}
}
