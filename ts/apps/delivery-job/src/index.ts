// delivery-job の Cloud Run Job エントリポイント。
//
// 現時点は骨格のみ（Task 2.2）。対象抽出・Flex 組立・LINE Push・配信記録（Task 4.1–4.4）は未実装で、
// ここでは「実行サマリー形式の構造化ログを1行出し、正常終了する」という観察可能な完了条件のみを満たす。
// status: 'skeleton_only' は本ジョブがまだ実配信を行わないことを正直に表す値であり、
// 実装が進み次第 'ready' 等の実値へ置き換わる想定。

export interface DeliveryJobSummary {
  readonly event: 'delivery-job.run';
  readonly status: 'skeleton_only';
  readonly targetsFound: number;
  readonly delivered: number;
  readonly failed: number;
  readonly skipped: number;
}

/** 実行サマリーを組み立てる（純関数・骨格段階は常に空実績）。 */
export function buildSummary(): DeliveryJobSummary {
  return {
    event: 'delivery-job.run',
    status: 'skeleton_only',
    targetsFound: 0,
    delivered: 0,
    failed: 0,
    skipped: 0,
  };
}

/** エントリの本体。サマリーを JSON 1 行として stdout へ出力する。 */
export function main(): void {
  console.log(JSON.stringify(buildSummary()));
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main();
}
