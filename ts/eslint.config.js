// @ts-check
// ワークスペース共通の ESLint flat config（ESLint 9 / typescript-eslint 8）。
// 各パッケージの `lint` スクリプト（`eslint src`）は上位ディレクトリ探索で本設定を使用する。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // 生成物のみを除外する。以前は '**/*.config.*' も含めており、next/postcss/vitest/
    // playwright/eslint の設定 11 本がモノレポ全体で一度も lint されていなかった（Issue #66）。
    // scripts/check-config-lint-coverage.sh が再発を機械検証する。
    ignores: ['**/dist/**', '**/dist-scripts/**', '**/node_modules/**', '**/.next/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // typescript-eslint の eslint-recommended は `no-undef` を off にするが、その files は
    // **/*.ts|tsx|mts|cts に限られる。したがって .mjs/.cjs/.js では js.configs.recommended の
    // no-undef が生きており、Node のグローバルが未定義扱いになる。Issue #66 で
    // survey-web/perf/bundle-budget.mjs（CI で実行される）が lint 対象に入り、実測 7 件で露見した。
    // globals パッケージは直接依存に無いため、実際に使う識別子だけを列挙する。
    files: ['**/*.mjs', '**/*.cjs', '**/*.js'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' },
    },
  },
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
