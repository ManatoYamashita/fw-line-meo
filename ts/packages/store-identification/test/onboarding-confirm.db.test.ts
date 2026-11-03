import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '@fwlm/db';
import type { Queryable, StoreCandidate } from '@fwlm/db';
import { createStoreIdentificationService } from '../src/store-identification.js';
import type { ConnectablePool, TransactionClient } from '../src/store-identification.js';

// オンボーディング専用の確定（owner-line-unlink task 3.1・Req 6.1, 6.3–6.6）を実 postgres で検証する。
// 他ファイルと DB を共有するため、衝突しない専用 UUID プレフィックス（5b）と place_id を使う。
// DATABASE_URL 無しは skip。
const OP = '5b000000-0000-0000-0000-000000000001';
const AG1 = '5b000000-0000-0000-0000-000000000011';
const AG2 = '5b000000-0000-0000-0000-000000000012';

// 新規の確定・自分の重複
const OW_FRESH = '5b000000-0000-0000-0000-000000000021';
const OW_SELF = '5b000000-0000-0000-0000-000000000022';
// 引継ぎ（元は解除済み・先は同じ代理店の連携中）
const OW_OLD = '5b000000-0000-0000-0000-000000000023';
const OW_NEW = '5b000000-0000-0000-0000-000000000024';
// 拒否: 別の代理店の解除済み所有者・連携中の所有者
const OW_OTHER_AGENCY_OLD = '5b000000-0000-0000-0000-000000000025';
const OW_OTHER_AGENCY_NEW = '5b000000-0000-0000-0000-000000000026';
const OW_LINKED_HOLDER = '5b000000-0000-0000-0000-000000000027';
const OW_LINKED_NEW = '5b000000-0000-0000-0000-000000000028';
// 同時の確定（元は解除済み・先は 2 人）
const OW_RACE_OLD = '5b000000-0000-0000-0000-000000000029';
const OW_RACE_A = '5b000000-0000-0000-0000-00000000002a';
const OW_RACE_B = '5b000000-0000-0000-0000-00000000002b';
// 一意制約に当たった後のやり直し
const OW_RETRY_OLD = '5b000000-0000-0000-0000-00000000002c';
const OW_RETRY_NEW = '5b000000-0000-0000-0000-00000000002d';
// 途中の失敗でのロールバック
const OW_ATOMIC_OLD = '5b000000-0000-0000-0000-00000000002e';
const OW_ATOMIC_NEW = '5b000000-0000-0000-0000-00000000002f';
// 既存の確定（管理画面の店舗登録）の振る舞いの固定
const OW_LEGACY_OLD = '5b000000-0000-0000-0000-000000000030';
const OW_LEGACY_NEW = '5b000000-0000-0000-0000-000000000031';
const MISSING_OWNER = '5b000000-0000-0000-0000-0000000000ff';

const ST_SELF = '5b000000-0000-0000-0000-000000000041';
const ST_OLD_CONFIRMED = '5b000000-0000-0000-0000-000000000042';
const ST_OLD_SUSPENDED = '5b000000-0000-0000-0000-000000000043';
const ST_OLD_PENDING = '5b000000-0000-0000-0000-000000000044';
const ST_OTHER_AGENCY = '5b000000-0000-0000-0000-000000000045';
const ST_LINKED = '5b000000-0000-0000-0000-000000000046';
const ST_RACE = '5b000000-0000-0000-0000-000000000047';
const ST_RACE_SECOND = '5b000000-0000-0000-0000-000000000048';
const ST_RETRY = '5b000000-0000-0000-0000-000000000049';
const ST_ATOMIC = '5b000000-0000-0000-0000-00000000004a';
const ST_LEGACY = '5b000000-0000-0000-0000-00000000004b';

const PLACE_FRESH = 'ChIJ_onboarding_confirm_fresh';
const PLACE_SELF = 'ChIJ_onboarding_confirm_self';
const PLACE_OLD = 'ChIJ_onboarding_confirm_old';
const PLACE_OLD_SUSPENDED = 'ChIJ_onboarding_confirm_old_suspended';
const PLACE_OTHER_AGENCY = 'ChIJ_onboarding_confirm_other_agency';
const PLACE_LINKED = 'ChIJ_onboarding_confirm_linked';
const PLACE_RACE = 'ChIJ_onboarding_confirm_race';
const PLACE_RETRY = 'ChIJ_onboarding_confirm_retry';
const PLACE_ATOMIC = 'ChIJ_onboarding_confirm_atomic';
const PLACE_LEGACY = 'ChIJ_onboarding_confirm_legacy';

function candidate(placeId: string, name = 'オンボーディング確定店'): StoreCandidate {
  return {
    placeId,
    name,
    address: '東京都テスト区1-1-1',
    latitude: 35.6,
    longitude: 139.7,
    types: ['restaurant'],
  };
}

const noPlaces = { searchCandidates: async () => ({ kind: 'empty' as const }) };

/** 接続のたびにバックエンドの pid を記録するプール（並行の試験で、待ちに入った接続を特定する）。 */
function trackingPool(pool: ConnectablePool, pids: number[]): ConnectablePool {
  return {
    async connect() {
      const client = await pool.connect();
      const res = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      pids.push(res.rows[0]!.pid);
      return client;
    },
  };
}

/** 指定した文を含む問い合わせだけを失敗させるプール（トランザクションの途中の失敗を作る）。 */
function failingPool(pool: ConnectablePool, failOn: RegExp): ConnectablePool {
  return {
    async connect(): Promise<TransactionClient> {
      const client = await pool.connect();
      const query = ((...args: Parameters<Queryable['query']>) => {
        const [text] = args;
        if (typeof text === 'string' && failOn.test(text)) {
          return Promise.reject(new Error('injected failure'));
        }
        return (client.query as (...a: unknown[]) => unknown)(...args);
      }) as Queryable['query'];
      return { query, release: () => client.release() };
    },
  };
}

/** 指定した接続が行ロックの待ちに入るまで待つ。他の試験ファイルの待ちと取り違えないよう pid で絞る。 */
async function waitForLockWait(pid: number): Promise<void> {
  const pool = await getPool();
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

/** 記録された接続が count 個になるまで待つ。 */
async function waitForConnections(pids: number[], count: number): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    if (pids.length >= count) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`expected ${count} connections, got ${pids.length}`);
}

async function ownerIdsOf(ids: string[]): Promise<Record<string, string>> {
  const pool = await getPool();
  const res = await pool.query<{ id: string; owner_id: string }>(
    'SELECT id, owner_id FROM stores WHERE id = ANY($1::uuid[])',
    [ids],
  );
  return Object.fromEntries(res.rows.map((r) => [r.id, r.owner_id]));
}

async function ownerState(
  id: string,
): Promise<{ onboarding_status: string; taken_over_by_owner_id: string | null }> {
  const pool = await getPool();
  const res = await pool.query<{ onboarding_status: string; taken_over_by_owner_id: string | null }>(
    'SELECT onboarding_status, taken_over_by_owner_id FROM owners WHERE id = $1',
    [id],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`owner ${id} not found`);
  return row;
}

async function storeCountOfPlace(placeId: string): Promise<number> {
  const pool = await getPool();
  const res = await pool.query<{ n: string }>('SELECT count(*) AS n FROM stores WHERE place_id = $1', [
    placeId,
  ]);
  return Number(res.rows[0]!.n);
}

describe.skipIf(!process.env.DATABASE_URL)('confirmStoreForOnboarding (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, '確定引継ぎ運営']);
    await pool.query(
      'INSERT INTO agencies (id, operator_id, name) VALUES ($1, $3, $4), ($2, $3, $5)',
      [AG1, AG2, OP, '確定引継ぎ代理店1', '確定引継ぎ代理店2'],
    );
    // 連携中のオーナーを作ってから、元になるオーナーを解除済みへ移す（ck_owner_line_link を満たす形で書く）。
    const owners: Array<[string, string, string]> = [
      [OW_FRESH, AG1, 'pending'],
      [OW_SELF, AG1, 'active'],
      [OW_OLD, AG1, 'active'],
      [OW_NEW, AG1, 'pending'],
      [OW_OTHER_AGENCY_OLD, AG2, 'active'],
      [OW_OTHER_AGENCY_NEW, AG1, 'pending'],
      [OW_LINKED_HOLDER, AG1, 'active'],
      [OW_LINKED_NEW, AG1, 'pending'],
      [OW_RACE_OLD, AG1, 'active'],
      [OW_RACE_A, AG1, 'pending'],
      [OW_RACE_B, AG1, 'pending'],
      [OW_RETRY_OLD, AG1, 'active'],
      [OW_RETRY_NEW, AG1, 'pending'],
      [OW_ATOMIC_OLD, AG1, 'active'],
      [OW_ATOMIC_NEW, AG1, 'pending'],
      [OW_LEGACY_OLD, AG1, 'active'],
      [OW_LEGACY_NEW, AG1, 'pending'],
    ];
    for (const [id, agencyId, status] of owners) {
      await pool.query(
        `INSERT INTO owners (id, agency_id, line_user_id, onboarding_status) VALUES ($1, $2, $3, $4)`,
        [id, agencyId, `U-onboarding-confirm-${id}`, status],
      );
    }
    await pool.query(
      `UPDATE owners SET line_user_id = NULL, line_unlinked_at = now() WHERE id = ANY($1::uuid[])`,
      [[OW_OLD, OW_OTHER_AGENCY_OLD, OW_RACE_OLD, OW_RETRY_OLD, OW_ATOMIC_OLD, OW_LEGACY_OLD]],
    );
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_id, place_status, suspended_at)
       VALUES ($1, $2, '自分の店舗', $3, 'confirmed', NULL),
              ($4, $5, '引継ぎ元-確定', $6, 'confirmed', NULL),
              ($7, $5, '引継ぎ元-停止中', $8, 'confirmed', TIMESTAMPTZ '2026-10-01 09:00+09'),
              ($9, $5, '引継ぎ元-未確定', NULL, 'pending', NULL),
              ($10, $11, '別代理店の店舗', $12, 'confirmed', NULL),
              ($13, $14, '連携中の店舗', $15, 'confirmed', NULL),
              ($16, $17, '同時の店舗', $18, 'confirmed', NULL),
              ($19, $17, '同時の店舗-2', NULL, 'pending', NULL),
              ($20, $21, '途中失敗の店舗', $22, 'confirmed', NULL),
              ($23, $24, '既存確定の店舗', $25, 'confirmed', NULL)`,
      [
        ST_SELF,
        OW_SELF,
        PLACE_SELF,
        ST_OLD_CONFIRMED,
        OW_OLD,
        PLACE_OLD,
        ST_OLD_SUSPENDED,
        PLACE_OLD_SUSPENDED,
        ST_OLD_PENDING,
        ST_OTHER_AGENCY,
        OW_OTHER_AGENCY_OLD,
        PLACE_OTHER_AGENCY,
        ST_LINKED,
        OW_LINKED_HOLDER,
        PLACE_LINKED,
        ST_RACE,
        OW_RACE_OLD,
        PLACE_RACE,
        ST_RACE_SECOND,
        ST_ATOMIC,
        OW_ATOMIC_OLD,
        PLACE_ATOMIC,
        ST_LEGACY,
        OW_LEGACY_OLD,
        PLACE_LEGACY,
      ],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it('Place の店舗が無ければ新規に確定し、オーナーを店舗特定済みにする', async () => {
    const pool = await getPool();
    const service = createStoreIdentificationService({ pool, places: noPlaces });

    const result = await service.confirmStoreForOnboarding(OW_FRESH, candidate(PLACE_FRESH, '新規の店舗'));

    expect(result.kind).toBe('confirmed');
    if (result.kind !== 'confirmed') throw new Error('unreachable');
    const res = await pool.query<{ id: string; owner_id: string; place_status: string; name: string }>(
      'SELECT id, owner_id, place_status, name FROM stores WHERE place_id = $1',
      [PLACE_FRESH],
    );
    expect(res.rows).toEqual([
      { id: result.storeId, owner_id: OW_FRESH, place_status: 'confirmed', name: '新規の店舗' },
    ]);
    expect((await ownerState(OW_FRESH)).onboarding_status).toBe('store_identified');
  });

  it('Place の店舗の所有者が自分なら、何も変えずに成功を返す（連打・再送）', async () => {
    const pool = await getPool();
    const service = createStoreIdentificationService({ pool, places: noPlaces });

    const result = await service.confirmStoreForOnboarding(OW_SELF, candidate(PLACE_SELF));

    expect(result).toEqual({ kind: 'confirmed', storeId: ST_SELF });
    expect(await storeCountOfPlace(PLACE_SELF)).toBe(1);
    // 完了済みの段階を店舗特定済みへ戻さない
    expect((await ownerState(OW_SELF)).onboarding_status).toBe('active');
  });

  it('所有者が解除済みで代理店が同じなら、全店舗を引き継ぎ店舗特定済みにする（Req 6.1, 6.3）', async () => {
    const pool = await getPool();
    const service = createStoreIdentificationService({ pool, places: noPlaces });
    const ownStores = [ST_OLD_CONFIRMED, ST_OLD_SUSPENDED, ST_OLD_PENDING];
    const before = await pool.query(
      `SELECT to_jsonb(s) - 'owner_id' AS row FROM stores s WHERE s.id = ANY($1::uuid[]) ORDER BY s.id`,
      [ownStores],
    );

    // 停止中の店舗の Place を確定しても、全店舗を引き継ぐ
    const result = await service.confirmStoreForOnboarding(OW_NEW, candidate(PLACE_OLD_SUSPENDED));

    expect(result.kind).toBe('taken_over');
    if (result.kind !== 'taken_over') throw new Error('unreachable');
    expect(result.storeId).toBe(ST_OLD_SUSPENDED);
    expect(result.previousOwnerId).toBe(OW_OLD);
    expect([...result.movedStoreIds].sort()).toEqual([...ownStores].sort());
    expect(await ownerIdsOf(ownStores)).toEqual({
      [ST_OLD_CONFIRMED]: OW_NEW,
      [ST_OLD_SUSPENDED]: OW_NEW,
      [ST_OLD_PENDING]: OW_NEW,
    });
    // 店舗の身元・停止状態などのほかの列は変わらず、新しい店舗も作らない（Req 6.3）
    const after = await pool.query(
      `SELECT to_jsonb(s) - 'owner_id' AS row FROM stores s WHERE s.id = ANY($1::uuid[]) ORDER BY s.id`,
      [ownStores],
    );
    expect(after.rows).toEqual(before.rows);
    expect(await storeCountOfPlace(PLACE_OLD_SUSPENDED)).toBe(1);
    expect(await ownerState(OW_NEW)).toEqual({
      onboarding_status: 'store_identified',
      taken_over_by_owner_id: null,
    });
    expect((await ownerState(OW_OLD)).taken_over_by_owner_id).toBe(OW_NEW);
  });

  it('所有者が解除済みでも代理店が違えば、登録済みとして拒否し何も変えない（Req 6.4）', async () => {
    const pool = await getPool();
    const service = createStoreIdentificationService({ pool, places: noPlaces });

    const result = await service.confirmStoreForOnboarding(
      OW_OTHER_AGENCY_NEW,
      candidate(PLACE_OTHER_AGENCY),
    );

    expect(result).toEqual({ kind: 'place_already_registered' });
    expect(await ownerIdsOf([ST_OTHER_AGENCY])).toEqual({ [ST_OTHER_AGENCY]: OW_OTHER_AGENCY_OLD });
    expect(await ownerState(OW_OTHER_AGENCY_OLD)).toEqual({
      onboarding_status: 'active',
      taken_over_by_owner_id: null,
    });
    expect((await ownerState(OW_OTHER_AGENCY_NEW)).onboarding_status).toBe('pending');
  });

  it('所有者が連携中なら、同じ代理店でも登録済みとして拒否し何も変えない（Req 6.5）', async () => {
    const pool = await getPool();
    const service = createStoreIdentificationService({ pool, places: noPlaces });

    const result = await service.confirmStoreForOnboarding(OW_LINKED_NEW, candidate(PLACE_LINKED));

    expect(result).toEqual({ kind: 'place_already_registered' });
    expect(await ownerIdsOf([ST_LINKED])).toEqual({ [ST_LINKED]: OW_LINKED_HOLDER });
    expect((await ownerState(OW_LINKED_NEW)).onboarding_status).toBe('pending');
  });

  it('同じ解除済みオーナーの店舗を 2 つの接続が同時に確定すると、片方だけが引き継ぎ、もう片方は登録済み（Req 6.6）', async () => {
    const pool = await getPool();
    const pids: number[] = [];
    const service = createStoreIdentificationService({
      pool: trackingPool(pool, pids),
      places: noPlaces,
    });

    // 旧オーナーの行を先に押さえ、2 つの確定を同じ行のロック待ちに並ばせてから放す
    const gate = await pool.connect();
    let results: Awaited<ReturnType<typeof service.confirmStoreForOnboarding>>[];
    try {
      await gate.query('BEGIN');
      await gate.query('SELECT 1 FROM owners WHERE id = $1 FOR UPDATE', [OW_RACE_OLD]);
      const a = service.confirmStoreForOnboarding(OW_RACE_A, candidate(PLACE_RACE));
      const b = service.confirmStoreForOnboarding(OW_RACE_B, candidate(PLACE_RACE));
      await waitForConnections(pids, 2);
      for (const pid of pids) await waitForLockWait(pid);
      await gate.query('COMMIT');
      results = await Promise.all([a, b]);
    } finally {
      await gate.query('ROLLBACK').catch(() => undefined);
      gate.release();
    }

    const takenOver = results.filter((r) => r.kind === 'taken_over');
    const rejected = results.filter((r) => r.kind === 'place_already_registered');
    expect(takenOver).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const winner = results[0]!.kind === 'taken_over' ? OW_RACE_A : OW_RACE_B;
    const loser = winner === OW_RACE_A ? OW_RACE_B : OW_RACE_A;
    const won = takenOver[0]!;
    if (won.kind !== 'taken_over') throw new Error('unreachable');
    expect(won.previousOwnerId).toBe(OW_RACE_OLD);
    expect([...won.movedStoreIds].sort()).toEqual([ST_RACE, ST_RACE_SECOND].sort());
    // 全店舗が勝者へ移り、負けた側は何も得ず段階も変わらない
    expect(await ownerIdsOf([ST_RACE, ST_RACE_SECOND])).toEqual({
      [ST_RACE]: winner,
      [ST_RACE_SECOND]: winner,
    });
    expect((await ownerState(OW_RACE_OLD)).taken_over_by_owner_id).toBe(winner);
    expect((await ownerState(winner)).onboarding_status).toBe('store_identified');
    expect((await ownerState(loser)).onboarding_status).toBe('pending');
  });

  it('新規の確定が並行の挿入の一意制約に当たったら、1 回だけやり直して改めて判断する', async () => {
    const pool = await getPool();
    const pids: number[] = [];
    const service = createStoreIdentificationService({
      pool: trackingPool(pool, pids),
      places: noPlaces,
    });

    // 並行の確定が同じ Place の店舗を挿入し、まだ確定していない状態を作る。
    // 確定の側は店舗を見つけられず新規に挿入し、一意性の判定でこの挿入の確定を待つ。
    const concurrent = await pool.connect();
    let result: Awaited<ReturnType<typeof service.confirmStoreForOnboarding>>;
    try {
      await concurrent.query('BEGIN');
      await concurrent.query(
        `INSERT INTO stores (id, owner_id, name, place_id, place_status)
         VALUES ($1, $2, '並行で挿入された店舗', $3, 'confirmed')`,
        [ST_RETRY, OW_RETRY_OLD, PLACE_RETRY],
      );
      const pending = service.confirmStoreForOnboarding(OW_RETRY_NEW, candidate(PLACE_RETRY));
      await waitForConnections(pids, 1);
      await waitForLockWait(pids[0]!);
      await concurrent.query('COMMIT');
      result = await pending;
    } finally {
      await concurrent.query('ROLLBACK').catch(() => undefined);
      concurrent.release();
    }

    // やり直しで、並行で挿入された店舗の所有者（解除済み・同じ代理店）から引き継ぐ
    expect(result).toEqual({
      kind: 'taken_over',
      storeId: ST_RETRY,
      previousOwnerId: OW_RETRY_OLD,
      movedStoreIds: [ST_RETRY],
    });
    expect(await storeCountOfPlace(PLACE_RETRY)).toBe(1);
    expect((await ownerState(OW_RETRY_NEW)).onboarding_status).toBe('store_identified');
  });

  it('確定・付け替え・状態遷移は 1 トランザクションで、途中で失敗すれば付け替えも残らない（Req 6.1）', async () => {
    const pool = await getPool();
    const service = createStoreIdentificationService({
      pool: failingPool(pool, /onboarding_status\s*=\s*'store_identified'/),
      places: noPlaces,
    });

    await expect(
      service.confirmStoreForOnboarding(OW_ATOMIC_NEW, candidate(PLACE_ATOMIC)),
    ).rejects.toThrow(/injected failure/);

    expect(await ownerIdsOf([ST_ATOMIC])).toEqual({ [ST_ATOMIC]: OW_ATOMIC_OLD });
    expect(await ownerState(OW_ATOMIC_OLD)).toEqual({
      onboarding_status: 'active',
      taken_over_by_owner_id: null,
    });
    expect((await ownerState(OW_ATOMIC_NEW)).onboarding_status).toBe('pending');
  });

  it('確定するオーナーが存在しなければ例外を投げ、店舗を作らない', async () => {
    const pool = await getPool();
    const service = createStoreIdentificationService({ pool, places: noPlaces });

    await expect(
      service.confirmStoreForOnboarding(MISSING_OWNER, candidate('ChIJ_onboarding_confirm_missing')),
    ).rejects.toThrow();
    expect(await storeCountOfPlace('ChIJ_onboarding_confirm_missing')).toBe(0);
  });

  it('既存の確定（管理画面の店舗登録）は、解除済みオーナーの Place に対して登録済みを返し続け、引き継がない', async () => {
    const pool = await getPool();
    const service = createStoreIdentificationService({ pool, places: noPlaces });

    const result = await service.confirmStore(OW_LEGACY_NEW, candidate(PLACE_LEGACY));

    expect(result).toEqual({ kind: 'place_already_registered' });
    expect(await ownerIdsOf([ST_LEGACY])).toEqual({ [ST_LEGACY]: OW_LEGACY_OLD });
    expect((await ownerState(OW_LEGACY_OLD)).taken_over_by_owner_id).toBeNull();
    expect((await ownerState(OW_LEGACY_NEW)).onboarding_status).toBe('pending');
  });
});
