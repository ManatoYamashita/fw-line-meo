# scripts/check-test-code-coverage.sh の自己テスト（Issue #90）。
#
# このガードは #70 / #78 / #83 / #81 と 4 回、事後に穴が見つかっている。中でも #81 の偽緑は
# 653 行を読むだけでは見つからず、実走して初めて出た。ここでは実物の tsc / eslint に問い合わせる
# 合成ツリーを組み、そのときの再現条件をケースとして固定する。

# 緑になる最小の合成 ts ツリーを組む。
# 対象ガードの空振り防止（workspace / ディレクトリ / 直下ファイル / サブディレクトリファイル が
# それぞれ 1 件以上）をすべて満たす必要があるため、この 4 種を最低 1 件ずつ含める。
tcc_fixture() {
  fx_guard check-test-code-coverage

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
  # ignored 扱いにし、ガードの (A) 判定が意図と無関係に赤くなる。
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

  # 実物の tsc / eslint を借用する（pnpm install も worktree 汚染も不要）。
  fx_link_node_modules ts
  fx_link_node_modules ts/packages/w1
}

# ---------------------------------------------------------------------------

t_begin 'check-test-code-coverage: 正常な合成ツリーは緑（件数まで照合）'
if ! fx_has_real_toolchain; then
  t_skip 'ts/node_modules の tsc / eslint が無い（pnpm install 前）'
else
  tcc_fixture
  fx_run check-test-code-coverage
  expect_green
  # 「OK」だけでなく件数を照合する。0 件のまま緑になる経路と区別するため。
  # 末尾の語は対象ガードの OK 行と一致させること。#92 が check_js_files を check_subdir_files へ
  # 改名した際に「サブディレクトリ JS」→「サブディレクトリファイル」へ変わったが、本ケースは
  # #92 と独立に書かれていたため、両者が merge された時点で main が赤くなった（実測: e0f6d5c）。
  expect_output_matches '1 workspace / 2 ディレクトリ / 2 直下ファイル / 1 サブディレクトリファイル'
fi
t_end

# ---------------------------------------------------------------------------
# Issue #81 の中核。この条件は base（PR #88 以前）では exit 0（偽緑）だった。
# check_root_files は ts/ 直下のコードファイルが 0 件だと早期 return するため、tsc が一度も
# 走っていないことを誰も報告しなかった。判定を関数の外側へ出したことでここが赤になる。
# 誰かが判定を check_root_files の内側へ戻すと、このケースが再び緑になり失敗する。

t_begin 'check-test-code-coverage: ts/ 直下 0 件かつ tsc 空振りで緑を返さない（#81 の偽緑）'
if ! fx_has_real_toolchain; then
  t_skip 'ts/node_modules の tsc / eslint が無い（pnpm install 前）'
else
  tcc_fixture
  # ts/ 直下のコードファイルを 0 件にする。eslint の flat config は合成ツリーのルートへ退避し、
  # workspace 側からは上位探索で届く状態を保つ（lint 判定を巻き込まないため）。
  mv "${FX}/ts/eslint.config.js" "${FX}/eslint.config.js"
  fx_stub_npx_failing_tsc_in '*/ts'
  fx_run check-test-code-coverage stub
  expect_red 'ts/ 直下で tsc のプログラム構成を取得できませんでした'
fi
t_end

t_begin 'check-test-code-coverage: 対照 — 同じ 0 件ツリーでも tsc が動けば緑（偽陽性でない）'
if ! fx_has_real_toolchain; then
  t_skip 'ts/node_modules の tsc / eslint が無い（pnpm install 前）'
else
  tcc_fixture
  mv "${FX}/ts/eslint.config.js" "${FX}/eslint.config.js"
  # スタブを置かない。上のケースの赤が「0 件だから」ではなく「tsc が空振りしたから」で
  # あることを示す対照。ts/ 直下に検査すべきファイルが無い以上、緑が正しい。
  fx_run check-test-code-coverage
  expect_green
fi
t_end

# ---------------------------------------------------------------------------

t_begin 'check-test-code-coverage: ts/ の typecheck が -p を持たないとき二重報告しない（#81 タスク2）'
if ! fx_has_real_toolchain; then
  t_skip 'ts/node_modules の tsc / eslint が無い（pnpm install 前）'
else
  tcc_fixture
  fx_write ts/package.json <<'EOF'
{
  "name": "selftest-root",
  "private": true,
  "type": "module",
  "scripts": {
    "lint": "eslint eslint.config.js && pnpm -r lint",
    "typecheck": "pnpm -r typecheck"
  }
}
EOF
  fx_run check-test-code-coverage
  expect_red 'typecheck が ts/ 直下用の tsconfig を走らせていません'
  # 同じ 1 つの原因に対し「include へ追加してください」を重ねない。
  # 修正前は 2 件出て互いに矛盾する指示になっていた。
  expect_absent 'が tsc のプログラムに含まれていません'
fi
t_end

t_begin 'check-test-code-coverage: tsconfig.tools.json 欠落は空振りとして報告する'
if ! fx_has_real_toolchain; then
  t_skip 'ts/node_modules の tsc / eslint が無い（pnpm install 前）'
else
  tcc_fixture
  rm -f "${FX}/ts/tsconfig.tools.json"
  fx_run check-test-code-coverage
  expect_red 'typecheck が指す tsconfig.tools.json が存在しません'
  expect_red 'ts/ 直下で tsc のプログラム構成を取得できませんでした'
fi
t_end

t_begin 'check-test-code-coverage: workspace 側の tsc 空振りも検出する'
if ! fx_has_real_toolchain; then
  t_skip 'ts/node_modules の tsc / eslint が無い（pnpm install 前）'
else
  tcc_fixture
  fx_stub_npx_failing_tsc_in '*/packages/w1'
  fx_run check-test-code-coverage stub
  expect_red 'で tsc のプログラム構成を取得できませんでした'
fi
t_end

# ---------------------------------------------------------------------------
# Issue #82: 走査対象を作業ツリーから git 管理下へ寄せたことの検証。
#
# 再現条件は vitest / vite が設定ファイルと同じディレクトリへ生成する
# `<config>.timestamp-<ms>-<rand>.mjs`。通常は finally で消えるが強制終了時に残り、
# .gitignore にも該当パターンが無い。修正前はこれを「配線すべきコードファイル」として扱い、
# **一時ファイル名を lint 引数へ恒久的に追加せよ**という従ってはいけない指示を出していた。

t_begin 'check-test-code-coverage: 未追跡の一時ファイルで誤爆しない（#82）'
if ! fx_has_real_toolchain; then
  t_skip 'ts/node_modules の tsc / eslint が無い（pnpm install 前）'
else
  tcc_fixture
  fx_track_now   # ここまでを追跡させる
  # 以降は未追跡。vitest がクラッシュ時に残す一時ファイルを模す。
  fx_write ts/packages/w1/vitest.config.ts.timestamp-1754600000000-abcdef.mjs <<'EOF'
export default {};
EOF
  fx_run check-test-code-coverage
  expect_green
  # **従ってはいけない指示**（一時ファイル名を lint 引数へ恒久的に追加せよ）が出ないこと。
  # ファイル名そのものは下の WARNING に現れるため、名前の不在では検証にならない。
  expect_absent 'lint スクリプトの引数にありません'
  expect_absent 'ERROR:'
  # 見逃しを可視化する対の仕組みが働いていること。git 列挙は「未 add を見逃す」側へ倒れるため、
  # この警告が無いと fail-open が沈黙する。
  expect_output_matches 'WARNING: .*未追跡のコードファイルが 1 件'
fi
t_end

t_begin 'check-test-code-coverage: 対照 — 同じファイルが追跡されていれば検出する（見逃しでない）'
if ! fx_has_real_toolchain; then
  t_skip 'ts/node_modules の tsc / eslint が無い（pnpm install 前）'
else
  tcc_fixture
  # fx_track_now を呼ばない。fx_run が全ファイルを追跡させるため、この .mjs も対象になる。
  # 上のケースの緑が「未追跡だから」であって「拡張子や場所で落としたから」ではないことを示す。
  fx_write ts/packages/w1/tracked-extra.mjs <<'EOF'
export default {};
EOF
  fx_run check-test-code-coverage
  expect_red 'tracked-extra.mjs'
fi
t_end

t_begin 'check-test-code-coverage: git work tree でなければ緑を返さない'
if ! fx_has_real_toolchain; then
  t_skip 'ts/node_modules の tsc / eslint が無い（pnpm install 前）'
else
  tcc_fixture
  # .git を作らずに直接起動する（fx_run の自動 git 化を迂回する）。
  OUT="$(cd "$FX" && bash scripts/check-test-code-coverage.sh 2>&1)" && RC=0 || RC=$?
  expect_red 'git work tree ではありません'
fi
t_end

# ---------------------------------------------------------------------------
# 列挙を git へ寄せたことの残差。情報源を替えると「対象の集合」だけでなく
# **対象の表現**まで替わる。以下 3 件はいずれもその表現差・出力経路の差で生じる。

t_begin 'check-test-code-coverage: 非 ASCII ファイル名のコードファイルも列挙する'
if ! fx_has_real_toolchain; then
  t_skip 'ts/node_modules の tsc / eslint が無い（pnpm install 前）'
else
  tcc_fixture
  # git ls-files は core.quotePath 既定 true のもとで非 ASCII パスを引用符で括って返すため、
  # 行末が `"` になり CODE_EXT_RE の `$` アンカーに一致しない。結果としてこのファイルは
  # **すべての列挙から丸ごと消え**、lint にも型検査にも配線されていないのにガードは緑になる。
  # 上の tracked-extra.mjs と配置も未配線ぶりも同一で、違いはファイル名だけである
  # （つまりこのケースが赤で tracked-extra.mjs が赤なら、差は名前の表現に閉じている）。
  fx_write 'ts/packages/w1/日本語設定.mjs' <<'EOF'
export default {};
EOF
  fx_run check-test-code-coverage
  expect_red '日本語設定.mjs'
fi
t_end

t_begin 'check-test-code-coverage: 未追跡が大量でも中断しない'
if ! fx_has_real_toolchain; then
  t_skip 'ts/node_modules の tsc / eslint が無い（pnpm install 前）'
else
  tcc_fixture
  fx_track_now   # ここまでを追跡させる
  # 未追跡一覧の**バイト数**が pipe buffer（64KB）を超えると、先頭数件へ絞る consumer が
  # 先にパイプを閉じ、上流が SIGPIPE で落ちる。set -e × pipefail によりガード自体が
  # exit 141 で中断し、OK も NG も出ないまま赤になる。入力サイズ依存で赤にも緑にも
  # 転ぶという点で、本スクリプトが grep -q を避けているのと同じ罠である。
  # 件数は「1 行 185 バイト前後 × 1200 件 ≒ 216KB」を狙って選んである。上流が書き込める
  # 上限（consumer の入力 buffer 2 杯分 ＝ 128KB 前後）に対し 1.7 倍の余裕を取り、
  # BSD / GNU の buffer 幅の差でケースが緑へ転ばないようにする。
  fx_flood 1200 ts .mjs 'export default {};'
  fx_run check-test-code-coverage
  expect_green
  # 警告そのものが出ていることまで見る（出力を丸ごと落として緑にしても通らないように）。
  expect_output_matches 'WARNING: .*未追跡のコードファイルが 1200 件'
fi
t_end

t_begin 'check-test-code-coverage: サブディレクトリ 0 件の診断が撤去済みの find / prune を指さない'
if ! fx_has_real_toolchain; then
  t_skip 'ts/node_modules の tsc / eslint が無い（pnpm install 前）'
else
  tcc_fixture
  # 唯一のサブディレクトリ占有者を外して checked_subdir_files を 0 にし、両論併記の診断を出させる。
  # 走査系は find でも prune でもなくなったため、その語で調査先を案内すると存在しない機構へ
  # 誘導することになる（原因と逆方向へ誘導するのは #81 で塞いだはずの欠落である）。
  rm -f "${FX}/ts/packages/w1/perf/x.mjs"
  fx_run check-test-code-coverage
  expect_red 'サブディレクトリのコードファイルを1件も検証できませんでした'
  expect_absent 'prune'
  expect_absent 'find の'
fi
t_end
