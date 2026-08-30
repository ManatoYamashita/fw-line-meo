// @ts-check
// ワークスペース共通の ESLint flat config（ESLint 9 / typescript-eslint 8）。
// 各パッケージの `lint` スクリプト（`eslint src`）は上位ディレクトリ探索で本設定を使用する。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // 生成物のみを除外する。以前は '**/*.config.*' も含めており、next/postcss/vitest/
    // playwright/eslint の設定がモノレポ全体で一度も lint されていなかった（Issue #78）。
    // この除外はファイル指定で eslint を直接叩いても効くため、lint スクリプトの引数へ
    // 足すだけでは決して届かない（走査そのものが行われない）。
    // scripts/check-test-code-coverage.sh が eslint 自身に問い合わせて再発を機械検証する。
    ignores: ['**/dist/**', '**/dist-scripts/**', '**/node_modules/**', '**/.next/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // typescript-eslint の eslint-recommended は no-undef を off にするが、その files は
    // **/*.ts|tsx|mts|cts に限られる。したがって .mjs/.cjs/.js では js.configs.recommended の
    // no-undef が生きている（Issue #78 で設定ファイル群が lint 対象に入り露見した）。
    //
    // 以前はここで globals を手書き列挙していた（console / process / URL の 3 つ）。その列挙は
    // 実測で「対象 6 ファイルにちょうど適合しているだけ」で余裕がなく、Buffer / setTimeout /
    // TextEncoder / fetch を 1 つ足すか .cjs を 1 本追加するだけで、require / module / exports /
    // __dirname が一斉に未定義扱いになった。失敗は 'Buffer' is not defined という形で出るため
    // **コードの誤りに見え**、原因が globals の列挙漏れであることは診断から読み取れない
    // （Issue #85）。列挙の陳腐化は本リポジトリが #33 / #51 / #78 で繰り返し踏んだ形である。
    //
    // no-undef は off にする。JS 系の未定義識別子は tsc が捕捉するため、この規則は二重化でしか
    // ない。実測: perf/bundle-budget.mjs から型の供給を外して tsc を走らせると、no-undef が
    // 挙げるのと同一の 7 箇所・3 識別子を TS2304 / TS2580 / TS2584 で報告する。逆に Buffer や
    // setTimeout のように @types/node が供給する識別子は tsc が緑を返す（= no-undef 側だけが
    // 誤って赤くしていた）。
    //
    // この前提は宣言ではなく機械強制されている。scripts/check-test-code-coverage.sh が
    // git 管理下の JS 系ファイルすべてに対し、先頭 3 行の @ts-check を要求し、@ts-nocheck を
    // 禁じ、tsc のプログラムに載っていることまで確認する。プラグマが失われた場合に赤くなるのは
    // 型検査ではなくそのガードであり、ここで no-undef を落としても検査の穴にはならない。
    files: ['**/*.mjs', '**/*.cjs', '**/*.js'],
    rules: { 'no-undef': 'off' },
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
