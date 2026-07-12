import type { Queryable } from './pool.js';

export interface ActiveInviteCode {
  agencyId: string;
}

/**
 * 招待コードを検証し、有効（disabled_at IS NULL）なら紐づく代理店 ID を返す（Req 2.1, 2.2, 2.5）。
 * コードは代理店単位・共有であり、本関数はコードを消費・使用済み化しない。
 * 同一コードで複数のオーナーを登録できる（disabled_at が設定されるまで有効）。
 */
export async function findActiveInviteCode(
  db: Queryable,
  code: string,
): Promise<ActiveInviteCode | null> {
  const res = await db.query<{ agency_id: string }>(
    'SELECT agency_id FROM agency_invite_codes WHERE code = $1 AND disabled_at IS NULL',
    [code],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { agencyId: row.agency_id };
}
