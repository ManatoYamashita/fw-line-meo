// Package logging は、日次バッチ層の記録を集約基盤が解釈できる形式で出力する薄い層である。
//
// 標準ライブラリは重大度を "level" という項目名で、値を "WARN" という綴りで出力するが、
// 集約基盤はどちらも解釈しない。項目名は "severity"、値は LogSeverity の綴り（WARNING）で
// なければ重大度として扱われず、「指標は存在するのに常に 0」という静かな失敗になる
// （本番実測の経緯は infra/modules/guardrails/main.tf のコメント、Issue #62 と同型）。
//
// 項目名の正典は docs/observability/log-field-canon.md にある。業務上のメッセージと属性には
// 一切触れない（実行サマリーの属性は competitive-daily-summary の設計文書が要求仕様として
// 名指ししている）。
package logging

import (
	"io"
	"log/slog"
)

// severityKey は集約基盤が重大度として解釈する項目名。正典の「重大度」の行に対応する。
const severityKey = "severity"

// NewJSONHandler は、重大度を集約基盤の綴りで出力する JSON ハンドラを返す。
func NewJSONHandler(w io.Writer) slog.Handler {
	return slog.NewJSONHandler(w, &slog.HandlerOptions{
		ReplaceAttr: toSeverity,
	})
}

// toSeverity は最上位の level 属性だけを severity へ改め、値を集約基盤の綴りへ揃える。
// グループ内の属性と業務上の属性には触れない。
func toSeverity(groups []string, a slog.Attr) slog.Attr {
	if len(groups) != 0 || a.Key != slog.LevelKey {
		return a
	}

	a.Key = severityKey
	if level, ok := a.Value.Any().(slog.Level); ok {
		a.Value = slog.StringValue(severityString(level))
	}
	return a
}

// severityString は標準ライブラリの水準を集約基盤が受け付ける綴りへ写す。
//
// **警告は WARNING であって WARN ではない。** 標準ライブラリの String() は "WARN" を返すため、
// そのまま出すと集約基盤が重大度として解釈しない。綴りの取り違えは出力を見ても気づきにくく、
// 「重大度で絞り込めない」という形でしか現れない。
func severityString(l slog.Level) string {
	switch {
	case l < slog.LevelInfo:
		return "DEBUG"
	case l < slog.LevelWarn:
		return "INFO"
	case l < slog.LevelError:
		return "WARNING"
	default:
		return "ERROR"
	}
}
