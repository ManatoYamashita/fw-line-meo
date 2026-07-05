// @ts-check
// ワークスペース共通の ESLint flat config（ESLint 9 / typescript-eslint 8）。
// 各パッケージの `lint` スクリプト（`eslint src`）は上位ディレクトリ探索で本設定を使用する。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.next/**', '**/*.config.*'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // 設計原則: TypeScript で any を禁止（Type Safety is Mandatory）。
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
