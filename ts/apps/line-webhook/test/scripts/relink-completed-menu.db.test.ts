// 完了後メニューの張り替えスクリプトの抽出を実 DB で確かめる試験（owner-line-unlink Requirement 3.5・
// design.md「GbpCallback・relink-completed-menu（変更）」）。
//
// 解除済みのオーナーは、店舗特定済み（onboarding_status = 'store_identified'）のまま残る。張り替えの抽出が
// 解除済みのオーナーを拾わないこと（抽出の SQL が返す行に含まれないこと）と、解除した元の LINE ユーザー ID
// （menu_pending_line_user_id に残る）へメニューを張らないことを、実 postgres の行で固定する。
// 偽の DB を使う relink-completed-menu.test.ts は SQL を実行しないので、述語の有無を検出できない。
//
// LINE は偽の fetch で置き換え、実 LINE には一切つながない。他の試験ファイルと同じ DB を共有するので、
// 試験の行はトランザクションの中で作り、最後にロールバックして残さない（他の試験から見えない）。
// 他の試験ファイルが作った店舗特定済みのオーナーも抽出に入るため、件数ではなく、試験の行の有無で判定する。
// UUID の接頭辞 4b は ts/ のどの試験も使っていない。DATABASE_URL が無ければ skip する。

import { afterAll, describe, expect, it } from 'vitest';
import { closePool, getPool, type Queryable } from '@fwlm/db';
import { buildCompletedRichMenu } from '../../scripts/rich-menu-definitions.js';
import { relinkCompletedMenu } from '../../scripts/relink-completed-menu.js';

const OP = '4b000000-0000-0000-0000-000000000001';
const AG = '4b000000-0000-0000-0000-000000000002';
const OWNER_LINKED = '4b100000-0000-0000-0000-000000000001';
const OWNER_UNLINKED = '4b100000-0000-0000-0000-000000000002';
const LINE_USER_LINKED = 'U4b00000000000000000000000000link';
/** 解除済みのオーナーの元の LINE ユーザー ID（完了後メニューをまだ外せていない印として残っている）。 */
const LINE_USER_UNLINKED_ORIGINAL = 'U4b0000000000000000000000000unlk';

const TOKEN_URL = 'https://api.line.me/oauth2/v3/token';
const NEW_MENU_ID = 'richmenu-4b-new-00000000000000000000';
const LIFF_STORE_DETAIL_URL = 'https://liff.line.me/2000000000-4bdetail';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 張り替えの全員が「張れた」になる偽の LINE。リンクした相手を記録する。 */
function createFakeLine(): { fetch: typeof fetch; linkedUsers: string[] } {
  const menu = buildCompletedRichMenu(LIFF_STORE_DETAIL_URL);
  const linkedUsers: string[] = [];

  const fakeFetch = (async (rawUrl: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(rawUrl);
    const method = init?.method ?? 'GET';
    if (url === TOKEN_URL) {
      return jsonResponse(200, { access_token: 'stateless-token-4b', expires_in: 900 });
    }
    if (url === `https://api.line.me/v2/bot/richmenu/${NEW_MENU_ID}` && method === 'GET') {
      return jsonResponse(200, { richMenuId: NEW_MENU_ID, ...menu });
    }
    const linkMatch = /^https:\/\/api\.line\.me\/v2\/bot\/user\/([^/]+)\/richmenu\/([^/]+)$/.exec(url);
    if (linkMatch && method === 'POST') {
      linkedUsers.push(decodeURIComponent(linkMatch[1]!));
      return jsonResponse(200, {});
    }
    if (/^https:\/\/api\.line\.me\/v2\/bot\/user\/[^/]+\/richmenu$/.test(url) && method === 'GET') {
      return jsonResponse(200, { richMenuId: NEW_MENU_ID });
    }
    if (/^https:\/\/api\.line\.me\/v2\/bot\/profile\/[^/]+$/.test(url) && method === 'GET') {
      return jsonResponse(200, { userId: 'x' });
    }
    throw new Error(`unexpected fetch call: ${method} ${url}`);
  }) as typeof fetch;

  return { fetch: fakeFetch, linkedUsers };
}

describe.skipIf(!process.env.DATABASE_URL)('relinkCompletedMenu の抽出（実 DB・Req 3.5）', () => {
  afterAll(async () => {
    await closePool();
  });

  it('解除済みのオーナーを抽出せず、元の LINE ユーザー ID へメニューを張らない', async () => {
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, 'relink-unlink運営']);
      await client.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
        AG,
        OP,
        'relink-unlink代理店',
      ]);
      await client.query(
        `INSERT INTO owners (id, agency_id, line_user_id, onboarding_status)
         VALUES ($1, $2, $3, 'store_identified')`,
        [OWNER_LINKED, AG, LINE_USER_LINKED],
      );
      // 解除済み: LINE ユーザー ID を持たず、店舗特定済みの段階のまま残る（Migration0018 の状態の表）。
      await client.query(
        `INSERT INTO owners
           (id, agency_id, line_user_id, onboarding_status, line_unlinked_at, menu_pending_line_user_id)
         VALUES ($1, $2, NULL, 'store_identified', now(), $3)`,
        [OWNER_UNLINKED, AG, LINE_USER_UNLINKED_ORIGINAL],
      );

      // 抽出の SQL が返した行そのものを記録する（スクリプト内の後段の絞り込みに隠れないようにする）。
      const extractedRows: Record<string, unknown>[] = [];
      const db = {
        query: async (text: string, values?: unknown[]) => {
          const result = await client.query(text, values);
          extractedRows.push(...(result.rows as Record<string, unknown>[]));
          return result;
        },
      } as unknown as Queryable;

      const line = createFakeLine();
      const summary = await relinkCompletedMenu(
        {
          channelId: 'test-channel-id',
          channelSecret: 'test-channel-secret',
          fetch: line.fetch,
          db,
          log: () => {},
        },
        { toRichMenuId: NEW_MENU_ID, deleteOldRichMenuId: null, dryRun: false },
      );

      expect(summary.ready).toBe(true);
      // 連携中のオーナーは従来どおり抽出され、張られる（対照）。
      expect(extractedRows.map((row) => row.line_user_id)).toContain(LINE_USER_LINKED);
      expect(line.linkedUsers).toContain(LINE_USER_LINKED);
      // 解除済みのオーナーは抽出の行に現れない。解除済みは LINE ユーザー ID を持たない（ck_owner_line_link）ので、
      // ID の無い行が 1 つでも返れば、解除済みを抽出したことになる。
      expect(extractedRows.filter((row) => row.line_user_id === null)).toEqual([]);
      // 元の LINE ユーザー ID へは張らない。
      expect(extractedRows.map((row) => row.line_user_id)).not.toContain(LINE_USER_UNLINKED_ORIGINAL);
      expect(line.linkedUsers).not.toContain(LINE_USER_UNLINKED_ORIGINAL);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
