import { defineConfig } from 'vitest/config';

// 事実性評価（Issue #132）専用の設定。通常の vitest.config.ts は eval/ を除外しているため、
// 評価はこの設定を明示したときだけ走る（`pnpm run eval:factuality`）。
//
// 実 Gemini を叩いて従量課金が発生する。評価本体にも GEMINI_API_KEY 未設定なら skip する
// 防御があり、実行経路の分離と合わせて二重になっている。
export default defineConfig({
  test: {
    include: ['eval/**/*.eval.test.ts'],
    // 素材 12 件 × EVAL_RUNS 回を 1 テスト内で直列に回すため、既定の 5 秒では到底足りない。
    testTimeout: 10 * 60 * 1000,
    hookTimeout: 60 * 1000,
  },
});
