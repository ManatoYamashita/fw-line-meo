import type { Queryable } from './pool.js';
import type { AgencyItem } from './types.js';

const AGENCY_COLUMNS = 'id, operator_id, name, created_at';

interface AgencyItemRow {
  id: string;
  operator_id: string;
  name: string;
  created_at: Date;
}

function mapAgency(row: AgencyItemRow): AgencyItem {
  return {
    id: row.id,
    operatorId: row.operator_id,
    name: row.name,
    createdAt: row.created_at,
  };
}

/**
 * 運営配下に代理店を新規作成する（Req 6.1）。operator_id は呼び出し側で解決した運営スコープ。
 * agencies は TS 層（ダッシュボード）が書込責任を持つ。
 */
export async function createAgency(
  db: Queryable,
  input: { operatorId: string; name: string },
): Promise<AgencyItem> {
  const res = await db.query<AgencyItemRow>(
    `INSERT INTO agencies (operator_id, name)
     VALUES ($1, $2)
     RETURNING ${AGENCY_COLUMNS}`,
    [input.operatorId, input.name],
  );
  const row = res.rows[0];
  if (!row) throw new Error('createAgency: insert did not return a row');
  return mapAgency(row);
}

/** 指定運営に属する代理店を作成日時の降順で一覧する（Req 6.1・operator スコープ）。 */
export async function listAgencies(db: Queryable, operatorId: string): Promise<AgencyItem[]> {
  const res = await db.query<AgencyItemRow>(
    `SELECT ${AGENCY_COLUMNS} FROM agencies WHERE operator_id = $1 ORDER BY created_at DESC`,
    [operatorId],
  );
  return res.rows.map(mapAgency);
}

/** 代理店名を単一取得する（GET /me の agencyName 用・不在は null）。 */
export async function findAgencyName(db: Queryable, agencyId: string): Promise<string | null> {
  const res = await db.query<{ name: string }>('SELECT name FROM agencies WHERE id = $1', [
    agencyId,
  ]);
  return res.rows[0]?.name ?? null;
}
