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
# accessibility も 1.0 を返す。**つまり別の面を測ったまま両方の assert が緑になる。**
# これは Issue #53 が塞いだ「前提が崩れたまま緑を返す」形そのものである。
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

fail=0
doc_checked=0

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
        echo "         LCP も accessibility も緑を返すため、別の面を測っていることに誰も気づけません。" >&2
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

if [ "$fail" -ne 0 ]; then
  echo "NG: E2E の storeId に不整合があります（上記参照）。" >&2
  exit 1
fi

echo "OK: E2E の storeId を検証しました（役割 4 件が一致 ${seed_id} / 既定値の宣言 ${decl_count} 件 / ts 走査 ${decl_scanned} ファイル / 手順書 ${doc_checked} 件照合）。"
