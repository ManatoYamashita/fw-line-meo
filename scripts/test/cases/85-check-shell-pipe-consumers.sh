# scripts/check-shell-pipe-consumers.sh の自己テスト（Issue #117）。
#
# 本ガードは「入力を読み切らない consumer をパイプの下流へ置かない」（規律 2）を機械強制する。
# 守る対象が **入力サイズ依存で赤にも緑にも転ぶ退行**であるため、振る舞いテストでは
# 閾値の下で必ず緑になり、書いた本人は踏まない。よって構文の検出そのものを検証する。
#
# **このファイルへ違反構文をリテラルで書いてはならない。** ケースファイルも実ガードの走査対象
# （追跡下の `scripts/**/*.sh`）に入るため、素朴に書くと本ガードが自分のテストを違反として
# 報告し、リポジトリが永久に赤くなる。フラグ部分を変数で組み、ヒアドキュメントの展開で
# fixture 側にだけ違反構文を出現させる。
#
# 誤検出しないことの担保が要る観点が 2 つある。行頭 `#` のコメント行を赤にしないこと
# （規律や過去の失敗を説明する注記が、まさにこの構文を引用するため）、および `-c` のような
# 入力を読み切るフラグを巻き込まないこと。前者を落とすとガードは永久に緑にならず、
# 後者を落とすと是正済みの正しいコードまで書き換えさせられる。

# fixture の基本形。**ガード本体は fx_track_now の後に置いて未追跡のままにする。**
# 追跡させると走査対象へ入って件数が本体の増減で動き、件数照合が壊れやすくなるためである
# （ガード自身を対象に含めても自己検出しないことは、下に専用のケースを置いて別途検証する）。
sp_fixture() {
  fx_write scripts/clean.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'a\nb\n' | grep -c 'a'
printf 'a\nb\n' | sort | wc -l
EOF
  fx_track_now
  fx_guard check-shell-pipe-consumers
}

# 合成ツリーへ複製したガードの `WHITELIST=()` へ項目を注入する（$1 = 括弧の中身をそのまま）。
# `sed -i` はプラットフォームで引数が異なるため awk と mv で行う（80- のケースと同形）。
sp_whitelist() {
  awk -v entry="$1" '
    /^WHITELIST=\(\)$/ { print "WHITELIST=(" entry ")"; next }
    { print }
  ' "${FX}/scripts/check-shell-pipe-consumers.sh" > "${FX}/scripts/sp-whitelist.tmp"
  mv "${FX}/scripts/sp-whitelist.tmp" "${FX}/scripts/check-shell-pipe-consumers.sh"

  # **注入が当たったことを先に確かめる。** 空振りしたまま走らせると、ガードが元のまま
  # 返した結果を「WHITELIST が効いた証拠」と読み違える。
  if [ "$(grep -cF "$1" "${FX}/scripts/check-shell-pipe-consumers.sh")" -eq 0 ]; then
    _t_fail "WHITELIST の注入が空振りしました: $1"
  fi
}

t_begin 'check-shell-pipe-consumers: 読み切る consumer だけなら緑（件数まで照合）'
sp_fixture
fx_run check-shell-pipe-consumers
expect_green
# 「OK」だけでなく件数を照合する。列挙が空振りしたまま緑になる経路と区別するため。
expect_output_matches '1 ファイル / 2 パイプ行を検証'
t_end

# ---------------------------------------------------------------------------
# 本命: パイプの下流に置かれた早期終了 consumer の 3 形。

t_begin 'check-shell-pipe-consumers: grep の quiet 判定を検出する'
sp_fixture
q='-q'
fx_write scripts/bad.sh <<EOF
#!/usr/bin/env bash
printf 'a\n' | grep $q 'a'
EOF
fx_track_now
fx_run check-shell-pipe-consumers
expect_red 'scripts/bad.sh:2 は grep の quiet / max-count 系をパイプの下流へ置いています'
# 該当行そのものを添えて出す（どの行かを名前で特定できないと是正できないため）。
expect_output_matches 'NG: パイプの下流に早期終了 consumer を置く行が 1 件あります'
t_end

t_begin 'check-shell-pipe-consumers: grep の max-count を検出する'
sp_fixture
m='-m 1'
fx_write scripts/bad.sh <<EOF
#!/usr/bin/env bash
printf 'a\n' | grep $m 'a'
EOF
fx_track_now
fx_run check-shell-pipe-consumers
expect_red 'scripts/bad.sh:2 は grep の quiet / max-count 系をパイプの下流へ置いています'
t_end

t_begin 'check-shell-pipe-consumers: head を検出する'
sp_fixture
hd='head'
fx_write scripts/bad.sh <<EOF
#!/usr/bin/env bash
printf 'a\nb\n' | $hd -n 1
EOF
fx_track_now
fx_run check-shell-pipe-consumers
expect_red 'scripts/bad.sh:2 は head をパイプの下流へ置いています'
t_end

t_begin 'check-shell-pipe-consumers: q コマンドを持つ sed を検出する'
sp_fixture
sq='sed 1q'
fx_write scripts/bad.sh <<EOF
#!/usr/bin/env bash
printf 'a\nb\n' | $sq
EOF
fx_track_now
fx_run check-shell-pipe-consumers
expect_red 'scripts/bad.sh:2 は q コマンドを持つ sed をパイプの下流へ置いています'
t_end

t_begin 'check-shell-pipe-consumers: パイプ終端でなく途中でも検出する'
sp_fixture
hd='head'
fx_write scripts/bad.sh <<EOF
#!/usr/bin/env bash
printf 'a\nb\n' | $hd -n 1 | wc -l
EOF
fx_track_now
fx_run check-shell-pipe-consumers
# 終端でなくても上流は EPIPE を受ける。位置ではなく「下流にあること」で判定する。
expect_red 'scripts/bad.sh:2 は head をパイプの下流へ置いています'
t_end

t_begin 'check-shell-pipe-consumers: 行頭が引用符の行に置かれた違反も検出する（PR #119 指摘）'
# 複数行の `awk` / `sed` はコマンドの残りが**閉じ引用符の行**へ続く。本リポジトリに実在する形で
# ある（`scripts/test/cases/80-check-workflow-step-names.sh:36` ほか 2 箇所）。この行を WHITELIST の
# データ行と同一視して読み飛ばすと、置かれた違反が ERROR も SKIP も出さないまま消える。
# 除外の広さは「入れた理由」ではなく「外したら赤くなるか」で測る。この対照が無い間、
# 当該除外を削除しても実リポジトリ緑・Tier A 全 PASS のままだった（PR #119 レビューで実測）。
sp_fixture
q='-q'
fx_write scripts/quoted.sh <<EOF
#!/usr/bin/env bash
awk '
  { print }
' "\$1" | grep $q 'needle'
EOF
fx_track_now
fx_run check-shell-pipe-consumers
expect_red 'scripts/quoted.sh:4 は grep の quiet / max-count 系をパイプの下流へ置いています'
# WHITELIST へ載せて黙らせる形での「是正」と区別する。SKIP は痕跡が残るが、除外は残らない。
expect_absent 'SKIP: scripts/quoted.sh'
t_end

# ---------------------------------------------------------------------------
# 対照: 誤検出しないこと。落とすとガードが永久に赤い、または正しいコードを壊す。

t_begin 'check-shell-pipe-consumers: 対照 — 行頭 # のコメント行は赤にしない'
sp_fixture
q='-q'
fx_write scripts/noted.sh <<EOF
#!/usr/bin/env bash
# printf 'a\n' | grep $q 'a' は SIGPIPE で入力サイズ依存の偽陽性を生むため使わない。
printf 'a\n' | grep -c 'a'
EOF
fx_track_now
fx_run check-shell-pipe-consumers
# 規律そのものを説明する注記がこの構文を引用する。除外を落とすと本リポジトリは永久に赤くなる
# （実測: 素朴な走査は check-prod-image-drift.sh の注記を拾って 4 件ではなく 5 件を返す）。
expect_green
t_end

t_begin 'check-shell-pipe-consumers: 対照 — 入力を読み切る -c は巻き込まない'
sp_fixture
fx_write scripts/counting.sh <<'EOF'
#!/usr/bin/env bash
printf 'a\n' | grep -c 'a'
printf 'a\n' | grep -cE 'a'
printf 'a\n' | grep -Fxc 'a'
printf 'a\nb\n' | sed -n '1,3p'
EOF
fx_track_now
fx_run check-shell-pipe-consumers
expect_green
t_end

t_begin 'check-shell-pipe-consumers: 対照 — ガード自身を走査対象へ含めても自己検出しない'
# 実リポジトリではガード本体も追跡下にあり走査対象へ入る。検出パターンをリテラルで書くと
# 自分を違反として報告し、恒久的に赤くなる。その退行をここで捕まえる。
fx_guard check-shell-pipe-consumers
fx_write scripts/clean.sh <<'EOF'
#!/usr/bin/env bash
printf 'a\n' | grep -c 'a'
EOF
fx_run check-shell-pipe-consumers
expect_green
expect_absent 'check-shell-pipe-consumers.sh:'
t_end

# ---------------------------------------------------------------------------
# WHITELIST と空振り防止。

# ---------------------------------------------------------------------------
# 走査面（Issue #162）。`db/test/` の検査資産は #156 / #158 (a) 以降 CI から毎 PR 実行されて
# いるのに、#162 まで本ガードの外にあった（`check_docs.sh` に `printf | grep -q` が 2 件残存）。

t_begin 'check-shell-pipe-consumers: db/test/ 配下の違反も検出する（#162）'
sp_fixture
q='-q'
fx_write db/test/bad.sh <<EOF
#!/usr/bin/env bash
printf 'a\n' | grep $q 'a'
EOF
fx_track_now
fx_run check-shell-pipe-consumers
expect_red 'db/test/bad.sh:2 は grep の quiet / max-count 系をパイプの下流へ置いています'
t_end

t_begin 'check-shell-pipe-consumers: 走査面に db/test/ が入っていることを件数で固定する（#162）'
# **pathspec を広げても件数が変わらなければ、広げていないのと同じである。** 上の赤ケースだけ
# では「db/test/ を pathspec から外す」変異を検出できない（違反が消えれば緑になるため）。
# **fixture を使わず順序を自分で組む。** sp_fixture は track の後にガードを置いて未追跡へ
# 残すが、その後に fx_track_now を呼ぶとガード本体まで追跡され、母数がガードの増減で動く。
fx_write scripts/clean.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'a\nb\n' | grep -c 'a'
printf 'a\nb\n' | sort | wc -l
EOF
fx_write db/test/clean.sh <<'EOF'
#!/usr/bin/env bash
printf 'a\nb\n' | grep -c 'a'
EOF
fx_track_now
fx_guard check-shell-pipe-consumers
fx_run check-shell-pipe-consumers
expect_green
expect_output_matches '2 ファイル / 3 パイプ行を検証'
t_end

t_begin 'check-shell-pipe-consumers: WHITELIST の行は SKIP になる'
# **fixture の違反行に引用符とバックスラッシュを入れないこと。** WHITELIST のキーは行そのもの
# なので、そのまま awk -v へ渡ることになる。awk -v は値のエスケープ列を解釈するため、
# `\'` や `\n` を含むキーは注入の時点で別物へ化け、配列が 2 要素へ割れる（実測）。
sp_fixture
q='-q'
fx_write scripts/bad.sh <<EOF
#!/usr/bin/env bash
printf a | grep $q a
EOF
fx_track_now
# キー側もフラグを変数で組む。ここへリテラルで書くと、このケースファイル自身が
# 実ガードの走査対象なので違反として報告される（実測で踏んだ）。
sp_whitelist "'scripts/bad.sh|printf a | grep ${q} a'"
fx_run check-shell-pipe-consumers
# WHITELIST へ載せた違反行の内容はガード本体のソースへ現れる。ガードがそれを自分の違反として
# 拾えば、除外した途端に永久に赤くなる。緑であることがその退行の検出になっている。
expect_green
expect_output_matches 'SKIP: scripts/bad.sh:2'
t_end

t_begin 'check-shell-pipe-consumers: 当たらない WHITELIST は WARNING になる'
sp_fixture
sp_whitelist "'scripts/gone.sh|already fixed line'"
fx_run check-shell-pipe-consumers
expect_green
# 是正済みの行を除外したままにすると、次に同じ行が壊れたとき無言で見逃す。
expect_output_matches 'WARNING: scripts/gone.sh\|already fixed line は WHITELIST に載っていますが'
t_end

t_begin 'check-shell-pipe-consumers: 空振り防止 — 追跡下の対象が 0 件なら赤'
# 先に git 化してからガードを置くことで、ガード本体を未追跡のまま残す（= 列挙が 0 件）。
fx_write docs/placeholder.md <<'EOF'
placeholder
EOF
fx_track_now
fx_guard check-shell-pipe-consumers
fx_run check-shell-pipe-consumers
# 列挙が壊れたまま「違反 0 件だから緑」を返さないこと。
expect_red '追跡下の scripts/**/*.sh と db/test/**/*.sh が 1 件もありません'
t_end

t_begin 'check-shell-pipe-consumers: 空振り防止 — パイプを含む行が 0 件なら赤'
fx_write scripts/nopipe.sh <<'EOF'
#!/usr/bin/env bash
echo hi
EOF
fx_track_now
fx_guard check-shell-pipe-consumers
fx_run check-shell-pipe-consumers
# 走査パターンの前提が崩れている状態を緑で通さないこと。
expect_red 'パイプを含む行を 1 件も検出できませんでした'
t_end

t_begin 'check-shell-pipe-consumers: 検出パターンが評価不能なら緑ではなく赤にする'
# 本ガードが守っている失敗形状そのもの。壊れたパターンを「違反 0 件」に化けさせない。
sp_fixture
awk '
  /^HEAD_RE=/ { print "HEAD_RE='"'"'['"'"'"; next }
  { print }
' "${FX}/scripts/check-shell-pipe-consumers.sh" > "${FX}/scripts/sp-broken.tmp"
mv "${FX}/scripts/sp-broken.tmp" "${FX}/scripts/check-shell-pipe-consumers.sh"
fx_run check-shell-pipe-consumers
expect_red '検出パターンを評価できません'
t_end
