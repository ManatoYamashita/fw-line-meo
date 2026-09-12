/**
 * 記録の出力経路（Issue #228）。応答層 5 面が記録を出す唯一の経路である。
 *
 * 項目名と事象名の正典は `docs/observability/log-field-canon.md` にあり、
 * 実装との乖離は `scripts/check-log-field-binding.sh` が機械検証する。
 *
 * 外部の実行時依存を持たない（標準出力へ 1 行書くだけである）。
 */

export type { LogFields, LogLevel, Severity } from './fields.js';
export type { Sink } from './sink.js';
export { writeStructuredLog } from './sink.js';
export {
  correlationIdFromHeaders,
  correlationIdFromTraceId,
  executionCorrelationId,
  projectIdFromEnv,
  supportCodeFromCorrelationId,
  traceIdFromHeaders,
  withCorrelation,
} from './correlation.js';
