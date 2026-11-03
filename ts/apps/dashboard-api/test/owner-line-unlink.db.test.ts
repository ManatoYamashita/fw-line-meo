import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getPool, closePool } from '@fwlm/db';
import type { LogFields, LogLevel } from '@fwlm/observability';
import { createApp } from '../src/app.js';
import type { TokenVerifier } from '../src/auth.js';
import { buildAppDeps } from '../src/composition.js';
import type { OwnerLineUnlinkResponse } from '../src/owner-line-unlink.js';

// 実 postgres（ts-test-db）＋実 @fwlm/db で POST /owners/:id/unlink を app.request 経由で検証する
// （owner-line-unlink Req 1.1–1.3, 1.5, 3.1–3.4, 7.1, 7.3）。firebase-admin のみモック（Bearer 文字列＝uid とみなす）。
// 配線は本番と同じ合成根（src/composition.ts）を使うので、DAL・監査（migration 0018 の CHECK が
// owner_line_unlinked を受け付けること）・LINE のアダプタも実物である。LINE への通信だけを偽の取得関数で
// 受け、試験から api.line.me へ出ない。
// DATABASE_URL 無しは skip。共有 DB のため UUID prefix は d8（他のファイルと非交差）。

const OP1 = 'd8000000-0000-0000-0000-000000000001';
const AG1 = 'd8000000-0000-0000-0000-000000000002';
const AG2 = 'd8000000-0000-0000-0000-000000000003';
const OW_AG1 = 'd8000000-0000-0000-0000-000000000004'; // AG1・連携中（代理店の解除と二重の解除）
const OW_AG2 = 'd8000000-0000-0000-0000-000000000005'; // AG2・連携中（AG1 の代理店からは範囲外。運営の解除と外し直し）
const S1 = 'd8000000-0000-0000-0000-000000000006'; // OW_AG1 の店舗（解除で変わらないこと）
const DU_OP = 'd8000000-0000-0000-0000-000000000010';
const DU_AG1 = 'd8000000-0000-0000-0000-000000000011';
const OW_LINKED = 'd8000000-0000-0000-0000-000000000007'; // AG1・連携中のまま（認証の失敗で状態が変わらないこと）
const MISSING = 'd8000000-0000-0000-0000-0000000000ff';

const OP_TOKEN = 'd8-op-uid';
const AG1_TOKEN = 'd8-ag1-uid';

// LINE ユーザー ID の形（U に続く 16 進 32 桁）。アダプタは形に合わない値を通信せずに弾く。
const LINE_AG1 = 'Ud8000000000000000000000000000001';
const LINE_AG2 = 'Ud8000000000000000000000000000002';
const LINE_LINKED = 'Ud8000000000000000000000000000003';

// 合成根がアダプタへ渡す資格情報。取り違え（ID とシークレットの入れ替え）を検出できるよう、互いに異なる値にする。
const CHANNEL_ID = '1234567890';
const CHANNEL_SECRET = 'dummy-line-channel-secret';
// 偽のトークン発行が返すアクセストークン。DELETE の Authorization に使われることを確かめる。
const FAKE_ACCESS_TOKEN = 'd8-fake-access-token';

const config = {
  placesApiKey: 'test-places-key',
  corsOrigin: 'https://dash.example',
  surveyBaseUrl: 'https://survey.example',
  lineChannelId: CHANNEL_ID,
  lineChannelSecret: CHANNEL_SECRET,
};

// firebase-admin を隔離した TokenVerifier のモック（Bearer 文字列をそのまま uid とみなす）。
const verifier: TokenVerifier = {
  verifyIdToken: (t) => Promise.resolve({ uid: t, email: null, emailVerified: false, signInProvider: null }),
};

// LINE への通信を受ける偽の取得関数。トークン発行には常に成功し、個別リンクの DELETE には
// deleteStatus の状態コードを返す。呼ばれた URL と、トークン発行の form と DELETE の Authorization を記録し、
// 合成根が資格情報を取り違えずにアダプタへ渡していることを確かめる。
let deleteStatus = 200;
let lineCalls: { method: string; url: string }[] = [];
let tokenForms: Record<string, string>[] = [];
let deleteAuthorizations: (string | null)[] = [];
const fakeLineFetch: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? 'GET';
  lineCalls.push({ method, url });
  if (url === 'https://api.line.me/oauth2/v3/token') {
    const body = typeof init?.body === 'string' ? init.body : '';
    tokenForms.push(Object.fromEntries(new URLSearchParams(body)));
    return Promise.resolve(
      new Response(JSON.stringify({ access_token: FAKE_ACCESS_TOKEN, expires_in: 900, token_type: 'Bearer' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }
  deleteAuthorizations.push(new Headers(init?.headers).get('Authorization'));
  return Promise.resolve(new Response(null, { status: deleteStatus }));
};

let logged: { level: LogLevel; event: string; fields: LogFields | undefined }[] = [];

function buildApp(): ReturnType<typeof createApp> {
  // 本番と同じ合成根（src/composition.ts）を呼び、verifier と LINE の取得関数だけを差し替える。
  return createApp(
    buildAppDeps({
      config,
      verifier,
      lineFetch: fakeLineFetch,
      structuredLog: (level, event, fields) => {
        logged.push({ level, event, fields });
      },
    }),
  );
}

async function post(path: string, bearer: string): Promise<Response> {
  return await buildApp().request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}` },
  });
}

async function linkColumns(id: string): Promise<{
  line_user_id: string | null;
  unlinked: boolean;
  menu_pending_line_user_id: string | null;
}> {
  const pool = await getPool();
  const res = await pool.query<{
    line_user_id: string | null;
    unlinked: boolean;
    menu_pending_line_user_id: string | null;
  }>(
    `SELECT line_user_id, line_unlinked_at IS NOT NULL AS unlinked, menu_pending_line_user_id
       FROM owners WHERE id = $1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`owner ${id} が見つかりません`);
  return row;
}

async function auditRows(ownerId: string): Promise<Record<string, unknown>[]> {
  const pool = await getPool();
  const res = await pool.query<Record<string, unknown>>(
    `SELECT action, actor_type::text AS actor_type, actor_id::text AS actor_id, target_type::text AS target_type
       FROM audit_logs
      WHERE target_id = $1
      ORDER BY occurred_at, id`,
    [ownerId],
  );
  return res.rows;
}

/** 監査の行を丸ごと JSON にした文字列（LINE ユーザー ID がどの列にも入っていないことを見る）。 */
async function auditRowsText(ownerId: string): Promise<string> {
  const pool = await getPool();
  const res = await pool.query<{ row: unknown }>(
    'SELECT to_jsonb(a) AS row FROM audit_logs a WHERE target_id = $1',
    [ownerId],
  );
  return JSON.stringify(res.rows);
}

describe.skipIf(!process.env.DATABASE_URL)('owner line unlink route (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP1, '解除運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3), ($4, $2, $5)', [
      AG1, OP1, '解除代理店1', AG2, '解除代理店2',
    ]);
    await pool.query(
      `INSERT INTO owners (id, agency_id, line_user_id, onboarding_status)
       VALUES ($1, $2, $3, 'active'), ($4, $5, $6, 'active'), ($7, $2, $8, 'active')`,
      [OW_AG1, AG1, LINE_AG1, OW_AG2, AG2, LINE_AG2, OW_LINKED, LINE_LINKED],
    );
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_id, place_status)
       VALUES ($1, $2, '解除店1', 'ChIJ-d8-1', 'confirmed')`,
      [S1, OW_AG1],
    );
    await pool.query(
      `INSERT INTO dashboard_users (id, role, operator_id, agency_id, auth_subject) VALUES
        ($1, 'operator', $3, NULL, $5),
        ($2, 'agency', $3, $4, $6)`,
      [DU_OP, DU_AG1, OP1, AG1, OP_TOKEN, AG1_TOKEN],
    );
  });

  beforeEach(() => {
    deleteStatus = 200;
    lineCalls = [];
    tokenForms = [];
    deleteAuthorizations = [];
    logged = [];
  });

  afterAll(async () => {
    await closePool();
  });

  it('代理店が他代理店のオーナー・存在しないオーナーを解除すると同じ本文の 404 で、行も監査も変わらず LINE も呼ばない（1.3）', async () => {
    const before = await linkColumns(OW_AG2);
    const res = await post(`/owners/${OW_AG2}/unlink`, AG1_TOKEN);
    expect(res.status).toBe(404);
    const missing = await post(`/owners/${MISSING}/unlink`, AG1_TOKEN);
    expect(missing.status).toBe(404);
    const invalid = await post('/owners/not-a-uuid/unlink', AG1_TOKEN);
    expect(invalid.status).toBe(404);
    // ルート未配線の Hono 既定 404 と取り違えないよう封筒も確かめる。
    const outOfScopeBody = await res.text();
    expect(outOfScopeBody).toBe(await missing.text());
    expect(outOfScopeBody).toBe(await invalid.text());
    expect((JSON.parse(outOfScopeBody) as { error: { code: string } }).error.code).toBe('not_found');
    expect(await linkColumns(OW_AG2)).toEqual(before);
    expect(before.line_user_id).toBe(LINE_AG2);
    expect(await auditRows(OW_AG2)).toEqual([]);
    expect(lineCalls).toEqual([]);
  });

  it('代理店が担当オーナーを解除すると解除済みになり、メニューを外して印を消し、監査が 1 行残る。二度目は not_needed で監査も LINE も増えない（1.2, 1.5, 3.1, 7.1, 7.3）', async () => {
    const res = await post(`/owners/${OW_AG1}/unlink`, AG1_TOKEN);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text) as OwnerLineUnlinkResponse).toEqual({
      owner: { id: OW_AG1, lineLink: 'unlinked', menuUnlinkPending: false },
      menu: 'removed',
    });
    expect(text).not.toContain(LINE_AG1);

    // LINE はトークン発行と、元の ID の個別リンクの DELETE を 1 回ずつ。
    expect(lineCalls).toEqual([
      { method: 'POST', url: 'https://api.line.me/oauth2/v3/token' },
      { method: 'DELETE', url: `https://api.line.me/v2/bot/user/${LINE_AG1}/richmenu` },
    ]);
    // 合成根が config のチャネル ID とシークレットを取り違えずに渡し、発行したトークンで DELETE する。
    expect(tokenForms).toEqual([
      { grant_type: 'client_credentials', client_id: CHANNEL_ID, client_secret: CHANNEL_SECRET },
    ]);
    expect(deleteAuthorizations).toEqual([`Bearer ${FAKE_ACCESS_TOKEN}`]);
    expect(await linkColumns(OW_AG1)).toEqual({
      line_user_id: null,
      unlinked: true,
      menu_pending_line_user_id: null,
    });
    // 店舗の所有者は変わらない（1.6 の一端。網羅は DAL の試験が持つ）。
    const pool = await getPool();
    const store = await pool.query<{ owner_id: string }>('SELECT owner_id FROM stores WHERE id = $1', [S1]);
    expect(store.rows[0]?.owner_id).toBe(OW_AG1);

    expect(await auditRows(OW_AG1)).toEqual([
      { action: 'owner_line_unlinked', actor_type: 'agency', actor_id: DU_AG1, target_type: 'owner' },
    ]);
    expect(await auditRowsText(OW_AG1)).not.toContain(LINE_AG1);
    expect(logged.map((l) => [l.level, l.event])).toEqual([['info', 'dashboard-api.richmenu_unlinked']]);

    // 二度目: 既に解除済み・印なし。
    lineCalls = [];
    logged = [];
    const again = await post(`/owners/${OW_AG1}/unlink`, AG1_TOKEN);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({
      owner: { id: OW_AG1, lineLink: 'unlinked', menuUnlinkPending: false },
      menu: 'not_needed',
    });
    expect(lineCalls).toEqual([]);
    expect(logged).toEqual([]);
    expect(await auditRows(OW_AG1)).toHaveLength(1);
  });

  it('運営は他代理店のオーナーも解除でき、LINE の失敗は解除を取り消さず印を残し、外し直しで印が消える。監査は解除の 1 行だけ（1.1, 3.2, 3.3, 3.4, 7.3）', async () => {
    deleteStatus = 500;
    const res = await post(`/owners/${OW_AG2}/unlink`, OP_TOKEN);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text) as OwnerLineUnlinkResponse).toEqual({
      owner: { id: OW_AG2, lineLink: 'unlinked', menuUnlinkPending: true },
      menu: 'failed',
    });
    expect(text).not.toContain(LINE_AG2);
    expect(await linkColumns(OW_AG2)).toEqual({
      line_user_id: null,
      unlinked: true,
      menu_pending_line_user_id: LINE_AG2,
    });
    expect(logged.map((l) => [l.level, l.event, l.fields])).toEqual([
      ['warn', 'dashboard-api.richmenu_unlink_failed', { errorKind: 'http_error', status: 500 }],
    ]);
    expect(JSON.stringify(logged)).not.toContain(LINE_AG2);

    // 外し直し（同じルート）。今度は LINE が成功する。
    deleteStatus = 200;
    lineCalls = [];
    logged = [];
    const retry = await post(`/owners/${OW_AG2}/unlink`, OP_TOKEN);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({
      owner: { id: OW_AG2, lineLink: 'unlinked', menuUnlinkPending: false },
      menu: 'removed',
    });
    expect(lineCalls.map((c) => c.method)).toEqual(['POST', 'DELETE']);
    expect(await linkColumns(OW_AG2)).toEqual({
      line_user_id: null,
      unlinked: true,
      menu_pending_line_user_id: null,
    });

    expect(await auditRows(OW_AG2)).toEqual([
      { action: 'owner_line_unlinked', actor_type: 'operator', actor_id: DU_OP, target_type: 'owner' },
    ]);
  });

  it('トークン無しは 401 で、連携中のオーナーの状態を変えず LINE も呼ばない', async () => {
    const before = await linkColumns(OW_LINKED);
    expect(before).toEqual({ line_user_id: LINE_LINKED, unlinked: false, menu_pending_line_user_id: null });
    const res = await buildApp().request(`/owners/${OW_LINKED}/unlink`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(await linkColumns(OW_LINKED)).toEqual(before);
    expect(await auditRows(OW_LINKED)).toEqual([]);
    expect(lineCalls).toEqual([]);
  });
});
