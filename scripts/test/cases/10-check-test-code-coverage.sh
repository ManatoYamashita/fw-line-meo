# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
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

# ---------------------------------------------------------------------------
# fail-closed 分岐。実物の eslint では「判定結果が返らない」「JSON が壊れる」状態を安定して
# 作れないため、この層でしか到達を確認できない。ガードが空振りしたときに空振りだと言えることは、
# ガード本体の検査項目より重要である（本ガードは「緑が信用できるか」を守る装置であるため）。

t_begin 'check-test-code-coverage[A]: eslint の判定結果が返らないとき空振りとして赤になる'
tcc_stub_fixture
fx_stub_eslint_blank
fx_run check-test-code-coverage
expect_red 'eslint の判定結果を取得できませんでした'
expect_red '本ガードの lint 判定が空振りします'
t_end

t_begin 'check-test-code-coverage[A]: eslint の出力形式が変わったとき空振りとして赤になる'
tcc_stub_fixture
fx_stub_eslint_garbage
fx_run check-test-code-coverage
expect_red 'eslint の JSON 出力を解釈できませんでした'
t_end

t_begin 'check-test-code-coverage[A]: eslint の ignores に消されたサブディレクトリのファイルを検出する'
tcc_stub_fixture
# lint スクリプトの引数に perf があっても、ignores に入っていれば走査そのものが行われない。
# 設定文字列を読むだけでは判定できない形状であり、ガードが eslint 自身に尋ねる理由でもある。
fx_stub_eslint_ignored 'perf/x.mjs'
fx_run check-test-code-coverage
expect_red 'perf/x.mjs は eslint の ignores に除外されています'
t_end

# ---------------------------------------------------------------------------
# 分岐到達性（Issue #90 コメントの主眼）。
#
# 赤ケースを期待エラー文字列まで照合しても、**判別子が定数化して片側の分岐が実質デッドコードに
# なった**状態は緑のまま残る。PR #92 のレビューで found_subdir_candidates が実際にその劣化を
# しており、深さフィルタの前で数えるよう直したのが found_deep_paths である。分岐ごとに
# 「そこへ到達する最小改変が存在すること」自体を assert しておかないと、同じ劣化が再発する。

t_begin 'check-test-code-coverage[A]: 占有者ゼロは両論併記で赤にする（断定へ戻ったら落ちる）'
tcc_stub_fixture
# サブディレクトリの占有者を消す。列挙自体は生きているため「対象の消失」と「列挙の破損」の
# どちらとも決められない。列挙の返却だけでは両者は同じ 0 件を生む。
rm -f "${FX}/ts/packages/w1/perf/x.mjs"
fx_run check-test-code-coverage
expect_red 'サブディレクトリのコードファイルを1件も検証できませんでした'
expect_red '(1) 対象の消失'
expect_red '(2) 列挙の破損'
# 片側へ断定する実装へ戻ると、この不在アサーションが落ちる。
expect_absent '列挙が深さ 2 以上へ一度も到達していません'
t_end

t_begin 'check-test-code-coverage[A]: 【変異】列挙が深さ方向へ死ぬと破損側の分岐へ到達する'
# **この分岐は無変異では到達不能である。** 先に置かれた checked_dirs の空振り防止が
# 「.ts を含むディレクトリが 1 件以上ある」ことを要求し、それは構造的に深さ 2 以上のファイルの
# 存在を意味するため、found_deep_paths は必ず非ゼロになる。到達するのは列挙が実際に壊れた
# ときだけであり、それを再現するには変異が要る。変異が当たらなければ fx_guard_mutate が落とす。
#
# 変異は `tracked_code_files` の **--cached 側だけ**へ当てて深さ 2 以上を落とす（Issue #82 で
# 走査が find/prune から `git ls-files` へ替わったため、以前の prune 一覧を広げる変異は
# 当たらなくなった）。深さ 1 は残るので checked_dirs / checked_root_files の空振り防止は
# 通過し、狙った分岐だけへ到達する。未追跡側（--others）は対の警告に使うため巻き込まない。
fx_guard_mutate check-test-code-coverage \
  -e 's@--cached -- .) 2>/dev/null | grep -E "$CODE_EXT_RE"@--cached -- .) 2>/dev/null | grep -E "$CODE_EXT_RE" | grep -v /@'
tcc_tree
fx_run check-test-code-coverage
expect_red '列挙が深さ 2 以上へ一度も到達していません'
expect_red 'tracked_code_files が壊れている可能性が高いです'
# 両論併記側と取り違えていないこと。
expect_absent '(1) 対象の消失'
t_end

t_begin 'check-test-code-coverage[A]: 【変異】範囲指定が壊れたら未知の指定として赤になる'
# 呼出側の引数がずれたときに既定値へ倒すと、「走査したつもりで何も見ていない」状態が緑のまま
# 通る。fail-closed 側へ倒す分岐が生きていることを確認する。
fx_guard_mutate check-test-code-coverage -e "s/'' 'ts-extra'/'' 'bogus'/"
tcc_tree
fx_run check-test-code-coverage
expect_red "check_subdir_files の呼出で未知の拡張子指定です: 'bogus'"
t_end

t_begin 'check-test-code-coverage[A]: 【変異】関数内の評価不能が呼出元まで伝播して赤になる（#120）'
# `count_matches` の `exit 1` はコマンド置換の subshell を終わらせるだけで、**呼出元が単純代入で
# あることに依存して** `set -e` に拾われている。`check_root_files` を `if` や `|| fail=1` の
# 条件文脈へ移すと `set -e` が丸ごと無効になり、13 箇所すべてが空文字を `${n:-0}` で 0 と読む形
# — つまり本 PR が撤去した後置 true と同じ挙動 — へ黙って戻る（PR #123 レビューで実測）。
#
# ここでは `check_root_files` の**内側**にある照合パターンだけを壊す。無変異では到達不能な
# 分岐であり、変異が当たらなければ fx_guard_mutate が落とす。呼出が条件文脈へ移されると
# 関数内の exit が届かなくなり、この赤が消えて本ケースが失敗する。**それがこの対照の役目**である。
#
# **ツリーの構築は `tcc_tree` を直に呼ぶこと。** `tcc_stub_fixture` は内側で `fx_guard` を
# 呼ぶため、当てたばかりの変異を無改変の複製で上書きしてしまう（`fx_guard_mutate` の空振り
# 検出は変異時点しか見ないので、この上書きは検出されない）。実際に踏んで緑になった。
#
# **変異は「括弧が閉じない」形にすること。** `${crf_re}` だけを `[` へ替える形では、
# 残った `([[:space:]]|$)` がブラケット式の中身として解釈でき、BSD grep が exit 0/1 を
# 返して変異が空振りする（実測）。実装非依存に不正となるよう、引数の末尾ごと落とす。
fx_guard_mutate check-test-code-coverage -e 's@\${crf_re}(\[\[:space:\]\]|\\$)@[@'
tcc_tree
fx_run check-test-code-coverage
expect_red '照合パターンを評価できません'
# 「評価不能」が「lint 引数に無い」へ化けていないこと（原因と逆向きの指示を出さない）。
expect_absent 'lint スクリプトの引数にありません'
t_end

# ---------------------------------------------------------------------------
# Issue #82: 走査対象を作業ツリーから git 管理下へ寄せたことの検証。
#
# 再現条件は vitest / vite が設定ファイルと同じディレクトリへ生成する
# `<config>.timestamp-<ms>-<rand>.mjs`。通常は finally で消えるが強制終了時に残り、
# .gitignore にも該当パターンが無い。修正前はこれを「配線すべきコードファイル」として扱い、
# **一時ファイル名を lint 引数へ恒久的に追加せよ**という従ってはいけない指示を出していた。

t_begin 'check-test-code-coverage: 未追跡の一時ファイルで誤爆しない（#82）'
tcc_stub_fixture
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
t_end

t_begin 'check-test-code-coverage: 対照 — 同じファイルが追跡されていれば検出する（見逃しでない）'
tcc_stub_fixture
# fx_track_now を呼ばない。fx_run が全ファイルを追跡させるため、この .mjs も対象になる。
# 上のケースの緑が「未追跡だから」であって「拡張子や場所で落としたから」ではないことを示す。
fx_write ts/packages/w1/tracked-extra.mjs <<'EOF'
export default {};
EOF
fx_run check-test-code-coverage
expect_red 'tracked-extra.mjs'
t_end

t_begin 'check-test-code-coverage: git work tree でなければ緑を返さない'
tcc_stub_fixture
# .git を作らずに直接起動する（fx_run の自動 git 化を迂回する）。
# shellcheck disable=SC2034 # OUT / RC は run.sh の expect_* が読むハーネス側のグローバル
OUT="$(cd "$FX" && bash scripts/check-test-code-coverage.sh 2>&1)" && RC=0 || RC=$?
expect_red 'git work tree ではありません'
t_end

# ---------------------------------------------------------------------------
# 列挙を git へ寄せたことの残差。情報源を替えると「対象の集合」だけでなく
# **対象の表現**まで替わる。以下 3 件はいずれもその表現差・出力経路の差で生じる。

t_begin 'check-test-code-coverage: 非 ASCII ファイル名のコードファイルも列挙する'
tcc_stub_fixture
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
t_end

t_begin 'check-test-code-coverage: 未追跡が大量でも中断しない'
tcc_stub_fixture
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
t_end

t_begin 'check-test-code-coverage: サブディレクトリ 0 件の診断が撤去済みの find / prune を指さない'
tcc_stub_fixture
# 唯一のサブディレクトリ占有者を外して checked_subdir_files を 0 にし、両論併記の診断を出させる。
# 走査系は find でも prune でもなくなったため、その語で調査先を案内すると存在しない機構へ
# 誘導することになる（原因と逆方向へ誘導するのは #81 で塞いだはずの欠落である）。
rm -f "${FX}/ts/packages/w1/perf/x.mjs"
fx_run check-test-code-coverage
expect_red 'サブディレクトリのコードファイルを1件も検証できませんでした'
expect_absent 'prune'
expect_absent 'find の'
t_end
