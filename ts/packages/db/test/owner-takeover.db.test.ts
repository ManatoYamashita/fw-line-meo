import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from '../src/pool.js';
import type { Queryable, TransactionCapable } from '../src/pool.js';
import { lockPlaceHolder, moveAllStores } from '../src/owner-line-link.js';
import { incrementTallies } from '../src/tallies.js';

// 引継ぎのための所有者の施錠と全店舗の付け替え（owner-line-unlink task 2.3・Req 2.6, 6.1, 6.3, 6.6）。
// 他ファイルと DB を共有するため、衝突しない専用 UUID プレフィックス（b9）と place_id を使う。
const OP = 'b9000000-0000-0000-0000-000000000001';
const AG1 = 'b9000000-0000-0000-0000-000000000011';
// 付け替えの元（解除済み）と先（連携中）
const OW_OLD = 'b9000000-0000-0000-0000-000000000021';
const OW_NEW = 'b9000000-0000-0000-0000-000000000022';
// 付け替えに巻き込まれてはならない別のオーナー（連携中）
const OW_BYSTANDER = 'b9000000-0000-0000-0000-000000000023';
// 誤った付け替え（連携中の元・自分自身・不存在）を見るオーナー
const OW_LINKED_FROM = 'b9000000-0000-0000-0000-000000000024';
const OW_SELF = 'b9000000-0000-0000-0000-000000000025';
// 同時の施錠を見るオーナー（元は解除済み・先は連携中）
const OW_RACE_OLD = 'b9000000-0000-0000-0000-000000000026';
const OW_RACE_NEW = 'b9000000-0000-0000-0000-000000000027';
// line_webhook の権限だけで付け替えが通ることを見るオーナー
const OW_ROLE_OLD = 'b9000000-0000-0000-0000-000000000028';
const OW_ROLE_NEW = 'b9000000-0000-0000-0000-000000000029';
const MISSING = 'b9000000-0000-0000-0000-0000000000ff';

// OW_OLD の店舗（確定済み・停止中・未確定）と、OW_BYSTANDER の店舗
const ST_CONFIRMED = 'b9000000-0000-0000-0000-000000000031';
const ST_SUSPENDED = 'b9000000-0000-0000-0000-000000000032';
const ST_PENDING = 'b9000000-0000-0000-0000-000000000033';
const ST_BYSTANDER = 'b9000000-0000-0000-0000-000000000034';
const ST_LINKED_FROM = 'b9000000-0000-0000-0000-000000000035';
const ST_SELF = 'b9000000-0000-0000-0000-000000000036';
const ST_RACE = 'b9000000-0000-0000-0000-000000000037';
const ST_ROLE = 'b9000000-0000-0000-0000-000000000038';
const COMPETITOR = 'b9000000-0000-0000-0000-000000000041';

const PLACE_CONFIRMED = 'ChIJ_owner_takeover_confirmed';
const PLACE_SUSPENDED = 'ChIJ_owner_takeover_suspended';
const PLACE_BYSTANDER = 'ChIJ_owner_takeover_bystander';
const PLACE_LINKED_FROM = 'ChIJ_owner_takeover_linked_from';
const PLACE_SELF = 'ChIJ_owner_takeover_self';
const PLACE_RACE = 'ChIJ_owner_takeover_race';
const PLACE_ROLE = 'ChIJ_owner_takeover_role';

const here = dirname(fileURLToPath(import.meta.url));
const GRANTS_SQL = resolve(here, '../../../../infra/sql/grants.sql');
const SUFFIX = `${process.pid}_${Date.now()}`;
const ROLE_KEYS = ['line_webhook', 'survey', 'dashboard', 'batch', 'delivery', 'detail'] as const;
const roleName = (key: string) => `fwlm_t487_${key}_${SUFFIX}`;

/** grants.sql から GRANT / REVOKE 文だけを取り出し、SA の変数を検証用のロール名へ置き換える。 */
function grantStatements(): string[] {
  const text = readFileSync(GRANTS_SQL, 'utf8')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('\\'))
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  return text
    .split(';')
    .map((s) => s.trim())
    .filter((s) => /^(GRANT|REVOKE)\b/.test(s))
    .map((s) =>
      s.replace(/:"(\w+)"/g, (_, key: string) => {
        if (!(ROLE_KEYS as readonly string[]).includes(key)) throw new Error(`grants.sql の未知の SA: ${key}`);
        return `"${roleName(key)}"`;
      }),
    );
}

/** 呼び出し側が開くトランザクションの中で fn を実行し、成功なら COMMIT、失敗なら ROLLBACK して投げ直す。 */
async function inTransaction<T>(
  pool: TransactionCapable,
  fn: (tx: Queryable) => Promise<T>,
  role?: string,
): Promise<T> {
  const client = await pool.connect();
  try {
    if (role) await client.query(`SET ROLE "${role}"`);
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    if (role) await client.query('RESET ROLE').catch(() => undefined);
    client.release();
  }
}

/** 列が増えても比較から漏れないよう、行を to_jsonb で丸ごと読む。 */
async function rowsAsJson(sql: string, params: unknown[]): Promise<unknown[]> {
  const pool = await getPool();
  const res = await pool.query<{ row: unknown }>(sql, params);
  return res.rows.map((r) => r.row);
}

/** 店舗の行を、所有者の列を除いて丸ごと読む（店舗のほかの列が変わらないことを見る）。 */
async function storesWithoutOwner(ids: string[]): Promise<unknown[]> {
  return rowsAsJson(
    `SELECT to_jsonb(s) - 'owner_id' AS row FROM stores s WHERE s.id = ANY($1::uuid[]) ORDER BY s.id`,
    [ids],
  );
}

async function ownerIdsOf(ids: string[]): Promise<Record<string, string>> {
  const pool = await getPool();
  const res = await pool.query<{ id: string; owner_id: string }>(
    'SELECT id, owner_id FROM stores WHERE id = ANY($1::uuid[])',
    [ids],
  );
  return Object.fromEntries(res.rows.map((r) => [r.id, r.owner_id]));
}

async function ownerRow(id: string): Promise<Record<string, unknown>> {
  const rows = await rowsAsJson('SELECT to_jsonb(o) AS row FROM owners o WHERE o.id = $1', [id]);
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error(`owner ${id} not found`);
  return row;
}

/**
 * stores(id) を外部キーで参照するすべての表について、指定した店舗を指す行を丸ごと読む。
 * 参照する表の一覧はカタログから引くので、表が増えても比較から漏れない。
 */
async function dependentRows(storeIds: string[]): Promise<Record<string, unknown[]>> {
  const pool = await getPool();
  const refs = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT c.conrelid::regclass::text AS table_name, a.attname AS column_name
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f'
        AND c.confrelid = 'stores'::regclass
        AND array_length(c.conkey, 1) = 1
      ORDER BY 1, 2`,
  );
  const out: Record<string, unknown[]> = {};
  for (const { table_name: table, column_name: column } of refs.rows) {
    out[`${table}.${column}`] = await rowsAsJson(
      `SELECT to_jsonb(t) AS row FROM ${table} t WHERE t.${column} = ANY($1::uuid[]) ORDER BY to_jsonb(t)::text`,
      [storeIds],
    );
  }
  return out;
}

/** 指定した接続が行ロックの待ちに入るまで待つ。他の試験ファイルの待ちと取り違えないよう pid で絞る。 */
async function waitForLockWait(pid: number): Promise<void> {
  const pool = await getPool();
  // 試験の時間制限（5 秒）より先に、待ちに入らなかったことを明示の失敗として返す。
  for (let i = 0; i < 80; i += 1) {
    const res = await pool.query<{ waiting: boolean }>(
      `SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1`,
      [pid],
    );
    if (res.rows[0]?.waiting === true) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`connection ${pid} did not wait for a lock`);
}

describe.skipIf(!process.env.DATABASE_URL)('owner-line-link 引継ぎの施錠と付け替え (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, '引継ぎ運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      AG1,
      OP,
      '引継ぎ代理店',
    ]);
    // 連携中のオーナーを作ってから、元になるオーナーを解除済みへ移す（ck_owner_line_link を満たす形で書く）。
    await pool.query(
      `INSERT INTO owners (id, agency_id, line_user_id, display_name, onboarding_status)
       VALUES ($1, $10, 'U-owner-takeover-old', '引継ぎ元', 'active'),
              ($2, $10, 'U-owner-takeover-new', '引継ぎ先', 'pending'),
              ($3, $10, 'U-owner-takeover-bystander', '無関係', 'active'),
              ($4, $10, 'U-owner-takeover-linked-from', '連携中の元', 'active'),
              ($5, $10, 'U-owner-takeover-self', '自分自身', 'active'),
              ($6, $10, 'U-owner-takeover-race-old', '同時の元', 'active'),
              ($7, $10, 'U-owner-takeover-race-new', '同時の先', 'pending'),
              ($8, $10, 'U-owner-takeover-role-old', '権限の元', 'active'),
              ($9, $10, 'U-owner-takeover-role-new', '権限の先', 'pending')`,
      [
        OW_OLD,
        OW_NEW,
        OW_BYSTANDER,
        OW_LINKED_FROM,
        OW_SELF,
        OW_RACE_OLD,
        OW_RACE_NEW,
        OW_ROLE_OLD,
        OW_ROLE_NEW,
        AG1,
      ],
    );
    await pool.query(
      `UPDATE owners SET line_user_id = NULL, line_unlinked_at = now()
        WHERE id = ANY($1::uuid[])`,
      [[OW_OLD, OW_SELF, OW_RACE_OLD, OW_ROLE_OLD]],
    );
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, latitude, longitude, place_id, place_status, suspended_at, category_code)
       VALUES ($1, $5, '引継ぎ店舗-確定', 35.1, 139.1, $6, 'confirmed', NULL, 'izakaya'),
              ($2, $5, '引継ぎ店舗-停止中', 35.2, 139.2, $7, 'confirmed', TIMESTAMPTZ '2026-10-01 09:00+09', NULL),
              ($3, $5, '引継ぎ店舗-未確定', NULL, NULL, NULL, 'pending', NULL, NULL),
              ($4, $8, '無関係の店舗', NULL, NULL, $9, 'confirmed', NULL, NULL)`,
      [ST_CONFIRMED, ST_SUSPENDED, ST_PENDING, ST_BYSTANDER, OW_OLD, PLACE_CONFIRMED, PLACE_SUSPENDED, OW_BYSTANDER, PLACE_BYSTANDER],
    );
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_id, place_status)
       VALUES ($1, $2, '連携中の元の店舗', $3, 'confirmed'),
              ($4, $5, '自分自身の店舗', $6, 'confirmed'),
              ($7, $8, '同時の店舗', $9, 'confirmed'),
              ($10, $11, '権限の店舗', $12, 'confirmed')`,
      [
        ST_LINKED_FROM,
        OW_LINKED_FROM,
        PLACE_LINKED_FROM,
        ST_SELF,
        OW_SELF,
        PLACE_SELF,
        ST_RACE,
        OW_RACE_OLD,
        PLACE_RACE,
        ST_ROLE,
        OW_ROLE_OLD,
        PLACE_ROLE,
      ],
    );
    // 付け替えで蓄積が消えも変わりもしないことを見るため、日次データ・競合・評価の時系列・配信記録・
    // 匿名集計に行を作る（確定済みと停止中の両方）。
    for (const storeId of [ST_CONFIRMED, ST_SUSPENDED]) {
      await incrementTallies(pool, {
        storeId,
        star: 4,
        aspectCodes: ['taste'],
        concernCodes: ['service'],
        hasComment: true,
      });
      await pool.query(
        `INSERT INTO daily_summaries (store_id, summary_date, status, rank, rank_total, rating, review_count)
         VALUES ($1, DATE '2026-07-12', 'ready', 2, 6, 4.2, 80)`,
        [storeId],
      );
      await pool.query(
        `INSERT INTO summary_deliveries (store_id, summary_date, line_user_id, status, retry_key, delivered_at)
         VALUES ($1, DATE '2026-07-12', 'U-owner-takeover-old', 'delivered', gen_random_uuid(), now())`,
        [storeId],
      );
      await pool.query(
        `INSERT INTO rating_snapshots (store_id, subject_kind, place_id, captured_on, rating, review_count, rank)
         VALUES ($1, 'self', 'ChIJ_owner_takeover_self_snapshot', DATE '2026-07-12', 4.2, 80, 2)`,
        [storeId],
      );
    }
    await pool.query(
      `INSERT INTO competitors (id, store_id, place_id, name) VALUES ($1, $2, 'ChIJ_owner_takeover_competitor', '競合')`,
      [COMPETITOR, ST_CONFIRMED],
    );
    await pool.query(
      `INSERT INTO rating_snapshots (store_id, subject_kind, competitor_id, place_id, captured_on, rating, review_count, rank)
       VALUES ($1, 'competitor', $2, 'ChIJ_owner_takeover_competitor', DATE '2026-07-12', 4.0, 50, 3)`,
      [ST_CONFIRMED, COMPETITOR],
    );
  });

  afterAll(async () => {
    const pool = await getPool();
    for (const key of ROLE_KEYS) {
      const role = roleName(key);
      await pool.query(`DROP OWNED BY "${role}"`).catch(() => undefined);
      await pool.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
    }
    await closePool();
  });

  it('Place の店舗が無ければ null を返す', async () => {
    const pool = await getPool();
    const holder = await inTransaction(pool, (tx) => lockPlaceHolder(tx, 'ChIJ_owner_takeover_absent'));
    expect(holder).toBeNull();
  });

  it('Place の店舗と、その所有者の代理店・連携状態を返す', async () => {
    const pool = await getPool();
    const unlinked = await inTransaction(pool, (tx) => lockPlaceHolder(tx, PLACE_SUSPENDED));
    expect(unlinked).toEqual({ storeId: ST_SUSPENDED, ownerId: OW_OLD, agencyId: AG1, unlinked: true });
    const linked = await inTransaction(pool, (tx) => lockPlaceHolder(tx, PLACE_BYSTANDER));
    expect(linked).toEqual({ storeId: ST_BYSTANDER, ownerId: OW_BYSTANDER, agencyId: AG1, unlinked: false });
  });

  it('旧オーナーの全店舗を移し、店舗のほかの列と蓄積を変えず、旧オーナーに引継ぎ先を記録する（Req 2.6, 6.1, 6.3）', async () => {
    const pool = await getPool();
    const ownStores = [ST_CONFIRMED, ST_SUSPENDED, ST_PENDING];
    const storesBefore = await storesWithoutOwner(ownStores);
    const dependentsBefore = await dependentRows(ownStores);
    // 空の比較で空振りしないよう、代表的な蓄積の表に行があることを先に確かめる
    for (const key of [
      'daily_summaries.store_id',
      'summary_deliveries.store_id',
      'rating_snapshots.store_id',
      'competitors.store_id',
      'survey_rating_tallies.store_id',
      'survey_aspect_tallies.store_id',
      'survey_concern_tallies.store_id',
      'survey_material_tallies.store_id',
    ]) {
      expect(dependentsBefore[key]?.length ?? 0, key).toBeGreaterThan(0);
    }
    const oldBefore = await ownerRow(OW_OLD);
    const newBefore = await ownerRow(OW_NEW);
    const bystanderStoreBefore = await rowsAsJson(
      'SELECT to_jsonb(s) AS row FROM stores s WHERE s.id = $1',
      [ST_BYSTANDER],
    );

    const moved = await inTransaction(pool, async (tx) => {
      const holder = await lockPlaceHolder(tx, PLACE_CONFIRMED);
      expect(holder).toEqual({ storeId: ST_CONFIRMED, ownerId: OW_OLD, agencyId: AG1, unlinked: true });
      return moveAllStores(tx, { fromOwnerId: OW_OLD, toOwnerId: OW_NEW });
    });

    // 確定済み・停止中・未確定のすべてが移り、移した店舗 ID を返す
    expect([...moved].sort()).toEqual([...ownStores].sort());
    expect(await ownerIdsOf(ownStores)).toEqual({
      [ST_CONFIRMED]: OW_NEW,
      [ST_SUSPENDED]: OW_NEW,
      [ST_PENDING]: OW_NEW,
    });
    // 店舗の ID・名前・Place・停止状態などのほかの列は変わらない（Req 6.3）
    expect(await storesWithoutOwner(ownStores)).toEqual(storesBefore);
    // 日次データ・評価の時系列・配信記録・匿名集計は同じ店舗 ID を指したまま残る（Req 6.3）
    expect(await dependentRows(ownStores)).toEqual(dependentsBefore);
    // 旧オーナーは引継ぎ先だけが変わり、新しいオーナーの行は変わらない（Req 2.6）
    expect(await ownerRow(OW_OLD)).toEqual({ ...oldBefore, taken_over_by_owner_id: OW_NEW });
    expect(await ownerRow(OW_NEW)).toEqual(newBefore);
    // 別のオーナーの店舗は巻き込まない
    expect(
      await rowsAsJson('SELECT to_jsonb(s) AS row FROM stores s WHERE s.id = $1', [ST_BYSTANDER]),
    ).toEqual(bystanderStoreBefore);
  });

  it('連携中のオーナー・自分自身・存在しないオーナーからの付け替えは失敗し、ロールバックで何も残さない', async () => {
    const pool = await getPool();
    const storesBefore = await ownerIdsOf([ST_LINKED_FROM, ST_SELF]);
    const linkedBefore = await ownerRow(OW_LINKED_FROM);
    const selfBefore = await ownerRow(OW_SELF);

    await expect(
      inTransaction(pool, (tx) => moveAllStores(tx, { fromOwnerId: OW_LINKED_FROM, toOwnerId: OW_NEW })),
    ).rejects.toThrow(/ck_owner_taken_over/);
    await expect(
      inTransaction(pool, (tx) => moveAllStores(tx, { fromOwnerId: OW_SELF, toOwnerId: OW_SELF })),
    ).rejects.toThrow(/ck_owner_taken_over/);
    await expect(
      inTransaction(pool, (tx) => moveAllStores(tx, { fromOwnerId: MISSING, toOwnerId: OW_NEW })),
    ).rejects.toThrow(/not found/);

    expect(await ownerIdsOf([ST_LINKED_FROM, ST_SELF])).toEqual(storesBefore);
    expect(await ownerRow(OW_LINKED_FROM)).toEqual(linkedBefore);
    expect(await ownerRow(OW_SELF)).toEqual(selfBefore);
  });

  it('施錠は旧オーナーの行を押さえ、後着は先着の付け替えの後の所有者を読み直す（Req 6.6）', async () => {
    const pool = await getPool();
    const first = await pool.connect();
    const second = await pool.connect();
    let secondDone = false;
    try {
      await first.query('BEGIN');
      const firstHolder = await lockPlaceHolder(first, PLACE_RACE);
      expect(firstHolder).toEqual({ storeId: ST_RACE, ownerId: OW_RACE_OLD, agencyId: AG1, unlinked: true });

      const pid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      await second.query('BEGIN');
      const secondHolder = lockPlaceHolder(second, PLACE_RACE).then((h) => {
        secondDone = true;
        return h;
      });
      // 後着が旧オーナーの行のロック待ちに入ることを確かめてから、先着が付け替えて確定する
      await waitForLockWait(pid);
      expect(secondDone).toBe(false);
      await moveAllStores(first, { fromOwnerId: OW_RACE_OLD, toOwnerId: OW_RACE_NEW });
      await first.query('COMMIT');

      // 後着は施錠の後に読み直すので、引き継いだ連携中のオーナーを所有者として返す
      expect(await secondHolder).toEqual({
        storeId: ST_RACE,
        ownerId: OW_RACE_NEW,
        agencyId: AG1,
        unlinked: false,
      });
      await second.query('COMMIT');
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      await second.query('ROLLBACK').catch(() => undefined);
      first.release();
      second.release();
    }
    expect((await ownerRow(OW_RACE_OLD)).taken_over_by_owner_id).toBe(OW_RACE_NEW);
  });

  it('line_webhook のロールに与えた権限だけで、施錠と付け替えが通る', async () => {
    const pool = await getPool();
    const canCreate = await pool.query<{ ok: boolean }>(
      'SELECT rolcreaterole OR rolsuper AS ok FROM pg_roles WHERE rolname = current_user',
    );
    // 権限を確かめられない環境で緑にしない（skip ではなく赤にする）。
    expect(canCreate.rows[0]?.ok, '接続ユーザーに CREATEROLE がありません').toBe(true);
    for (const key of ROLE_KEYS) await pool.query(`CREATE ROLE "${roleName(key)}" NOLOGIN`);
    await pool.query(`GRANT "${roleName('line_webhook')}" TO CURRENT_USER`);
    const statements = grantStatements();
    expect(statements.length).toBeGreaterThan(5);
    for (const sql of statements) await pool.query(sql);

    const moved = await inTransaction(
      pool,
      async (tx) => {
        const holder = await lockPlaceHolder(tx, PLACE_ROLE);
        expect(holder).toEqual({ storeId: ST_ROLE, ownerId: OW_ROLE_OLD, agencyId: AG1, unlinked: true });
        return moveAllStores(tx, { fromOwnerId: OW_ROLE_OLD, toOwnerId: OW_ROLE_NEW });
      },
      roleName('line_webhook'),
    );

    expect(moved).toEqual([ST_ROLE]);
    expect(await ownerIdsOf([ST_ROLE])).toEqual({ [ST_ROLE]: OW_ROLE_NEW });
    expect((await ownerRow(OW_ROLE_OLD)).taken_over_by_owner_id).toBe(OW_ROLE_NEW);
  });
});
