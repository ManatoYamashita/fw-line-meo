// delivery-job のエントリ統合（Task 4.4）の一気通貫（E2E）テスト。
//
// フェイク LINE HTTP サーバー（node:http、line.test.ts と同じ依存追加なしの方式）+ 実 postgres
// （migrations 0001/0002/0004 適用済み。ts/scripts/with-test-db.sh または make ts-test-db 経由）で
// 「対象抽出→組立→Push→記録」の一気通貫実行を検証する。design.md 観察可能な完了条件:
// 「LINE モックとの一気通貫実行で正常・409・500 再送・クォータ・skip の記録が期待どおり残る」。
//
// 決定的な検証のため、readyTargets は index.ts 内で storeId 昇順にソートして処理される
// （runDeliveryJob の実装判断・CONCERNS 参照）。本テストの store_id は意図的に
// NORMAL < DUPLICATE < RETRY < FLEX_FAIL < QUOTA < AFTER_QUOTA の順に並ぶよう採番し、
// 「quota_exceeded 検知後の残対象が Push を一切試みず quota_exceeded 記録される」ことを
// 決定的に検証できるようにしている。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { closePool, getPool } from '@fwlm/db';
import { LineClient } from '../src/line.js';
import { runDeliveryJob } from '../src/index.js';

// --- フェイク LINE HTTP サーバー（line.test.ts と同方式）--------------------------------------

interface RecordedRequest {
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

// --- テストデータ（他テストファイルと DB を共有するため固有 UUID / place_id を使う）-------------

const OP = 'f0000000-0000-0000-0000-000000000001';
const AG = 'f0000000-0000-0000-0000-000000000002';

const OW_NORMAL = 'f0000000-0000-0000-0000-000000000011';
const OW_DUPLICATE = 'f0000000-0000-0000-0000-000000000012';
const OW_RETRY = 'f0000000-0000-0000-0000-000000000013';
const OW_FLEX_FAIL = 'f0000000-0000-0000-0000-000000000014';
const OW_QUOTA = 'f0000000-0000-0000-0000-000000000015';
const OW_AFTER_QUOTA = 'f0000000-0000-0000-0000-000000000016';
const OW_SKIP_NO_SUMMARY = 'f0000000-0000-0000-0000-000000000017';

// store_id を昇順採番して、runDeliveryJob 内のソート順（storeId 昇順）を決定的に固定する。
const ST_NORMAL = 'f1000000-0000-0000-0000-000000000001';
const ST_DUPLICATE = 'f1000000-0000-0000-0000-000000000002';
const ST_RETRY = 'f1000000-0000-0000-0000-000000000003';
const ST_FLEX_FAIL = 'f1000000-0000-0000-0000-000000000004';
const ST_QUOTA = 'f1000000-0000-0000-0000-000000000005';
const ST_AFTER_QUOTA = 'f1000000-0000-0000-0000-000000000006';
const ST_SKIP_NO_SUMMARY = 'f1000000-0000-0000-0000-000000000007';

// 他ファイル（targets.db.test.ts）が同一 postgres インスタンスを共有し hour=9/10・TODAY=2026-07-12
// で daily_summaries を作るため、targetsTotal の厳密件数比較が汚染されないよう衝突しない時刻を使う。
const TARGET_HOUR = 14;
const TODAY = '2026-07-12';
// resolveJstNow(NOW) === { hour: 14, date: '2026-07-12' }（UTC 5時 = JST 14時）。
const NOW = new Date('2026-07-12T05:00:00Z');

const lineUserId = (ownerId: string): string => `U-${ownerId}`;

/** 30KB 超の Flex Bubble を確実に作らせるための異常肥大化 competitors（buildDailySummaryFlex の
 * FlexBubbleTooLargeError を実データで誘発する。5件上限は Go 抽出パイプラインのアプリ制約であり
 * DB・flex.ts 自体には無いため、直接大量件数を書き込める）。 */
function oversizedCompetitorsJson(): string {
  const competitors = Array.from({ length: 400 }, (_, i) => ({
    name: `競合ストア番号${i}のとても長い名称サンプルテキストです`,
    rating: '4.2',
    reviewCount: 50,
    starDiff: '0.3',
  }));
  return JSON.stringify(competitors);
}

describe.skipIf(!process.env.DATABASE_URL)('delivery-job index.ts — 一気通貫（E2E）', () => {
  let server: FakeServer;

  beforeAll(async () => {
    const pool = await getPool();

    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, 'E2E運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [AG, OP, 'E2E代理店']);

    const owners = [
      OW_NORMAL,
      OW_DUPLICATE,
      OW_RETRY,
      OW_FLEX_FAIL,
      OW_QUOTA,
      OW_AFTER_QUOTA,
      OW_SKIP_NO_SUMMARY,
    ];
    for (const ownerId of owners) {
      await pool.query(
        'INSERT INTO owners (id, agency_id, line_user_id, onboarding_status, delivery_hour) VALUES ($1, $2, $3, $4, $5)',
        [ownerId, AG, lineUserId(ownerId), 'active', TARGET_HOUR],
      );
    }

    const stores: Array<[string, string, string]> = [
      [ST_NORMAL, OW_NORMAL, 'places/e2e-normal'],
      [ST_DUPLICATE, OW_DUPLICATE, 'places/e2e-duplicate'],
      [ST_RETRY, OW_RETRY, 'places/e2e-retry'],
      [ST_FLEX_FAIL, OW_FLEX_FAIL, 'places/e2e-flex-fail'],
      [ST_QUOTA, OW_QUOTA, 'places/e2e-quota'],
      [ST_AFTER_QUOTA, OW_AFTER_QUOTA, 'places/e2e-after-quota'],
      [ST_SKIP_NO_SUMMARY, OW_SKIP_NO_SUMMARY, 'places/e2e-skip-no-summary'],
    ];
    for (const [storeId, ownerId, placeId] of stores) {
      await pool.query(
        'INSERT INTO stores (id, owner_id, name, place_id, place_status) VALUES ($1, $2, $3, $4, $5)',
        [storeId, ownerId, `店舗 ${storeId}`, placeId, 'confirmed'],
      );
    }

    // 当日 daily_summaries: skip-no-summary 以外の全店舗に用意する（意図的に ST_SKIP_NO_SUMMARY のみ未挿入）。
    for (const storeId of [ST_NORMAL, ST_DUPLICATE, ST_RETRY, ST_QUOTA, ST_AFTER_QUOTA]) {
      await pool.query(
        `INSERT INTO daily_summaries (store_id, summary_date, status, rank, rank_total, rating, review_count, new_review_count)
         VALUES ($1, $2, 'ready', 1, 3, '4.5', 100, 0)`,
        [storeId, TODAY],
      );
    }
    // FlexBubbleTooLargeError を実データで誘発するための異常肥大化 competitors。
    await pool.query(
      `INSERT INTO daily_summaries (store_id, summary_date, status, rank, rank_total, rating, review_count, new_review_count, competitors)
       VALUES ($1, $2, 'ready', 1, 3, '4.5', 100, 0, $3::jsonb)`,
      [ST_FLEX_FAIL, TODAY, oversizedCompetitorsJson()],
    );

    // --- フェイク LINE サーバー: トークン発行は常に成功、Push は to（lineUserId）で分岐する ---
    const pushCallCounts = new Map<string, number>();
    server = await startFakeLineServer((record, res) => {
      if (record.url === '/oauth2/v3/token') {
        respondJson(res, 200, { token_type: 'Bearer', access_token: 'e2e-access-token', expires_in: 900 });
        return;
      }
      if (record.url === '/v2/bot/message/push') {
        const parsed = JSON.parse(record.body) as { to: string };
        const to = parsed.to;

        if (to === lineUserId(OW_NORMAL)) {
          respondJson(res, 200, { sentMessages: [{ id: '1' }] }, { 'X-Line-Request-Id': 'req-normal' });
          return;
        }
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
          respondJson(
            res,
            429,
            { message: 'You have reached your monthly limit.' },
            { 'X-Line-Request-Id': 'req-quota' },
          );
          return;
        }
        // OW_FLEX_FAIL（Flex組立失敗で push 未到達のはず）・OW_AFTER_QUOTA（quota早期終了で push
        // 未到達のはず）がここに来た場合は本テストの根幹アサーションが検出する「あってはならない」応答。
        respondJson(res, 200, { sentMessages: [] }, { 'X-Line-Request-Id': `req-unexpected-${to}` });
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

  afterEach(() => {
    // 各 it() は同じ DB 状態に対して runDeliveryJob を呼ぶため、2 回目以降は summary_deliveries
    // が既に存在し 'already_processed' になってしまう。本ファイルは意図的に it() を1つに絞り、
    // 全アサーションをその中で行う（複数 it 化による状態共有の複雑さを避ける）。
  });

  it('正常・409・500再送・クォータ早期終了（残対象のquota_exceeded記録含む）・skipの記録が期待どおり残る', async () => {
    const pool = await getPool();
    const lineClient = new LineClient(
      { channelId: 'test-channel-id', channelSecret: 'test-channel-secret' },
      {
        tokenEndpoint: `${server.url}/oauth2/v3/token`,
        pushEndpoint: `${server.url}/v2/bot/message/push`,
        backoffBaseMs: 5,
        backoffMaxMs: 50,
      },
    );

    const summary = await runDeliveryJob({
      pool,
      lineClient,
      liffUrl: 'https://liff.line.me/e2e-test-liff-id',
      now: () => NOW,
    });

    // --- 実行サマリー（構造化ログの元になる値）の件数検証 ---
    expect(summary.event).toBe('delivery-job.run');
    expect(summary.currentJstHour).toBe(TARGET_HOUR);
    expect(summary.summaryDate).toBe(TODAY);
    expect(summary.targetsTotal).toBe(7); // ready 6 + skip候補 1
    expect(summary.delivered).toBe(3); // normal, duplicate(409), retry(500→500→200)
    expect(summary.failed).toBe(1); // flex_fail
    expect(summary.quotaExceeded).toBe(2); // quota本人 + after_quota（残対象backfill）
    expect(summary.skipped).toBe(1); // skip_no_summary
    expect(summary.quotaExceededStopped).toBe(true);

    // --- summary_deliveries の実データ検証 ---
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
        [ST_NORMAL, ST_DUPLICATE, ST_RETRY, ST_FLEX_FAIL, ST_QUOTA, ST_AFTER_QUOTA, ST_SKIP_NO_SUMMARY],
      ],
    );
    const byStore = new Map(rows.rows.map((r) => [r.store_id, r]));

    const normal = byStore.get(ST_NORMAL);
    expect(normal?.status).toBe('delivered');
    expect(normal?.line_request_id).toBe('req-normal');
    expect(normal?.delivered_at).not.toBeNull();

    const duplicate = byStore.get(ST_DUPLICATE);
    expect(duplicate?.status).toBe('delivered');
    expect(duplicate?.line_request_id).toBe('req-duplicate');
    expect(duplicate?.delivered_at).not.toBeNull();

    const retry = byStore.get(ST_RETRY);
    expect(retry?.status).toBe('delivered');
    expect(retry?.line_request_id).toBe('req-retry-recovered');
    expect(retry?.delivered_at).not.toBeNull();

    const flexFail = byStore.get(ST_FLEX_FAIL);
    expect(flexFail?.status).toBe('failed');
    expect(flexFail?.error_detail).toContain('flex build failed');
    expect(flexFail?.delivered_at).toBeNull();

    const quota = byStore.get(ST_QUOTA);
    expect(quota?.status).toBe('quota_exceeded');
    expect(quota?.line_request_id).toBe('req-quota');
    expect(quota?.error_detail).toContain('monthly limit');

    const afterQuota = byStore.get(ST_AFTER_QUOTA);
    expect(afterQuota?.status).toBe('quota_exceeded');
    // 残対象backfill: push未到達のため line_request_id は付かない。
    expect(afterQuota?.line_request_id).toBeNull();
    expect(afterQuota?.error_detail).toContain('not attempted');

    const skipNoSummary = byStore.get(ST_SKIP_NO_SUMMARY);
    expect(skipNoSummary?.status).toBe('skipped_no_summary');
    expect(skipNoSummary?.line_request_id).toBeNull();

    // --- push 未到達の証明（決定的性質の核心）: OW_FLEX_FAIL / OW_AFTER_QUOTA 宛ての push
    // リクエストが実際に一度も発生していないことをフェイクサーバーの記録から直接検証する。
    const pushRequests = server.requests.filter((r) => r.url === '/v2/bot/message/push');
    const pushedTo = pushRequests.map((r) => (JSON.parse(r.body) as { to: string }).to);
    expect(pushedTo).not.toContain(lineUserId(OW_FLEX_FAIL));
    expect(pushedTo).not.toContain(lineUserId(OW_AFTER_QUOTA));

    // push リクエスト総数: normal(1) + duplicate(1) + retry(3: 500,500,200) + quota(1) = 6
    expect(pushRequests).toHaveLength(6);

    // Retry-Key はオーナーごとに異なる（reserveDelivery が毎回新規生成する）。
    const retryKeys = new Set(pushRequests.map((r) => r.headers['x-line-retry-key']));
    // normal/duplicate/quota は1回ずつ・retryは3回とも同一キー → ユニークキー数は 4。
    expect(retryKeys.size).toBe(4);
  });
});
