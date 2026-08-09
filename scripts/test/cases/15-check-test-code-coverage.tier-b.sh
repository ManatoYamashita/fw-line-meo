# scripts/check-test-code-coverage.sh の自己テスト — Tier B（Issue #90）。
#
# このガードは #70 / #78 / #83 / #81 と 4 回、事後に穴が見つかっている。中でも #81 の偽緑は
# 653 行を読むだけでは見つからず、実走して初めて出た。
#
# **本ファイルは実物の tsc / eslint にしか答えられないことだけを扱う。** tsconfig の include の
# 実効範囲、flat config の ignores の合成結果、@ts-check / @ts-nocheck の効き — いずれも
# 設定文字列を読んでも判定できず、スタブで模擬すれば「模擬した通りに動いた」だけの緑になる。
# 走査範囲・担当分界・fail-closed 分岐の到達性は Tier A（10-）が担当する。

# 緑になる最小の合成 ts ツリー（共有定義は scripts/test/fixtures.sh）へ、実 node_modules の
# 借用を足したもの。pnpm install も worktree 汚染も不要なまま本物のツールチェインへ問い合わせる。
tcc_fixture() {
  fx_guard check-test-code-coverage
  tcc_tree
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
