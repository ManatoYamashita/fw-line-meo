# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/run-db-test-suites.sh の自己テスト（Issue #156・PR #159 レビュー指摘 2）。
#
# 実行装置が守っているのは **「今は起きない状態」でしか発火しない分岐**である
# （スイートが空・ディレクトリが 0 件・db/test へ置いたのに未宣言）。どれを削っても
# 実リポジトリでは何も起きず CI は緑のままなので、**消えたことを誰も検出できない**。
# `check-guard-selftest-coverage.sh` は `check-*.sh` にしかケースを要求しないため、
# 機械強制も掛からない。ここが唯一の後ろ盾になる。
#
# DB は要らない。`psql` をスタブへ差し替え、`-f` の対象名で成否を決める
# （Tier A は t_begin が PATH を合成ツリーの stub/ へ差し替えている）。

rdt_fixture() {
  fx_guard run-db-test-suites

  # psql スタブ: `-f <path>` の対象名に fail を含むときだけ非ゼロで終わる。
  cat > "${STUB_DIR}/psql" <<'STUB'
#!/usr/bin/env bash
set -u
target=''
prev=''
for a in "$@"; do
  if [ "$prev" = '-f' ]; then target="$a"; fi
  prev="$a"
done
case "$target" in
  *fail*) echo "psql-stub: simulated ERROR for ${target}" >&2; exit 3 ;;
esac
exit 0
STUB
  chmod +x "${STUB_DIR}/psql"

  fx_write db/test/assertions/10_ok.sql <<'EOF'
-- assertion
EOF
  fx_write db/test/smoke/20_ok.sql <<'EOF'
-- smoke
EOF

  # RUN 表が指す実体。既定では成功する。
  fx_write db/test/check_docs.sh <<'EOF'
#!/usr/bin/env bash
echo "check_docs-stub: OK"
EOF
  # RUN 表が指す実体その 2（#158 (a) で SKIP から昇格）。既定では成功する。
  fx_write db/test/check_no_optional_capabilities.sh <<'EOF'
#!/usr/bin/env bash
echo "no-optional-capabilities-stub: OK"
EOF
  # SKIP 表が指す実体（存在照合のためだけに置く）。
  for f in run.sh cross_runtime_steps.sh; do
    fx_write "db/test/${f}" <<'EOF'
#!/usr/bin/env bash
: # SKIP 宣言済み。実行されない
EOF
  done
  # ELSEWHERE 表が指す実体（#158 (b)）。**実行されたら出力で分かる形にする。**
  # 空の `:` にすると「実行されていない」と「実行されたが何も起きない」が区別できない。
  fx_write db/test/cross_runtime_integration.sh <<'EOF'
#!/usr/bin/env bash
echo "cross-runtime-stub: 実行された"
EOF

  DATABASE_URL='postgres://stub@127.0.0.1:5432/stub'
  export DATABASE_URL
}

# ---------------------------------------------------------------------------
# 中核: 集約実行（最初の失敗で止めない）
# ---------------------------------------------------------------------------

t_begin 'run-db-test-suites: 全スイートが通れば緑（件数を出す）'
rdt_fixture
fx_run run-db-test-suites
expect_green
expect_output_matches 'OK: db/test スイート緑（2 ディレクトリ / 2 SQL / 2 スクリプト・別ジョブ 1 件）'
t_end

t_begin 'run-db-test-suites: 最初の失敗で止めず、別スイートの失敗も同じ実行で出す'
# **これが集約実行の存在理由である。** 逐次中断だと assertions で止まり、smoke が
# 実行されている証明にならない（Issue #156 の対照実験がこの性質に依存している）。
rdt_fixture
fx_write db/test/assertions/11_fail.sql <<'EOF'
-- 失敗する assertion
EOF
fx_write db/test/smoke/21_fail.sql <<'EOF'
-- 失敗する smoke
EOF
fx_run run-db-test-suites
expect_red 'db/test/assertions/11_fail.sql が非ゼロ終了しました'
expect_output_matches 'db/test/smoke/21_fail\.sql が非ゼロ終了しました'
expect_output_matches 'NG: db/test スイートに失敗があります'
t_end

t_begin 'run-db-test-suites: docs 経路の失敗も伝播する'
rdt_fixture
fx_write db/test/check_docs.sh <<'EOF'
#!/usr/bin/env bash
echo "check_docs-stub: FAIL"
exit 1
EOF
fx_run run-db-test-suites
expect_red 'db/test/check_docs.sh が非ゼロ終了しました'
t_end

t_begin 'run-db-test-suites: 能力の不在チェックの失敗も伝播する（#158 (a) で RUN へ昇格した行が実際に実行されている証拠）'
# **RUN 表へ 1 行足しただけでは「宣言した」までしか言えない。** ループが実際にこのファイルを
# 起動していなければ、宣言は虚偽のまま緑を返す（それは #156 / #158 が潰した当の形である）。
# スタブを非ゼロ終了させ、実行装置がそれを拾うことをここで固定する。
rdt_fixture
fx_write db/test/check_no_optional_capabilities.sh <<'EOF'
#!/usr/bin/env bash
echo "no-optional-capabilities-stub: FAIL" >&2
exit 1
EOF
fx_run run-db-test-suites
expect_red 'db/test/check_no_optional_capabilities.sh が非ゼロ終了しました'
t_end

# ---------------------------------------------------------------------------
# 第 3 の状態（ELSEWHERE・Issue #158 (b)）
#
# 「CI では実行されるが、この実行装置からは呼ばない」。RUN との違いは実行の有無であり、
# SKIP との違いは CI に載っているかどうかである。どちらとも取り違えられると、
# 実行されていないのに宣言だけが健全に見える状態が作れてしまう。
# ---------------------------------------------------------------------------

t_begin 'run-db-test-suites: ELSEWHERE 宣言のスクリプトは実行しない（RUN との対照）'
# **RUN 表の行は非ゼロ終了が伝播する**（上の check_docs / 能力の不在のケース）。
# ELSEWHERE 表の行は実行そのものをしないので、非ゼロで終わるスタブを置いても緑でなければ
# ならない。ここが赤くなるなら第 3 の状態として機能していない（＝ただの RUN である）。
rdt_fixture
fx_write db/test/cross_runtime_integration.sh <<'EOF'
#!/usr/bin/env bash
echo "cross-runtime-stub: 実行された" >&2
exit 1
EOF
fx_run run-db-test-suites
expect_green
expect_absent 'cross-runtime-stub'
t_end

t_begin 'run-db-test-suites: ELSEWHERE 宣言の実体が消えると赤（指す対象が消えた宣言は虚偽）'
rdt_fixture
rm -f "${FX}/db/test/cross_runtime_integration.sh"
fx_run run-db-test-suites
expect_red 'ELSEWHERE 宣言の db/test/cross_runtime_integration.sh が存在しません'
t_end

t_begin 'run-db-test-suites: 同じファイルが 2 つの表に載ると赤（後勝ちで静かに実行されなくなる）'
# 宣言をフラグで持つと、RUN で立てた should_run を後続の SKIP / ELSEWHERE が 0 へ倒す。
# 「RUN に書いたのに実行されない」が緑のまま成立するので、件数で数えて鳴らす。
rdt_fixture
sed -i.bak "s/^    'cross_runtime_integration.sh|/    'check_docs.sh|/" "${FX}/scripts/run-db-test-suites.sh"
rm -f "${FX}/scripts/run-db-test-suites.sh.bak"
# **変異が当たったことを先に確かめる。** 当たっていない変異の緑を「検出できなかった」と
# 読み違えると、無効な実験を成功と誤読する（#158 (a) で実際に踏んだ）。
OUT="MUTATED: $(grep -c "^    'check_docs.sh|" "${FX}/scripts/run-db-test-suites.sh")"
expect_output_matches '^MUTATED: 1$'
fx_run run-db-test-suites
expect_red 'db/test/check_docs.sh が複数の表に宣言されています'
t_end

# ---------------------------------------------------------------------------
# 空振り防止（消しても実リポジトリでは何も起きない分岐）
# ---------------------------------------------------------------------------

t_begin 'run-db-test-suites: スイートに *.sql が 1 件も無いと赤'
rdt_fixture
rm -f "${FX}"/db/test/smoke/*.sql
fx_run run-db-test-suites
# expect_red は ERE ではなく case の glob によるリテラル部分一致。正規表現エスケープを書くと
# 一致しない（ERE なのは expect_output_matches の側）。
expect_red 'db/test/smoke/ に *.sql が 1 件もありません'
t_end

t_begin 'run-db-test-suites: スイートディレクトリが 1 件も無いと赤'
rdt_fixture
rm -rf "${FX}/db/test/assertions" "${FX}/db/test/smoke"
fx_run run-db-test-suites
expect_red 'スイートディレクトリが 1 件もありません'
t_end

t_begin 'run-db-test-suites: DATABASE_URL が無ければ無言終了しない'
rdt_fixture
unset DATABASE_URL
fx_run run-db-test-suites
expect_red 'DATABASE_URL'
t_end

# ---------------------------------------------------------------------------
# 宣言の網羅（db/test へ置いたのに誰も呼ばない、を無言で起こさない）
# ---------------------------------------------------------------------------

t_begin 'run-db-test-suites: 未宣言の db/test/*.sh があると赤'
rdt_fixture
fx_write db/test/new_suite.sh <<'EOF'
#!/usr/bin/env bash
: # RUN にも SKIP にも宣言されていない
EOF
fx_run run-db-test-suites
expect_red 'db/test/new_suite.sh が RUN にも SKIP にも ELSEWHERE にも宣言されていません'
t_end

t_begin 'run-db-test-suites: SKIP 宣言の実体が消えると赤'
rdt_fixture
rm -f "${FX}/db/test/cross_runtime_steps.sh"
fx_run run-db-test-suites
expect_red 'SKIP 宣言の db/test/cross_runtime_steps.sh が存在しません'
t_end

t_begin 'run-db-test-suites: RUN 表から外すと未宣言として赤（除外を外すと赤くなる対照）'
# steering「除外の広さは『入れた理由』ではなく『外したら赤くなるか』で測る」の充足。
rdt_fixture
sed -i.bak "/^    'check_docs.sh'\$/d" "${FX}/scripts/run-db-test-suites.sh"
rm -f "${FX}/scripts/run-db-test-suites.sh.bak"
fx_run run-db-test-suites
expect_red 'db/test/check_docs.sh が RUN にも SKIP にも ELSEWHERE にも宣言されていません'
t_end

t_begin 'run-db-test-suites: 宣言表が空でも unbound variable で死なない（bash 3.2 の空配列）'
# macOS 既定の bash 3.2 は `set -u` 下の `"${a[@]}"` を unbound variable として落とす。
# 宣言表が空になるのはこのリポジトリでは常態（既存ガード 7 本の WHITELIST は全て空）なので、
# 防御形 `${a[@]+"${a[@]}"}` が外れたらここで気づけるようにする。
rdt_fixture
sed -i.bak "/^    'check_docs.sh'\$/d; /^    'run.sh|/d; /^    'check_no_optional_capabilities.sh'\$/d; /^    'cross_runtime_integration.sh|/d; /^    'cross_runtime_steps.sh|/d" \
  "${FX}/scripts/run-db-test-suites.sh"
rm -f "${FX}/scripts/run-db-test-suites.sh.bak"
fx_run run-db-test-suites
expect_red 'RUN にも SKIP にも ELSEWHERE にも宣言されていません'
expect_absent 'unbound variable'
t_end
