import { afterAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/pool.js';
import { AUDIT_LOG_ACTIONS, createAuditLog, type AuditLogAction } from '../src/audit-logs.js';

const ACTOR = 'e7777777-7777-7777-7777-777777777777';
const TARGET = 'e8888888-8888-8888-8888-888888888888';

/**
 * `pg_get_constraintdef` が返す action の CHECK の定義から、許可されている値を並び順のまま取り出す。
 *
 * PostgreSQL は `action IN ('a', 'b')` を `CHECK ((action = ANY (ARRAY['a'::text, 'b'::text])))`
 * の形へ正規化して返す。この形に完全一致しない定義（別の列・OR で繋いだ形・引用符を含む値）は、
 * 取り出せた分だけを返さずに例外にする。一部だけを取り出して返すと、集合一致の検査が
 * 「取り出せなかった値」を見落とすからである。
 */
function extractCheckedActions(definition: string): string[] {
  const body = /^CHECK \(\(action = ANY \(ARRAY\[(.+)\]\)\)\)$/.exec(definition)?.[1];
  if (body === undefined) {
    throw new Error(`action の CHECK の形を解釈できません: ${definition}`);
  }
  return body.split(', ').map((element) => {
    const value = /^'([a-z0-9_]+)'::text$/.exec(element)?.[1];
    if (value === undefined) {
      throw new Error(`action の CHECK の値を解釈できません: ${element}`);
    }
    return value;
  });
}

describe('extractCheckedActions（CHECK 定義の抽出器の自己検証）', () => {
  it('正規化された IN の形から、値を並び順のまま取り出す', () => {
    expect(
      extractCheckedActions(
        "CHECK ((action = ANY (ARRAY['owner_created'::text, 'dashboard_user_display_name_updated'::text])))",
      ),
    ).toEqual(['owner_created', 'dashboard_user_display_name_updated']);
  });

  it('想定と異なる形は、取り出せた分だけを返さずに例外にする', () => {
    // 別の列に掛かる CHECK
    expect(() => extractCheckedActions("CHECK ((target = ANY (ARRAY['a'::text])))")).toThrow();
    // OR で繋いだ形（IN 以外で書かれた CHECK）
    expect(() =>
      extractCheckedActions("CHECK (((action = 'a'::text) OR (action = 'b'::text)))"),
    ).toThrow();
    // 引用符を含む値（区切りの解釈が崩れる）
    expect(() =>
      extractCheckedActions("CHECK ((action = ANY (ARRAY['a'::text, 'b''c'::text])))"),
    ).toThrow();
  });
});

describe('AuditLogAction（正典から導いた型）', () => {
  it('正典に無い値を型で拒否する', () => {
    // 正典が `as const` を失うと AuditLogAction は string へ広がり、次の行が型エラーにならなくなる。
    // そのときは使われない @ts-expect-error として typecheck が赤くなる。
    // @ts-expect-error 正典に無い action は AuditLogAction に代入できない
    const unknownAction: AuditLogAction = 'dashboard_user_updated';
    expect(AUDIT_LOG_ACTIONS).not.toContain(unknownAction);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('audit_logs accessors (DB)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('業務書込の監査行を追記できる', async () => {
    const pool = await getPool();
    const occurredAt = new Date('2026-09-13T00:00:00.000Z');

    await createAuditLog(pool, {
      actorType: 'operator',
      actorId: ACTOR,
      action: 'agency_created',
      targetType: 'agency',
      targetId: TARGET,
      occurredAt,
    });

    const result = await pool.query<{
      actor_type: string;
      actor_id: string;
      action: string;
      target_type: string;
      target_id: string;
      occurred_at: Date;
    }>(
      `SELECT actor_type, actor_id, action, target_type, target_id, occurred_at
         FROM audit_logs
        WHERE actor_id = $1
        ORDER BY occurred_at DESC
        LIMIT 1`,
      [ACTOR],
    );

    expect(result.rows[0]).toMatchObject({
      actor_type: 'operator',
      actor_id: ACTOR,
      action: 'agency_created',
      target_type: 'agency',
      target_id: TARGET,
    });
    expect(result.rows[0]?.occurred_at.toISOString()).toBe(occurredAt.toISOString());
  });

  it('customer は監査主体として登録できない', async () => {
    const pool = await getPool();

    await expect(
      pool.query(
        `INSERT INTO audit_logs
           (actor_type, actor_id, action, target_type, target_id)
         VALUES ('customer', $1, 'onboarding_completed', 'store', $2)`,
        [ACTOR, TARGET],
      ),
    ).rejects.toMatchObject({ code: '22P02' });
  });

  it('正典 AUDIT_LOG_ACTIONS と DB の ck_audit_logs_action は同じ集合を持つ（Req 5.2）', async () => {
    const pool = await getPool();

    const result = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'audit_logs'::regclass
          AND contype = 'c'
          AND conname = 'ck_audit_logs_action'`,
    );
    // 明示名の CHECK がちょうど 1 つあること。0 行なら 0009 が当たっていない。
    expect(result.rows).toHaveLength(1);

    const checked = extractCheckedActions(result.rows[0]?.definition ?? '');
    // 抽出の失敗を「集合が一致しない」と取り違えないよう、先に空でないことを確かめる。
    expect(checked.length).toBeGreaterThan(0);
    // 並びを揃えて比べ、食い違った値が差分として読めるようにする。
    expect([...checked].sort()).toEqual([...AUDIT_LOG_ACTIONS].sort());
    // 16 = 0007 の 12 値 + #259 の 4 値。action を足すときは、CHECK を作り直す migration・
    // AUDIT_LOG_ACTIONS・この件数を同時に変える。重複が無いことも併せて確かめる。
    expect(checked).toHaveLength(16);
    expect(new Set(checked).size).toBe(checked.length);
  });
});
