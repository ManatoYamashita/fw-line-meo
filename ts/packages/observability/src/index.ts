/**
 * 記録の出力経路（Issue #228）。応答層 5 面が記録を出す唯一の経路である。
 *
 * 項目名と事象名の正典は `docs/observability/log-field-canon.md` にあり、
 * 実装との乖離は `scripts/check-log-field-binding.sh` が機械検証する。
 *
 * 本ファイルは公開 API の集約点であり、実体は以下が持つ。
 * - 許可項目の型と鍵集合の表明: `fields.ts`（タスク 1.3）
 * - 出力と特別項目への写像: `sink.ts`（タスク 1.4）
 *
 * 外部の実行時依存を持たない（標準出力へ 1 行書くだけである）。
 */

export {};
