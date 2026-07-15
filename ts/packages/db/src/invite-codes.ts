import type { Queryable } from './pool.js';
import type { AgencyInviteCodeRow, InviteCodeItem } from './types.js';

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

const INVITE_CODE_COLUMNS = 'id, agency_id, code, disabled_at, created_at';

function mapInviteCode(row: AgencyInviteCodeRow): InviteCodeItem {
  return {
    id: row.id,
    agencyId: row.agency_id,
    code: row.code,
    disabled: row.disabled_at !== null,
    createdAt: row.created_at,
  };
}

/**
 * ダッシュボード用に代理店の招待コードを有効/無効の別とともに一覧する（agency-dashboard spec・Req 5.1）。
 * agency_id をスコープ列として WHERE に含め、他代理店のコードは返さない。
 */
export async function listInviteCodes(
  db: Queryable,
  agencyId: string,
): Promise<InviteCodeItem[]> {
  const res = await db.query<AgencyInviteCodeRow>(
    `SELECT ${INVITE_CODE_COLUMNS}
       FROM agency_invite_codes WHERE agency_id = $1 ORDER BY created_at DESC`,
    [agencyId],
  );
  return res.rows.map(mapInviteCode);
}

/**
 * 代理店の招待コードを新規発行する（Req 5.2）。code の UNIQUE 違反は呼び出し側で再生成リトライする。
 */
export async function createInviteCode(
  db: Queryable,
  input: { agencyId: string; code: string },
): Promise<InviteCodeItem> {
  const res = await db.query<AgencyInviteCodeRow>(
    `INSERT INTO agency_invite_codes (agency_id, code)
     VALUES ($1, $2)
     RETURNING ${INVITE_CODE_COLUMNS}`,
    [input.agencyId, input.code],
  );
  const row = res.rows[0];
  if (!row) throw new Error('createInviteCode: insert did not return a row');
  return mapInviteCode(row);
}

/**
 * 招待コードを無効化する（Req 5.3）。agency_id をスコープ列として WHERE に含め、
 * 越権（他代理店の id 指定）は 0 行更新 → null を返す（呼び出し側は 404 に写像する）。
 */
export async function disableInviteCode(
  db: Queryable,
  id: string,
  agencyId: string,
): Promise<InviteCodeItem | null> {
  const res = await db.query<AgencyInviteCodeRow>(
    `UPDATE agency_invite_codes
        SET disabled_at = now()
      WHERE id = $1 AND agency_id = $2
      RETURNING ${INVITE_CODE_COLUMNS}`,
    [id, agencyId],
  );
  const row = res.rows[0];
  return row ? mapInviteCode(row) : null;
}
