# scripts/check-grep-exit-codes.sh の自己テスト（Issue #120）。
#
# 本ガードは「grep の失敗を後置 true で潰さない」（規律 2 の後半）を機械強制する。
# 潰すと無一致（exit 1）と評価不能（exit 2 以上）が同じ結果に化け、壊れたパターンが
# 「違反 0 件」として素通りする。実測では、違反をツリーに置いたままガードが exit 0 を
# 返し、しかも件数表示は健全な実行と一致していた。
#
# **このファイルへ違反構文をリテラルで書いてはならない。** ケースファイルも走査対象に
# 入るため、素朴に書くと本ガードが自分のテストを違反として報告する。握り潰しの部分を
# 変数で組み、ヒアドキュメントの展開で fixture 側にだけ出現させる。
#
# 誤検出しないことの担保が要る観点が 2 つある。終了コードを捕捉する正しい形（`|| rc=$?`）を
# 巻き込まないこと、および行頭 `#` のコメント行を赤にしないこと。前者を落とすと是正済みの
# コードまで書き換えさせられ、後者を落とすとガードは永久に緑にならない。

SWALLOW='|| true'
SWALLOW_TIGHT='||true'

gec_fixture() {
  fx_write scripts/clean.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
rc=0
n="$(printf 'a\nb\n' | grep -c 'a')" || rc=$?
if [ "$rc" -gt 1 ]; then
  echo "ERROR: パターンを評価できません" >&2
  exit 1
fi
printf '%s\n' "$n"
EOF
  fx_track_now
  fx_guard check-grep-exit-codes
}

gec_whitelist() {
  awk -v entry="$1" '
    /^WHITELIST=\(\)$/ { print "WHITELIST=(" entry ")"; next }
    { print }
  ' "${FX}/scripts/check-grep-exit-codes.sh" > "${FX}/scripts/gec-whitelist.tmp"
  mv "${FX}/scripts/gec-whitelist.tmp" "${FX}/scripts/check-grep-exit-codes.sh"

  # **注入が当たったことを先に確かめる。** 空振りしたまま走らせると、ガードが元のまま
  # 返した結果を「WHITELIST が効いた証拠」と読み違える。
  if [ "$(grep -cF "$1" "${FX}/scripts/check-grep-exit-codes.sh")" -eq 0 ]; then
    _t_fail "WHITELIST の注入が空振りしました: $1"
  fi
}

t_begin 'check-grep-exit-codes: 終了コードを捕捉していれば緑（件数まで照合）'
gec_fixture
fx_run check-grep-exit-codes
expect_green
# 「OK」だけでなく件数を照合する。列挙が空振りしたまま緑になる経路と区別するため。
expect_output_matches '1 ファイル / 1 件の grep 行を検証'
t_end

# ---------------------------------------------------------------------------
# 本命: 握り潰しの検出。

t_begin 'check-grep-exit-codes: 件数を受ける形の握り潰しを検出する'
gec_fixture
fx_write scripts/bad.sh <<EOF
#!/usr/bin/env bash
n="\$(printf 'a\n' | grep -c 'a' ${SWALLOW})"
EOF
fx_track_now
fx_run check-grep-exit-codes
expect_red 'scripts/bad.sh:2 は grep の失敗を後置 true で潰しています'
expect_output_matches 'NG: grep の失敗を後置 true で潰す行が 1 件あります'
t_end

t_begin 'check-grep-exit-codes: 検出結果を文字列で受ける形の握り潰しも検出する'
# こちらが偽 PASS 方向である。空文字が `[ -n ... ]` で「違反なし」と同義になる。
gec_fixture
fx_write scripts/bad.sh <<EOF
#!/usr/bin/env bash
hits="\$(grep -rnE 'x' . ${SWALLOW})"
if [ -n "\$hits" ]; then echo found; fi
EOF
fx_track_now
fx_run check-grep-exit-codes
expect_red 'scripts/bad.sh:2 は grep の失敗を後置 true で潰しています'
t_end

t_begin 'check-grep-exit-codes: 空白の無い形も検出する'
gec_fixture
fx_write scripts/bad.sh <<EOF
#!/usr/bin/env bash
n="\$(printf 'a\n' | grep -c 'a' ${SWALLOW_TIGHT})"
EOF
fx_track_now
fx_run check-grep-exit-codes
expect_red 'scripts/bad.sh:2 は grep の失敗を後置 true で潰しています'
t_end

# ---------------------------------------------------------------------------
# 対照: 誤検出しないこと。

t_begin 'check-grep-exit-codes: 対照 — 終了コードを捕捉する形は巻き込まない'
gec_fixture
fx_write scripts/good.sh <<'EOF'
#!/usr/bin/env bash
rc=0
n="$(printf 'a\n' | grep -cE 'a')" || rc=$?
other=0
list="$(grep -rnE 'x' .)" || other=$?
EOF
fx_track_now
fx_run check-grep-exit-codes
expect_green
t_end

t_begin 'check-grep-exit-codes: 対照 — 行頭 # のコメント行は赤にしない'
gec_fixture
fx_write scripts/noted.sh <<EOF
#!/usr/bin/env bash
# n="\$(grep -c 'a' ${SWALLOW})" と書くと壊れたパターンが 0 件に化けるため使わない。
rc=0
n="\$(printf 'a\n' | grep -c 'a')" || rc=\$?
EOF
fx_track_now
fx_run check-grep-exit-codes
# 規律を説明する注記がこの構文を引用する。除外を落とすとリポジトリは永久に赤くなる。
expect_green
t_end

t_begin 'check-grep-exit-codes: 対照 — ガード自身を走査対象へ含めても自己検出しない'
fx_guard check-grep-exit-codes
fx_write scripts/clean.sh <<'EOF'
#!/usr/bin/env bash
rc=0
n="$(printf 'a\n' | grep -c 'a')" || rc=$?
EOF
fx_run check-grep-exit-codes
expect_green
expect_absent 'check-grep-exit-codes.sh:'
t_end

# ---------------------------------------------------------------------------
# WHITELIST と空振り防止。

t_begin 'check-grep-exit-codes: WHITELIST の行は SKIP になる'
gec_fixture
fx_write scripts/bad.sh <<EOF
#!/usr/bin/env bash
n=\$(grep -c a f ${SWALLOW})
EOF
fx_track_now
# キー側も変数で組む。リテラルで書くと、このケースファイル自身が違反として報告される。
gec_whitelist "'scripts/bad.sh|n=\$(grep -c a f ${SWALLOW})'"
fx_run check-grep-exit-codes
expect_green
expect_output_matches 'SKIP: scripts/bad.sh:2'
t_end

t_begin 'check-grep-exit-codes: 当たらない WHITELIST は WARNING になる'
gec_fixture
gec_whitelist "'scripts/gone.sh|already fixed line'"
fx_run check-grep-exit-codes
expect_green
expect_output_matches 'WARNING: scripts/gone.sh\|already fixed line は WHITELIST に載っていますが'
t_end

t_begin 'check-grep-exit-codes: 空振り防止 — 追跡下の対象が 0 件なら赤'
fx_write docs/placeholder.md <<'EOF'
placeholder
EOF
fx_track_now
fx_guard check-grep-exit-codes
fx_run check-grep-exit-codes
expect_red '追跡下の scripts/**/*.sh が 1 件もありません'
t_end

t_begin 'check-grep-exit-codes: 空振り防止 — grep を含む行が 0 件なら赤'
fx_write scripts/nogrep.sh <<'EOF'
#!/usr/bin/env bash
echo hi
EOF
fx_track_now
fx_guard check-grep-exit-codes
fx_run check-grep-exit-codes
expect_red 'grep を含む行を 1 件も検出できませんでした'
t_end
