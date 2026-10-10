import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closePool, createAuditLog, getPool, type AuditLogInput } from '@fwlm/db';

import { authorizeStoreDetailRequest } from '../lib/liff-auth';
import { handleSurveySettings, type SurveySettingsDeps, type SurveySettingsOperation } from '../lib/survey-settings-api';
import type { SurveySettingsResponse } from '../lib/survey-settings-contract';

// 店舗オーナーのアンケート設定 API（Issue #437）を、実 PostgreSQL と実物の認可（lib/liff-auth.ts）で確かめる。
// LINE の ID トークン検証だけを fetch の差し替えで固定し（トークン → sub）、それ以外は本番と同じ経路を通す。
// 他の DB テストと DB を共有するため、衝突しない固有 UUID / line_user_id を使う。

const OP = 'a4370002-0000-4000-8000-000000000001';
const AG = 'a4370002-0000-4000-8000-000000000002';
const OWNER = 'a4370002-0000-4000-8000-000000000011'; // 1 店
const OWNER_MULTI = 'a4370002-0000-4000-8000-000000000012'; // 2 店
const OWNER_NONE = 'a4370002-0000-4000-8000-000000000013'; // 確定店舗なし
const OWNER_OTHER = 'a4370002-0000-4000-8000-000000000014'; // 他店のオーナー

const STORE = 'a4370002-0000-4000-8000-000000000101';
const MULTI_A = 'a4370002-0000-4000-8000-000000000102';
const MULTI_B = 'a4370002-0000-4000-8000-000000000103';
const OTHER_STORE = 'a4370002-0000-4000-8000-000000000104';

const TOKENS: Record<string, string> = {
  'token-owner': 'U-survey-settings-api-owner',
  'token-multi': 'U-survey-settings-api-multi',
  'token-none': 'U-survey-settings-api-none',
  'token-other': 'U-survey-settings-api-other',
  'token-unknown-owner': 'U-survey-settings-api-not-registered',
};

/** LINE の /oauth2/v2.1/verify の代わり。表に無いトークンは 400（無効なトークン）。 */
const fakeVerify: typeof fetch = async (_input, init) => {
  const idToken = new URLSearchParams(String(init?.body)).get('id_token') ?? '';
  const sub = TOKENS[idToken];
  if (!sub) return new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400 });
  return new Response(JSON.stringify({ sub }), { status: 200 });
};

interface Harness {
  deps: SurveySettingsDeps;
  logs: { level: string; event: string; fields?: Record<string, unknown> }[];
}

async function harness(overrides: Partial<SurveySettingsDeps> = {}): Promise<Harness> {
  const pool = await getPool();
  const logs: Harness['logs'] = [];
  return {
    logs,
    deps: {
      authorize: (idToken) => authorizeStoreDetailRequest(idToken, 'test-client', pool, { fetchImpl: fakeVerify }),
      pool,
      auditLog: (input) => createAuditLog(pool, input),
      log: (level, event, fields) => logs.push({ level, event, fields: fields as Record<string, unknown> }),
      ...overrides,
    },
  };
}

function request(method: string, path: string, opts: { token?: string | null; body?: unknown; query?: string } = {}): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? 'token-owner'}`;
  return new Request(`http://localhost${path}${opts.query ?? ''}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body) }),
  });
}

async function call(
  op: SurveySettingsOperation,
  opts: { token?: string | null; body?: unknown; query?: string; method?: string } = {},
  deps?: SurveySettingsDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const h = deps ?? (await harness()).deps;
  const res = await handleSurveySettings(request(opts.method ?? 'POST', '/api/survey-settings', opts), op, h);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const READ: SurveySettingsOperation = { kind: 'read' };
const ADD: SurveySettingsOperation = { kind: 'addTarget' };

async function addTarget(label: string, categoryCode = 'food', token = 'token-owner', query?: string): Promise<string> {
  const res = await call(ADD, { token, body: { categoryCode, label }, ...(query ? { query } : {}) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const settings = res.body as unknown as SurveySettingsResponse;
  const target = settings.targets.find((t) => t.label === label && t.categoryCode === categoryCode && t.active);
  if (!target) throw new Error(`追加した ${label} が応答に無い`);
  return target.id;
}

async function revisionOf(storeId: string): Promise<number | null> {
  const res = await (await getPool()).query<{ revision: string }>(
    'SELECT revision FROM store_survey_configs WHERE store_id = $1',
    [storeId],
  );
  return res.rows[0] ? Number(res.rows[0].revision) : null;
}

async function auditActions(storeId: string): Promise<string[]> {
  const res = await (await getPool()).query<{ action: string }>(
    `SELECT action FROM audit_logs WHERE target_type = 'store' AND target_id = $1 ORDER BY occurred_at, id`,
    [storeId],
  );
  return res.rows.map((r) => r.action);
}

describe.skipIf(!process.env.DATABASE_URL)('survey settings API (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, '設定 API 運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [AG, OP, '設定 API 代理店']);
    const owners: [string, string][] = [
      [OWNER, TOKENS['token-owner']!],
      [OWNER_MULTI, TOKENS['token-multi']!],
      [OWNER_NONE, TOKENS['token-none']!],
      [OWNER_OTHER, TOKENS['token-other']!],
    ];
    for (const [id, sub] of owners) {
      await pool.query(
        'INSERT INTO owners (id, agency_id, line_user_id, onboarding_status) VALUES ($1, $2, $3, $4)',
        [id, AG, sub, 'active'],
      );
    }
    const stores: [string, string, string][] = [
      [STORE, OWNER, '設定 API 店'],
      [MULTI_A, OWNER_MULTI, '設定 API 多店舗 A'],
      [MULTI_B, OWNER_MULTI, '設定 API 多店舗 B'],
      [OTHER_STORE, OWNER_OTHER, '設定 API 他店'],
    ];
    for (const [id, owner, name] of stores) {
      await pool.query(
        `INSERT INTO stores (id, owner_id, name, place_id, place_status, created_at)
         VALUES ($1, $2, $3, $4, 'confirmed', $5)`,
        [id, owner, name, `ChIJ_${id.slice(-3)}`, `2026-01-01T00:00:0${id.slice(-1)}Z`],
      );
    }
    // 確定店舗を持たないオーナー（オンボーディング途中）。
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_status) VALUES ($1, $2, '未確定店', 'pending')`,
      ['a4370002-0000-4000-8000-000000000105', OWNER_NONE],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  describe('認可', () => {
    it('Authorization が無い・無効なトークンは 401', async () => {
      expect((await call(READ, { token: null, method: 'GET' })).status).toBe(401);
      expect((await call(READ, { token: 'token-forged', method: 'GET' })).status).toBe(401);
      expect((await call(ADD, { token: 'token-forged', body: { categoryCode: 'food', label: 'x' } })).status).toBe(401);
    });

    it('owner が無い・確定店舗が無いときは 404（2 つを区別しない）', async () => {
      for (const token of ['token-unknown-owner', 'token-none']) {
        const res = await call(ADD, { token, body: { categoryCode: 'food', label: 'x' } });
        expect(res.status, token).toBe(404);
        expect(res.body).toMatchObject({ error: { code: 'STORE_NOT_FOUND' } });
      }
    });

    it('1 店のオーナーは自店の設定を読める（店舗は認証から決まり、URL にも本文にも要らない）', async () => {
      const res = await call(READ, { method: 'GET' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ storeId: STORE, storeName: '設定 API 店', structuredEnabled: false });
      expect(res.body.stores).toEqual([{ storeId: STORE, name: '設定 API 店' }]);
    });

    it('本文に他店の storeId を入れても、書き込むのは認証から決まった自店だけ', async () => {
      const before = await revisionOf(OTHER_STORE);
      const res = await call(ADD, {
        body: { categoryCode: 'food', label: '本文で他店を指す', storeId: OTHER_STORE },
      });
      expect(res.status).toBe(200);
      expect(res.body.storeId).toBe(STORE);
      expect(await revisionOf(OTHER_STORE)).toBe(before);
      const theirs = await (await getPool()).query('SELECT 1 FROM store_survey_targets WHERE store_id = $1', [OTHER_STORE]);
      expect(theirs.rows).toEqual([]);
    });

    it('?storeId に他店を指しても、認可済み集合の外は無視して自店に書く（値はログに残さない）', async () => {
      const { deps, logs } = await harness();
      const res = await call(
        ADD,
        { body: { categoryCode: 'food', label: 'クエリで他店を指す' }, query: `?storeId=${OTHER_STORE}` },
        deps,
      );
      expect(res.status).toBe(200);
      expect(res.body.storeId).toBe(STORE);
      expect(logs).toContainEqual({
        level: 'warn',
        event: 'store-detail.store_hint_ignored',
        fields: { reason: 'not_in_authorized_set', authorizedCount: 1 },
      });
      expect(JSON.stringify(logs)).not.toContain(OTHER_STORE);
    });

    it('複数店舗のオーナーは、ヒントが無いと 409 と候補を返し、ヒントで自分の店の 1 つを選んで書く', async () => {
      const none = await call(ADD, { token: 'token-multi', body: { categoryCode: 'food', label: 'どの店？' } });
      expect(none.status).toBe(409);
      expect(none.body).toMatchObject({ error: { code: 'STORE_SELECTION_REQUIRED' } });
      expect(none.body.stores).toEqual([
        { storeId: MULTI_A, name: '設定 API 多店舗 A' },
        { storeId: MULTI_B, name: '設定 API 多店舗 B' },
      ]);
      expect(await revisionOf(MULTI_A)).toBeNull();
      expect(await revisionOf(MULTI_B)).toBeNull();

      await addTarget('B 店の料理', 'food', 'token-multi', `?storeId=${MULTI_B}`);
      expect(await revisionOf(MULTI_B)).toBe(1);
      expect(await revisionOf(MULTI_A)).toBeNull();
      // 他のオーナーの店舗をヒントにしても、集合の外なので選ばれない（409 のまま）。
      const outside = await call(ADD, {
        token: 'token-multi',
        body: { categoryCode: 'food', label: 'x' },
        query: `?storeId=${STORE}`,
      });
      expect(outside.status).toBe(409);
    });
  });

  describe('Target の操作', () => {
    it('料理・ドリンク以外へは登録できない（400）', async () => {
      for (const categoryCode of ['price', 'service_delivery', 'reservation_visit', 'unknown', null]) {
        const res = await call(ADD, { body: { categoryCode, label: '何か' } });
        expect(res.status, String(categoryCode)).toBe(400);
        expect(res.body).toMatchObject({ error: { code: 'CATEGORY_NOT_EDITABLE' } });
      }
    });

    it('不正な名前は 400 で、何を直せばよいかを返す', async () => {
      const cases: [unknown, string, string][] = [
        ['', 'LABEL_EMPTY', '名前を入力してください。'],
        ['あ'.repeat(41), 'LABEL_TOO_LONG', '名前は40文字以内で入力してください。'],
        ['刺身\n盛り', 'LABEL_MULTILINE', '名前に改行は使えません。1 行で入力してください。'],
        [42, 'LABEL_INVALID', '名前を文字で入力してください。'],
      ];
      for (const [label, code, message] of cases) {
        const res = await call(ADD, { body: { categoryCode: 'food', label } });
        expect(res.status, code).toBe(400);
        expect(res.body.error).toEqual({ code, message });
      }
      expect((await call(ADD, { body: '{not json' })).status).toBe(400);
      expect((await call(ADD, { body: '[1,2]' })).status).toBe(400);
    });

    it('表示中の同名は 409・非表示の同名は再表示して同じ UUID を返す', async () => {
      const id = await addTarget('刺身盛り合わせ');
      const dup = await call(ADD, { body: { categoryCode: 'food', label: '刺身盛り合わせ' } });
      expect(dup.status).toBe(409);
      expect(dup.body).toMatchObject({ error: { code: 'DUPLICATE_LABEL' } });

      const disabled = await call({ kind: 'disableTarget', targetId: id });
      expect(disabled.status).toBe(200);
      expect((disabled.body as unknown as SurveySettingsResponse).targets.find((t) => t.id === id)?.active).toBe(false);

      const again = await addTarget('刺身盛り合わせ');
      expect(again).toBe(id);
      const rows = await (await getPool()).query(
        `SELECT count(*)::int AS n FROM store_survey_targets WHERE store_id = $1 AND label = '刺身盛り合わせ'`,
        [STORE],
      );
      expect(rows.rows[0]).toEqual({ n: 1 });
    });

    it('11 件目は 409。上限でも名前の変更・非表示・並び替えはできる', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) ids.push(await addTarget(`上限ドリンク ${i}`, 'drink'));
      const over = await call(ADD, { body: { categoryCode: 'drink', label: '11 件目' } });
      expect(over.status).toBe(409);
      expect(over.body).toMatchObject({ error: { code: 'TARGET_LIMIT_REACHED' } });

      expect(
        (await call({ kind: 'updateTarget', targetId: ids[0]! }, { method: 'PATCH', body: { label: '上限ドリンク 0（改）' } }))
          .status,
      ).toBe(200);
      expect(
        (await call({ kind: 'reorderTargets' }, { method: 'PUT', body: { categoryCode: 'drink', targetIds: [...ids].reverse() } }))
          .status,
      ).toBe(200);
      expect((await call({ kind: 'disableTarget', targetId: ids[1]! })).status).toBe(200);
      // 空いた 1 件ぶんの再表示はできる（PATCH active: true）。
      const reshow = await call({ kind: 'updateTarget', targetId: ids[1]! }, { method: 'PATCH', body: { active: true } });
      expect(reshow.status).toBe(200);
    });

    it('他店の Target・存在しない Target・UUID でない ID は 404（他店に実在するかを区別しない）', async () => {
      const theirs = await addTarget('他店の料理', 'food', 'token-other');
      const before = await revisionOf(STORE);
      for (const targetId of [theirs, 'a4370002-0000-4000-8000-0000000009ff', 'not-a-uuid', "1' OR '1'='1"]) {
        const patch = await call({ kind: 'updateTarget', targetId }, { method: 'PATCH', body: { label: '乗っ取り' } });
        expect(patch.status, targetId).toBe(404);
        expect(patch.body).toMatchObject({ error: { code: 'TARGET_NOT_FOUND' } });
        expect((await call({ kind: 'disableTarget', targetId })).status, targetId).toBe(404);
      }
      expect(await revisionOf(STORE)).toBe(before);
      const row = await (await getPool()).query('SELECT label, active FROM store_survey_targets WHERE id = $1', [theirs]);
      expect(row.rows).toEqual([{ label: '他店の料理', active: true }]);
    });

    it('PATCH の本文は label か active のどちらかが要り、active は真偽値に限る', async () => {
      const id = await addTarget('本文の検査');
      for (const body of [{}, { active: 'false' }, { active: 1 }, { storeId: OTHER_STORE }]) {
        const res = await call({ kind: 'updateTarget', targetId: id }, { method: 'PATCH', body });
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body).toMatchObject({ error: { code: 'INVALID_BODY' } });
      }
    });

    it('並び替えは、他店の ID・重複・欠落を 400 で拒否し、正しい並びは保存して返す', async () => {
      const pool = await getPool();
      const theirs = await addTarget('並び他店', 'food', 'token-other');
      const current = (await call(READ, { method: 'GET' })).body as unknown as SurveySettingsResponse;
      const food = current.targets.filter((t) => t.categoryCode === 'food' && t.active).map((t) => t.id);
      expect(food.length).toBeGreaterThan(2);
      const before = await revisionOf(STORE);
      const invalid: unknown[] = [
        [...food.slice(1), theirs],
        [...food, theirs],
        [food[0], ...food],
        food.slice(1),
        'not-an-array',
      ];
      for (const targetIds of invalid) {
        const res = await call({ kind: 'reorderTargets' }, { method: 'PUT', body: { categoryCode: 'food', targetIds } });
        expect(res.status, JSON.stringify(targetIds)).toBe(400);
        expect(res.body).toMatchObject({ error: { code: 'INVALID_ORDER' } });
      }
      expect(await revisionOf(STORE)).toBe(before);

      const reversed = [...food].reverse();
      const ok = await call({ kind: 'reorderTargets' }, { method: 'PUT', body: { categoryCode: 'food', targetIds: reversed } });
      expect(ok.status).toBe(200);
      const saved = (ok.body as unknown as SurveySettingsResponse).targets
        .filter((t) => t.categoryCode === 'food' && t.active)
        .map((t) => t.id);
      expect(saved).toEqual(reversed);
      expect(await revisionOf(STORE)).toBe(before! + 1);
      // 他店の並びは触らない。
      const theirRow = await pool.query('SELECT sort_order FROM store_survey_targets WHERE id = $1', [theirs]);
      expect(theirRow.rows).toEqual([{ sort_order: 1 }]);
    });
  });

  describe('カテゴリ', () => {
    it('予約・来店の表示を切り替えられる。それ以外・不正な本文は 400', async () => {
      const off = await call({ kind: 'setCategory', categoryCode: 'reservation_visit' }, { method: 'PATCH', body: { enabled: false } });
      expect(off.status).toBe(200);
      const categories = (off.body as unknown as SurveySettingsResponse).categories;
      expect(categories.find((c) => c.code === 'reservation_visit')).toMatchObject({ enabled: false, toggleable: true });

      const food = await call({ kind: 'setCategory', categoryCode: 'food' }, { method: 'PATCH', body: { enabled: false } });
      expect(food.status).toBe(400);
      expect(food.body).toMatchObject({ error: { code: 'CATEGORY_NOT_TOGGLEABLE' } });
      const bad = await call({ kind: 'setCategory', categoryCode: 'reservation_visit' }, { method: 'PATCH', body: { enabled: 'no' } });
      expect(bad.status).toBe(400);
      expect((await call({ kind: 'setCategory', categoryCode: 'reservation_visit' }, { method: 'PATCH', body: { enabled: true } })).status).toBe(200);
    });
  });

  describe('監査', () => {
    it('確定した変更ごとに owner → store の監査を残し、名前は写さない。変化の無い操作と失敗は残さない', async () => {
      const store = OTHER_STORE;
      const before = await auditActions(store);
      const id = await addTarget('監査される料理', 'food', 'token-other');
      await call({ kind: 'updateTarget', targetId: id }, { token: 'token-other', method: 'PATCH', body: { label: '監査される料理 改' } });
      await call({ kind: 'updateTarget', targetId: id }, { token: 'token-other', method: 'PATCH', body: { label: '監査される料理 改' } });
      await call(ADD, { token: 'token-other', body: { categoryCode: 'food', label: '監査される料理 改' } }); // 409
      await call({ kind: 'disableTarget', targetId: id }, { token: 'token-other' });
      expect((await auditActions(store)).slice(before.length)).toEqual([
        'survey_target_added',
        'survey_target_renamed',
        'survey_target_disabled',
      ]);
      const rows = await (await getPool()).query(
        `SELECT actor_type, actor_id, target_type, target_id FROM audit_logs WHERE target_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
        [store],
      );
      expect(rows.rows[0]).toEqual({ actor_type: 'owner', actor_id: OWNER_OTHER, target_type: 'store', target_id: store });
      // audit_logs のどの列にも名前は入らない（payload の列を持たない）。
      const text = await (await getPool()).query(`SELECT row_to_json(a)::text AS t FROM audit_logs a WHERE target_id = $1`, [store]);
      expect(text.rows.map((r: { t: string }) => r.t).join()).not.toContain('監査される料理');
    });

    it('監査の書込が失敗しても変更は巻き戻さず 200 を返し、警告を残す', async () => {
      const failing = vi.fn(async (_input: AuditLogInput) => {
        throw new Error('audit down');
      });
      const { deps, logs } = await harness({ auditLog: failing });
      const before = await revisionOf(STORE);
      const res = await call(ADD, { body: { categoryCode: 'drink', label: '監査失敗でも残る' } }, deps);
      expect(res.status).toBe(409); // drink は上のテストで上限に達している
      const food = await call(ADD, { body: { categoryCode: 'food', label: '監査失敗でも残る' } }, deps);
      expect(food.status).toBe(200);
      expect(failing).toHaveBeenCalledTimes(1);
      expect(await revisionOf(STORE)).toBe(before! + 1);
      expect(logs).toContainEqual({
        level: 'warn',
        event: 'store-detail.audit_log_failed',
        fields: { errorKind: 'Error', auditAction: 'survey_target_added', auditTargetId: STORE },
      });
    });
  });

  it('structured_enabled はどの操作でも変わらない（客向けの structured の画面が未接続）', async () => {
    const res = await (await getPool()).query(
      'SELECT count(*)::int AS n FROM store_survey_configs WHERE store_id = ANY($1) AND structured_enabled',
      [[STORE, MULTI_A, MULTI_B, OTHER_STORE]],
    );
    expect(res.rows[0]).toEqual({ n: 0 });
  });
});
