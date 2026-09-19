import type { Pool } from 'pg';
import type { Result } from './types.js';

// 配信時刻設定（machine-Req 3.2, 3.3）: `delivery_hour` を書く唯一のエントリポイント。
// owners は既存 TS 書込境界（write-boundary.md）。
//
// 呼び出し元は無い。LINE 上で配信時刻を変える手段は提供しないと決めたため
// （line-on-demand-report Requirement 1.9・#256）。値は既定の 7 時のまま運用し、
// 変更が要るときは運用者が直接 UPDATE する。この関数は、その手段を将来 LINE 面へ
// 足すときの入口として残してある。

/**
 * 配信時刻（JST・時単位）を更新する。hour は 0–23 のみ許容。
 * 該当する line_user_id の owner が存在しない場合は OWNER_NOT_FOUND を返す。
 */
export async function updateDeliveryHour(
  pool: Pool,
  lineUserId: string,
  hour: number,
): Promise<Result<void, 'INVALID_HOUR' | 'OWNER_NOT_FOUND'>> {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return { ok: false, error: 'INVALID_HOUR' };
  }

  const res = await pool.query('UPDATE owners SET delivery_hour = $1 WHERE line_user_id = $2', [
    hour,
    lineUserId,
  ]);

  if (!res.rowCount) {
    return { ok: false, error: 'OWNER_NOT_FOUND' };
  }

  return { ok: true, value: undefined };
}
