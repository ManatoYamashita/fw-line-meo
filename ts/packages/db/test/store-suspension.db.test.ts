import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PoolClient } from 'pg';
import { getPool, closePool } from '../src/pool.js';
import {
  findStoreForSurvey,
  findStoreWithAgency,
  listStoresWithStatus,
  setStoreSuspension,
} from '../src/stores.js';
import { incrementTallies } from '../src/tallies.js';

// 他ファイルと DB を共有するため、衝突しない専用 UUID プレフィックス（a5）と line_user_id を使う。
const OP = 'a5000000-0000-0000-0000-000000000001';
const AG1 = 'a5000000-0000-0000-0000-000000000011';
const AG2 = 'a5000000-0000-0000-0000-000000000012';
const OW1 = 'a5000000-0000-0000-0000-000000000021';
const OW2 = 'a5000000-0000-0000-0000-000000000022';
// 列と匿名集計の不変を見る店舗（AG1 の担当）
const ST_KEEP = 'a5000000-0000-0000-0000-000000000031';
// 同時の停止を見る店舗（AG1 の担当）
const ST_RACE = 'a5000000-0000-0000-0000-000000000032';
// 範囲外を見る店舗（AG2 の担当）
const ST_OTHER = 'a5000000-0000-0000-0000-000000000033';
// 停止と再開の往復と、読み出しでの停止時刻を見る店舗（AG1 の担当）
const ST_CYCLE = 'a5000000-0000-0000-0000-000000000034';
const MISSING = 'a5000000-0000-0000-0000-0000000000ff';

const TALLY_TABLES = [
  'survey_rating_tallies',
  'survey_aspect_tallies',
  'survey_concern_tallies',
  'survey_material_tallies',
] as const;

/** 店舗の行を、停止時刻を除いた全列で読む。列が増えても比較から漏れないよう to_jsonb で丸ごと取る。 */
async function storeRowWithoutSuspension(id: string): Promise<Record<string, unknown>> {
  const pool = await getPool();
  const res = await pool.query<{ row: Record<string, unknown> }>(
    `SELECT to_jsonb(s) - 'suspended_at' AS row FROM stores s WHERE s.id = $1`,
    [id],
  );
  const row = res.rows[0]?.row;
  if (!row) throw new Error(`store ${id} not found`);
  return row;
}

async function suspendedAtOf(id: string): Promise<Date | null> {
  const pool = await getPool();
  const res = await pool.query<{ suspended_at: Date | null }>(
    'SELECT suspended_at FROM stores WHERE id = $1',
    [id],
  );
  return res.rows[0]?.suspended_at ?? null;
}

/** 店舗の匿名集計 4 表を、表ごとに行の JSON の配列として読む（順序を固定する）。 */
async function talliesOf(storeId: string): Promise<Record<string, unknown[]>> {
  const pool = await getPool();
  const out: Record<string, unknown[]> = {};
  for (const table of TALLY_TABLES) {
    const res = await pool.query<{ row: unknown }>(
      `SELECT to_jsonb(t) AS row FROM ${table} t WHERE t.store_id = $1 ORDER BY to_jsonb(t)::text`,
      [storeId],
    );
    out[table] = res.rows.map((r) => r.row);
  }
  return out;
}

/** 指定件数の接続が行ロック待ちに入るまで待つ（同時実行を確実に重ねるため）。 */
async function waitForLockWaiters(count: number): Promise<void> {
  const pool = await getPool();
  for (let i = 0; i < 200; i += 1) {
    const res = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%suspended_at%'`,
    );
    if ((res.rows[0]?.n ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`lock waiters did not reach ${count}`);
}

describe.skipIf(!process.env.DATABASE_URL)('setStoreSuspension (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, '停止運営']);
    await pool.query(
      'INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3), ($4, $2, $5)',
      [AG1, OP, '停止代理店1', AG2, '停止代理店2'],
    );
    await pool.query(
      `INSERT INTO owners (id, agency_id, line_user_id, onboarding_status)
       VALUES ($1, $2, $3, 'active'), ($4, $5, $6, 'active')`,
      [OW1, AG1, 'U-suspension-owner-1', OW2, AG2, 'U-suspension-owner-2'],
    );
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, latitude, longitude, place_id, place_status)
       VALUES ($1, $5, '停止店舗-不変', 35.1, 139.1, 'ChIJ_suspension_keep', 'confirmed'),
              ($2, $5, '停止店舗-同時', NULL, NULL, 'ChIJ_suspension_race', 'confirmed'),
              ($3, $6, '停止店舗-他代理店', NULL, NULL, 'ChIJ_suspension_other', 'confirmed'),
              ($4, $5, '停止店舗-往復', NULL, NULL, 'ChIJ_suspension_cycle', 'confirmed')`,
      [ST_KEEP, ST_RACE, ST_OTHER, ST_CYCLE, OW1, OW2],
    );
    // 匿名集計が停止・再開で消えも変わりもしないことを見るため、4 表すべてに行を作っておく。
    await incrementTallies(pool, {
      storeId: ST_KEEP,
      star: 4,
      aspectCodes: ['taste'],
      concernCodes: ['service'],
      hasComment: true,
    });
  });

  afterAll(async () => {
    await closePool();
  });

  it('停止も再開も停止時刻以外の列と匿名集計を変えない（Req 1.7, 5.3）', async () => {
    const pool = await getPool();
    const rowBefore = await storeRowWithoutSuspension(ST_KEEP);
    const talliesBefore = await talliesOf(ST_KEEP);
    // 空の集計を比べて空振りしないよう、4 表すべてに行があることを先に確かめる
    for (const table of TALLY_TABLES) expect(talliesBefore[table]?.length ?? 0).toBeGreaterThan(0);

    const suspended = await setStoreSuspension(pool, {
      storeId: ST_KEEP,
      direction: 'suspend',
      agencyId: null,
    });
    expect(suspended.kind).toBe('changed');
    expect(await suspendedAtOf(ST_KEEP)).toBeInstanceOf(Date);
    expect(await storeRowWithoutSuspension(ST_KEEP)).toEqual(rowBefore);
    expect(await talliesOf(ST_KEEP)).toEqual(talliesBefore);

    const resumed = await setStoreSuspension(pool, {
      storeId: ST_KEEP,
      direction: 'resume',
      agencyId: null,
    });
    expect(resumed.kind).toBe('changed');
    expect(await suspendedAtOf(ST_KEEP)).toBeNull();
    expect(await storeRowWithoutSuspension(ST_KEEP)).toEqual(rowBefore);
    expect(await talliesOf(ST_KEEP)).toEqual(talliesBefore);
  });

  it('同じ店舗へ同時に 2 回停止すると変化ありは 1 回だけで、もう 1 回は現在の停止時刻を返す（Req 1.5）', async () => {
    const pool = await getPool();
    // 2 つの停止を確実に重ねるため、別の接続で行ロックを握ったまま 2 つを発行し、両方が待ちに入ってから放す。
    const blocker: PoolClient = await pool.connect();
    let results: Awaited<ReturnType<typeof setStoreSuspension>>[];
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM stores WHERE id = $1 FOR UPDATE', [ST_RACE]);
      const first = setStoreSuspension(pool, {
        storeId: ST_RACE,
        direction: 'suspend',
        agencyId: AG1,
      });
      const second = setStoreSuspension(pool, {
        storeId: ST_RACE,
        direction: 'suspend',
        agencyId: null,
      });
      await waitForLockWaiters(2);
      await blocker.query('COMMIT');
      results = await Promise.all([first, second]);
    } finally {
      blocker.release();
    }

    const kinds = results.map((r) => r.kind).sort();
    expect(kinds).toEqual(['changed', 'unchanged']);
    const stored = await suspendedAtOf(ST_RACE);
    expect(stored).toBeInstanceOf(Date);
    for (const r of results) {
      if (r.kind === 'not_found') throw new Error('unexpected not_found');
      // 後着の unchanged も、先着が書いた現在の停止時刻を返す（古い null を返さない）
      expect(r.store).toEqual({ id: ST_RACE, suspendedAt: stored });
    }
  });

  it('代理店が他の代理店の店舗を停止しようとすると見つからない扱いで、行は変わらない（Req 1.4）', async () => {
    const pool = await getPool();
    const rowBefore = await storeRowWithoutSuspension(ST_OTHER);

    const outcome = await setStoreSuspension(pool, {
      storeId: ST_OTHER,
      direction: 'suspend',
      agencyId: AG1,
    });
    expect(outcome).toEqual({ kind: 'not_found' });
    expect(await suspendedAtOf(ST_OTHER)).toBeNull();
    expect(await storeRowWithoutSuspension(ST_OTHER)).toEqual(rowBefore);
  });

  it('存在しない店舗は範囲外と同じ見つからない扱いになる（Req 1.4）', async () => {
    const pool = await getPool();
    expect(
      await setStoreSuspension(pool, { storeId: MISSING, direction: 'suspend', agencyId: null }),
    ).toEqual({ kind: 'not_found' });
    expect(
      await setStoreSuspension(pool, { storeId: MISSING, direction: 'resume', agencyId: AG1 }),
    ).toEqual({ kind: 'not_found' });
  });

  it('範囲外の店舗は再開も見つからない扱いで、停止中のまま残る（Req 1.4）', async () => {
    const pool = await getPool();
    await setStoreSuspension(pool, { storeId: ST_OTHER, direction: 'suspend', agencyId: AG2 });
    const stored = await suspendedAtOf(ST_OTHER);
    expect(stored).toBeInstanceOf(Date);

    expect(
      await setStoreSuspension(pool, { storeId: ST_OTHER, direction: 'resume', agencyId: AG1 }),
    ).toEqual({ kind: 'not_found' });
    expect(await suspendedAtOf(ST_OTHER)).toEqual(stored);

    // 後片付けを兼ねて、担当代理店は再開できることを確かめる
    const resumed = await setStoreSuspension(pool, {
      storeId: ST_OTHER,
      direction: 'resume',
      agencyId: AG2,
    });
    expect(resumed).toEqual({ kind: 'changed', store: { id: ST_OTHER, suspendedAt: null } });
  });

  it('担当代理店の停止・重ねた停止・再開・重ねた再開が changed / unchanged を正しく返し、読み出しが停止時刻を返す（Req 1.2, 1.3, 1.5）', async () => {
    const pool = await getPool();

    const suspended = await setStoreSuspension(pool, {
      storeId: ST_CYCLE,
      direction: 'suspend',
      agencyId: AG1,
    });
    expect(suspended.kind).toBe('changed');
    const stored = await suspendedAtOf(ST_CYCLE);
    expect(stored).toBeInstanceOf(Date);
    expect(suspended).toEqual({ kind: 'changed', store: { id: ST_CYCLE, suspendedAt: stored } });

    // 停止中の店舗への停止は変化なしで、停止時刻を書き換えない
    const again = await setStoreSuspension(pool, {
      storeId: ST_CYCLE,
      direction: 'suspend',
      agencyId: null,
    });
    expect(again).toEqual({ kind: 'unchanged', store: { id: ST_CYCLE, suspendedAt: stored } });
    expect(await suspendedAtOf(ST_CYCLE)).toEqual(stored);

    // 停止中は 3 つの読み出しすべてが停止時刻を返す
    expect((await findStoreForSurvey(pool, ST_CYCLE))?.suspendedAt).toEqual(stored);
    expect((await findStoreWithAgency(pool, ST_CYCLE))?.suspendedAt).toEqual(stored);
    const listed = (await listStoresWithStatus(pool, { agencyId: AG1 })).find(
      (s) => s.id === ST_CYCLE,
    );
    expect(listed?.suspendedAt).toEqual(stored);

    const resumed = await setStoreSuspension(pool, {
      storeId: ST_CYCLE,
      direction: 'resume',
      agencyId: AG1,
    });
    expect(resumed).toEqual({ kind: 'changed', store: { id: ST_CYCLE, suspendedAt: null } });

    // 利用中の店舗への再開は変化なし
    const resumedAgain = await setStoreSuspension(pool, {
      storeId: ST_CYCLE,
      direction: 'resume',
      agencyId: null,
    });
    expect(resumedAgain).toEqual({
      kind: 'unchanged',
      store: { id: ST_CYCLE, suspendedAt: null },
    });

    // 再開後は 3 つの読み出しすべてが null を返す
    expect((await findStoreForSurvey(pool, ST_CYCLE))?.suspendedAt).toBeNull();
    expect((await findStoreWithAgency(pool, ST_CYCLE))?.suspendedAt).toBeNull();
    const listedAfter = (await listStoresWithStatus(pool, {})).find((s) => s.id === ST_CYCLE);
    expect(listedAfter?.suspendedAt).toBeNull();
  });
});
