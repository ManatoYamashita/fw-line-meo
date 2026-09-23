// クロスランタイム契約検証 — TS 半分（配信ジョブ）。
//
// go/internal/batch/crossruntime_test.go（Go 半分）が実 postgres に対して REAL な
// batch.Run（cmd/daily-batch/main.go が使うのと同じ関数）を実行し、フェイク Places 相手に
// daily_summaries を書き込む。本ファイルは「別プロセス・別言語」から同じ postgres インスタンスへ
// 接続し、REAL な runDeliveryJob（index.ts の main() が使うのと同じ関数）でその行を読み取り・
// 判定・偽の LINE への Push・summary_deliveries への記録まで一気通貫で行う。
//
// 「言語間の結合は SQL スキーマのみ」（design.md Architecture Integration）が実際に成立している
// ことの証明であり、db/test/assertions（CHECK/UNIQUE の検証）や個別タスクの単体テストが別々に
// 確認済みの「各言語が自分の書いた / SQL で直接シードしたデータを正しく扱えること」とは異なる
// 性質を検証する: Go が実際に書いた JSONB（competitors・new_reviews）と評価・順位の列を TS が
// 実際に読み、フィールド名・JSON 型（数値 or 文字列）・評価なしの表し方（null）の想定が一致して
// いるかどうか。
//
// line-on-demand-report（tasks 4.5）で、旧来の日次カードの配信から**変化があった日の通知**へ
// 改めた。したがってここで固定するのは次の 3 つである。
//   - 変化があった日（新着口コミ 5 件）の店舗へ通知が出ること
//   - 競合比較できない店舗（競合なし・評価を持つ競合なし）へ通知が出ず、理由つきで記録されること
//   - 評価なしの競合を含む行で、判定が**正規化後の順位母数**を使うこと（競合の件数ではない）
//
// store-suspension（tasks 7.1・Requirements 4.3, 4.5）で、停止中の店舗を足した。Go の段はこの店舗の
// 取得も集計も行わない。配信の段は、同じ店舗を対象にも見送りの候補にもせず、通知記録を 1 行も残さない
// ことを確かめる（集計が無い店舗なので、見送りの候補の述語が停止を見ていなければ skipped_no_summary が残る）。
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
import { encodeReportPostback } from '@fwlm/line-report';
import { LineClient } from '../src/line.js';
import { runDeliveryJob } from '../src/index.js';

// go/internal/batch/crossruntime_test.go と一致させる固定識別子・配信時刻（変更する場合は両ファイルを揃える）。
const READY_STORE_ID = 'c7100000-0000-0000-0000-000000000001';
const NOCOMP_STORE_ID = 'c7100000-0000-0000-0000-000000000002';
const UNRATED_STORE_ID = 'c7100000-0000-0000-0000-000000000003';
const READY_LINE_USER_ID = 'U-cross-runtime-ready';
const NOCOMP_LINE_USER_ID = 'U-cross-runtime-nocomp';
const UNRATED_LINE_USER_ID = 'U-cross-runtime-unrated';
// 停止中の店舗（store-suspension tasks 7.1）。
const SUSPENDED_STORE_ID = 'c7100000-0000-0000-0000-000000000004';
const SUSPENDED_LINE_USER_ID = 'U-cross-runtime-suspended';
const CROSS_RUNTIME_DELIVERY_HOUR = 17;
const TODAY = '2026-07-12';
// resolveJstNow(NOW) === { hour: 17, date: '2026-07-12' }（UTC 8時 = JST 17時）。
const NOW = new Date('2026-07-12T08:00:00Z');

/** 設定された完了後メニューの ID（env LINE_RICHMENU_COMPLETED_ID に相当）。 */
const COMPLETED_RICH_MENU_ID = 'richmenu-cross-runtime-completed';

// --- 偽の LINE（node:http。line.test.ts・index.e2e.test.ts と同方式） -----------------------

interface RecordedRequest {
  readonly method: string | undefined;
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
        const record: RecordedRequest = {
          method: req.method,
          url: req.url,
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

// CROSS_RUNTIME_GO_SEEDED 未設定時は前提データ（Go 側書込み）が無いため無条件 skip する。
const goSideRan = process.env.CROSS_RUNTIME_GO_SEEDED === '1';

describe.skipIf(!process.env.DATABASE_URL || !goSideRan)(
  'delivery-job cross-runtime contract — Go が書いた daily_summaries を TS が読み通知する',
  () => {
    let server: FakeServer;

    beforeAll(async () => {
      server = await startFakeLineServer((record, res) => {
        const url = record.url ?? '';

        if (url === '/oauth2/v3/token') {
          respondJson(res, 200, { token_type: 'Bearer', access_token: 'cross-runtime-token', expires_in: 900 });
          return;
        }
        // 完了後メニューの準備判定（レポート 3 導線を持つ）。
        if (record.method === 'GET' && url === `/v2/bot/richmenu/${COMPLETED_RICH_MENU_ID}`) {
          respondJson(res, 200, readyRichMenuBody());
          return;
        }
        // オーナーのメニューの照会（既に完了後メニューを見ている）。
        if (record.method === 'GET' && url.startsWith('/v2/bot/user/') && url.endsWith('/richmenu')) {
          respondJson(res, 200, { richMenuId: COMPLETED_RICH_MENU_ID });
          return;
        }
        if (url === '/v2/bot/message/push') {
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
      // 前日の自店スナップショットがある日だけ、新着の判定に載る（通知の 1.1 が読む列）。
      expect(summary.review_count_prev).toBe(90);

      // --- JSONB 契約の実データ検証（本タスクの核心）: pg の jsonb パーサは Go の encoding/json が
      // 出力した JSON 数値をそのまま JS number として返す。competitors[].rating/starDiff・
      // new_reviews[].rating は「文字列ではなく number」でなければならない。
      //
      // 発見した契約バグ（修正済み・competitive-daily-summary task 7.1）: 修正前の
      // ts/packages/db/src/types.ts は DailySummaryCompetitor.rating / .starDiff を
      // `string | null` と宣言していた。これは daily_summaries.rating などの「テーブル直下の
      // numeric 列は pg ドライバが文字列として返す」という規約（types.ts 冒頭コメント）を、
      // JSONB の中にネストされた数値フィールドにも誤って適用したものだった。
      expect(summary.competitors).toHaveLength(3);
      const [comp1, comp2, comp3] = summary.competitors;
      if (comp1 === undefined || comp2 === undefined || comp3 === undefined) {
        throw new Error('expected 3 competitors');
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

      // Issue #255: Google の評価が無い競合（クチコミ 0 件）は比較集合に入らず（rank_total は 3 のまま）、
      // 評価のある競合の後ろに並ぶ。rating・starDiff はキーを持ったまま JSON の null（0 ではない）。
      expect(comp3).toEqual({ name: '競合サン', rating: null, reviewCount: 0, starDiff: null });
      expect(Object.keys(comp3).sort()).toEqual(['name', 'rating', 'reviewCount', 'starDiff']);

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

      // --- 競合 0 件の店舗: Go が書いた competitors は `[]`（null ではない）でなければならない。
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

      // --- 評価を持つ競合が 1 店も無い店舗（tasks 4.5）: 競合の一覧は 1 件あるが、順位母数は
      // 自店だけの 1 である。**件数と母数が食い違う行**であり、判定がどちらを読んでいるかを
      // 次の it が分ける。
      const unratedRes = await pool.query<DailySummaryRow>(
        `SELECT id, store_id, summary_date, status, rank, rank_total, rank_prev,
                rating, review_count, rating_prev, review_count_prev,
                new_review_count, new_reviews, competitors, created_at
           FROM daily_summaries WHERE store_id = $1 AND summary_date = $2`,
        [UNRATED_STORE_ID, TODAY],
      );
      expect(unratedRes.rows).toHaveLength(1);
      const unratedSummary = unratedRes.rows[0];
      if (unratedSummary === undefined) {
        throw new Error('unratedStore daily_summaries row not found');
      }
      expect(unratedSummary.status).toBe('ready');
      expect(unratedSummary.rank).toBe(1);
      expect(unratedSummary.rank_total).toBe(1);
      expect(unratedSummary.competitors).toHaveLength(1);
      expect(unratedSummary.competitors[0]?.rating).toBeNull();
      // 新着はある。したがって「変化が無いから送らない」ではないことを、次の it が理由で見分ける。
      expect(unratedSummary.new_review_count).toBe(2);
    });

    it('実 runDeliveryJob が Go 産の行を読み、変化があった店舗へ通知し、比較できない店舗は理由つきで記録する', async () => {
      const pool = await getPool();
      const lineClient = new LineClient(
        { channelId: 'cross-runtime-channel-id', channelSecret: 'cross-runtime-channel-secret' },
        {
          apiBaseUrl: server.url,
          tokenEndpoint: `${server.url}/oauth2/v3/token`,
          pushEndpoint: `${server.url}/v2/bot/message/push`,
          backoffBaseMs: 5,
          backoffMaxMs: 50,
        },
      );

      const summary = await runDeliveryJob({
        pool,
        lineClient,
        completedRichMenuId: COMPLETED_RICH_MENU_ID,
        now: () => NOW,
      });

      expect(summary.currentJstHour).toBe(CROSS_RUNTIME_DELIVERY_HOUR);
      expect(summary.summaryDate).toBe(TODAY);
      expect(summary.reportMenuReady).toBe(true);
      // この配信時刻を使うのは Go 側が seed した 4 店舗だけである（他の試験ファイルは 7・9・10・11・14）。
      // そのうち停止中の 1 店舗は対象にも見送りの候補にもならないので、対象は 3 件である。
      expect(summary.targetsTotal).toBe(3);
      // 当日の集計が無い店舗は停止中の 1 店舗だけであり、それを見送りとして数えない（store-suspension 4.3）。
      expect(summary.skipped).toBe(0);
      expect(summary.delivered).toBe(1); // readyStore だけが変化のあった店舗
      expect(summary.failed).toBe(0);
      // 競合なし（nocompStore）と、評価を持つ競合なし（unratedStore）。どちらも比較できない。
      expect(summary.skippedNotComparable).toBe(2);
      expect(summary.skippedNoChange).toBe(0);
      expect(summary.skippedMenuUnavailable).toBe(0);

      // --- readyStore: delivered として記録され、実際に LINE へ push が飛んでいること ---
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

      // 通知の中身: Go が書いた新着件数（5 件）と店舗名、メニューの導線、帰属表示。
      const readyPush = server.requests.find(
        (r) => r.url === '/v2/bot/message/push' && (JSON.parse(r.body) as { to: string }).to === READY_LINE_USER_ID,
      );
      if (readyPush === undefined) {
        throw new Error('readyStore push request not found');
      }
      const flexTexts = collectFlexTexts(JSON.parse(readyPush.body));
      expect(
        flexTexts.some((text) => text.includes('「クロスランタイム店舗（競合あり）」で新着口コミが5件ありました。')),
      ).toBe(true);
      expect(flexTexts.some((text) => text.includes('新着口コミをみる'))).toBe(true);
      expect(flexTexts).toContain('データ提供: Google Maps');

      // --- 競合なしの店舗（status='no_competitors'・competitors=[]）: 通知は出さず、理由を残す ---
      const nocompDeliveryRes = await pool.query<{ status: string; error_detail: string | null }>(
        `SELECT status, error_detail FROM summary_deliveries WHERE store_id = $1 AND summary_date = $2`,
        [NOCOMP_STORE_ID, TODAY],
      );
      expect(nocompDeliveryRes.rows).toHaveLength(1);
      expect(nocompDeliveryRes.rows[0]?.status).toBe('skipped_not_comparable');
      expect(pushedTo).not.toContain(NOCOMP_LINE_USER_ID);

      // --- 評価を持つ競合が無い店舗: 競合の一覧は 1 件あるが、順位母数は 1 である。
      // 判定が**正規化後の母数**（1）ではなく競合の件数（1 件＋自店＝2）を読んでいれば、
      // この店舗は比較可能になり新着 2 件の通知が出てしまう。出ないことと、記録された理由が
      // 「変化なし」ではなく「比較不能」であることの両方を固定する。
      const unratedDeliveryRes = await pool.query<{ status: string; error_detail: string | null }>(
        `SELECT status, error_detail FROM summary_deliveries WHERE store_id = $1 AND summary_date = $2`,
        [UNRATED_STORE_ID, TODAY],
      );
      expect(unratedDeliveryRes.rows).toHaveLength(1);
      expect(unratedDeliveryRes.rows[0]?.status).toBe('skipped_not_comparable');
      expect(unratedDeliveryRes.rows[0]?.error_detail).toContain('not comparable');
      expect(pushedTo).not.toContain(UNRATED_LINE_USER_ID);

      // 送ったのは 1 通だけ（比較できない 2 店へは 1 度も送っていない）。
      expect(pushedTo).toHaveLength(1);

      // --- 停止中の店舗（store-suspension 4.3, 4.5）: Go が取得の対象から外したのと同じ停止状態を配信も
      // 参照し、送信も見送りも記録しない。前提（確定済み・停止中・同じ配信時刻のオーナー・当日の集計なし）を
      // 先に確かめ、不在の表明が空振りしないようにする。
      const suspendedStoreRes = await pool.query<{ suspended: boolean; delivery_hour: number; has_summary: boolean }>(
        `SELECT s.suspended_at IS NOT NULL AS suspended, o.delivery_hour,
                EXISTS (SELECT 1 FROM daily_summaries ds WHERE ds.store_id = s.id) AS has_summary
           FROM stores s JOIN owners o ON o.id = s.owner_id
          WHERE s.id = $1 AND s.place_status = 'confirmed'`,
        [SUSPENDED_STORE_ID],
      );
      expect(suspendedStoreRes.rows).toEqual([
        { suspended: true, delivery_hour: CROSS_RUNTIME_DELIVERY_HOUR, has_summary: false },
      ]);
      const suspendedDeliveryRes = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM summary_deliveries WHERE store_id = $1`,
        [SUSPENDED_STORE_ID],
      );
      expect(suspendedDeliveryRes.rows[0]?.n).toBe(0);
      expect(pushedTo).not.toContain(SUSPENDED_LINE_USER_ID);
    });
  },
);
