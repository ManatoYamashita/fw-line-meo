# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# ケース間で共有する合成ツリーの組み立て（Issue #90）。
#
# run.sh が tier に関わらず必ず読み込む。tier ごとのケースファイルへ同じツリーを二重に
# 書くと、片方だけが更新される日が来る — それはこのハーネスが検出しようとしている失敗形状
# そのものである。ツリーの定義は 1 箇所に置く。
#
# ガードの複製（fx_guard / fx_guard_mutate）はここでは行わない。変異ケースが無改変の複製を
# 上書きされて空振りするのを避けるため、呼出側が先に選ぶ。

# check-test-code-coverage.sh 用の合成 ts ツリー。
#
# 対象ガードの空振り防止（workspace / ディレクトリ / 直下ファイル / サブディレクトリファイルが
# それぞれ 1 件以上）をすべて満たす必要があるため、この 4 種を最低 1 件ずつ含める。
# 満たさないと、狙った検査へ到達する前に空振り防止で赤くなり、赤の原因を取り違える。
tcc_tree() {
  fx_write ts/pnpm-workspace.yaml <<'EOF'
packages:
  - 'packages/*'
EOF

  fx_write ts/package.json <<'EOF'
{
  "name": "selftest-root",
  "private": true,
  "type": "module",
  "scripts": {
    "lint": "eslint eslint.config.js && pnpm -r lint",
    "typecheck": "pnpm -r typecheck && tsc -p tsconfig.tools.json"
  }
}
EOF

  fx_write ts/tsconfig.tools.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": [],
    "allowJs": true,
    "checkJs": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["eslint.config.js"]
}
EOF

  # flat config。files を明示しないと eslint が「no matching configuration」で全ファイルを
  # ignored 扱いにし、ガードの (A) 判定が意図と無関係に赤くなる（Tier B で実測）。
  fx_write ts/eslint.config.js <<'EOF'
// @ts-check
export default [
  { files: ['**/*.js', '**/*.mjs', '**/*.cjs', '**/*.jsx', '**/*.ts', '**/*.tsx'], rules: {} },
];
EOF

  fx_write ts/packages/w1/package.json <<'EOF'
{
  "name": "w1",
  "private": true,
  "type": "module",
  "scripts": {
    "lint": "eslint src test perf vitest.config.ts",
    "typecheck": "tsc -p tsconfig.json"
  }
}
EOF

  fx_write ts/packages/w1/tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": [],
    "allowJs": true,
    "checkJs": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts", "perf/*.mjs"]
}
EOF

  fx_write ts/packages/w1/src/a.ts <<'EOF'
export const a = 1;
EOF
  fx_write ts/packages/w1/test/b.test.ts <<'EOF'
export const b = 2;
EOF
  fx_write ts/packages/w1/vitest.config.ts <<'EOF'
// @ts-check
export default {};
EOF
  fx_write ts/packages/w1/perf/x.mjs <<'EOF'
// @ts-check
export const x = 1;
EOF
}
