import type { DailySummaryCompetitor } from '@fwlm/db';

/**
 * Go の日次バッチが書く「Google の評価が無い競合」（クチコミ 0 件・Issue #255）の形。
 *
 * Go が実際に書く形と、それを使うテストを同じ値で結ぶための定数である。結ぶ相手の要は次の 2 つで、
 * ほかのテスト（絞り込みの純関数やページ全体の検索のテストなど）も、評価の無い店の代表としてこの値を使う。
 * - `cross-runtime.e2e.test.ts`（node 環境・実 postgres）は、Go が実際に書いた行を
 *   `queryStoreDetail` で読み、競合一覧にこの値がそのまま含まれることを確かめる
 * - `store-page.test.tsx`（jsdom）は、この値を描画して「評価なし」と出ることを確かめる
 *
 * 描画のテストに DB を持ち込まない（jsdom と pg を 1 ファイルに混ぜると、CI にしか無い認証経路が
 * ローカルで一度も試されない）代わりに、Go の行を読むテストと、この値を使うテストが同じ形を検証している
 * ことを、型と値の両方で保証する。
 * 名前は go/internal/batch/crossruntime_test.go の固定データ（readyStore の 3 件目の競合）と一致させる。
 */
export const UNRATED_COMPETITOR_FROM_GO = {
  name: '競合サン',
  rating: null,
  reviewCount: 0,
  starDiff: null,
} as const satisfies DailySummaryCompetitor;
