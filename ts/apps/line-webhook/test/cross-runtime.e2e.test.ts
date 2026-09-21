// クロスランタイム契約検証（line-on-demand-report tasks 2.5）— レポート用の読み出しの半分。
//
// go/internal/batch/crossruntime_test.go（Go 半分）が実 postgres に対して実際の batch.Run を実行し、
// daily_summaries を書き込む。本ファイルは別プロセス・別言語から同じ postgres へ接続し、line-webhook の
// レポートが使う読み出し（@fwlm/db の findLatestDailySummary・listDailySummariesEndingAt）でその行を読む。
// 配信と詳細画面の読込の同種の検証は、delivery-job と store-detail の cross-runtime.e2e.test.ts が受け持つ。
//
// 確かめるのは次の 3 つである。
//   - 口コミの帰属 3 項目（口コミを Google Maps で開く URL・投稿者のプロフィールの URL・画像の URL）:
//     Go は値のある口コミに 3 項目を書き、値の無い口コミにはキーごと書かない（3 項目を足す前に書かれた
//     行の要素と同じ形になる）。TS の読み出しが、どちらの要素もそのままの形で返すこと（Req 8.2・8.6・8.7）
//   - 新着口コミのレポート（tasks 3.11）: Go が書いた店舗と行から、レポート応答（ReportHandler）が実際の読み出しと
//     ビルダーで Reply を組み立てること。3 項目を持つ口コミは Go が受け取った URL のまま「Google Maps で見る」の
//     導線と投稿者の段に出し、持たない口コミは内容を出さずに件数にだけ数えること（Req 4.2・4.4・8.2・8.6・8.7）
//   - 30 日の窓: Go の削除（PurgeOlderThan）が実際に残した最古の行（基準日の 29 日前 = 30 日目）を、TS の
//     範囲の読み出し（listDailySummariesEndingAt）が同じ基準日の窓の中で返すこと（Req 6.7）。30 という値は
//     Go と TS の二重定義なので、Go が 30 日目の行まで消す食い違いと、範囲の読み出しの窓が Go より狭くなる
//     食い違いは、ここで赤になる。ここで検出できないものは次の 2 つで、どちらも packages/db の
//     report-reads.db.test.ts が関数ごとに 30 日目を返し 31 日目を返さないことで固定している
//       - TS の窓が広がる食い違い（31 日目の行は Go が消しているので、ここには残っていない）
//       - 最新の行の読み出し（findLatestDailySummary）の窓（Go は確定店舗すべてに当日の行を書くので、
//         この基準日で最も新しい行は常に当日の行になる）
//
// 基準日には、Go が行を書く固定日 2026-07-12 を渡す（実行日の日付を渡すと、窓の外になり 0 行を読む）。
// レポート応答へは、読み出しの基準日がその日になる時計（日本時間の 2026-07-12 の昼）を渡す。
//
// レポート応答は、Go が書いたオーナーの ID を直接渡して呼ぶ。Go の契約試験はオーナーを onboarding_status = 'active'
// で書き、振り分け口は 'store_identified' のオーナーだけをレポートへ渡すので、webhook からは通さない（webhook から
// DB と Reply までの通しは report-flow.db.test.ts が受け持つ）。レポート応答の店舗の読み出しは、オーナーの状態では
// なく確定店舗の有無で決まる。
//
// 実行方法: db/test/cross_runtime_steps.sh が Go 側テストの後に CROSS_RUNTIME_GO_SEEDED=1 付きで実行する。
// 通常の `pnpm -C ts run test` では前提データ（Go の書込み）が無いため無条件 skip する。
import { afterAll, describe, expect, it, vi } from 'vitest';
import { closePool, findLatestDailySummary, getPool, listDailySummariesEndingAt } from '@fwlm/db';
import type { DailySummaryNewReview } from '@fwlm/db';
import type { LineMessenger } from '../src/line/client.js';
import { GOOGLE_MAPS_LINK_TEXT, STORE_REVIEWS_LINK_TEXT } from '../src/report/builders/new-reviews.js';
import { ATTRIBUTION_TEXT } from '../src/report/format.js';
import { createReportHandler } from '../src/report/handler.js';

// go/internal/batch/crossruntime_test.go と一致させる固定識別子・日付・値（変更する場合は両ファイルを揃える）。
const READY_OWNER_ID = 'c7000000-0000-0000-0000-000000000011';
const READY_STORE_ID = 'c7100000-0000-0000-0000-000000000001';
const READY_STORE_NAME = 'クロスランタイム店舗（競合あり）';
/** Go の契約試験が行を書く日。レポートの基準日（日本時間の今日）として渡す。 */
const AS_OF = '2026-07-12';
/** 基準日の 29 日前。Go の削除が残す最古の日（30 日目）。 */
const DAY_30 = '2026-06-13';
/** Go が 30 日目の行へ書いた口コミ総数（行の取り違えを見分けるための値）。 */
const DAY_30_REVIEW_COUNT = 80;
/** 日本時間 2026-07-12 12:00。レポート応答の読み出しの基準日が AS_OF になる。 */
const NOON_OF_AS_OF_JST = new Date('2026-07-12T03:00:00Z');
/**
 * Go が readyStore の行へ書く、店舗の口コミ一覧を Google Maps で開く URL（Issue #303）。
 * go/internal/batch/crossruntime_test.go の crossRuntimeStoreReviewsURI と同じ値である。
 */
const STORE_REVIEWS_URI = 'https://www.google.com/maps/place//data=cross-runtime-reviews';

// 帰属 3 項目を持つ新着口コミ。型の注釈で、DailySummaryNewReview が 3 項目を持つことも固定する
// （型から項目が消えると、ここが型検査で落ちる）。
const ATTRIBUTED_REVIEW: DailySummaryNewReview = {
  authorName: 'テスト太郎',
  publishTime: '2026-07-12T01:00:00Z',
  rating: 5,
  textExcerpt: 'とても美味しかったです、また来ます',
  authorUri: 'https://www.google.com/maps/contrib/cross-runtime-author/reviews',
  authorPhotoUri: 'https://lh3.googleusercontent.com/a/cross-runtime-photo',
  googleMapsUri: 'https://www.google.com/maps/reviews/data=cross-runtime-review',
};

// 帰属 3 項目を持たない新着口コミ（3 項目を足す前に書かれた行の要素と同じ形）。
const UNATTRIBUTED_REVIEW: DailySummaryNewReview = {
  authorName: 'テスト花子',
  publishTime: '2026-07-12T02:00:00Z',
  rating: 4,
  textExcerpt: '落ち着いて食事ができました',
};

const goSideRan = process.env.CROSS_RUNTIME_GO_SEEDED === '1';

describe.skipIf(!process.env.DATABASE_URL || !goSideRan)(
  'line-webhook cross-runtime contract — Go が書いた daily_summaries をレポート用の読み出しが読む',
  () => {
    afterAll(async () => {
      await closePool();
    });

    it('最新の行の新着口コミを、帰属 3 項目を持つ要素と持たない要素のまま返す', async () => {
      const pool = await getPool();
      const row = await findLatestDailySummary(pool, READY_STORE_ID, AS_OF);
      if (row === null) {
        throw new Error('readyStore の daily_summaries 行がありません — Go 側の段が先に走っていますか');
      }

      expect(row.summary_date).toBe(AS_OF);
      expect(row.status).toBe('ready');
      // 店舗の口コミ一覧の URL（Issue #303）。Go が Places の googleMapsLinks.reviewsUri を加工せずに
      // 書いた値を、TS の読み出しがそのまま返す。
      expect(row.google_maps_reviews_uri).toBe(STORE_REVIEWS_URI);
      // 前日 90 件 → 当日 95 件。抜粋は前日の集計基準より後に投稿された 2 件。
      expect(row.new_review_count).toBe(5);
      expect(row.new_reviews).toHaveLength(2);

      const [attributed, unattributed] = row.new_reviews;
      if (attributed === undefined || unattributed === undefined) {
        throw new Error('新着口コミの抜粋が 2 件ありません');
      }

      // Go が受け取った 3 つの URL を、加工せずにそのまま返す。
      expect(attributed).toEqual(ATTRIBUTED_REVIEW);

      // 値の無い 3 項目は、null ではなくキーごと無い（Go の omitempty）。レポートはキーの有無で
      // 「導線を取得できているか」を判定するので、null や空文字が入っていても赤にする。
      expect(unattributed).toEqual(UNATTRIBUTED_REVIEW);
      expect(Object.keys(unattributed).sort()).toEqual(['authorName', 'publishTime', 'rating', 'textExcerpt']);
      expect('googleMapsUri' in unattributed).toBe(false);
      expect('authorUri' in unattributed).toBe(false);
      expect('authorPhotoUri' in unattributed).toBe(false);
    });

    it('Go の削除が残す最古の行（基準日の 29 日前・30 日目）を、同じ基準日の窓の中で返す', async () => {
      const pool = await getPool();
      // 基準日で終わる 30 暦日の範囲。Go は 30 日目と当日の行を残し、31 日目の行を消している
      // （Go 側の段がその状態を確かめてから終わる）。
      const rows = await listDailySummariesEndingAt(pool, READY_STORE_ID, AS_OF, 30, AS_OF);

      expect(rows.map((r) => r.summary_date)).toEqual([DAY_30, AS_OF]);
      expect(rows[0]?.review_count).toBe(DAY_30_REVIEW_COUNT);
    });

    it('Go が書いた最新の行から新着口コミのレポートを組み立て、帰属 3 項目を持つ口コミだけを Google Maps への導線つきで出す', async () => {
      const pool = await getPool();
      const reply = vi.fn<LineMessenger['reply']>(async () => {});
      const handler = createReportHandler({
        db: pool,
        messenger: { reply },
        liffStoreDetailUrl: 'https://liff.line.me/2000000000-crossrt',
        logger: { info: vi.fn(), warn: vi.fn() },
        now: () => NOON_OF_AS_OF_JST,
      });

      const outcome = await handler.handle({
        replyToken: 'reply-cross-runtime-new-reviews',
        ownerId: READY_OWNER_ID,
        request: { kind: 'new_reviews', storeId: null, page: 0 },
      });

      expect(outcome).toBe('report');
      expect(reply).toHaveBeenCalledTimes(1);
      const [replyToken, messages] = reply.mock.calls[0] ?? [];
      expect(replyToken).toBe('reply-cross-runtime-new-reviews');
      expect(messages).toHaveLength(1);
      const message = messages?.[0];
      if (message?.type !== 'flex' || !isRecord(message.contents)) {
        throw new Error('新着口コミのレポートが Flex で返っていません');
      }
      const bubble = message.contents;

      // 見出しは Go が書いた店舗の名前と行の日付、footer の最後は帰属表示。
      expect(textsOf(bubble.header)).toEqual([READY_STORE_NAME, '7月12日時点のデータ']);
      expect(textsOf(bubble.footer).at(-1)).toBe(ATTRIBUTION_TEXT);

      // 本文: Go が数えた新着 5 件、3 項目を持つ口コミ 1 件の内容、表示していない残り 4 件
      // （3 項目を持たない口コミも、Go が抜粋しなかった 3 件も、件数にだけ数える）。
      // 末尾は店舗の口コミ一覧への導線（Issue #303）— 内容を読めていない新着が 4 件残るためである。
      const bodyTexts = textsOf(bubble.body);
      expect(bodyTexts[0]).toBe('新着口コミ 5件（前日比）');
      expect(bodyTexts).toContain(ATTRIBUTED_REVIEW.authorName);
      expect(bodyTexts).toContain(ATTRIBUTED_REVIEW.textExcerpt);
      expect(bodyTexts.at(-2)).toBe('表示していない新着口コミがほかに4件あります。');
      expect(bodyTexts.at(-1)).toBe(STORE_REVIEWS_LINK_TEXT);

      // 導線は Go が受け取った URL のまま。口コミを Google Maps で開く導線と、投稿者のプロフィールへの導線、
      // そして店舗の口コミ一覧への導線。**これが Go の書込から LINE の部品までを一本で結ぶ唯一の試験である。**
      expect(uriActionsOf(bubble.body)).toEqual([
        { label: '投稿者のプロフィール', uri: ATTRIBUTED_REVIEW.authorUri },
        { label: GOOGLE_MAPS_LINK_TEXT, uri: ATTRIBUTED_REVIEW.googleMapsUri },
        { label: STORE_REVIEWS_LINK_TEXT, uri: STORE_REVIEWS_URI },
      ]);
      expect(imageUrlsOf(bubble.body)).toEqual([ATTRIBUTED_REVIEW.authorPhotoUri]);

      // 3 項目を持たない口コミは、投稿者名も本文も出さない（8.7）。
      const serialized = JSON.stringify(message);
      expect(serialized).not.toContain(UNATTRIBUTED_REVIEW.authorName);
      expect(serialized).not.toContain(UNATTRIBUTED_REVIEW.textExcerpt);
    });
  },
);

// --- Flex の中身を、ビルダーを経由せずに読む ------------------------------------------

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 部品を深さ優先・出現順にたどり、pick が返した値を集める。 */
function collect<T>(node: unknown, pick: (record: JsonRecord) => T | null): T[] {
  if (Array.isArray(node)) return node.flatMap((child) => collect(child, pick));
  if (!isRecord(node)) return [];
  const own = pick(node);
  return [...(own === null ? [] : [own]), ...Object.values(node).flatMap((child) => collect(child, pick))];
}

/** text 部品の文言。 */
function textsOf(node: unknown): string[] {
  return collect(node, (record) => (record.type === 'text' && typeof record.text === 'string' ? record.text : null));
}

/** uri アクションの label と uri。 */
function uriActionsOf(node: unknown): Array<{ label: unknown; uri: unknown }> {
  return collect(node, (record) => (record.type === 'uri' ? { label: record.label, uri: record.uri } : null));
}

/** image 部品の url。 */
function imageUrlsOf(node: unknown): unknown[] {
  return collect(node, (record) => (record.type === 'image' ? record.url : null));
}
