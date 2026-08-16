import { defineConfig, configDefaults } from 'vitest/config';

// vitest はユニット/コンポーネント/DB テストのみ。Playwright E2E（e2e/*.spec.ts）は除外する。
//
// eval/ も除外する。あちらは実 Gemini を叩いて従量課金が発生するため、通常の test で
// 走ってはならない（eval 側にも API キー未設定時の skip があるが、鍵がある環境で誤って
// 走らないよう、実行経路そのものを分けている）。実行は eval:factuality から。
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'e2e/**', 'eval/**'],
  },
});
