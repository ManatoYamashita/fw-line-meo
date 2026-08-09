# scripts/check-test-code-coverage.sh の自己テスト — Tier A（Issue #90）。
#
# 実 node_modules を使わず、npx スタブで eslint / tsc の応答だけを模擬して走らせる。
# ここで検証するのは **走査範囲・担当分界・fail-closed 分岐の到達性** である。
# tsconfig の include の実効範囲や flat config の ignores の合成は模擬しない（Tier B の担当）。
#
# なぜ層を分けるか: 赤ケースを期待エラー文字列まで照合しても、**判別子が定数化して片側の分岐が
# 実質デッドコードになった**状態は緑のまま残る。PR #92 のレビューで found_subdir_candidates が
# 実際にその劣化をしており、653 行を読むだけでも赤ケースを増やすだけでも出なかった。分岐へ
# 到達する最小改変が存在すること自体を assert する型（fx_guard_mutate）はここにしか置けない。

tcc_stub_fixture() {
  fx_guard check-test-code-coverage
  tcc_tree
}

# ---------------------------------------------------------------------------

t_begin 'check-test-code-coverage[A]: スタブだけで正常な合成ツリーが緑（件数まで照合）'
tcc_stub_fixture
fx_run check-test-code-coverage
expect_green
# 件数まで照合する。0 件のまま緑になる経路と区別するため。
# Tier B と同じ件数が出ることが、スタブが実物と同じ担当分界を再現できている証拠でもある。
expect_output_matches '1 workspace / 2 ディレクトリ / 2 直下ファイル / 1 サブディレクトリファイル'
t_end

# ---------------------------------------------------------------------------
# Issue #95: workspace 配下の深さ 2 以上に置かれた `.mts` / `.cts` はどの器も見ていなかった。
# ディレクトリ走査の dir_ts_hits も候補外検出の entry_ts_hits も `*.ts` / `*.tsx` しか数えず、
# check_subdir_files の workspace 呼出は TS 系を範囲外にしていたためである。
# 素の穴より質が悪いのは、「TS 系は担当済み」と読める注記がそこに付いていたことである。

t_begin 'check-test-code-coverage[A]: 候補ディレクトリ内の深さ 2 の .mts が型検査外なら赤（#95）'
tcc_stub_fixture
# tsconfig の include は `src/**/*.ts` であり `.mts` に一致しない。実物の tsc と同じ状態を
# 「プログラムから落とす」ことで再現する。
fx_write ts/packages/w1/src/tool.mts <<'EOF'
export const tool = 1;
EOF
fx_stub_tsc_exclude 'src/tool.mts'
fx_run check-test-code-coverage
expect_red 'src/tool.mts が tsc のプログラムに含まれていません'
t_end

t_begin 'check-test-code-coverage[A]: 候補外ディレクトリの .cts が lint 走査外なら赤（#95）'
tcc_stub_fixture
# `tools` は CODE_DIR_CANDIDATES にも lint の引数（src test perf vitest.config.ts）にも無い。
fx_write ts/packages/w1/tools/other.cts <<'EOF'
export const other = 1;
EOF
fx_run check-test-code-coverage
expect_red 'tools/other.cts が lint スクリプトの走査対象にありません'
t_end

t_begin 'check-test-code-coverage[A]: 対照 — workspace 直下の .mts は元から担当がある（深さの境界）'
tcc_stub_fixture
# check_root_files の find 式は元から `.mts` / `.cts` を含む。#95 の穴は拡張子ではなく
# **深さ 2 以上**で開いていた。ここが赤のままであることが、その境界の実測になる。
fx_write ts/packages/w1/tool.mts <<'EOF'
export const tool = 1;
EOF
fx_stub_tsc_exclude 'w1/tool.mts'
fx_run check-test-code-coverage
expect_red 'tool.mts が tsc のプログラムに含まれていません'
t_end

t_begin 'check-test-code-coverage[A]: 対照 — 候補外の .ts は候補外検出だけが報告する（二重報告しない）'
tcc_stub_fixture
fx_write ts/packages/w1/tools/dup.ts <<'EOF'
export const dup = 1;
EOF
fx_run check-test-code-coverage
expect_red 'tools/ は TypeScript を含みますが本ガードの走査候補にありません'
# `.ts` / `.tsx` はディレクトリ走査と候補外検出が担当済みである。サブディレクトリ走査まで
# 広げると、同じ 1 つの原因が 2 種類の指示になる（#81 タスク 2 で潰した形状）。
expect_absent 'tools/dup.ts が lint スクリプトの走査対象にありません'
t_end
