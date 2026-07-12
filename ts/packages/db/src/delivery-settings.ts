import type { Pool } from 'pg';
import type { Result } from './types.js';

// 配信時刻設定（machine-Req 3.2, 3.3）: postback データ契約
// `action=set_delivery_hour&hour={0-23}`（design.md「Postback データ契約」）を実装する側から
// 呼ばれる唯一の書込エントリポイント。owners は既存 TS 書込境界（write-boundary.md）。

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
