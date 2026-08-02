// トークンスケールの恒久検証（ui-token-collision）。
//
// design.md「test/token-scales.test.ts」/ Requirements 1.1–1.3, 2.1, 2.2, 3.2, 3.3, 5.1–5.9。
//
// 本ファイルはタスク 1.1 で「基準線の自己確認」から始まり、タスク 2.1〜2.4 で
// 越境衝突・角丸の段差・トークン対応・注入対照へ拡張される。
import { describe, it, expect, beforeAll } from 'vitest';
import { APPS, compileStockBaseline } from './support/compile-app-css';

/**
 * 基準線の自己確認に用いる最小のプローブ。
 * Tailwind は参照されないテーマ変数を出力しないため、既定値の存在を確かめるには
 * その値を読むユーティリティを 1 つ以上生成させる必要がある。
 */
const BASELINE_SELF_CHECK_PROBES = ['max-w-md'] as const;

describe.each(APPS)(
  '$packageName の基準線コンパイルは素の Tailwind である（Requirements 1.3, 5.7）',
  (app) => {
    let baseline: string;

    beforeAll(async () => {
      baseline = await compileStockBaseline(app, BASELINE_SELF_CHECK_PROBES);
    });

    it('既定のコンテナ寸法スケールを出力する', () => {
      // 基準線が実際に Tailwind を読み込めていることの確認。空文字やエラー握り潰しで
      // 「差分ゼロ＝違反なし」という空振りの緑が出ることを防ぐ。
      expect(
        baseline,
        '基準線に既定のコンテナ寸法が現れません。素の Tailwind がコンパイルできていない可能性があります',
      ).toContain('--container-md: 28rem');
    });

    it('プロジェクト独自のトークンを含まない', () => {
      // theme.css を読み込んでいないことの確認。読み込んでしまうと基準線が現行と同一になり、
      // 越境衝突の差分が永久に 0 件になる（検出できないのに緑）。
      //
      // 照合先に `--color-primary` を選ぶ理由: Tailwind は **参照されないテーマ変数を出力しない**。
      // `--color-brand` は theme.css が宣言しているが `bg-brand` を使う部品が無いため現行の生成 CSS
      // にも現れず、これを照合先にすると「theme.css を読み込んでいても緑」という空振りになる
      // （実装時に実測で確認）。`--color-primary` は Button の `bg-primary` により現行では必ず
      // 出力されるため、差が出る照合先として成立する。
      expect(
        baseline,
        '基準線にプロジェクト独自の色トークンが現れました。theme.css を読み込んでいます',
      ).not.toContain('--color-primary');
    });

    it('プローブで指定したユーティリティを実際に出力する', () => {
      // `@source inline(...)` が効いていることの確認。効いていなければ以降の解決先検査は
      // 「対象が存在しない」ことを「違反なし」と取り違える。
      expect(
        baseline,
        'プローブで指定したユーティリティが生成されていません。@source inline が効いていません',
      ).toMatch(/\.max-w-md\s*\{/);
    });
  },
);
