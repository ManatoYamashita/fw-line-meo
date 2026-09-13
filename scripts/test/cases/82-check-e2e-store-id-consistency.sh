# scripts/check-e2e-store-id-consistency.sh の自己テスト（Issue #53 / #264）。
#
# 本ガードが守るのは「役割の違う 4 箇所に現れる E2E の storeId が同じ値であること」と、
# 「測った画面の確認（perf/verify-lhr.mjs）を CI とローカルの実行装置が同じ形で呼んでいること」である。
# ずれたときの症状は赤ではない —— とくに Lighthouse の URL がずれると、存在しない店舗の
# 1 段落だけの面を測って LCP も accessibility も緑を返す。**別の面を測ったまま合格する。**
# 確認の呼び出しが消えたときも同じで、lhci は合格し続ける（Issue #264）。

esi_tree() {
  fx_guard check-e2e-store-id-consistency

  fx_write ts/apps/survey-web/e2e/seed.sql <<'EOF'
INSERT INTO owners (id, agency_id) VALUES ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222') ON CONFLICT DO NOTHING;
INSERT INTO stores (id, owner_id, name, place_id, place_status)
  VALUES ('44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', 'E2E店', 'ChIJxxxx', 'confirmed') ON CONFLICT DO NOTHING;
EOF
  fx_write ts/apps/survey-web/e2e/fixtures/surfaces.ts <<'EOF'
export const STORE_ID = process.env.E2E_STORE_ID ?? '44444444-4444-4444-4444-444444444444';
EOF
  # lighthouse ジョブは末尾に置く（ジョブのブロックがファイル末尾で終わる境界を、緑の側で通す）。
  # 拾ってはならないものも混ぜてある: 別のステップの if: / continue-on-error:、判定の語や
  # 確認の呼び出しを含むコメント。これらで赤くなるなら、抽出が広すぎる。
  fx_write .github/workflows/ts-ci.yml <<'EOF'
name: ts-ci
jobs:
  e2e:
    env:
      E2E_STORE_ID: '44444444-4444-4444-4444-444444444444'
    steps:
      - uses: actions/checkout@v5
        continue-on-error: true
      - run: echo ok
  lighthouse:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - name: Lighthouse
        if: always()
        working-directory: ts/apps/survey-web
        run: npx --yes @lhci/cli@0.15.x autorun --config=perf/lighthouserc.json
      - name: '測った画面の確認（Issue #264）'
        working-directory: ts/apps/survey-web
        # 判定の中身（largest-contentful-paint-element を読む処理）はここに書かない。
        # run: node perf/verify-lhr.mjs --print-seed はコメントなので数えない。
        run: node perf/verify-lhr.mjs
EOF
  # 準備段の --print-seed は関数の外にある（layer_lighthouse の確認の代わりにはならない）。
  # 確認の後ろの空行・本体の中のコメントは「最後の実行行」に数えない。
  fx_write scripts/run-e2e-local.sh <<'EOF'
#!/usr/bin/env bash
# 判定の中身（largest-contentful-paint-element を読む処理）はここに書かない。
seed_line="$(node "${SURVEY_DIR}/perf/verify-lhr.mjs" --print-seed)" || seed_line=''

layer_survey() {
    echo survey
}

layer_lighthouse() {
    E2E_SEED_STORE_ID="$store_id" bash "$WITH_TEST_DB" bash "$SELF" __inside-db lighthouse || return 1
    # 判定は CI と同じ perf/verify-lhr.mjs。
    node "${SURVEY_DIR}/perf/verify-lhr.mjs"

}

layer_cross_runtime() {
    echo cross
}
EOF
  fx_write ts/apps/survey-web/perf/verify-lhr.mjs <<'EOF'
// @ts-check
// fixture（ガードは実在だけを見る）
EOF
  fx_write ts/apps/survey-web/perf/lighthouserc.json <<'EOF'
{
  "ci": {
    "collect": {
      "url": ["http://127.0.0.1:3000/s/44444444-4444-4444-4444-444444444444"]
    }
  }
}
EOF
  fx_write docs/e2e-runbook.md <<'EOF'
ローカルで走らせる手順:

```bash
export E2E_STORE_ID="44444444-4444-4444-4444-444444444444"
```
EOF
}

esi_replace() {
  # 合成ツリーのファイル（$1）の中の字面（$2）を $3 へ置き換える。$3 の \n は改行になる（awk -v）。
  # **ちょうど 1 箇所に当たったことを確かめる。** 空振りした置き換えは無改変の fixture を検査し、
  # 「赤にならなかった」「赤になった」のどちらも別の理由で読み違える。2 箇所以上に当たった場合も、
  # 狙った行だけを壊したと言えないので落とす。`sed -i` は BSD と GNU で引数が違うので awk で書く。
  er_path="${FX}/$1"
  er_rc=0
  er_n="$(awk -v old="$2" -v new="$3" -v out="${er_path}.tmp" '
    {
      line = $0
      res = ""
      while ((i = index(line, old)) > 0) {
        res = res substr(line, 1, i - 1) new
        line = substr(line, i + length(old))
        n++
      }
      print res line > out
    }
    END { print n + 0 }
  ' "$er_path")" || er_rc=$?
  if [ "$er_rc" -ne 0 ]; then
    _t_fail "fixture の置き換えを評価できません（awk exit=${er_rc}）: $1"
    return 1
  fi
  mv "${er_path}.tmp" "$er_path"
  if [ "$er_n" -ne 1 ]; then
    _t_fail "fixture の置き換えが ${er_n} 箇所に当たりました（ちょうど 1 箇所であるべきです）: $1: $2"
    return 1
  fi
  return 0
}

t_begin 'check-e2e-store-id-consistency: 正常なツリーで緑（値と件数まで照合）'
esi_tree
fx_run check-e2e-store-id-consistency
expect_green
# 「OK」だけでなく照合できた件数まで見る。走査が空振りしたまま緑になる経路と区別するため。
expect_output_matches '役割 4 件が一致 44444444-4444-4444-4444-444444444444 / 既定値の宣言 1 件 / ts 走査 1 ファイル / 手順書 1 件照合 / 判定の配線 2 箇所'
# 別のステップの if: / continue-on-error: と、コメントの中の判定の語・呼び出しは拾わない。
expect_absent 'continue-on-error か if: が付いています'
expect_absent '判定の中身'
expect_absent '形の違う呼び出し'
t_end

# ---------------------------------------------------------------------------
# 1. 役割ごとのずれ。3 経路それぞれで到達することを示す。

# **最も静かなずれ。** Lighthouse は存在しない店舗の URL を開き、1 段落だけの面に対して
# LCP も accessibility も緑を返す。
t_begin 'check-e2e-store-id-consistency: 計測（Lighthouse）の URL だけずれると赤'
esi_tree
fx_write ts/apps/survey-web/perf/lighthouserc.json <<'EOF'
{
  "ci": {
    "collect": {
      "url": ["http://127.0.0.1:3000/s/55555555-5555-5555-5555-555555555555"]
    }
  }
}
EOF
fx_run check-e2e-store-id-consistency
expect_red '計測（ts/apps/survey-web/perf/lighthouserc.json）の storeId が種と一致しません。'
t_end

t_begin 'check-e2e-store-id-consistency: 注入（CI の env）だけずれると赤'
esi_tree
esi_replace .github/workflows/ts-ci.yml \
  "E2E_STORE_ID: '44444444-4444-4444-4444-444444444444'" \
  "E2E_STORE_ID: '77777777-7777-7777-7777-777777777777'"
fx_run check-e2e-store-id-consistency
expect_red '注入（.github/workflows/ts-ci.yml）の storeId が種と一致しません。'
# 赤の原因が注入のずれだけであること（配線の側を巻き込んで壊していない）。
expect_absent 'ERROR: 判定:'
t_end

t_begin 'check-e2e-store-id-consistency: 既定（fixtures）だけずれると赤'
esi_tree
fx_write ts/apps/survey-web/e2e/fixtures/surfaces.ts <<'EOF'
export const STORE_ID = process.env.E2E_STORE_ID ?? '88888888-8888-8888-8888-888888888888';
EOF
fx_run check-e2e-store-id-consistency
expect_red '既定（ts/apps/survey-web/e2e/fixtures/surfaces.ts）の storeId が種と一致しません。'
t_end

# ---------------------------------------------------------------------------
# 2. 既定値の複写。**本ガードを入れた直接の動機**（PR #191 時点の状態）。
#    env が渡っている限り値は一致するため、複写であること自体が観測できない。

t_begin 'check-e2e-store-id-consistency: 既定値の宣言が 2 箇所あると赤'
esi_tree
fx_write ts/apps/survey-web/e2e/survey-flow.spec.ts <<'EOF'
const STORE_ID = process.env.E2E_STORE_ID ?? '44444444-4444-4444-4444-444444444444';
export default STORE_ID;
EOF
fx_run check-e2e-store-id-consistency
expect_red '既定値の宣言（process.env.E2E_STORE_ID ??）が 2 件あります（1 件であるべきです）'
t_end

# ---------------------------------------------------------------------------
# 3. 抽出の前提が崩れたときに赤くなること。
#
# **このケースは実際にバグを 1 件捕まえている。** 抽出関数はコマンド置換（副シェル）で
# 呼ばれるため、関数の中で fail=1 を立てても親へ戻らない。最初の実装はまさにその形で、
# ERROR を stderr へ出しながら exit 0 を返していた（健全な実行と見分けが付かない偽の緑）。
# expect_red は exit != 0 を要求するので、この形の再発はここで止まる。

t_begin 'check-e2e-store-id-consistency: 種の抽出前提が崩れると赤（exit も非ゼロ）'
esi_tree
fx_write ts/apps/survey-web/e2e/seed.sql <<'EOF'
INSERT INTO shops (id, owner_id, name, place_id, place_status)
  VALUES ('44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', 'E2E店', 'ChIJxxxx', 'confirmed') ON CONFLICT DO NOTHING;
EOF
fx_run check-e2e-store-id-consistency
expect_red '種: ts/apps/survey-web/e2e/seed.sql から storeId を抽出できませんでした。'
t_end

t_begin 'check-e2e-store-id-consistency: 種が 2 件取れると赤（正典が決まらない）'
esi_tree
fx_write ts/apps/survey-web/e2e/seed.sql <<'EOF'
INSERT INTO stores (id, owner_id, name, place_id, place_status)
  VALUES ('44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', 'E2E店', 'ChIJxxxx', 'confirmed');
INSERT INTO stores (id, owner_id, name, place_id, place_status)
  VALUES ('99999999-9999-9999-9999-999999999999', '33333333-3333-3333-3333-333333333333', 'E2E店2', 'ChIJyyyy', 'confirmed');
EOF
fx_run check-e2e-store-id-consistency
expect_red 'から storeId が 2 件取れました（どれが正典か決まりません）。'
t_end

# ---------------------------------------------------------------------------
# 4. 手順書の照合。**あれば照合し、無くても緑**（文書を消しただけで赤くなるのは行き過ぎ）。

t_begin 'check-e2e-store-id-consistency: 手順書の値が古いと赤'
esi_tree
fx_write docs/e2e-runbook.md <<'EOF'
ローカルで走らせる手順:

```bash
export E2E_STORE_ID="66666666-6666-6666-6666-666666666666"
```
EOF
fx_run check-e2e-store-id-consistency
expect_red 'docs/e2e-runbook.md の手順が古い storeId を指示しています'
t_end

t_begin 'check-e2e-store-id-consistency: 手順書が無くても緑（存在までは要求しない）'
esi_tree
fx_write docs/e2e-runbook.md <<'EOF'
ローカルで走らせる手順は CI のワークフローを参照すること。
EOF
fx_run check-e2e-store-id-consistency
expect_green
expect_output_matches '手順書 0 件照合'
t_end

# ---------------------------------------------------------------------------
# 5. 既定値の宣言を数える走査面の**母数**。
#
# 「宣言がちょうど 1 件」は、走査面を fixtures の 1 ディレクトリまで狭めても成立する。
# そのとき他所の複写は見えないまま緑を返す —— 「走査していない」と「違反が無い」を
# 区別できない形である（steering tech.md の #162 の規律）。母数を出力へ載せて照合する。

t_begin 'check-e2e-store-id-consistency: 既定値を数えた走査面の母数を出力する'
esi_tree
fx_run check-e2e-store-id-consistency
expect_green
expect_output_matches '既定値の宣言 1 件 / ts 走査 1 ファイル'
t_end

t_begin 'check-e2e-store-id-consistency: ts の走査面が消えると赤（母数 0 を違反 0 件と読まない）'
esi_tree
fx_guard_mutate check-e2e-store-id-consistency \
  -e "s|-type f -name '\*\.ts' -print|-type f -name '*.NOPE' -print|"
fx_run check-e2e-store-id-consistency
expect_red 'ts/ 配下に走査対象の .ts が 1 件もありません'
t_end

# ---------------------------------------------------------------------------
# 6. 判定の配線（Issue #264）。
#
# lhci の判定は、店舗が見つからない 1 段落の面を測っても合格する。それを赤にする確認
# （perf/verify-lhr.mjs）の呼び出しが消えても、ずれても、**lhci は合格し続けるので何も赤くならない。**
# 消し方・ずらし方を 1 つずつ当て、それぞれが名指しの理由で赤になることを固定する。

# --- 6-1. CI の lighthouse ジョブ ------------------------------------------------

t_begin 'check-e2e-store-id-consistency: 判定: CI の確認のステップを消すと赤'
esi_tree
esi_replace .github/workflows/ts-ci.yml '        run: node perf/verify-lhr.mjs' '        run: echo skipped'
fx_run check-e2e-store-id-consistency
expect_red "lighthouse ジョブに測った画面の確認（'run: node perf/verify-lhr.mjs' の 1 行）が 0 行あります"
t_end

t_begin 'check-e2e-store-id-consistency: 判定: 確認を別のジョブ（e2e）へ移すと赤'
esi_tree
fx_write .github/workflows/ts-ci.yml <<'EOF'
name: ts-ci
jobs:
  e2e:
    env:
      E2E_STORE_ID: '44444444-4444-4444-4444-444444444444'
    steps:
      - run: echo ok
      - run: node perf/verify-lhr.mjs
  lighthouse:
    steps:
      - run: npx --yes @lhci/cli@0.15.x autorun --config=perf/lighthouserc.json
EOF
fx_run check-e2e-store-id-consistency
expect_red "lighthouse ジョブに測った画面の確認（'run: node perf/verify-lhr.mjs' の 1 行）が 0 行あります"
t_end

# ジョブ名の境界。前方一致で切り出すと lighthouse-desktop を lighthouse として数える。
t_begin 'check-e2e-store-id-consistency: 判定: 名前の似たジョブ（lighthouse-desktop）の確認は数えない'
esi_tree
fx_write .github/workflows/ts-ci.yml <<'EOF'
name: ts-ci
jobs:
  e2e:
    env:
      E2E_STORE_ID: '44444444-4444-4444-4444-444444444444'
    steps:
      - run: echo ok
  lighthouse-desktop:
    steps:
      - run: npx --yes @lhci/cli@0.15.x autorun --config=perf/lighthouserc.json
      - run: node perf/verify-lhr.mjs
  lighthouse:
    steps:
      - run: npx --yes @lhci/cli@0.15.x autorun --config=perf/lighthouserc.json
EOF
fx_run check-e2e-store-id-consistency
expect_red "lighthouse ジョブに測った画面の確認（'run: node perf/verify-lhr.mjs' の 1 行）が 0 行あります"
expect_absent 'lighthouse ジョブが 2 個あります'
t_end

# ブロックの終端の境界。次のジョブの見出しでブロックを閉じないと、後ろのジョブの確認を数える。
t_begin 'check-e2e-store-id-consistency: 判定: lighthouse の後ろのジョブにある確認は数えない'
esi_tree
fx_write .github/workflows/ts-ci.yml <<'EOF'
name: ts-ci
jobs:
  e2e:
    env:
      E2E_STORE_ID: '44444444-4444-4444-4444-444444444444'
    steps:
      - run: echo ok
  lighthouse:
    steps:
      - run: npx --yes @lhci/cli@0.15.x autorun --config=perf/lighthouserc.json
  after-lighthouse:
    steps:
      - run: node perf/verify-lhr.mjs
EOF
fx_run check-e2e-store-id-consistency
expect_red "lighthouse ジョブに測った画面の確認（'run: node perf/verify-lhr.mjs' の 1 行）が 0 行あります"
t_end

t_begin 'check-e2e-store-id-consistency: 判定: 確認が lhci の autorun より前にあると赤'
esi_tree
fx_write .github/workflows/ts-ci.yml <<'EOF'
name: ts-ci
jobs:
  e2e:
    env:
      E2E_STORE_ID: '44444444-4444-4444-4444-444444444444'
    steps:
      - run: echo ok
  lighthouse:
    steps:
      - name: '測った画面の確認'
        run: node perf/verify-lhr.mjs
      - name: Lighthouse
        run: npx --yes @lhci/cli@0.15.x autorun --config=perf/lighthouserc.json
EOF
fx_run check-e2e-store-id-consistency
expect_red 'lighthouse ジョブの測った画面の確認が、lhci の autorun より前にあります。'
t_end

t_begin 'check-e2e-store-id-consistency: 判定: 確認に引数（--print-seed）を付けると赤'
esi_tree
esi_replace .github/workflows/ts-ci.yml '        run: node perf/verify-lhr.mjs' '        run: node perf/verify-lhr.mjs --print-seed'
fx_run check-e2e-store-id-consistency
expect_red '形の違う呼び出し（引数付き・複数行の run: など）が 1 行あります'
t_end

t_begin 'check-e2e-store-id-consistency: 判定: 確認の失敗を || true で捨てると赤'
esi_tree
esi_replace .github/workflows/ts-ci.yml '        run: node perf/verify-lhr.mjs' '        run: node perf/verify-lhr.mjs || true'
fx_run check-e2e-store-id-consistency
expect_red "lighthouse ジョブに測った画面の確認（'run: node perf/verify-lhr.mjs' の 1 行）が 0 行あります"
t_end

t_begin 'check-e2e-store-id-consistency: 判定: 確認のステップに continue-on-error を付けると赤'
esi_tree
esi_replace .github/workflows/ts-ci.yml \
  '        run: node perf/verify-lhr.mjs' \
  '        continue-on-error: true\n        run: node perf/verify-lhr.mjs'
fx_run check-e2e-store-id-consistency
expect_red 'lighthouse ジョブの測った画面の確認に continue-on-error か if: が付いています。'
t_end

# if: がステップの先頭のキー（`- if:`）でも同じステップとして読む。
t_begin 'check-e2e-store-id-consistency: 判定: 確認のステップに if: を付けると赤（ステップ先頭のキー）'
esi_tree
esi_replace .github/workflows/ts-ci.yml \
  "      - name: '測った画面の確認（Issue #264）'" \
  "      - if: github.event_name == 'push'\n        name: '測った画面の確認（Issue #264）'"
fx_run check-e2e-store-id-consistency
expect_red 'lighthouse ジョブの測った画面の確認に continue-on-error か if: が付いています。'
t_end

t_begin 'check-e2e-store-id-consistency: 判定: 確認がコメントの中にしか無いと赤'
esi_tree
esi_replace .github/workflows/ts-ci.yml \
  '        run: node perf/verify-lhr.mjs' \
  '        # run: node perf/verify-lhr.mjs\n        run: echo skipped'
fx_run check-e2e-store-id-consistency
expect_red "lighthouse ジョブに測った画面の確認（'run: node perf/verify-lhr.mjs' の 1 行）が 0 行あります"
t_end

t_begin 'check-e2e-store-id-consistency: 判定: lighthouse ジョブごと消すと赤'
esi_tree
fx_write .github/workflows/ts-ci.yml <<'EOF'
name: ts-ci
jobs:
  e2e:
    env:
      E2E_STORE_ID: '44444444-4444-4444-4444-444444444444'
    steps:
      - run: echo ok
EOF
fx_run check-e2e-store-id-consistency
expect_red 'lighthouse ジョブが 0 個あります（ちょうど 1 個であるべきです）。'
t_end

t_begin 'check-e2e-store-id-consistency: 判定: lighthouse ジョブに lhci の autorun が無いと赤'
esi_tree
esi_replace .github/workflows/ts-ci.yml \
  '        run: npx --yes @lhci/cli@0.15.x autorun --config=perf/lighthouserc.json' \
  '        run: echo no-lhci'
fx_run check-e2e-store-id-consistency
expect_red 'lighthouse ジョブに lhci の autorun がありません（確認の前提が崩れています）。'
t_end

t_begin 'check-e2e-store-id-consistency: 判定: CI に判定の中身を書き戻すと赤'
esi_tree
esi_replace .github/workflows/ts-ci.yml \
  '        run: node perf/verify-lhr.mjs' \
  '        run: node perf/verify-lhr.mjs\n      - run: echo largest-contentful-paint-element'
fx_run check-e2e-store-id-consistency
expect_red '.github/workflows/ts-ci.yml に判定の中身（largest-contentful-paint-element を読む処理）が 1 行あります。'
t_end

# --- 6-2. ローカルの実行装置 ------------------------------------------------------

# 準備段の --print-seed（関数の外）が残っていても、layer_lighthouse の確認の代わりにはならない。
t_begin 'check-e2e-store-id-consistency: 判定: 実行装置の確認を消すと赤（--print-seed の呼び出しは数えない）'
esi_tree
esi_replace scripts/run-e2e-local.sh '    node "${SURVEY_DIR}/perf/verify-lhr.mjs"' '    echo skipped'
fx_run check-e2e-store-id-consistency
expect_red "layer_lighthouse() に測った画面の確認（'node \"\${SURVEY_DIR}/perf/verify-lhr.mjs\"' の 1 行）が 0 行あります"
t_end

t_begin 'check-e2e-store-id-consistency: 判定: 確認が layer_lighthouse の外（別の関数）にしか無いと赤'
esi_tree
fx_write scripts/run-e2e-local.sh <<'EOF'
#!/usr/bin/env bash
layer_survey() {
    node "${SURVEY_DIR}/perf/verify-lhr.mjs"
}

layer_lighthouse() {
    E2E_SEED_STORE_ID="$store_id" bash "$WITH_TEST_DB" bash "$SELF" __inside-db lighthouse || return 1
}
EOF
fx_run check-e2e-store-id-consistency
expect_red "layer_lighthouse() に測った画面の確認（'node \"\${SURVEY_DIR}/perf/verify-lhr.mjs\"' の 1 行）が 0 行あります"
t_end

# set -e が効かない呼ばれ方なので、後ろの 1 行が判定の終了コードを上書きする。
t_begin 'check-e2e-store-id-consistency: 判定: 確認の後ろに行を足すと赤（終了コードが捨てられる）'
esi_tree
esi_replace scripts/run-e2e-local.sh \
  '    node "${SURVEY_DIR}/perf/verify-lhr.mjs"' \
  '    node "${SURVEY_DIR}/perf/verify-lhr.mjs"\n    echo done'
fx_run check-e2e-store-id-consistency
expect_red 'layer_lighthouse() の測った画面の確認が、本体の最後の実行行ではありません。'
t_end

t_begin 'check-e2e-store-id-consistency: 判定: 確認が lhci の実行より前にあると赤'
esi_tree
fx_write scripts/run-e2e-local.sh <<'EOF'
#!/usr/bin/env bash
layer_lighthouse() {
    node "${SURVEY_DIR}/perf/verify-lhr.mjs"
    E2E_SEED_STORE_ID="$store_id" bash "$WITH_TEST_DB" bash "$SELF" __inside-db lighthouse || return 1
}
EOF
fx_run check-e2e-store-id-consistency
expect_red 'layer_lighthouse() の測った画面の確認が、lhci の実行（__inside-db lighthouse）より前にあります。'
t_end

t_begin 'check-e2e-store-id-consistency: 判定: 実行装置の確認を || true で捨てると赤'
esi_tree
esi_replace scripts/run-e2e-local.sh \
  '    node "${SURVEY_DIR}/perf/verify-lhr.mjs"' \
  '    node "${SURVEY_DIR}/perf/verify-lhr.mjs" || true'
fx_run check-e2e-store-id-consistency
expect_red '形の違う呼び出し（引数付き・|| 付きなど）が 1 行あります'
t_end

t_begin 'check-e2e-store-id-consistency: 判定: 実行装置に判定の中身を書き戻すと赤'
esi_tree
esi_replace scripts/run-e2e-local.sh \
  '    # 判定は CI と同じ perf/verify-lhr.mjs。' \
  '    echo largest-contentful-paint-element >/dev/null'
fx_run check-e2e-store-id-consistency
expect_red 'scripts/run-e2e-local.sh に判定の中身（largest-contentful-paint-element を読む処理）が 1 行あります。'
t_end

t_begin 'check-e2e-store-id-consistency: 判定: layer_lighthouse() ごと消すと赤'
esi_tree
fx_write scripts/run-e2e-local.sh <<'EOF'
#!/usr/bin/env bash
layer_survey() {
    echo survey
}
EOF
fx_run check-e2e-store-id-consistency
expect_red 'scripts/run-e2e-local.sh に layer_lighthouse() が 0 個あります（ちょうど 1 個であるべきです）。'
t_end

t_begin 'check-e2e-store-id-consistency: 判定: 実行装置ごと消すと赤'
esi_tree
rm -f "${FX}/scripts/run-e2e-local.sh"
fx_run check-e2e-store-id-consistency
expect_red 'scripts/run-e2e-local.sh がありません（ローカルの実行装置が CI と同じ判定を呼ぶことを確かめられません）。'
t_end

# --- 6-3. 判定の実体 --------------------------------------------------------------

t_begin 'check-e2e-store-id-consistency: 判定: perf/verify-lhr.mjs を消すと赤'
esi_tree
rm -f "${FX}/ts/apps/survey-web/perf/verify-lhr.mjs"
fx_run check-e2e-store-id-consistency
expect_red '判定: ts/apps/survey-web/perf/verify-lhr.mjs がありません。'
t_end
