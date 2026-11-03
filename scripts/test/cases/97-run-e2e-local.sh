# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
#
# scripts/run-e2e-local.sh の自己テスト（Issue #502）。
#
# 守りたい性質は「シェルが差し替えたブラウザ（PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH）を、既定では
# この先の層へ渡さない」ことである。手元のシェルが Aside を指したまま `make e2e` を打つと、全件緑でも
# exit 1 になり（#381）、画素の検査はローカルだけで揺れる（#378）。どちらも実装の赤に見えるので、
# 環境の取り違えが毎回の切り分けの手間に化ける。
#
# 装置の本体（Playwright・一時 DB・ビルド）は流さない。`--prepare-only` で、シェルの env の掃除までを
# 行って止め、この先へ渡る値を `PREPARED:` 行で読む。
#
# 実行は env -u で利用者のシェルの値を必ず外してから、ケースごとに必要な値だけを渡す
# （このテストを Aside を指したシェルで流しても、ケースの前提が崩れないようにする）。

rel_run() {
  # 引数は env へ渡す `NAME=value` の並び。
  OUT=''
  RC=0
  OUT="$(cd "$FX" && env -u PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH -u E2E_KEEP_BROWSER_PATH "$@" \
    bash scripts/run-e2e-local.sh --prepare-only 2>&1)" || RC=$?
}

rel_fake_browser() {
  # 実行できる偽のブラウザを合成ツリーに置く（残す経路は、指す先が実行できることを確かめるため）。
  REL_FAKE_BROWSER="${FX}/fake-browser/Aside"
  mkdir -p "${FX}/fake-browser"
  printf '#!/bin/sh\nexit 0\n' > "$REL_FAKE_BROWSER"
  chmod +x "$REL_FAKE_BROWSER"
}

t_begin 'run-e2e-local: シェルが差し替えたブラウザは既定で外し、付属 Chromium で流す'
fx_guard run-e2e-local
rel_fake_browser
rel_run "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=${REL_FAKE_BROWSER}"
expect_green
expect_output_matches '^PREPARED: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=<未設定>$'
expect_output_matches "^-- シェルに設定されていた PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH（${REL_FAKE_BROWSER}）を、この実行では外し"
expect_output_matches 'E2E_KEEP_BROWSER_PATH=1 を付けてください'
t_end

t_begin 'run-e2e-local: E2E_KEEP_BROWSER_PATH=1 なら差し替えたブラウザを残す'
fx_guard run-e2e-local
rel_fake_browser
rel_run "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=${REL_FAKE_BROWSER}" 'E2E_KEEP_BROWSER_PATH=1'
expect_green
expect_output_matches "^PREPARED: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=${REL_FAKE_BROWSER}\$"
expect_output_matches '^-- E2E_KEEP_BROWSER_PATH=1 なので'
t_end

t_begin 'run-e2e-local: E2E_KEEP_BROWSER_PATH が 1 以外なら外す（逃げ道は明示の 1 だけ）'
fx_guard run-e2e-local
rel_fake_browser
rel_run "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=${REL_FAKE_BROWSER}" 'E2E_KEEP_BROWSER_PATH=0'
expect_green
expect_output_matches '^PREPARED: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=<未設定>$'
t_end

t_begin 'run-e2e-local: 変数が無ければ何も言わない'
fx_guard run-e2e-local
rel_fake_browser
rel_run
expect_green
expect_output_matches '^PREPARED: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=<未設定>$'
expect_absent 'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH（'
t_end

t_begin 'run-e2e-local: 残すと言ったのに実行できないファイルを指していれば止める'
fx_guard run-e2e-local
rel_run "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=${FX}/no-such-browser" 'E2E_KEEP_BROWSER_PATH=1'
expect_red 'は実行できるファイルではありません'
expect_absent 'PREPARED:'
t_end
