// クロスランタイム契約検証（Task 7.1）— TS 半分。
//
// go/internal/batch/crossruntime_test.go（Go 半分）が実 postgres に対して REAL な
// batch.Run（cmd/daily-batch/main.go が使うのと同じ関数）を実行し、フェイク Places 相手に
// daily_summaries を書き込む。本ファイルは「別プロセス・別言語」から同じ postgres インスタンスへ
// 接続し、REAL な runDeliveryJob（index.ts の main() が使うのと同じ関数）でその行を読み取り・
// Flex 組立・フェイク LINE への Push・summary_deliveries への記録まで一気通貫で行う。
//
// 「言語間の結合は SQL スキーマのみ」（design.md Architecture Integration）が実際に成立している
// ことの証明であり、db/test/assertions（0004 の CHECK/UNIQUE 検証）や個別タスクの単体テスト
// （3.5 の run_test.go・4.4 の index.e2e.test.ts）が別々に確認済みの「各言語が自分の書いた/
// SQLで直接シードしたデータを正しく扱えること」とは異なる性質を検証する:
// Go が実際に書いた JSONB（competitors・new_reviews）を TS が実際に読み、フィールド名・JSON型
// （数値 or 文字列）の想定が一致しているかどうか。
//
// 実行方法: db/test/cross_runtime_steps.sh が
//   1. Go 側テスト（go test ./internal/batch/... -run TestCrossRuntimeContract）を先に実行し、
//   2. 直後に本ファイルを CROSS_RUNTIME_GO_SEEDED=1 付きで実行する
// という順序を保証する（同一 DATABASE_URL・同一 postgres インスタンス）。
//
// 本ファイルは通常の `make ts-test-db` / `pnpm -C ts run test` の一部としても vitest に発見される
// （test/*.test.ts の既定 glob に一致するため）。しかしそれらの実行では Go 側の書込みステップが
// 走っていないため、CROSS_RUNTIME_GO_SEEDED が立っていない限り無条件に skip する
// （describe.skipIf(!process.env.DATABASE_URL) と同じ「前提が無ければ自動 skip」の方針を踏襲。
// 通常スイートを cross-runtime データ不在で失敗させないための必須ガード）。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePool, getPool } from '@fwlm/db';
import type { DailySummaryRow } from '@fwlm/db';
import { LineClient } from '../src/line.js';
import { runDeliveryJob } from '../src/index.js';

// go/internal/batch/crossruntime_test.go と一致させる固定識別子・配信時刻（変更する場合は両ファイルを揃える）。
const READY_STORE_ID = 'c7100000-0000-0000-0000-000000000001';
const NOCOMP_STORE_ID = 'c7100000-0000-0000-0000-000000000002';
const READY_LINE_USER_ID = 'U-cross-runtime-ready';
const NOCOMP_LINE_USER_ID = 'U-cross-runtime-nocomp';
const CROSS_RUNTIME_DELIVERY_HOUR = 17;
const TODAY = '2026-07-12';
// resolveJstNow(NOW) === { hour: 17, date: '2026-07-12' }（UTC 8時 = JST 17時）。
const NOW = new Date('2026-07-12T08:00:00Z');

// --- フェイク LINE HTTP サーバー（line.test.ts・index.e2e.test.ts と同方式） -----------------

interface RecordedRequest {
  readonly url: string | undefined;
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
        const record: RecordedRequest = { url: req.url, body: Buffer.concat(chunks).toString('utf8') };
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

// CROSS_RUNTIME_GO_SEEDED 未設定時は前提データ（Go 側書込み）が無いため無条件 skip する。
const goSideRan = process.env.CROSS_RUNTIME_GO_SEEDED === '1';

describe.skipIf(!process.env.DATABASE_URL || !goSideRan)(
  'delivery-job cross-runtime contract — Go が書いた daily_summaries を TS が読み配信する',
  () => {
    let server: FakeServer;

    beforeAll(async () => {
      server = await startFakeLineServer((record, res) => {
        if (record.url === '/oauth2/v3/token') {
          respondJson(res, 200, { token_type: 'Bearer', access_token: 'cross-runtime-token', expires_in: 900 });
          return;
        }
        if (record.url === '/v2/bot/message/push') {
          const parsed = JSON.parse(record.body) as { to: string };
          respondJson(res, 200, { sentMessages: [{ id: '1' }] }, { 'X-Line-Request-Id': `req-${parsed.to}` });
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

    it('Go が書いた daily_summaries 行がそのまま存在し、TS の型が想定する形と一致する', async () => {
      const pool = await getPool();

      const res = await pool.query<DailySummaryRow>(
        `SELECT id, store_id, summary_date, status, rank, rank_total, rank_prev,
                rating, review_count, rating_prev, review_count_prev,
                new_review_count, new_reviews, competitors, created_at
           FROM daily_summaries WHERE store_id = $1 AND summary_date = $2`,
        [READY_STORE_ID, TODAY],
      );
      expect(res.rows).toHaveLength(1);
      const summary = res.rows[0];
      if (summary === undefined) {
        throw new Error('readyStore daily_summaries row not found — did the Go half run first?');
      }

      // --- Go が書いた値そのものの検証（別プロセス・別言語で書かれた行を TS が正しく読めること） ---
      expect(summary.status).toBe('ready');
      expect(summary.rank).toBe(1);
      expect(summary.rank_total).toBe(3);
      expect(summary.new_review_count).toBe(5);

      // --- JSONB 契約の実データ検証（本タスクの核心）: pg の jsonb パーサは Go の encoding/json が
      // 出力した JSON 数値をそのまま JS number として返す。competitors[].rating/starDiff・
      // new_reviews[].rating は「文字列ではなく number」でなければならない。
      //
      // 発見した契約バグ（本タスクで修正・CONCERNS 参照）: 修正前の
      // ts/packages/db/src/types.ts は DailySummaryCompetitor.rating / .starDiff を
      // `string | null` と宣言していた。これは daily_summaries.rating などの「テーブル直下の
      // numeric 列は pg ドライバが文字列として返す」という規約（types.ts 冒頭コメント）を、
      // JSONB の中にネストされた数値フィールドにも誤って適用したものだった。JSONB 内の数値は
      // pg 側ではなく Go の encoding/json → jsonb パーサ経由であり、この規約は適用されない
      // （実際には JS number のまま）。型注釈と実行時の値が食い違っていた。
      expect(summary.competitors).toHaveLength(2);
      const [comp1, comp2] = summary.competitors;
      if (comp1 === undefined || comp2 === undefined) {
        throw new Error('expected 2 competitors');
      }
      expect(typeof comp1.rating).toBe('number');
      expect(typeof comp1.starDiff).toBe('number');
      expect(typeof comp1.reviewCount).toBe('number');
      // 表示順は rank 順（Go run.go の displayOrder）: 競合イチ(4.0) が 競合ニ(3.8) より上位。
      expect(comp1.name).toBe('競合イチ');
      expect(comp1.rating).toBe(4.0);
      expect(comp1.reviewCount).toBe(50);
      expect(comp1.starDiff).toBeCloseTo(0.5, 5); // 自店4.5 - 競合4.0
      expect(comp2.name).toBe('競合ニ');
      expect(comp2.starDiff).toBeCloseTo(0.7, 5); // 自店4.5 - 競合3.8

      expect(summary.new_reviews.length).toBeGreaterThanOrEqual(1);
      const review = summary.new_reviews[0];
      if (review === undefined) {
        throw new Error('expected at least 1 new review excerpt');
      }
      expect(typeof review.rating).toBe('number');
      expect(review.rating).toBe(5);
      expect(review.authorName).toBe('テスト太郎');
      expect(review.textExcerpt).toContain('美味しかった');
      // Go の time.Time は encoding/json で RFC3339 文字列として出力される（publishTime: string）。
      expect(typeof review.publishTime).toBe('string');
      expect(new Date(review.publishTime).toISOString()).toBe('2026-07-12T01:00:00.000Z');

      // --- R1.3 の 0 件競合分岐: Go が書いた competitors は `[]`（null ではない）でなければ
      // ならない（flex.ts の buildCompetitorsSection は `summary.competitors.length === 0` を
      // 判定条件にしており、null が来ると TypeError で落ちる）。
      const nocompRes = await pool.query<DailySummaryRow>(
        `SELECT id, store_id, summary_date, status, rank, rank_total, rank_prev,
                rating, review_count, rating_prev, review_count_prev,
                new_review_count, new_reviews, competitors, created_at
           FROM daily_summaries WHERE store_id = $1 AND summary_date = $2`,
        [NOCOMP_STORE_ID, TODAY],
      );
      expect(nocompRes.rows).toHaveLength(1);
      const nocompSummary = nocompRes.rows[0];
      if (nocompSummary === undefined) {
        throw new Error('nocompStore daily_summaries row not found');
      }
      expect(nocompSummary.status).toBe('no_competitors');
      expect(Array.isArray(nocompSummary.competitors)).toBe(true);
      expect(nocompSummary.competitors).toHaveLength(0);
    });

    it('実 runDeliveryJob が Go 産の daily_summaries を読み Flex を組立て Push・記録まで一気通貫で行う', async () => {
      const pool = await getPool();
      const lineClient = new LineClient(
        { channelId: 'cross-runtime-channel-id', channelSecret: 'cross-runtime-channel-secret' },
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
        liffUrl: 'https://liff.line.me/cross-runtime-test-liff-id',
        now: () => NOW,
      });

      expect(summary.currentJstHour).toBe(CROSS_RUNTIME_DELIVERY_HOUR);
      expect(summary.summaryDate).toBe(TODAY);
      // readyStore・nocompStore はどちらも daily_summaries 行を持つ（nocompStore は
      // status='no_competitors' だが行自体は存在する — R1.3「競合0件でも自店のみのサマリーを
      // 配信する」ため、queryOwnersDueWithoutSummary の skip 候補（daily_summaries が丸ごと
      // 無い場合のみ）には該当せず、通常の配信対象として処理される）。よって両方 delivered。
      // 本テストが使う hour=17 は他ファイル（targets.db.test.ts=9/10・index.e2e.test.ts=14）と
      // 衝突しないよう意図的に選んだため、少なくとも2件は delivered に含まれるはず。
      expect(summary.delivered).toBeGreaterThanOrEqual(2); // readyStore + nocompStore

      // --- readyStore: delivered として記録され、実際に LINE へ push リクエストが飛んでいること ---
      const deliveryRes = await pool.query<{
        status: string;
        line_request_id: string | null;
        delivered_at: Date | null;
      }>(
        `SELECT status, line_request_id, delivered_at FROM summary_deliveries WHERE store_id = $1 AND summary_date = $2`,
        [READY_STORE_ID, TODAY],
      );
      expect(deliveryRes.rows).toHaveLength(1);
      const delivery = deliveryRes.rows[0];
      if (delivery === undefined) {
        throw new Error('readyStore summary_deliveries row not found');
      }
      expect(delivery.status).toBe('delivered');
      expect(delivery.line_request_id).toBe(`req-${READY_LINE_USER_ID}`);
      expect(delivery.delivered_at).not.toBeNull();

      const pushedTo = server.requests
        .filter((r) => r.url === '/v2/bot/message/push')
        .map((r) => (JSON.parse(r.body) as { to: string }).to);
      expect(pushedTo).toContain(READY_LINE_USER_ID);

      // --- nocompStore（status='no_competitors'・competitors=[]）も同様に delivered すること
      // （R1.3: 競合0件でも自店のみのサマリーを配信する。flex.ts の buildCompetitorsSection が
      // 空配列を例外なく「競合が見つかっていません」表示へ縮退させることの実データ証明）。
      const nocompDeliveryRes = await pool.query<{ status: string }>(
        `SELECT status FROM summary_deliveries WHERE store_id = $1 AND summary_date = $2`,
        [NOCOMP_STORE_ID, TODAY],
      );
      expect(nocompDeliveryRes.rows).toHaveLength(1);
      expect(nocompDeliveryRes.rows[0]?.status).toBe('delivered');

      const pushedToNocomp = server.requests
        .filter((r) => r.url === '/v2/bot/message/push')
        .map((r) => (JSON.parse(r.body) as { to: string }).to);
      expect(pushedToNocomp).toContain(NOCOMP_LINE_USER_ID);
    });
  },
);
