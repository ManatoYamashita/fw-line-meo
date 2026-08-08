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

      // 意図的に使わない引数は `_` 接頭辞で示す、という既存の慣習を規則として明文化する
      // （リポジトリ全体で 20 箇所以上採用されている）。位置引数は「使わないから消す」が
      // できない（後続の引数の位置が動く）ため、命名で意図を示す以外の手段がない。
      // Issue #70 でテストコードが lint の対象に入り、この慣習が規則化されていない
      // ことが露見した。捕捉した例外変数も同じ扱いにする。
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
);
