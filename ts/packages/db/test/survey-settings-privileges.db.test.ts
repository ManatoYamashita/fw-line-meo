import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool, type TransactionCapable, type TransactionClient } from '../src/pool.js';
import {
  addSurveyTarget,
  readStoreSurveySettings,
  renameSurveyTarget,
  reorderSurveyTargets,
  setSurveyCategoryEnabled,
  setSurveyTargetActive,
  type SurveySettingsChange,
} from '../src/survey-settings.js';
import { createAuditLog } from '../src/audit-logs.js';

// store-detail の SA に与えた権限だけで、店舗オーナーのアンケート設定の DAL が実際に動くか（Issue #437）。
//
// infra/sql/grants.sql をそのまま実ロールへ当て（psql のメタコマンドを除き、`:"<SA>"` を検証用のロール名へ
// 置き換える）、store-detail のロールへ SET ROLE した接続で **本物の DAL** を流す。権限の表だけを照合する
// db/test/check_structured_survey_privileges.sh と対になる: あちらは「与えすぎていない」ことを、こちらは
// 「DAL が書く列・操作をすべて与えている」ことを確かめる（DAL が列を 1 つ足して権限を足し忘れると、ここが赤になる）。
//
// ロールの作成には CREATEROLE が要る。CI・ローカルの with-test-db.sh の接続ユーザーは持っている。

const here = dirname(fileURLToPath(import.meta.url));
const GRANTS_SQL = resolve(here, '../../../../infra/sql/grants.sql');

const SUFFIX = `${process.pid}_${Date.now()}`;
const ROLE_KEYS = ['line_webhook', 'survey', 'dashboard', 'batch', 'delivery', 'detail'] as const;
const roleName = (key: string) => `fwlm_t437_${key}_${SUFFIX}`;

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

/** 接続を取るたびに store-detail のロールへ切り替える pool。返すときに元へ戻す。 */
function asRole(role: string, pool: Awaited<ReturnType<typeof getPool>>): TransactionCapable {
  return {
    async connect(): Promise<TransactionClient> {
      const client = await pool.connect();
      await client.query(`SET ROLE "${role}"`);
      return {
        query: client.query.bind(client) as TransactionClient['query'],
        release() {
          client
            .query('RESET ROLE')
            .catch(() => undefined)
            .finally(() => client.release());
        },
      };
    },
  };
}

const OP = 'a4370001-0000-4000-8000-000000000001';
const AG = 'a4370001-0000-4000-8000-000000000002';
const OW = 'a4370001-0000-4000-8000-000000000003';
const STORE = 'a4370001-0000-4000-8000-000000000004';

function targetIdOf(result: SurveySettingsChange): string {
  if (!result.ok || !result.changed || !result.targetId) throw new Error(JSON.stringify(result));
  return result.targetId;
}

async function canCreateRole(): Promise<boolean> {
  const res = await (await getPool()).query<{ ok: boolean }>(
    'SELECT rolcreaterole OR rolsuper AS ok FROM pg_roles WHERE rolname = current_user',
  );
  return res.rows[0]?.ok === true;
}

describe.skipIf(!process.env.DATABASE_URL)('survey settings DAL × grants.sql（store-detail の権限だけで動く）', () => {
  let detail: TransactionCapable;

  beforeAll(async () => {
    const pool = await getPool();
    // 権限を確かめられない環境で緑にしない（skip ではなく赤にする）。
    expect(await canCreateRole(), '接続ユーザーに CREATEROLE がありません').toBe(true);
    for (const key of ROLE_KEYS) await pool.query(`CREATE ROLE "${roleName(key)}" NOLOGIN`);
    // 検証用のロールへ切り替えられるよう、接続ユーザーをメンバーにする（superuser なら不要だが害は無い）。
    await pool.query(`GRANT "${roleName('detail')}" TO CURRENT_USER`);
    const statements = grantStatements();
    expect(statements.length).toBeGreaterThan(5);
    for (const sql of statements) await pool.query(sql);
    detail = asRole(roleName('detail'), pool);

    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, '権限設定運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [AG, OP, '権限設定代理店']);
    await pool.query(
      'INSERT INTO owners (id, agency_id, line_user_id, onboarding_status) VALUES ($1, $2, $3, $4)',
      [OW, AG, 'U-survey-settings-privileges', 'active'],
    );
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_id, place_status)
       VALUES ($1, $2, '権限設定店舗', 'ChIJ_survey_settings_privileges', 'confirmed')`,
      [STORE, OW],
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

  it('store-detail のロールで、追加・名前の変更・非表示・再表示・並び替え・カテゴリの切り替えが通る', async () => {
    const a = targetIdOf(await addSurveyTarget(detail, STORE, { categoryCode: 'food', label: '刺身盛り合わせ' }));
    const b = targetIdOf(await addSurveyTarget(detail, STORE, { categoryCode: 'food', label: '焼き鳥' }));
    expect(await renameSurveyTarget(detail, STORE, a, 'お刺身盛り合わせ')).toMatchObject({ changed: true });
    expect(await reorderSurveyTargets(detail, STORE, { categoryCode: 'food', targetIds: [b, a] })).toMatchObject({
      changed: true,
    });
    expect(await setSurveyTargetActive(detail, STORE, b, false)).toMatchObject({ changed: true });
    expect(await setSurveyTargetActive(detail, STORE, b, true)).toMatchObject({ changed: true });
    // 非表示の同名の再登録（UUID を引き継ぐ再表示）も同じ権限で通る。
    await setSurveyTargetActive(detail, STORE, a, false);
    expect(
      await addSurveyTarget(detail, STORE, { categoryCode: 'food', label: 'お刺身盛り合わせ' }),
    ).toMatchObject({ changed: true, targetId: a });
    expect(await setSurveyCategoryEnabled(detail, STORE, 'reservation_visit', false)).toMatchObject({ changed: true });
    expect(await setSurveyCategoryEnabled(detail, STORE, 'reservation_visit', true)).toMatchObject({ changed: true });

    const settings = await readStoreSurveySettings(await getPool(), STORE);
    expect(settings.revision).toBe(10);
    expect(settings.structuredEnabled).toBe(false);
  });

  it('store-detail のロールで、店舗オーナーの監査記録を追記できる', async () => {
    const client = await detail.connect();
    try {
      await createAuditLog(client, {
        actorType: 'owner',
        actorId: OW,
        action: 'survey_target_added',
        targetType: 'store',
        targetId: STORE,
      });
    } finally {
      client.release();
    }
    const res = await (await getPool()).query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE actor_id = $1 AND action = 'survey_target_added'`,
      [OW],
    );
    expect(res.rows[0]).toEqual({ n: 1 });
  });

  it('store-detail のロールでは、structured の切り替え・行の削除・他の表の書込ができない', async () => {
    const denied = [
      `UPDATE store_survey_configs SET structured_enabled = true WHERE store_id = '${STORE}'`,
      `UPDATE store_survey_targets SET store_id = store_id WHERE store_id = '${STORE}'`,
      `UPDATE store_survey_targets SET category_code = 'drink' WHERE store_id = '${STORE}'`,
      `UPDATE store_survey_category_settings SET sort_order = 1 WHERE store_id = '${STORE}'`,
      `DELETE FROM store_survey_targets WHERE store_id = '${STORE}'`,
      `DELETE FROM store_survey_configs WHERE store_id = '${STORE}'`,
      `UPDATE audit_logs SET action = 'store_resumed' WHERE actor_id = '${OW}'`,
      `DELETE FROM audit_logs WHERE actor_id = '${OW}'`,
      `UPDATE stores SET name = '書き換え' WHERE id = '${STORE}'`,
      `UPDATE owners SET onboarding_status = 'active' WHERE id = '${OW}'`,
      `INSERT INTO survey_categories (code, label, allows_targets, default_enabled, default_sort_order) VALUES ('x', 'x', false, true, 1)`,
      `UPDATE survey_facets SET label = 'x'`,
      `INSERT INTO survey_rating_tallies (store_id, period_month, star, count) VALUES ('${STORE}', DATE '2026-10-01', 5, 1)`,
      `UPDATE survey_structured_material_tallies SET count = count + 1`,
    ];
    for (const sql of denied) {
      const client = await detail.connect();
      try {
        await expect(client.query(sql), sql).rejects.toThrow(/permission denied/);
      } finally {
        client.release();
      }
    }
  });
});
