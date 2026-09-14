#!/usr/bin/env bash
# Issue #53 ガードレール: E2E で使う「確定店舗」の storeId は、役割の違う 4 箇所に現れる。
# **4 つとも同じ値でなければならないが、ずれても CI は緑を返しうる。**
#
#   1. 種   `ts/apps/survey-web/e2e/seed.sql`            … この行が店舗を作る（正典）
#   2. 既定 `ts/apps/survey-web/e2e/fixtures/surfaces.ts`… env が無いときの既定値
#   3. 注入 `.github/workflows/ts-ci.yml`                … CI が Playwright へ渡す E2E_STORE_ID
#   4. 計測 `ts/apps/survey-web/perf/lighthouserc.json`  … Lighthouse が開く URL
#
# **4 のずれが最も静かである。** 種の UUID を変えて lighthouserc.json を直し忘れると、
# Lighthouse は存在しない店舗の URL を開く。そのとき出るのは 404 ではなく
# 「このアンケートは現在ご利用いただけません。」の 1 段落だけの面で、LCP は当然速く、
# accessibility も 1.0 を返す。**つまり別の面を測ったまま lhci の両方の assert が緑になる。**
# これは Issue #53 が塞いだ「前提が崩れたまま緑を返す」形そのものである。
# lighthouse ジョブの画面の確認（perf/verify-lhr.mjs・Issue #264）もこのずれで赤くなるが、
# あちらは「測った画面が違う」としか言えない。原因が storeId のずれだと名指しするのはここである。
#
# **storeId が 4 箇所で一致していても、画面が描けないことはある**（seed の投入の失敗・店舗の状態を
# 変える migration・画面側の分岐の変更）。それは storeId の照合の射程の外であり、lighthouse ジョブの
# 画面の確認が赤にする。**ただし、その確認の呼び出しが消えても何も赤くならない。** 穴は緑のまま
# 静かに開き直る。そこで 5. で配線そのものを固定する（Issue #264）。
#
# 2 のずれは、env を渡さないローカル実行だけに効く（CI は 3 が勝つ）。前提 assert が入った
# 今は赤くなるが、原因は「storeId が違う」ではなく「面が描けていない」として現れる。
# ここで名指ししておくほうが早い。
#
# 本スクリプトは以下を機械検証する（read-only の走査・副作用なし・bash 3.2 でも走る）:
#   1. 4 つの役割それぞれから値が**ちょうど 1 つ**取れる（0 件＝抽出の前提が崩れた・
#      2 件以上＝どれが正典か決まらない、のどちらも赤）
#   2. 4 つの値がすべて一致する（不一致は役割名つきで報告する）
#   3. 既定値の宣言（`process.env.E2E_STORE_ID ??`）が ts/ 配下でちょうど 1 箇所。
#      **走査面の母数も出力へ載せる**（「ちょうど 1 件」は走査面を 1 ディレクトリまで狭めても
#        成立するため、件数だけでは「走査していない」と「違反が無い」を区別できない・#162 の規律）
#      （**これが本ガードを入れた直接の動機である。** PR #191 の時点では fixtures と
#        survey-flow.spec.ts が同じ UUID をそれぞれ持っており、env が渡っている限り
#        一致するため、複写であること自体が観測できなかった）
#   4. Markdown の手順書に書かれた `E2E_STORE_ID=...` の値も一致する（あれば照合する。
#      無くてもよい —— 手順書の有無まで要求すると、文書を消しただけで赤くなる）
#   5. 判定の配線（Issue #264）。測った画面の確認 `perf/verify-lhr.mjs` を、CI とローカルの
#      実行装置の両方が同じ形で呼んでいる:
#      - ts-ci.yml の lighthouse ジョブに、引数なしの `run: node perf/verify-lhr.mjs` がちょうど 1 行あり、
#        lhci の autorun より後ろにあり、そのステップに continue-on-error も if: も無い
#        （ジョブ名は完全一致で照合する。別のジョブ・コメント・引数付きの呼び出しは数えない。
#        そのステップを読めなければ赤にする。読めないまま「付いていない」とは読まない）
#      - scripts/run-e2e-local.sh の layer_lighthouse() が、`__inside-db lighthouse` の後に同じ判定を
#        **最後の実行行として**呼ぶ（層は `layer_lighthouse || rc=$?` で呼ばれ set -e が効かないため、
#        後ろに行があると判定の終了コードが捨てられる）
#      - 判定の中身（largest-contentful-paint-element を読む処理）が、どちらのファイルにも無い
#        （判定を 2 箇所に持たない。正典は perf/lhr-verification.mjs）
#
# 種の抽出は **位置で読む**（VALUES の最初の値）。stores の列の並びを変えると誤った赤になる
# （偽の緑にはならない）。そのときは抽出式を列の並びに合わせること。
#
# **UUID の一致を無条件には要求しない。** 同じ UUID は単体テストにも多数現れるが、あちらは
# 隔離された文脈で任意に選んだリテラルであり、種の値と一致する義務は無い。役割で照合する。
#
# 使い方: bash scripts/check-e2e-store-id-consistency.sh
#   ずれがあれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SEED_FILE="${ROOT}/ts/apps/survey-web/e2e/seed.sql"
FIXTURE_FILE="${ROOT}/ts/apps/survey-web/e2e/fixtures/surfaces.ts"
CI_FILE="${ROOT}/.github/workflows/ts-ci.yml"
LHCI_FILE="${ROOT}/ts/apps/survey-web/perf/lighthouserc.json"
RUNNER_FILE="${ROOT}/scripts/run-e2e-local.sh"
VERIFY_CLI="${ROOT}/ts/apps/survey-web/perf/verify-lhr.mjs"
# 判定の呼び出しの正規形（前後の空白を除いた行と完全一致で照合する。引数も `||` も許さない）。
CI_VERIFY_LINE='run: node perf/verify-lhr.mjs'
# shellcheck disable=SC2016  # 実行装置の行を字面のまま照合するため、展開させない。
RUNNER_VERIFY_LINE='node "${SURVEY_DIR}/perf/verify-lhr.mjs"'
# 判定の中身がここにあれば、判定が 2 箇所にある（LCP 要素の監査 ID で見分ける）。
JUDGE_MARKER='largest-contentful-paint-element'

fail=0
doc_checked=0
wired=0

# 役割ごとに値を 1 つだけ取り出す。0 件と 2 件以上はどちらも「抽出できなかった」として空を返す。
# 値は空白を含まないので、位置パラメータで件数を数えられる（パイプを作らない）。
#
# **この関数の中で fail を立ててはならない。** 呼び出しはコマンド置換（副シェル）なので、
# 代入した値は親へ戻らず、stderr のエラーだけが出て exit 0 という**偽の緑**になる。
# 実際この形で 1 度踏んだ（種の抽出前提を壊す対照で、ERROR を出しながら exit=0 を返した）。
# 判定は必ず呼び出し側で、返ってきた値の有無を見て行う。
extract_one() {
  # $1 = 役割名 / $2 = ファイル / $3 = sed の抽出式。取れなければ空を返す。
  eo_label="$1"
  eo_file="$2"
  eo_expr="$3"
  if [ ! -f "$eo_file" ]; then
    echo "ERROR: ${eo_label}: ${eo_file#$ROOT/} がありません。走査の前提が崩れています。" >&2
    printf ''
    return
  fi
  eo_out="$(sed -n "$eo_expr" "$eo_file")"
  set -- $eo_out
  if [ "$#" -eq 0 ]; then
    echo "ERROR: ${eo_label}: ${eo_file#$ROOT/} から storeId を抽出できませんでした。" >&2
    echo "       → 記述の形が変わっています。抽出できないことを「一致している」と読みません。" >&2
    printf ''
    return
  fi
  if [ "$#" -gt 1 ]; then
    echo "ERROR: ${eo_label}: ${eo_file#$ROOT/} から storeId が ${#} 件取れました（どれが正典か決まりません）。" >&2
    printf ''
    return
  fi
  printf '%s' "$1"
}

seed_id="$(extract_one '種' "$SEED_FILE" "/INSERT INTO stores/,/;/ s/.*VALUES ('\([0-9a-fA-F-]*\)'.*/\1/p")"
fixture_id="$(extract_one '既定' "$FIXTURE_FILE" "s/.*process\.env\.E2E_STORE_ID ?? '\([^']*\)'.*/\1/p")"
ci_id="$(extract_one '注入' "$CI_FILE" "s/.*E2E_STORE_ID: '\([^']*\)'.*/\1/p")"
lhci_id="$(extract_one '計測' "$LHCI_FILE" 's|.*/s/\([0-9a-fA-F-]*\)".*|\1|p')"

# 抽出の失敗は**親シェルで**赤にする（上のコメントを参照）。
for got in "種|${seed_id}" "既定|${fixture_id}" "注入|${ci_id}" "計測|${lhci_id}"; do
  g_label="${got%%|*}"
  g_value="${got#*|}"
  if [ -z "$g_value" ]; then
    echo "ERROR: ${g_label} の storeId を取得できませんでした（上記の理由）。照合を続けられません。" >&2
    fail=1
  fi
done

# --- 2. 役割どうしの一致 -----------------------------------------------------------------
# 種を正典にする。店舗の行を作るのがこの 1 行であり、他の 3 つはそれを指しているだけである。

if [ -n "$seed_id" ]; then
  for pair in "既定|${fixture_id}|${FIXTURE_FILE}" "注入|${ci_id}|${CI_FILE}" "計測|${lhci_id}|${LHCI_FILE}"; do
    p_label="${pair%%|*}"
    p_rest="${pair#*|}"
    p_value="${p_rest%%|*}"
    p_file="${p_rest#*|}"
    [ -n "$p_value" ] || continue
    if [ "$p_value" != "$seed_id" ]; then
      echo "ERROR: ${p_label}（${p_file#$ROOT/}）の storeId が種と一致しません。" >&2
      echo "       種  : ${seed_id}（${SEED_FILE#$ROOT/}）" >&2
      echo "       ${p_label}: ${p_value}" >&2
      if [ "$p_label" = '計測' ]; then
        echo "       → Lighthouse は存在しない店舗の URL を開き、1 段落だけの面を測ります。" >&2
        echo "         lhci の判定（LCP・accessibility）は緑を返します。lighthouse ジョブの画面の確認も赤くなりますが、" >&2
        echo "         そちらは「測った画面が違う」としか言えません。原因は storeId のずれです。" >&2
      fi
      fail=1
    fi
  done
fi

# --- 3. 既定値の宣言が 1 箇所 -------------------------------------------------------------

decl_count=0
decl_scanned=0
decl_paths=''
ts_files="$(find "${ROOT}/ts" -name node_modules -prune -o -name '.next' -prune -o -type f -name '*.ts' -print)"
for f in $ts_files; do
  decl_scanned=$((decl_scanned + 1))
  d_rc=0
  d_n="$(grep -cF 'process.env.E2E_STORE_ID ??' "$f")" || d_rc=$?
  if [ "$d_rc" -gt 1 ]; then
    echo "ERROR: ${f#$ROOT/} の走査に失敗しました（grep exit ${d_rc}）。" >&2
    fail=1
    continue
  fi
  [ "$d_n" -gt 0 ] || continue
  decl_count=$((decl_count + d_n))
  decl_paths="${decl_paths} ${f#$ROOT/}"
done

# 母数の空振り防止。走査面が消えていれば「宣言 0 件」は「違反が無い」ではなく「検証していない」。
if [ "$decl_scanned" -eq 0 ]; then
  echo "ERROR: ts/ 配下に走査対象の .ts が 1 件もありません（走査面の前提が崩れています）。" >&2
  echo "       → 母数 0 の「宣言 0 件」は、複写が無いことの証拠になりません。" >&2
  fail=1
fi

if [ "$decl_count" -ne 1 ]; then
  echo "ERROR: 既定値の宣言（process.env.E2E_STORE_ID ??）が ${decl_count} 件あります（1 件であるべきです）:" >&2
  for d in $decl_paths; do
    echo "       - ${d}" >&2
  done
  echo "       → 同じ既定値が複数箇所にあると、env が渡っている限り一致するため**複写であること" >&2
  echo "         自体が観測できません**。更新する日が来て初めて、片方だけが古びます。" >&2
  fail=1
fi

# --- 4. 手順書に書かれた値の照合（あれば） -----------------------------------------------
# 手順書の存在までは要求しない。文書を消しただけで赤くなるのは行き過ぎである。

if [ -n "$seed_id" ]; then
  md_files="$(find "$ROOT" -name node_modules -prune -o -name '.git' -prune -o -type f -name '*.md' -print)"
  for f in $md_files; do
    m_out="$(sed -n "s/.*E2E_STORE_ID=[\"']\([0-9a-fA-F-]*\)[\"'].*/\1/p" "$f")"
    [ -n "$m_out" ] || continue
    for m_value in $m_out; do
      doc_checked=$((doc_checked + 1))
      if [ "$m_value" != "$seed_id" ]; then
        echo "ERROR: ${f#$ROOT/} の手順が古い storeId を指示しています（${m_value} / 種は ${seed_id}）。" >&2
        echo "       → 手順どおりに実行すると、存在しない店舗の面を測ることになります。" >&2
        fail=1
      fi
    done
  done
fi

# --- 5. 判定の配線（Issue #264） ----------------------------------------------------------
# lhci の判定は、店舗が見つからない 1 段落の面を測っても合格する。それを赤にするのが
# perf/verify-lhr.mjs であり、CI の lighthouse ジョブとローカルの実行装置の両方がこれを呼ぶ。
# **呼び出しが消えても、ずれても、何も赤くならない**（lhci は合格し続ける）。ここで配線を固定する。
#
# 走査は awk 1 回ずつで、件数と行番号を返させて判定は親シェルで行う（副シェルの中で fail を
# 立てない・上の extract_one と同じ理由）。ジョブの切り出しは check-db-test-ci-coverage.sh と
# 同じ形にそろえる（ジョブ名は完全一致・非コメント行だけを見る）。括弧は mawk / BSD awk の
# 両方で字面どおりに読ませるため、ブラケット表現で書く。

if [ ! -f "$VERIFY_CLI" ]; then
  echo "ERROR: 判定: ${VERIFY_CLI#$ROOT/} がありません。" >&2
  echo "       → lighthouse ジョブと実行装置が呼ぶ判定の実体です。消すと、測った画面を誰も確かめなくなります。" >&2
  fail=1
fi

# 5-1. ts-ci.yml の lighthouse ジョブ。
#   出力: <ジョブの数> <正規形の行の数> <その行番号> <autorun の最後の行番号> <そのステップに if:/continue-on-error:> <形の違う呼び出しの数> <そのステップを読めたか>
# 「if:/continue-on-error: が付いていない」は否定側の検査なので、確認の行が属するステップを読めたときに
# だけ意味を持つ。ステップの境界は `    steps:` の行から数え始めるため、その行を読めない（行末コメントなど）と
# 境界が 0 件のまま「付いていない」と読んでしまう。読めたかを別に返し、読めなければ赤にする
# （PR #273 のレビューで実測: steps: の行に行末コメントを足すと continue-on-error が素通りした）。
ci_rc=0
ci_probe="$(awk -v job='lighthouse' -v want="$CI_VERIFY_LINE" '
    function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }
    /^jobs:[[:space:]]*$/ { injobs = 1; next }
    /^[^[:space:]#]/      { injobs = 0; injob = 0 }
    injobs && /^  [A-Za-z][A-Za-z0-9_-]*:[[:space:]]*$/ {
        name = $0
        sub(/:[[:space:]]*$/, "", name)
        sub(/^  /, "", name)
        injob = (name == job) ? 1 : 0
        if (injob) found++
        insteps = 0
        next
    }
    !injob { next }
    /^[[:space:]]*#/ { next }
    /^    steps:[[:space:]]*$/ { insteps = 1; next }
    insteps && /^[[:space:]]*- / {
        ind = match($0, /[^[:space:]]/) - 1
        if (step_indent == "") step_indent = ind
        if (ind == step_indent) step++
    }
    {
        line = trim($0)
        if (index(line, "@lhci/cli") > 0 && index(line, "autorun") > 0) autorun_nr = NR
        if (line == want || line == ("- " want)) { hits++; verify_nr = NR; verify_step = step }
        else if (index(line, "verify-lhr.mjs") > 0) loose++
        if (insteps && line ~ /^(- )?(if|continue-on-error):/) guarded[step] = 1
    }
    END {
        known = (verify_step != "") ? 1 : 0
        g = (known && (verify_step in guarded)) ? 1 : 0
        printf "%d %d %d %d %d %d %d\n", found + 0, hits + 0, verify_nr + 0, autorun_nr + 0, g, loose + 0, known
    }
' "$CI_FILE")" || ci_rc=$?
if [ "$ci_rc" -ne 0 ]; then
  echo "ERROR: 判定: ${CI_FILE#$ROOT/} を走査できません（awk exit=${ci_rc}）。" >&2
  fail=1
else
  set -- $ci_probe
  ci_found="$1" ci_hits="$2" ci_verify_nr="$3" ci_autorun_nr="$4" ci_guarded="$5" ci_loose="$6" ci_step_known="$7"
  ci_ok=1
  if [ "$ci_found" -ne 1 ]; then
    echo "ERROR: 判定: ${CI_FILE#$ROOT/} に lighthouse ジョブが ${ci_found} 個あります（ちょうど 1 個であるべきです）。" >&2
    ci_ok=0
  else
    if [ "$ci_hits" -ne 1 ]; then
      echo "ERROR: 判定: lighthouse ジョブに測った画面の確認（'${CI_VERIFY_LINE}' の 1 行）が ${ci_hits} 行あります（ちょうど 1 行であるべきです）。" >&2
      if [ "$ci_loose" -gt 0 ]; then
        echo "       → 形の違う呼び出し（引数付き・複数行の run: など）が ${ci_loose} 行あります。引数なしの 1 行へ戻してください。" >&2
      else
        echo "       → 確認が無いと、lhci は 1 段落の面を測っても合格します（Issue #264）。" >&2
      fi
      ci_ok=0
    fi
    if [ "$ci_autorun_nr" -eq 0 ]; then
      echo "ERROR: 判定: lighthouse ジョブに lhci の autorun がありません（確認の前提が崩れています）。" >&2
      ci_ok=0
    elif [ "$ci_hits" -eq 1 ] && [ "$ci_verify_nr" -le "$ci_autorun_nr" ]; then
      echo "ERROR: 判定: lighthouse ジョブの測った画面の確認が、lhci の autorun より前にあります。" >&2
      echo "       → まだ今回の結果が無い .lighthouseci を読むことになります。autorun の後ろへ置いてください。" >&2
      ci_ok=0
    fi
    if [ "$ci_hits" -eq 1 ] && [ "$ci_step_known" -eq 0 ]; then
      echo "ERROR: 判定: lighthouse ジョブの測った画面の確認が、どのステップに属するかを読めません。" >&2
      echo "       → steps: の行を読めていないため、continue-on-error や if: が付いていても「付いていない」と読みます。" >&2
      echo "         steps: の行はキーだけにしてください（行末のコメントは別の行へ）。" >&2
      ci_ok=0
    elif [ "$ci_hits" -eq 1 ] && [ "$ci_guarded" -eq 1 ]; then
      echo "ERROR: 判定: lighthouse ジョブの測った画面の確認に continue-on-error か if: が付いています。" >&2
      echo "       → 赤を捨てる・確認を飛ばす形です。何も付けずに、autorun が合格したら必ず走らせてください。" >&2
      ci_ok=0
    fi
  fi
  if [ "$ci_ok" -eq 1 ]; then
    wired=$((wired + 1))
  else
    fail=1
  fi
fi

# 5-2. scripts/run-e2e-local.sh の layer_lighthouse()。
#   出力: <関数の数> <正規形の行の数> <その行番号> <__inside-db lighthouse の行番号> <最後の実行行の行番号> <形の違う呼び出しの数>
if [ ! -f "$RUNNER_FILE" ]; then
  echo "ERROR: 判定: ${RUNNER_FILE#$ROOT/} がありません（ローカルの実行装置が CI と同じ判定を呼ぶことを確かめられません）。" >&2
  fail=1
else
  rn_rc=0
  rn_probe="$(awk -v want="$RUNNER_VERIFY_LINE" '
      function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }
      /^layer_lighthouse[(][)][[:space:]]*[{][[:space:]]*$/ { found++; inbody = 1; next }
      inbody && /^[}][[:space:]]*$/ { inbody = 0; next }
      !inbody { next }
      {
          line = trim($0)
          if (line == "" || line ~ /^#/) next
          last_nr = NR
          if (index(line, "__inside-db lighthouse") > 0) inside_nr = NR
          if (line == want) { hits++; verify_nr = NR }
          else if (index(line, "verify-lhr.mjs") > 0) loose++
      }
      END { printf "%d %d %d %d %d %d\n", found + 0, hits + 0, verify_nr + 0, inside_nr + 0, last_nr + 0, loose + 0 }
  ' "$RUNNER_FILE")" || rn_rc=$?
  if [ "$rn_rc" -ne 0 ]; then
    echo "ERROR: 判定: ${RUNNER_FILE#$ROOT/} を走査できません（awk exit=${rn_rc}）。" >&2
    fail=1
  else
    set -- $rn_probe
    rn_found="$1" rn_hits="$2" rn_verify_nr="$3" rn_inside_nr="$4" rn_last_nr="$5" rn_loose="$6"
    rn_ok=1
    if [ "$rn_found" -ne 1 ]; then
      echo "ERROR: 判定: ${RUNNER_FILE#$ROOT/} に layer_lighthouse() が ${rn_found} 個あります（ちょうど 1 個であるべきです）。" >&2
      rn_ok=0
    else
      if [ "$rn_hits" -ne 1 ]; then
        echo "ERROR: 判定: layer_lighthouse() に測った画面の確認（'${RUNNER_VERIFY_LINE}' の 1 行）が ${rn_hits} 行あります（ちょうど 1 行であるべきです）。" >&2
        if [ "$rn_loose" -gt 0 ]; then
          echo "       → 形の違う呼び出し（引数付き・|| 付きなど）が ${rn_loose} 行あります。引数なしの 1 行へ戻してください。" >&2
        fi
        rn_ok=0
      fi
      if [ "$rn_inside_nr" -eq 0 ]; then
        echo "ERROR: 判定: layer_lighthouse() に lhci の実行（__inside-db lighthouse）がありません（確認の前提が崩れています）。" >&2
        rn_ok=0
      elif [ "$rn_hits" -eq 1 ] && [ "$rn_verify_nr" -le "$rn_inside_nr" ]; then
        echo "ERROR: 判定: layer_lighthouse() の測った画面の確認が、lhci の実行（__inside-db lighthouse）より前にあります。" >&2
        rn_ok=0
      fi
      if [ "$rn_hits" -eq 1 ] && [ "$rn_verify_nr" -ne "$rn_last_nr" ]; then
        echo "ERROR: 判定: layer_lighthouse() の測った画面の確認が、本体の最後の実行行ではありません。" >&2
        echo "       → 層は 'layer_lighthouse || rc=\$?' で呼ばれ set -e が効かないため、後ろの行が判定の終了コードを上書きします。" >&2
        rn_ok=0
      fi
    fi
    if [ "$rn_ok" -eq 1 ]; then
      wired=$((wired + 1))
    else
      fail=1
    fi
  fi
fi

# 5-3. 判定を 2 箇所に持たない。判定の中身が CI やローカルの実行装置へ書き戻されると、
# 片方だけが直され、もう片方が古い基準のまま緑を返す。
for jd_file in "$CI_FILE" "$RUNNER_FILE"; do
  [ -f "$jd_file" ] || continue
  jd_rc=0
  jd_n="$(awk -v m="$JUDGE_MARKER" '$0 !~ /^[[:space:]]*#/ && index($0, m) > 0 { n++ } END { print n + 0 }' "$jd_file")" || jd_rc=$?
  if [ "$jd_rc" -ne 0 ]; then
    echo "ERROR: 判定: ${jd_file#$ROOT/} を走査できません（awk exit=${jd_rc}）。" >&2
    fail=1
    continue
  fi
  if [ "$jd_n" -gt 0 ]; then
    echo "ERROR: 判定: ${jd_file#$ROOT/} に判定の中身（${JUDGE_MARKER} を読む処理）が ${jd_n} 行あります。" >&2
    echo "       → 判定は ts/apps/survey-web/perf/lhr-verification.mjs の 1 箇所に置き、ここからは perf/verify-lhr.mjs を呼ぶだけにしてください。" >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "NG: E2E の storeId か、測った画面の確認の配線に不整合があります（上記参照）。" >&2
  exit 1
fi

echo "OK: E2E の storeId を検証しました（役割 4 件が一致 ${seed_id} / 既定値の宣言 ${decl_count} 件 / ts 走査 ${decl_scanned} ファイル / 手順書 ${doc_checked} 件照合 / 判定の配線 ${wired} 箇所）。"
