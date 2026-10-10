import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closePool, createAuditLog, getPool, type AuditLogInput } from '@fwlm/db';

import { authorizeStoreDetailRequest } from '../lib/liff-auth';
import { handleSurveySettings, type SurveySettingsDeps } from '../lib/survey-settings-api';

// PATCH /api/survey-settings/targets/:targetId は、本文 { label?, active? } を 1 つの設定変更として扱う
// （Issue #437）。名前と表示を同時に送っても 1 トランザクション・版の加算 1 回・監査 1 件で、片方が通らなければ
// 両方とも書かない。実 PostgreSQL と実物の認可（LINE の検証だけ差し替え）で確かめる。

const OP = 'a4370004-0000-4000-8000-000000000001';
const AG = 'a4370004-0000-4000-8000-000000000002';
const OWNER = 'a4370004-0000-4000-8000-000000000003';
const OTHER_OWNER = 'a4370004-0000-4000-8000-000000000004';
const STORE = 'a4370004-0000-4000-8000-000000000005';
const OTHER_STORE = 'a4370004-0000-4000-8000-000000000006';
const SUBS: Record<string, string> = { mine: 'U-survey-settings-patch', other: 'U-survey-settings-patch-other' };

const fakeVerify: typeof fetch = async (_input, init) => {
  const token = new URLSearchParams(String(init?.body)).get('id_token') ?? '';
  const sub = SUBS[token];
  return sub
    ? new Response(JSON.stringify({ sub }), { status: 200 })
    : new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400 });
};

async function deps(overrides: Partial<SurveySettingsDeps> = {}): Promise<SurveySettingsDeps> {
  const pool = await getPool();
  return {
    authorize: (idToken) => authorizeStoreDetailRequest(idToken, 'test-client', pool, { fetchImpl: fakeVerify }),
    pool,
    auditLog: (input) => createAuditLog(pool, input),
    log: () => {},
    ...overrides,
  };
}

async function call(
  kind: 'addTarget' | 'updateTarget' | 'disableTarget',
  opts: { targetId?: string; body?: unknown; token?: string } = {},
  d?: SurveySettingsDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const op =
    kind === 'addTarget' ? { kind } : { kind, targetId: opts.targetId ?? '' };
  const req = new Request('http://localhost/api/survey-settings', {
    method: kind === 'updateTarget' ? 'PATCH' : 'POST',
    headers: { Authorization: `Bearer ${opts.token ?? 'mine'}`, 'Content-Type': 'application/json' },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const res = await handleSurveySettings(req, op, d ?? (await deps()));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function add(label: string, categoryCode = 'food', token = 'mine'): Promise<string> {
  const res = await call('addTarget', { body: { categoryCode, label }, token });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const targets = res.body.targets as { id: string; label: string; active: boolean }[];
  return targets.find((t) => t.label === label && t.active)!.id;
}

async function row(id: string): Promise<{ label: string; active: boolean }> {
  const res = await (await getPool()).query<{ label: string; active: boolean }>(
    'SELECT label, active FROM store_survey_targets WHERE id = $1',
    [id],
  );
  return res.rows[0]!;
}

async function revision(storeId = STORE): Promise<number> {
  const res = await (await getPool()).query<{ revision: string }>(
    'SELECT revision FROM store_survey_configs WHERE store_id = $1',
    [storeId],
  );
  return Number(res.rows[0]!.revision);
}

async function auditCount(storeId = STORE): Promise<number> {
  const res = await (await getPool()).query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_logs WHERE target_type = 'store' AND target_id = $1`,
    [storeId],
  );
  return res.rows[0]!.n;
}

async function lastAction(storeId = STORE): Promise<string> {
  const res = await (await getPool()).query<{ action: string }>(
    `SELECT action FROM audit_logs WHERE target_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    [storeId],
  );
  return res.rows[0]!.action;
}

describe.skipIf(!process.env.DATABASE_URL)('PATCH targets/:targetId は 1 リクエスト = 1 トランザクション（DB）', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, 'PATCH 運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [AG, OP, 'PATCH 代理店']);
    for (const [id, sub] of [
      [OWNER, SUBS.mine],
      [OTHER_OWNER, SUBS.other],
    ] as const) {
      await pool.query('INSERT INTO owners (id, agency_id, line_user_id, onboarding_status) VALUES ($1, $2, $3, $4)', [
        id,
        AG,
        sub,
        'active',
      ]);
    }
    for (const [id, owner] of [
      [STORE, OWNER],
      [OTHER_STORE, OTHER_OWNER],
    ] as const) {
      await pool.query(
        `INSERT INTO stores (id, owner_id, name, place_id, place_status) VALUES ($1, $2, $3, $4, 'confirmed')`,
        [id, owner, `PATCH 店 ${id.slice(-1)}`, `ChIJ_patch_${id.slice(-1)}`],
      );
    }
  });

  afterAll(async () => {
    await closePool();
  });

  it('1. label だけ → 名前が変わり、revision +1・監査 1 件（renamed）', async () => {
    const id = await add('ラベルだけ');
    const [rev, audits] = [await revision(), await auditCount()];
    const res = await call('updateTarget', { targetId: id, body: { label: 'ラベルだけ（改）' } });
    expect(res.status).toBe(200);
    expect(await row(id)).toEqual({ label: 'ラベルだけ（改）', active: true });
    expect(await revision()).toBe(rev + 1);
    expect(await auditCount()).toBe(audits + 1);
    expect(await lastAction()).toBe('survey_target_renamed');
  });

  it('2. active だけ → 表示が変わり、revision +1・監査 1 件（disabled）', async () => {
    const id = await add('表示だけ');
    const [rev, audits] = [await revision(), await auditCount()];
    const res = await call('updateTarget', { targetId: id, body: { active: false } });
    expect(res.status).toBe(200);
    expect(await row(id)).toEqual({ label: '表示だけ', active: false });
    expect(await revision()).toBe(rev + 1);
    expect(await auditCount()).toBe(audits + 1);
    expect(await lastAction()).toBe('survey_target_disabled');
  });

  it('3. label + active → 両方変わり、revision は +1 だけ・監査も 1 件（updated）', async () => {
    const id = await add('両方');
    await call('updateTarget', { targetId: id, body: { active: false } });
    const [rev, audits] = [await revision(), await auditCount()];
    const res = await call('updateTarget', { targetId: id, body: { label: '両方（改）', active: true } });
    expect(res.status).toBe(200);
    expect(await row(id)).toEqual({ label: '両方（改）', active: true });
    expect(await revision()).toBe(rev + 1);
    expect(await auditCount()).toBe(audits + 1);
    expect(await lastAction()).toBe('survey_target_updated');
  });

  it('4. 不正な label + active の変更 → どちらも変わらない（400・revision・監査そのまま）', async () => {
    const id = await add('不正ラベル');
    const [rev, audits] = [await revision(), await auditCount()];
    for (const label of ['', 'あ'.repeat(41), '改行\nあり']) {
      const res = await call('updateTarget', { targetId: id, body: { label, active: false } });
      expect(res.status, JSON.stringify(label)).toBe(400);
    }
    expect(await row(id)).toEqual({ label: '不正ラベル', active: true });
    expect(await revision()).toBe(rev);
    expect(await auditCount()).toBe(audits);
  });

  it('5. 表示中の同名への変更 + active の変更 → どちらも変わらない（409）', async () => {
    await add('既にある名前');
    const id = await add('変えたい名前');
    await call('updateTarget', { targetId: id, body: { active: false } });
    const [rev, audits] = [await revision(), await auditCount()];
    const res = await call('updateTarget', { targetId: id, body: { label: '既にある名前', active: true } });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: 'DUPLICATE_LABEL' } });
    expect(await row(id)).toEqual({ label: '変えたい名前', active: false });
    expect(await revision()).toBe(rev);
    expect(await auditCount()).toBe(audits);
  });

  it('5b. 名前は通るが表示が上限に当たる → 名前も変わらない（409）', async () => {
    const pool = await getPool();
    const hidden = await add('上限待ち', 'drink');
    await call('updateTarget', { targetId: hidden, body: { active: false } });
    const activeDrinks = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM store_survey_targets WHERE store_id = $1 AND category_code = 'drink' AND active`,
      [STORE],
    );
    for (let i = activeDrinks.rows[0]!.n; i < 10; i++) await add(`ドリンク ${i}`, 'drink');
    const [rev, audits] = [await revision(), await auditCount()];
    const res = await call('updateTarget', { targetId: hidden, body: { label: '上限待ち（改）', active: true } });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: 'TARGET_LIMIT_REACHED' } });
    expect(await row(hidden)).toEqual({ label: '上限待ち', active: false });
    expect(await revision()).toBe(rev);
    expect(await auditCount()).toBe(audits);
  });

  it('6. 他店の Target → 404・どちらの店舗も変わらない', async () => {
    const theirs = await add('他店の料理', 'food', 'other');
    const [rev, theirRev, audits] = [await revision(), await revision(OTHER_STORE), await auditCount()];
    const res = await call('updateTarget', { targetId: theirs, body: { label: '乗っ取り', active: false } });
    expect(res.status).toBe(404);
    expect(await row(theirs)).toEqual({ label: '他店の料理', active: true });
    expect(await revision()).toBe(rev);
    expect(await revision(OTHER_STORE)).toBe(theirRev);
    expect(await auditCount()).toBe(audits);
  });

  it('7. 監査の書込が失敗しても、確定した変更（名前と表示の両方）は残り 200 を返す', async () => {
    const id = await add('監査失敗');
    const failing = vi.fn(async (_input: AuditLogInput) => {
      throw new Error('audit down');
    });
    const rev = await revision();
    const res = await call(
      'updateTarget',
      { targetId: id, body: { label: '監査失敗（改）', active: false } },
      await deps({ auditLog: failing }),
    );
    expect(res.status).toBe(200);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(failing.mock.calls[0]![0]).toMatchObject({ action: 'survey_target_updated', targetId: STORE });
    expect(await row(id)).toEqual({ label: '監査失敗（改）', active: false });
    expect(await revision()).toBe(rev + 1);
  });

  it('変化の無い PATCH（同じ名前・同じ表示）は何も書かず、版も監査も進めない', async () => {
    const id = await add('そのまま');
    const [rev, audits] = [await revision(), await auditCount()];
    const res = await call('updateTarget', { targetId: id, body: { label: ' そのまま ', active: true } });
    expect(res.status).toBe(200);
    expect(await revision()).toBe(rev);
    expect(await auditCount()).toBe(audits);
  });
});
