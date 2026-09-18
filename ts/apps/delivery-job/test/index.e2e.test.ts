// delivery-job の編成（tasks 4.4）の一気通貫（E2E）テスト。
//
// 偽の LINE（node:http。line.test.ts と同じ依存追加なしの方式。push とリッチメニューの照会・
// リンクに応える）と実 postgres（migrations 適用済み。ts/scripts/with-test-db.sh 経由）で、
// 「準備判定 → 予約 → 判定 → （送らないなら理由つきで記録）→ 通知 → オーナーの照合 → push → 記録」
// の順の編成を検証する。tasks 4.4 の観察可能な完了条件:
// 「変化があった日の送信、変化なしと比較不能の記録、準備判定の不成立で送らないこと、照合で
//  リンクしてから送ること、張れなければ送らないこと、同じ日の再実行で重複しないこと、変化の
//  無い実行でも準備判定の結果が実行サマリーに出ること」。
//
// 決定的な検証のため、配信可能対象は index.ts 内で storeId 昇順に処理される。本テストの store_id は
// 意図的に NORMAL < LINK < LINK_FAIL < NO_CHANGE < NOT_COMPARABLE < BUILD_FAIL < DUPLICATE <
// RETRY < QUOTA < AFTER_QUOTA の順に並ぶよう採番し、「上限超過の検知後は残りの対象へ push を
// 一切試みない」ことを決定的に検証できるようにしている。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePool, getPool } from '@fwlm/db';
import type { LogFields } from '@fwlm/observability';
import { encodeReportPostback } from '@fwlm/line-report';
import { LineClient } from '../src/line.js';
import { runDeliveryJob } from '../src/index.js';
import type { DeliveryJobLogger } from '../src/index.js';

// --- 偽の LINE（node:http。line.test.ts・cross-runtime.e2e.test.ts と同方式）--------------------

interface RecordedRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

interface FakeServer {
  readonly url: string;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

function startFakeLineServer(handler: (record: RecordedRequest, res: ServerResponse) => void): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const record: RecordedRequest = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        requests.push(record);
        handler(record, res);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise<void>((res2) => server.close(() => res2())),
      });
    });
  });
}

function respondJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** 送信本文の JSON から Flex の text をすべて集める（構造に依存しない検査用）。 */
function collectFlexTexts(node: unknown): string[] {
  if (node === null || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(collectFlexTexts);
  const obj = node as Record<string, unknown>;
  const own = obj['type'] === 'text' && typeof obj['text'] === 'string' ? [obj['text']] : [];
  return [...own, ...Object.values(obj).flatMap(collectFlexTexts)];
}

// --- 記録の捕捉（事象名と項目を検証する。識別子を載せていないことも見る）-----------------------

interface RecordedLog {
  readonly level: 'info' | 'warn' | 'error';
  readonly event: string;
  readonly fields: LogFields | undefined;
}

function createCapturingLogger(): { readonly logger: DeliveryJobLogger; readonly logs: RecordedLog[] } {
  const logs: RecordedLog[] = [];
  const logger: DeliveryJobLogger = {
    info(event, fields) {
      logs.push({ level: 'info', event, fields });
    },
    warn(event, fields) {
      logs.push({ level: 'warn', event, fields });
    },
    isolatedError(message, storeId, err) {
      logs.push({
        level: 'error',
        event: 'delivery-job.isolated_error',
        fields: { detail: message, storeId, errorKind: err instanceof Error ? err.name : 'UnknownError' },
      });
    },
    fatal(message, err) {
      logs.push({
        level: 'error',
        event: 'delivery-job.fatal',
        fields: { detail: message, errorKind: err instanceof Error ? err.name : 'UnknownError' },
      });
    },
  };
  return { logger, logs };
}

// --- 試験データ（他の試験ファイルと DB を共有するため固有 UUID / place_id を使う）-------------

const OP = 'f0000000-0000-0000-0000-000000000001';
const AG = 'f0000000-0000-0000-0000-000000000002';

const OW_NORMAL = 'f0000000-0000-0000-0000-000000000011';
const OW_LINK = 'f0000000-0000-0000-0000-000000000012';
const OW_LINK_FAIL = 'f0000000-0000-0000-0000-000000000013';
const OW_NO_CHANGE = 'f0000000-0000-0000-0000-000000000014';
const OW_NOT_COMPARABLE = 'f0000000-0000-0000-0000-000000000015';
const OW_BUILD_FAIL = 'f0000000-0000-0000-0000-000000000016';
const OW_DUPLICATE = 'f0000000-0000-0000-0000-000000000017';
const OW_RETRY = 'f0000000-0000-0000-0000-000000000018';
const OW_QUOTA = 'f0000000-0000-0000-0000-000000000019';
const OW_AFTER_QUOTA = 'f0000000-0000-0000-0000-00000000001a';
const OW_SKIP_NO_SUMMARY = 'f0000000-0000-0000-0000-00000000001b';
const OW_MENU_NOT_READY = 'f0000000-0000-0000-0000-00000000001c';

// store_id を昇順に採番して、index.ts のソート順（storeId 昇順）を決定的に固定する。
const ST_NORMAL = 'f1000000-0000-0000-0000-000000000001';
const ST_LINK = 'f1000000-0000-0000-0000-000000000002';
const ST_LINK_FAIL = 'f1000000-0000-0000-0000-000000000003';
const ST_NO_CHANGE = 'f1000000-0000-0000-0000-000000000004';
const ST_NOT_COMPARABLE = 'f1000000-0000-0000-0000-000000000005';
const ST_BUILD_FAIL = 'f1000000-0000-0000-0000-000000000006';
const ST_DUPLICATE = 'f1000000-0000-0000-0000-000000000007';
const ST_RETRY = 'f1000000-0000-0000-0000-000000000008';
const ST_QUOTA = 'f1000000-0000-0000-0000-000000000009';
const ST_AFTER_QUOTA = 'f1000000-0000-0000-0000-00000000000a';
const ST_SKIP_NO_SUMMARY = 'f1000000-0000-0000-0000-00000000000b';
const ST_MENU_NOT_READY = 'f1000000-0000-0000-0000-00000000000c';

// 他ファイル（targets.db.test.ts は 9/10/11・cross-runtime.e2e.test.ts は 17・line-webhook の
// report-flow.db.test.ts は 7）が同一 postgres を共有するため、件数の厳密比較が汚れない時刻を使う。
const TARGET_HOUR = 14;
const NOT_READY_HOUR = 15;
const TODAY = '2026-07-12';
const YESTERDAY = '2026-07-11';
// resolveJstNow(NOW) === { hour: 14, date: '2026-07-12' }（UTC 5時 = JST 14時）。
const NOW = new Date('2026-07-12T05:00:00Z');
const NOW_NOT_READY = new Date('2026-07-12T06:00:00Z');

/** 設定された完了後メニューの ID（env LINE_RICHMENU_COMPLETED_ID に相当）。 */
const COMPLETED_RICH_MENU_ID = 'richmenu-e2e-completed';
/** オーナーが見ている別のメニュー（張り替えの対象になる形）。 */
const OTHER_RICH_MENU_ID = 'richmenu-e2e-onboarding';

const lineUserId = (ownerId: string): string => `U-${ownerId}`;

/** 30KB を超える通知を作らせる店舗名（組立の失敗を実データで誘発する。`stores.name` は text で長さ制約が無い）。 */
const OVERSIZED_STORE_NAME = 'あ'.repeat(11_000);

/** レポート 3 導線を持つ完了後メニューの応答（`GET /v2/bot/richmenu/{id}`）。 */
function readyRichMenuBody(): unknown {
  return {
    richMenuId: COMPLETED_RICH_MENU_ID,
    areas: (['new_reviews', 'comparison', 'trend'] as const).map((kind) => ({
      bounds: { x: 0, y: 0, width: 833, height: 843 },
      action: { type: 'postback', data: encodeReportPostback({ kind, storeId: null, page: 0 }) },
    })),
  };
}

/** レポート導線を持たない旧メニューの応答（差し替え前の状態）。 */
function staleRichMenuBody(): unknown {
  return {
    richMenuId: COMPLETED_RICH_MENU_ID,
    areas: [{ bounds: { x: 0, y: 0, width: 2500, height: 843 }, action: { type: 'message', text: 'ステータス確認' } }],
  };
}

describe.skipIf(!process.env.DATABASE_URL)('delivery-job index.ts — 通知の編成の一気通貫（E2E）', () => {
  let server: FakeServer;
  // 準備判定の応答を実行ごとに切り替える（差し替え前＝旧メニューの状態を作るため）。
  let menuReady = true;

  const newClient = (): LineClient =>
    new LineClient(
      { channelId: 'test-channel-id', channelSecret: 'test-channel-secret' },
      {
        apiBaseUrl: server.url,
        tokenEndpoint: `${server.url}/oauth2/v3/token`,
        pushEndpoint: `${server.url}/v2/bot/message/push`,
        backoffBaseMs: 5,
        backoffMaxMs: 50,
      },
    );

  const pushRequests = (): RecordedRequest[] => server.requests.filter((r) => r.url === '/v2/bot/message/push');
  const pushedUserIds = (): string[] => pushRequests().map((r) => (JSON.parse(r.body) as { to: string }).to);

  beforeAll(async () => {
    const pool = await getPool();

    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, 'E2E運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [AG, OP, 'E2E代理店']);

    const owners: Array<[string, number]> = [
      [OW_NORMAL, TARGET_HOUR],
      [OW_LINK, TARGET_HOUR],
      [OW_LINK_FAIL, TARGET_HOUR],
      [OW_NO_CHANGE, TARGET_HOUR],
      [OW_NOT_COMPARABLE, TARGET_HOUR],
      [OW_BUILD_FAIL, TARGET_HOUR],
      [OW_DUPLICATE, TARGET_HOUR],
      [OW_RETRY, TARGET_HOUR],
      [OW_QUOTA, TARGET_HOUR],
      [OW_AFTER_QUOTA, TARGET_HOUR],
      [OW_SKIP_NO_SUMMARY, TARGET_HOUR],
      [OW_MENU_NOT_READY, NOT_READY_HOUR],
    ];
    for (const [ownerId, hour] of owners) {
      await pool.query(
        'INSERT INTO owners (id, agency_id, line_user_id, onboarding_status, delivery_hour) VALUES ($1, $2, $3, $4, $5)',
        [ownerId, AG, lineUserId(ownerId), 'store_identified', hour],
      );
    }

    const stores: Array<[string, string, string]> = [
      [ST_NORMAL, OW_NORMAL, '通知店舗ノーマル'],
      [ST_LINK, OW_LINK, '通知店舗リンク'],
      [ST_LINK_FAIL, OW_LINK_FAIL, '通知店舗リンク失敗'],
      [ST_NO_CHANGE, OW_NO_CHANGE, '通知店舗変化なし'],
      [ST_NOT_COMPARABLE, OW_NOT_COMPARABLE, '通知店舗比較不能'],
      [ST_BUILD_FAIL, OW_BUILD_FAIL, OVERSIZED_STORE_NAME],
      [ST_DUPLICATE, OW_DUPLICATE, '通知店舗重複'],
      [ST_RETRY, OW_RETRY, '通知店舗再送'],
      [ST_QUOTA, OW_QUOTA, '通知店舗上限'],
      [ST_AFTER_QUOTA, OW_AFTER_QUOTA, '通知店舗上限後'],
      [ST_SKIP_NO_SUMMARY, OW_SKIP_NO_SUMMARY, '通知店舗集計なし'],
      [ST_MENU_NOT_READY, OW_MENU_NOT_READY, '通知店舗メニュー未準備'],
    ];
    for (const [storeId, ownerId, name] of stores) {
      await pool.query(
        'INSERT INTO stores (id, owner_id, name, place_id, place_status) VALUES ($1, $2, $3, $4, $5)',
        [storeId, ownerId, name, `places/e2e-${storeId}`, 'confirmed'],
      );
    }

    // 当日の集計。新着 2 件・比較可能（順位 1/3）＝「変化があった日」の形にする。
    // review_count_prev が値を持つ日だけが新着の判定に載る（前日の自店スナップショットがある日）。
    const notifyStores = [
      ST_NORMAL,
      ST_LINK,
      ST_LINK_FAIL,
      ST_BUILD_FAIL,
      ST_DUPLICATE,
      ST_RETRY,
      ST_QUOTA,
      ST_AFTER_QUOTA,
      ST_MENU_NOT_READY,
    ];
    for (const storeId of notifyStores) {
      await pool.query(
        `INSERT INTO daily_summaries
           (store_id, summary_date, status, rank, rank_total, rank_prev, rating, review_count, rating_prev, review_count_prev, new_review_count)
         VALUES ($1, $2, 'ready', 1, 3, 1, '4.5', 102, '4.5', 100, 2)`,
        [storeId, TODAY],
      );
    }
    // 変化なし: 比較可能だが新着 0 件で、前日の順位も同じ。
    await pool.query(
      `INSERT INTO daily_summaries
         (store_id, summary_date, status, rank, rank_total, rank_prev, rating, review_count, rating_prev, review_count_prev, new_review_count)
       VALUES ($1, $2, 'ready', 1, 3, 1, '4.5', 100, '4.5', 100, 0)`,
      [ST_NO_CHANGE, TODAY],
    );
    await pool.query(
      `INSERT INTO daily_summaries
         (store_id, summary_date, status, rank, rank_total, rank_prev, rating, review_count, rating_prev, review_count_prev, new_review_count)
       VALUES ($1, $2, 'ready', 1, 3, 1, '4.5', 100, '4.5', 100, 0)`,
      [ST_NO_CHANGE, YESTERDAY],
    );
    // 比較不能: 競合が 1 件も無い日（順位母数 1）。新着があっても送らない。
    await pool.query(
      `INSERT INTO daily_summaries
         (store_id, summary_date, status, rank, rank_total, rating, review_count, review_count_prev, new_review_count)
       VALUES ($1, $2, 'no_competitors', 1, 1, '4.5', 102, 100, 2)`,
      [ST_NOT_COMPARABLE, TODAY],
    );
    // ST_SKIP_NO_SUMMARY は当日の集計を意図的に持たない（06:00 のバッチ失敗に相当）。

    // --- 偽の LINE: トークン発行・push・リッチメニューの照会とリンクに応える ---
    const pushCallCounts = new Map<string, number>();
    server = await startFakeLineServer((record, res) => {
      const url = record.url ?? '';

      if (url === '/oauth2/v3/token') {
        respondJson(res, 200, { token_type: 'Bearer', access_token: 'e2e-access-token', expires_in: 900 });
        return;
      }

      // 完了後メニューの準備判定。
      if (record.method === 'GET' && url === `/v2/bot/richmenu/${COMPLETED_RICH_MENU_ID}`) {
        respondJson(res, 200, menuReady ? readyRichMenuBody() : staleRichMenuBody());
        return;
      }

      // オーナーのメニューの照会。
      if (record.method === 'GET' && url.startsWith('/v2/bot/user/') && url.endsWith('/richmenu')) {
        const userId = decodeURIComponent(url.slice('/v2/bot/user/'.length, -'/richmenu'.length));
        if (userId === lineUserId(OW_LINK)) {
          res.writeHead(404);
          res.end();
          return;
        }
        if (userId === lineUserId(OW_LINK_FAIL)) {
          respondJson(res, 200, { richMenuId: OTHER_RICH_MENU_ID });
          return;
        }
        respondJson(res, 200, { richMenuId: COMPLETED_RICH_MENU_ID });
        return;
      }

      // オーナーへのリンク。
      if (record.method === 'POST' && url.startsWith('/v2/bot/user/') && url.includes('/richmenu/')) {
        const userId = decodeURIComponent(url.slice('/v2/bot/user/'.length, url.indexOf('/richmenu/')));
        if (userId === lineUserId(OW_LINK_FAIL)) {
          respondJson(res, 500, { message: 'Internal Server Error' });
          return;
        }
        respondJson(res, 200, {});
        return;
      }

      if (url === '/v2/bot/message/push') {
        const to = (JSON.parse(record.body) as { to: string }).to;

        if (to === lineUserId(OW_DUPLICATE)) {
          respondJson(res, 409, { message: 'The retry key is already accepted' }, { 'X-Line-Request-Id': 'req-duplicate' });
          return;
        }
        if (to === lineUserId(OW_RETRY)) {
          const count = (pushCallCounts.get(to) ?? 0) + 1;
          pushCallCounts.set(to, count);
          if (count <= 2) {
            respondJson(res, 500, { message: 'Internal Server Error' });
          } else {
            respondJson(res, 200, { sentMessages: [] }, { 'X-Line-Request-Id': 'req-retry-recovered' });
          }
          return;
        }
        if (to === lineUserId(OW_QUOTA)) {
          respondJson(res, 429, { message: 'You have reached your monthly limit.' }, { 'X-Line-Request-Id': 'req-quota' });
          return;
        }
        // 送ってはならない相手（組立失敗・上限超過後・張れなかったオーナー・メニュー未準備）が
        // ここへ来た場合は、下のアサーションが検出する。
        respondJson(res, 200, { sentMessages: [{ id: '1' }] }, { 'X-Line-Request-Id': `req-${to}` });
        return;
      }

      res.writeHead(404);
      res.end();
    });
  });

  afterAll(async () => {
    await server.close();
    await closePool();
  });

  it('変化があった日は送り、送らない日は理由つきで記録し、照合してから送り、同じ日の再実行で重複しない', async () => {
    const pool = await getPool();
    const first = createCapturingLogger();

    // --- 1 回目の実行（完了後メニューは準備済み） ---
    menuReady = true;
    const summary = await runDeliveryJob({
      pool,
      lineClient: newClient(),
      completedRichMenuId: COMPLETED_RICH_MENU_ID,
      now: () => NOW,
      logger: first.logger,
    });

    expect(summary.event).toBe('delivery-job.run');
    expect(summary.currentJstHour).toBe(TARGET_HOUR);
    expect(summary.summaryDate).toBe(TODAY);
    expect(summary.reportMenuReady).toBe(true);
    expect(summary.targetsTotal).toBe(11); // 配信可能 10 ＋ 当日の集計が無い 1
    expect(summary.delivered).toBe(4); // normal・link・duplicate(409)・retry(500→500→200)
    expect(summary.failed).toBe(1); // build_fail（30KB 超過）
    expect(summary.quotaExceeded).toBe(2); // quota 本人 ＋ after_quota（残対象）
    expect(summary.quotaExceededStopped).toBe(true);
    expect(summary.skipped).toBe(1); // 当日の集計が無い
    expect(summary.skippedNoChange).toBe(1);
    expect(summary.skippedNotComparable).toBe(1);
    expect(summary.skippedMenuUnavailable).toBe(1); // 張れなかったオーナー
    // すべての対象が、送信・失敗・上限・理由つきの見送りのいずれかに数えられている
    // （本番の読み取り確認の判定と同じ数え方）。
    expect(
      summary.delivered +
        summary.failed +
        summary.quotaExceeded +
        summary.skipped +
        summary.skippedNoChange +
        summary.skippedNotComparable +
        summary.skippedMenuUnavailable,
    ).toBe(summary.targetsTotal);

    // --- summary_deliveries の実データ ---
    const rows = await pool.query<{
      store_id: string;
      status: string;
      line_request_id: string | null;
      error_detail: string | null;
      delivered_at: Date | null;
    }>(
      `SELECT store_id, status, line_request_id, error_detail, delivered_at
         FROM summary_deliveries WHERE summary_date = $1 AND store_id = ANY($2)`,
      [
        TODAY,
        [
          ST_NORMAL,
          ST_LINK,
          ST_LINK_FAIL,
          ST_NO_CHANGE,
          ST_NOT_COMPARABLE,
          ST_BUILD_FAIL,
          ST_DUPLICATE,
          ST_RETRY,
          ST_QUOTA,
          ST_AFTER_QUOTA,
          ST_SKIP_NO_SUMMARY,
        ],
      ],
    );
    const byStore = new Map(rows.rows.map((r) => [r.store_id, r]));

    expect(byStore.get(ST_NORMAL)?.status).toBe('delivered');
    expect(byStore.get(ST_NORMAL)?.line_request_id).toBe(`req-${lineUserId(OW_NORMAL)}`);
    expect(byStore.get(ST_NORMAL)?.delivered_at).not.toBeNull();

    expect(byStore.get(ST_LINK)?.status).toBe('delivered');
    expect(byStore.get(ST_DUPLICATE)?.status).toBe('delivered');
    expect(byStore.get(ST_DUPLICATE)?.line_request_id).toBe('req-duplicate');
    expect(byStore.get(ST_RETRY)?.status).toBe('delivered');
    expect(byStore.get(ST_RETRY)?.line_request_id).toBe('req-retry-recovered');

    // 送らなかった日も、理由を status で残す（silent drop にしない）。
    expect(byStore.get(ST_NO_CHANGE)?.status).toBe('skipped_no_change');
    expect(byStore.get(ST_NO_CHANGE)?.delivered_at).toBeNull();
    expect(byStore.get(ST_NOT_COMPARABLE)?.status).toBe('skipped_not_comparable');
    expect(byStore.get(ST_LINK_FAIL)?.status).toBe('skipped_menu_unavailable');
    expect(byStore.get(ST_SKIP_NO_SUMMARY)?.status).toBe('skipped_no_summary');

    // 組立の失敗は、そのオーナーだけの失敗として残す。理由まで固定する（接頭辞だけを見ると、
    // 別の例外で落ちた実行も同じ文言になり、30KB 超過の経路を一度も通らないまま緑になる）。
    expect(byStore.get(ST_BUILD_FAIL)?.status).toBe('failed');
    expect(byStore.get(ST_BUILD_FAIL)?.error_detail).toMatch(
      /^notification build failed: Flex bubble size \d+ bytes exceeds limit 30000 bytes$/,
    );

    expect(byStore.get(ST_QUOTA)?.status).toBe('quota_exceeded');
    expect(byStore.get(ST_QUOTA)?.line_request_id).toBe('req-quota');
    expect(byStore.get(ST_AFTER_QUOTA)?.status).toBe('quota_exceeded');
    expect(byStore.get(ST_AFTER_QUOTA)?.line_request_id).toBeNull();

    // --- 送った相手と送らなかった相手 ---
    const pushed = pushedUserIds();
    expect(pushed).toContain(lineUserId(OW_NORMAL));
    expect(pushed).toContain(lineUserId(OW_LINK));
    // 送ってはならない相手（理由つきで見送った・組立に失敗した・上限超過の後）。
    expect(pushed).not.toContain(lineUserId(OW_NO_CHANGE));
    expect(pushed).not.toContain(lineUserId(OW_NOT_COMPARABLE));
    expect(pushed).not.toContain(lineUserId(OW_LINK_FAIL));
    expect(pushed).not.toContain(lineUserId(OW_BUILD_FAIL));
    expect(pushed).not.toContain(lineUserId(OW_AFTER_QUOTA));
    // normal(1) + link(1) + duplicate(1) + retry(3) + quota(1) = 7
    expect(pushRequests()).toHaveLength(7);

    // --- 通知の中身（旧来の日次カードではなく、変化の 2 文と帰属表示） ---
    const normalPush = pushRequests().find((r) => (JSON.parse(r.body) as { to: string }).to === lineUserId(OW_NORMAL));
    if (normalPush === undefined) {
      throw new Error('normal store push request not found');
    }
    const texts = collectFlexTexts(JSON.parse(normalPush.body));
    expect(texts.some((t) => t.includes('「通知店舗ノーマル」で新着口コミが2件ありました。'))).toBe(true);
    expect(texts.some((t) => t.includes('新着口コミをみる'))).toBe(true);
    expect(texts).toContain('データ提供: Google Maps');

    // --- 照合してから送る（2.8: どの経路でも最初の通知より前に完了後メニュー） ---
    const linkIndex = server.requests.findIndex(
      (r) => r.method === 'POST' && (r.url ?? '').startsWith(`/v2/bot/user/${lineUserId(OW_LINK)}/richmenu/`),
    );
    const linkPushIndex = server.requests.findIndex(
      (r) => r.url === '/v2/bot/message/push' && (JSON.parse(r.body) as { to: string }).to === lineUserId(OW_LINK),
    );
    expect(linkIndex).toBeGreaterThanOrEqual(0);
    expect(linkPushIndex).toBeGreaterThan(linkIndex);

    // 既に完了後メニューを見ているオーナーには張り直さない（照会だけ）。
    const relinkNormal = server.requests.filter(
      (r) => r.method === 'POST' && (r.url ?? '').startsWith(`/v2/bot/user/${lineUserId(OW_NORMAL)}/richmenu/`),
    );
    expect(relinkNormal).toHaveLength(0);

    // --- 準備判定は実行ごとに 1 回だけ照会する ---
    const readinessLookups = server.requests.filter(
      (r) => r.method === 'GET' && r.url === `/v2/bot/richmenu/${COMPLETED_RICH_MENU_ID}`,
    );
    expect(readinessLookups).toHaveLength(1);

    // --- 記録 ---
    const events = first.logs.map((l) => l.event);
    expect(events.filter((e) => e === 'delivery-job.richmenu_linked')).toHaveLength(1);
    expect(events.filter((e) => e === 'delivery-job.richmenu_link_failed')).toHaveLength(1);
    expect(events).not.toContain('delivery-job.report_menu_not_ready');
    // 記録に LINE ユーザー ID を載せない。
    const loggedJson = JSON.stringify(first.logs);
    for (const ownerId of [OW_NORMAL, OW_LINK, OW_LINK_FAIL]) {
      expect(loggedJson).not.toContain(lineUserId(ownerId));
    }

    // --- 2 回目の実行（同じ日・同じ時刻）: 対象が無く、push も増えない ---
    const pushCountAfterFirst = pushRequests().length;
    const rerun = createCapturingLogger();
    const second = await runDeliveryJob({
      pool,
      lineClient: newClient(),
      completedRichMenuId: COMPLETED_RICH_MENU_ID,
      now: () => NOW,
      logger: rerun.logger,
    });

    expect(second.targetsTotal).toBe(0);
    expect(second.delivered).toBe(0);
    expect(second.skippedNoChange).toBe(0);
    expect(second.skippedNotComparable).toBe(0);
    expect(second.skippedMenuUnavailable).toBe(0);
    // 変化の無い（対象の無い）実行でも、準備判定の結果は実行サマリーに出る。
    expect(second.reportMenuReady).toBe(true);
    expect(pushRequests()).toHaveLength(pushCountAfterFirst);
    // 対象が 1 件も無くても、準備判定の照会は 1 回行われる。
    expect(
      server.requests.filter((r) => r.method === 'GET' && r.url === `/v2/bot/richmenu/${COMPLETED_RICH_MENU_ID}`),
    ).toHaveLength(2);

    // --- 3 回目の実行（完了後メニューがレポート導線を持たない＝差し替え前の状態） ---
    menuReady = false;
    const notReady = createCapturingLogger();
    const third = await runDeliveryJob({
      pool,
      lineClient: newClient(),
      completedRichMenuId: COMPLETED_RICH_MENU_ID,
      now: () => NOW_NOT_READY,
      logger: notReady.logger,
    });

    expect(third.currentJstHour).toBe(NOT_READY_HOUR);
    expect(third.reportMenuReady).toBe(false);
    expect(third.targetsTotal).toBe(1);
    expect(third.delivered).toBe(0);
    expect(third.skippedMenuUnavailable).toBe(1);
    expect(pushedUserIds()).not.toContain(lineUserId(OW_MENU_NOT_READY));
    // 準備判定の不成立は、実行ごとに 1 回だけ記録する。
    expect(notReady.logs.filter((l) => l.event === 'delivery-job.report_menu_not_ready')).toHaveLength(1);

    const notReadyRow = await pool.query<{ status: string; error_detail: string | null }>(
      'SELECT status, error_detail FROM summary_deliveries WHERE store_id = $1 AND summary_date = $2',
      [ST_MENU_NOT_READY, TODAY],
    );
    expect(notReadyRow.rows[0]?.status).toBe('skipped_menu_unavailable');
  });
});
