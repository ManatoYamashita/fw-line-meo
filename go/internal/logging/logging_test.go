package logging

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"testing"
)

// decode は 1 行の JSON 出力を map へ落とす。
func decode(t *testing.T, buf *bytes.Buffer) map[string]any {
	t.Helper()
	var got map[string]any
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("出力が JSON として読めない: %v (出力=%q)", err, buf.String())
	}
	return got
}

// 重大度は集約基盤が解釈する項目名で出る。標準の "level" では解釈されない。
func TestSeverityKeyReplacesLevel(t *testing.T) {
	var buf bytes.Buffer
	slog.New(NewJSONHandler(&buf)).Info("何かの事象")

	got := decode(t, &buf)
	if _, ok := got["level"]; ok {
		t.Errorf("level が残っている。集約基盤はこの項目名を重大度として解釈しない: %v", got)
	}
	if got[severityKey] != "INFO" {
		t.Errorf("%s = %v, 期待 INFO", severityKey, got[severityKey])
	}
}

// 警告の綴りは WARNING である。標準ライブラリは WARN を返すため、写し忘れると
// 集約基盤が重大度として扱わず、重大度で絞り込めなくなる。
func TestWarningSpelling(t *testing.T) {
	var buf bytes.Buffer
	slog.New(NewJSONHandler(&buf)).Warn("警告の事象")

	got := decode(t, &buf)
	if got[severityKey] != "WARNING" {
		t.Errorf("%s = %v, 期待 WARNING（WARN ではない）", severityKey, got[severityKey])
	}
}

// 各水準が LogSeverity の綴りへ写ること。
func TestSeveritySpellingPerLevel(t *testing.T) {
	cases := []struct {
		level slog.Level
		want  string
	}{
		{slog.LevelDebug, "DEBUG"},
		{slog.LevelInfo, "INFO"},
		{slog.LevelWarn, "WARNING"},
		{slog.LevelError, "ERROR"},
	}
	for _, c := range cases {
		if got := severityString(c.level); got != c.want {
			t.Errorf("severityString(%v) = %q, 期待 %q", c.level, got, c.want)
		}
	}
}

// 業務上のメッセージと属性には一切触れない。実行サマリーの属性は
// competitive-daily-summary の設計文書が要求仕様として名指ししている。
func TestBusinessAttributesUnchanged(t *testing.T) {
	var buf bytes.Buffer
	slog.New(NewJSONHandler(&buf)).Info("daily-batch execution summary",
		"stores_total", 3,
		"fetch_ok", 2,
		"fetch_failed", 1,
		"store_id", "s-1",
	)

	got := decode(t, &buf)
	if got["msg"] != "daily-batch execution summary" {
		t.Errorf("msg が変わっている: %v", got["msg"])
	}
	for key, want := range map[string]float64{"stores_total": 3, "fetch_ok": 2, "fetch_failed": 1} {
		if got[key] != want {
			t.Errorf("%s = %v, 期待 %v", key, got[key], want)
		}
	}
	if got["store_id"] != "s-1" {
		t.Errorf("store_id = %v, 期待 s-1", got["store_id"])
	}
}

// 属性名が level と同じでも、グループ内なら触らない（最上位の重大度だけを写す）。
func TestGroupedAttributeUntouched(t *testing.T) {
	var buf bytes.Buffer
	slog.New(NewJSONHandler(&buf)).Info("事象", slog.Group("nested", slog.String("level", "業務上の値")))

	got := decode(t, &buf)
	nested, ok := got["nested"].(map[string]any)
	if !ok {
		t.Fatalf("nested がオブジェクトでない: %v", got["nested"])
	}
	if nested["level"] != "業務上の値" {
		t.Errorf("グループ内の level が書き換えられた: %v", nested["level"])
	}
}
