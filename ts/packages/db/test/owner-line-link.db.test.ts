import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../src/pool.js';
import type { TransactionCapable, TransactionClient } from '../src/pool.js';
import { clearOwnerMenuPending, unlinkOwnerLine } from '../src/owner-line-link.js';
import { createOwner } from '../src/owners.js';
import { incrementTallies } from '../src/tallies.js';

// 他ファイルと DB を共有するため、衝突しない専用 UUID プレフィックス（b7）と line_user_id を使う。
const OP = 'b7000000-0000-0000-0000-000000000001';
const AG1 = 'b7000000-0000-0000-0000-000000000011';
const AG2 = 'b7000000-0000-0000-0000-000000000012';
// 運営による解除と、店舗・集計・会話の行への影響を見るオーナー（AG1）
const OW_OP = 'b7000000-0000-0000-0000-000000000021';
// 代理店の範囲で解除するオーナー（AG1）
const OW_AG = 'b7000000-0000-0000-0000-000000000022';
// 範囲外を見るオーナー（AG2）
const OW_OTHER = 'b7000000-0000-0000-0000-000000000023';
// 二重の解除とメニュー未解除の印の消去を見るオーナー（AG1）
const OW_TWICE = 'b7000000-0000-0000-0000-000000000024';
// 元の ID を別の連携中オーナーが持つ場合を見るオーナー（AG1）
const OW_REUSED = 'b7000000-0000-0000-0000-000000000025';
// 途中の失敗で解除前のまま残ることを見るオーナー（AG1）
const OW_FAIL = 'b7000000-0000-0000-0000-000000000026';
// 同時の解除を見るオーナー（AG1）
const OW_RACE = 'b7000000-0000-0000-0000-000000000027';
// 運営の解除を受けるオーナーの店舗（確定済み・停止中・未確定）
const ST_CONFIRMED = 'b7000000-0000-0000-0000-000000000031';
const ST_SUSPENDED = 'b7000000-0000-0000-0000-000000000032';
const ST_PENDING = 'b7000000-0000-0000-0000-000000000033';
const MISSING = 'b7000000-0000-0000-0000-0000000000ff';

const LINE_OP = 'U-owner-line-link-op';
const LINE_AG = 'U-owner-line-link-ag';
const LINE_OTHER = 'U-owner-line-link-other';
const LINE_TWICE = 'U-owner-line-link-twice';
const LINE_REUSED = 'U-owner-line-link-reused';
const LINE_FAIL = 'U-owner-line-link-fail';
const LINE_RACE = 'U-owner-line-link-race';
// 当該オーナーに紐づくが、元の ID とは別のキーを持つ会話の行
const LINE_STRAY = 'U-owner-line-link-stray';
// 解除と無関係な利用者の会話の行（消えてはならない）
const LINE_BYSTANDER = 'U-owner-line-link-bystander';

const TALLY_TABLES = [
  'survey_rating_tallies',
  'survey_aspect_tallies',
  'survey_concern_tallies',
  'survey_material_tallies',
] as const;

/** 列が増えても比較から漏れないよう、行を to_jsonb で丸ごと読む。 */
async function rowsAsJson(sql: string, params: unknown[]): Promise<unknown[]> {
  const pool = await getPool();
  const res = await pool.query<{ row: unknown }>(sql, params);
  return res.rows.map((r) => r.row);
}

/** オーナーの行を丸ごと読む。 */
async function ownerRow(id: string): Promise<Record<string, unknown>> {
  const rows = await rowsAsJson('SELECT to_jsonb(o) AS row FROM owners o WHERE o.id = $1', [id]);
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error(`owner ${id} not found`);
  return row;
}

/** 解除で変わる 3 列を除いたオーナーの行（代理店・表示名・オンボーディングの状態などが残ることを見る）。 */
async function ownerRowWithoutLink(id: string): Promise<Record<string, unknown>> {
  const rows = await rowsAsJson(
    `SELECT to_jsonb(o) - 'line_user_id' - 'line_unlinked_at' - 'menu_pending_line_user_id' AS row
       FROM owners o WHERE o.id = $1`,
    [id],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error(`owner ${id} not found`);
  return row;
}

async function linkColumnsOf(id: string): Promise<{
  line_user_id: string | null;
  line_unlinked_at: Date | null;
  menu_pending_line_user_id: string | null;
}> {
  const pool = await getPool();
  const res = await pool.query<{
    line_user_id: string | null;
    line_unlinked_at: Date | null;
    menu_pending_line_user_id: string | null;
  }>(
    'SELECT line_user_id, line_unlinked_at, menu_pending_line_user_id FROM owners WHERE id = $1',
    [id],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`owner ${id} not found`);
  return row;
}

/** オーナーの店舗と、店舗に連なる蓄積（日次サマリー・配信記録・匿名集計）と監査記録をまとめて読む。 */
async function ownerFootprint(ownerId: string): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  out.stores = await rowsAsJson(
    'SELECT to_jsonb(s) AS row FROM stores s WHERE s.owner_id = $1 ORDER BY s.id',
    [ownerId],
  );
  out.daily_summaries = await rowsAsJson(
    `SELECT to_jsonb(d) AS row FROM daily_summaries d
       JOIN stores s ON s.id = d.store_id WHERE s.owner_id = $1 ORDER BY d.id`,
    [ownerId],
  );
  out.summary_deliveries = await rowsAsJson(
    `SELECT to_jsonb(d) AS row FROM summary_deliveries d
       JOIN stores s ON s.id = d.store_id WHERE s.owner_id = $1 ORDER BY d.id`,
    [ownerId],
  );
  for (const table of TALLY_TABLES) {
    out[table] = await rowsAsJson(
      `SELECT to_jsonb(t) AS row FROM ${table} t
         JOIN stores s ON s.id = t.store_id WHERE s.owner_id = $1 ORDER BY to_jsonb(t)::text`,
      [ownerId],
    );
  }
  out.audit_logs = await rowsAsJson(
    `SELECT to_jsonb(a) AS row FROM audit_logs a
      WHERE a.target_id = $1 OR a.actor_id = $1
         OR a.target_id IN (SELECT id FROM stores WHERE owner_id = $1)
      ORDER BY a.id`,
    [ownerId],
  );
  return out;
}

async function sessionKeys(lineUserIds: string[]): Promise<string[]> {
  const pool = await getPool();
  const res = await pool.query<{ line_user_id: string }>(
    'SELECT line_user_id FROM onboarding_sessions WHERE line_user_id = ANY($1::text[]) ORDER BY 1',
    [lineUserIds],
  );
  return res.rows.map((r) => r.line_user_id);
}

/**
 * 指定した SQL を受けた時点で失敗する接続を返すプール。トランザクションの途中で失敗させ、
 * 解除前のまま残ることを確かめるために使う。release の回数も数える。
 */
function failingPool(
  base: TransactionCapable,
  failWhen: (sql: string) => boolean,
): { pool: TransactionCapable; released: () => number; failed: () => number } {
  let released = 0;
  let failed = 0;
  const pool: TransactionCapable = {
    async connect(): Promise<TransactionClient> {
      const client = await base.connect();
      const wrapped: TransactionClient = {
        query: (async (...args: unknown[]) => {
          const sql = typeof args[0] === 'string' ? args[0] : '';
          if (failWhen(sql)) {
            failed += 1;
            throw new Error('injected failure');
          }
          return (client.query as (...a: unknown[]) => unknown)(...args);
        }) as TransactionClient['query'],
        release: () => {
          released += 1;
          client.release();
        },
      };
      return wrapped;
    },
  };
  return { pool, released: () => released, failed: () => failed };
}

/**
 * 指定した SQL の結果を返した直後で、最初の 1 回だけ止まる接続を返すプール。open() を呼ぶまで
 * そのトランザクションは先へ進まない。同時の解除を確実に重ねるために使う。
 */
function gatedPool(
  base: TransactionCapable,
  pauseAfter: (sql: string) => boolean,
): { pool: TransactionCapable; reached: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let markReached: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  let paused = false;
  const pool: TransactionCapable = {
    async connect(): Promise<TransactionClient> {
      const client = await base.connect();
      return {
        query: (async (...args: unknown[]) => {
          const sql = typeof args[0] === 'string' ? args[0] : '';
          const result = await (client.query as (...a: unknown[]) => Promise<unknown>)(...args);
          if (!paused && pauseAfter(sql)) {
            paused = true;
            markReached();
            await gate;
          }
          return result;
        }) as TransactionClient['query'],
        release: () => client.release(),
      };
    },
  };
  return { pool, reached, open: () => open() };
}

/** owners の行ロック待ちに入った接続が count 件になるまで待つ。 */
async function waitForOwnerLockWaiters(count: number): Promise<void> {
  const pool = await getPool();
  // 試験の時間制限（5 秒）より先に、待ちに入らなかったことを明示の失敗として返す。
  for (let i = 0; i < 80; i += 1) {
    const res = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%owners%'`,
    );
    if ((res.rows[0]?.n ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`lock waiters did not reach ${count}`);
}

describe.skipIf(!process.env.DATABASE_URL)('owner-line-link DAL (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, '解除運営']);
    await pool.query(
      'INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3), ($4, $2, $5)',
      [AG1, OP, '解除代理店1', AG2, '解除代理店2'],
    );
    await pool.query(
      `INSERT INTO owners (id, agency_id, line_user_id, display_name, onboarding_status)
       VALUES ($1, $8, $9, '運営で解除', 'active'),
              ($2, $8, $10, '代理店で解除', 'active'),
              ($3, $15, $11, '他代理店', 'active'),
              ($4, $8, $12, '二重の解除', 'active'),
              ($5, $8, $13, '再登録される', 'store_identified'),
              ($6, $8, $14, '途中で失敗', 'active'),
              ($7, $8, $16, '同時の解除', 'active')`,
      [
        OW_OP,
        OW_AG,
        OW_OTHER,
        OW_TWICE,
        OW_REUSED,
        OW_FAIL,
        OW_RACE,
        AG1,
        LINE_OP,
        LINE_AG,
        LINE_OTHER,
        LINE_TWICE,
        LINE_REUSED,
        LINE_FAIL,
        AG2,
        LINE_RACE,
      ],
    );
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, latitude, longitude, place_id, place_status, suspended_at)
       VALUES ($1, $4, '解除店舗-確定', 35.1, 139.1, 'ChIJ_owner_line_link_confirmed', 'confirmed', NULL),
              ($2, $4, '解除店舗-停止中', NULL, NULL, 'ChIJ_owner_line_link_suspended', 'confirmed', now()),
              ($3, $4, '解除店舗-未確定', NULL, NULL, NULL, 'pending', NULL)`,
      [ST_CONFIRMED, ST_SUSPENDED, ST_PENDING, OW_OP],
    );
    // 蓄積が解除で消えも変わりもしないことを見るため、集計 4 表・日次サマリー・配信記録・監査記録に行を作る。
    await incrementTallies(pool, {
      storeId: ST_CONFIRMED,
      star: 5,
      aspectCodes: ['taste'],
      concernCodes: ['service'],
      hasComment: true,
    });
    await pool.query(
      `INSERT INTO daily_summaries (store_id, summary_date, status, rank, rank_total, rating, review_count)
       VALUES ($1, DATE '2026-07-12', 'ready', 1, 6, 4.5, 120)`,
      [ST_CONFIRMED],
    );
    await pool.query(
      `INSERT INTO summary_deliveries (store_id, summary_date, line_user_id, status, retry_key, delivered_at)
       VALUES ($1, DATE '2026-07-12', $2, 'delivered', gen_random_uuid(), now())`,
      [ST_CONFIRMED, LINE_OP],
    );
    await pool.query(
      `INSERT INTO audit_logs (actor_type, actor_id, action, target_type, target_id)
       VALUES ('owner', $1, 'onboarding_completed', 'store', $2)`,
      [OW_OP, ST_CONFIRMED],
    );
    // 会話の行: 元の ID の行・当該オーナーに紐づく別キーの行・無関係な利用者の行
    await pool.query(
      `INSERT INTO onboarding_sessions (line_user_id, stage, owner_id)
       VALUES ($1, 'completed', $2),
              ($3, 'await_store_name', $2),
              ($4, 'await_invite_code', NULL),
              ($5, 'completed', $6)`,
      [LINE_OP, OW_OP, LINE_STRAY, LINE_BYSTANDER, LINE_FAIL, OW_FAIL],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it('運営は任意のオーナーを解除でき、元の ID が未解除の印とメニューの対象になる（Req 1.1, 3.3）', async () => {
    const pool = await getPool();
    const ownerBefore = await ownerRowWithoutLink(OW_OP);
    const footprintBefore = await ownerFootprint(OW_OP);
    // 空の比較で空振りしないよう、比べる表のすべてに行があることを先に確かめる
    for (const [table, rows] of Object.entries(footprintBefore)) {
      expect(rows.length, table).toBeGreaterThan(0);
    }
    expect(footprintBefore.stores).toHaveLength(3);

    const outcome = await unlinkOwnerLine(pool, { ownerId: OW_OP, agencyId: null });

    expect(outcome).toEqual({ kind: 'changed', ownerId: OW_OP, menuTarget: LINE_OP });
    const link = await linkColumnsOf(OW_OP);
    expect(link.line_user_id).toBeNull();
    expect(link.line_unlinked_at).toBeInstanceOf(Date);
    expect(link.menu_pending_line_user_id).toBe(LINE_OP);
    // 解除の 3 列以外（代理店・表示名・オンボーディングの状態・引継ぎ先）は変わらない（Req 1.6）
    expect(await ownerRowWithoutLink(OW_OP)).toEqual(ownerBefore);
    // 店舗・停止状態・日次データ・配信記録・匿名集計・監査記録は変わらない（Req 1.6, 5.5）
    expect(await ownerFootprint(OW_OP)).toEqual(footprintBefore);
    const stores = await pool.query<{ id: string; place_status: string; suspended: boolean }>(
      `SELECT id, place_status, suspended_at IS NOT NULL AS suspended
         FROM stores WHERE owner_id = $1 ORDER BY id`,
      [OW_OP],
    );
    expect(stores.rows).toEqual([
      { id: ST_CONFIRMED, place_status: 'confirmed', suspended: false },
      { id: ST_SUSPENDED, place_status: 'confirmed', suspended: true },
      { id: ST_PENDING, place_status: 'pending', suspended: false },
    ]);
  });

  it('元の ID の会話の行と当該オーナーに紐づく会話の行を消し、無関係な行は残す（Req 4.2）', async () => {
    // OW_OP の解除（最初の試験）で、元の ID の行と別キーの行が消えている
    expect(await sessionKeys([LINE_OP, LINE_STRAY, LINE_BYSTANDER])).toEqual([LINE_BYSTANDER]);
  });

  it('代理店の利用者は自代理店のオーナーを解除できる（Req 1.2）', async () => {
    const pool = await getPool();
    const outcome = await unlinkOwnerLine(pool, { ownerId: OW_AG, agencyId: AG1 });
    expect(outcome).toEqual({ kind: 'changed', ownerId: OW_AG, menuTarget: LINE_AG });
    expect((await linkColumnsOf(OW_AG)).line_user_id).toBeNull();
  });

  it('範囲外と不存在は同じ not_found になり、状態を変えない（Req 1.3）', async () => {
    const pool = await getPool();
    const before = await ownerRow(OW_OTHER);

    const outOfScope = await unlinkOwnerLine(pool, { ownerId: OW_OTHER, agencyId: AG1 });
    const missingAsAgency = await unlinkOwnerLine(pool, { ownerId: MISSING, agencyId: AG1 });
    const missingAsOperator = await unlinkOwnerLine(pool, { ownerId: MISSING, agencyId: null });

    expect(outOfScope).toEqual({ kind: 'not_found' });
    expect(missingAsAgency).toEqual(outOfScope);
    expect(missingAsOperator).toEqual(outOfScope);
    expect(await ownerRow(OW_OTHER)).toEqual(before);
    expect(await linkColumnsOf(OW_OTHER)).toMatchObject({ line_user_id: LINE_OTHER });
  });

  it('既に解除済みなら状態を変えず unchanged を返し、未解除の印が残っていればそれを対象に返す（Req 1.5, 3.3）', async () => {
    const pool = await getPool();
    const first = await unlinkOwnerLine(pool, { ownerId: OW_TWICE, agencyId: null });
    expect(first).toEqual({ kind: 'changed', ownerId: OW_TWICE, menuTarget: LINE_TWICE });
    const afterFirst = await ownerRow(OW_TWICE);

    const second = await unlinkOwnerLine(pool, { ownerId: OW_TWICE, agencyId: AG1 });

    expect(second).toEqual({ kind: 'unchanged', ownerId: OW_TWICE, menuTarget: LINE_TWICE });
    // 解除時刻を含めて行は変わらない
    expect(await ownerRow(OW_TWICE)).toEqual(afterFirst);

    // メニューを外せた後の解除は、対象を返さない
    await clearOwnerMenuPending(pool, { ownerId: OW_TWICE, lineUserId: LINE_TWICE });
    const third = await unlinkOwnerLine(pool, { ownerId: OW_TWICE, agencyId: null });
    expect(third).toEqual({ kind: 'unchanged', ownerId: OW_TWICE, menuTarget: null });
  });

  it('元の ID を別の連携中オーナーが持つときは、対象を返さず未解除の印を消す', async () => {
    const pool = await getPool();
    const first = await unlinkOwnerLine(pool, { ownerId: OW_REUSED, agencyId: null });
    expect(first).toEqual({ kind: 'changed', ownerId: OW_REUSED, menuTarget: LINE_REUSED });
    // 同じ LINE アカウントが招待コードから再登録し、新しいオーナーとして連携中になる
    const reRegistered = await createOwner(pool, { agencyId: AG1, lineUserId: LINE_REUSED });
    const holderBefore = await ownerRow(reRegistered.id);

    const second = await unlinkOwnerLine(pool, { ownerId: OW_REUSED, agencyId: null });

    expect(second).toEqual({ kind: 'unchanged', ownerId: OW_REUSED, menuTarget: null });
    const link = await linkColumnsOf(OW_REUSED);
    expect(link.menu_pending_line_user_id).toBeNull();
    expect(link.line_user_id).toBeNull();
    expect(link.line_unlinked_at).toBeInstanceOf(Date);
    // 新しいオーナーの連携には触れない
    expect(await ownerRow(reRegistered.id)).toEqual(holderBefore);
  });

  it('clearOwnerMenuPending は印が指定の ID と一致するときだけ消す', async () => {
    const pool = await getPool();
    // OW_AG は「解除済み・メニュー未解除」（印 = LINE_AG）
    await clearOwnerMenuPending(pool, { ownerId: OW_AG, lineUserId: 'U-owner-line-link-mismatch' });
    expect((await linkColumnsOf(OW_AG)).menu_pending_line_user_id).toBe(LINE_AG);

    await clearOwnerMenuPending(pool, { ownerId: OW_OTHER, lineUserId: LINE_OTHER });
    // 連携中のオーナーは印を持たず、LINE ユーザー ID にも触れない
    expect(await linkColumnsOf(OW_OTHER)).toEqual({
      line_user_id: LINE_OTHER,
      line_unlinked_at: null,
      menu_pending_line_user_id: null,
    });

    await clearOwnerMenuPending(pool, { ownerId: OW_AG, lineUserId: LINE_AG });
    expect((await linkColumnsOf(OW_AG)).menu_pending_line_user_id).toBeNull();
  });

  it('トランザクションの途中で失敗すると、解除前の状態のまま残り接続を返す（Req 1.7）', async () => {
    const base = await getPool();
    const ownerBefore = await ownerRow(OW_FAIL);
    const { pool, released, failed } = failingPool(base, (sql) =>
      /DELETE\s+FROM\s+onboarding_sessions/i.test(sql),
    );

    await expect(unlinkOwnerLine(pool, { ownerId: OW_FAIL, agencyId: null })).rejects.toThrow(
      'injected failure',
    );

    // 失敗は会話の行の削除（owners を更新した後）で起きている
    expect(failed()).toBe(1);
    expect(released()).toBe(1);
    expect(await ownerRow(OW_FAIL)).toEqual(ownerBefore);
    expect(await sessionKeys([LINE_FAIL])).toEqual([LINE_FAIL]);
  });

  it('同じオーナーへの同時の解除は直列化され、後着は unchanged になる', async () => {
    const base = await getPool();
    // 先着は対象の行を読んだ直後で止める。後着はその行のロック待ちに入る。
    const gated = gatedPool(base, (sql) =>
      sql.includes('SELECT id, line_user_id, menu_pending_line_user_id'),
    );
    const first = unlinkOwnerLine(gated.pool, { ownerId: OW_RACE, agencyId: null });
    await gated.reached;
    const second = unlinkOwnerLine(base, { ownerId: OW_RACE, agencyId: AG1 });
    try {
      // 後着が対象の行のロック待ちに入ることを確かめてから先着を進める
      await waitForOwnerLockWaiters(1);
    } finally {
      // 失敗しても先着のトランザクションを閉じさせ、接続を残さない
      gated.open();
      await Promise.allSettled([first, second]);
    }

    // 後着は先着が確定した状態を読み直すので、解除し直さず、先着が残した印を対象として返す
    expect(await first).toEqual({ kind: 'changed', ownerId: OW_RACE, menuTarget: LINE_RACE });
    expect(await second).toEqual({ kind: 'unchanged', ownerId: OW_RACE, menuTarget: LINE_RACE });
  });
});
