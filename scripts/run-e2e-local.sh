#!/usr/bin/env bash
# E2E の自動層をローカルで 1 本で流す実行装置（Issue #257）。手順書は docs/testing/e2e.md。
#
# ts-ci の e2e / e2e-surfaces / lighthouse / cross-runtime の 4 ジョブと同じものを、このマシンで流す。
# CI を待つと、画面をいくつも触ってから初めて赤を見ることになり、どれが壊したかを切り分けられない。
#
# 層（--only に渡す名前・実行順）:
#   survey         客向け口コミ画面の Playwright（一時 DB ＋ seed ＋ Gemini モック）
#   surfaces       管理ダッシュボードと店舗詳細の Playwright（IdP をスタブへ差し替えたビルド）
#   lighthouse     客向け画面の Lighthouse ＋ 測った画面が seed の店舗であることの確認
#   cross-runtime  Go 日次バッチ → TS 配信の契約検証（db/test/cross_runtime_integration.sh）
#
# 装置の側で潰している罠（2026-09-13 の実施で踏んだもの。経緯は Issue #257）:
#   - node 24 未満なら nvm の v24 へ切り替える（ts/package.json の engines。版が違うと容量が CI とずれる）
#   - 使うポートに先客がいたら、その層を止める。playwright.config.ts はローカルで既存サーバーを再利用
#     するため、先客が別アプリだとその画面を測って大量に赤くなる。先客は殺さない（他セッションの
#     ものでありうる）。ポートは各 playwright.config.ts と lighthouserc.json から読む
#   - IdP スタブ入りのビルドを残さない。surfaces の後、2 画面を通常のビルドへ戻す。中断（Ctrl-C）されたときは
#     戻さずに止まり、スタブ入りのビルドが残りうることと戻し方を表示する
#   - 前提のコマンドが無い層だけを止め、ほかの層は流す（全層に要る node 24 と pnpm は例外）
#   - Gemini モックの NODE_OPTIONS は survey の playwright にだけ渡す（広く渡すと関係ない node を巻き込む）
#   - DB と鍵は常に明示する。survey-web の .env.local（gitignore 済み）は既存の env を上書きしないので、
#     明示しておけば開発用 DB や実の鍵へは繋がらない
#   - Lighthouse は「店舗が見つからない 1 段落の画面」でも合格しうる。LCP 要素が seed の店名で
#     あることを確かめる
#   - 最後に、検査したコミットを表示する（本番のコミットとの突き合わせは run-e2e-prod-checks.sh）
#
# 使い方:
#   bash scripts/run-e2e-local.sh                            # 全層
#   bash scripts/run-e2e-local.sh --only survey,lighthouse   # 一部だけ
#   make e2e
#
# 前提: pnpm・Homebrew の postgres（initdb / pg_ctl / psql）・go・lsof・Chrome（Lighthouse 用）。
# 最初の失敗で止めず、選んだ層をすべて流してから結果を集約する。1 層でも赤なら exit 1、引数の誤りは exit 2。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="${SCRIPT_DIR}/$(basename "${BASH_SOURCE[0]}")"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# どこから呼ばれても同じに動くよう、リポジトリのルートで動かす。
cd "$ROOT"
TS_DIR="${ROOT}/ts"
SURVEY_DIR="${TS_DIR}/apps/survey-web"
SEED_SQL="${SURVEY_DIR}/e2e/seed.sql"
MOCK_GEMINI="${SURVEY_DIR}/e2e/mock-gemini.mjs"
LHCI_CONFIG_REL='perf/lighthouserc.json'
WITH_TEST_DB="${TS_DIR}/scripts/with-test-db.sh"
# 画面 E2E の fixture が応答を横取りする API の起点。ビルドへ渡す値はここから読む（二重に書かない）。
SURFACES_API_FIXTURE="${TS_DIR}/apps/dashboard-web/e2e/fixtures/api.ts"
# store-detail のスタブは値を見ない。空でなければよい（ts-ci.yml の e2e-surfaces と同じ値にしてある）。
SURFACES_LIFF_ID='e2e-stub-liff-id'

ALL_LAYERS=(survey surfaces lighthouse cross-runtime)

usage() {
    # 冒頭のコメント（shebang の次から最初の非コメント行の手前まで）をそのまま出す。
    awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$SELF"
}

# --- 内部モード: with-test-db.sh が起動した一時 DB の内側で呼ばれる -----------------------
# with-test-db.sh は引数のコマンドを 1 つ実行するだけなので、seed の投入と env の設定を
# 同じプロセスで行うために自分自身を呼び直す。利用者が直接使う入口ではない。
inside_db() {
    local layer="$1"
    : "${DATABASE_URL:?ERROR: 内部モードは ts/scripts/with-test-db.sh の内側で呼ばれる前提です}"
    : "${E2E_SEED_STORE_ID:?ERROR: E2E_SEED_STORE_ID が渡されていません}"
    # PGHOST / PGUSER / PGDATABASE は with-test-db.sh が export 済み。
    psql -v ON_ERROR_STOP=1 -q -f "$SEED_SQL" >/dev/null
    export SESSION_SIGNING_KEY='e2e-local-signing-key'
    export GEMINI_API_KEY='e2e-local-dummy-key'
    case "$layer" in
        survey)
            export E2E_STORE_ID="$E2E_SEED_STORE_ID"
            NODE_OPTIONS="--import ${MOCK_GEMINI}" \
                pnpm -C "$TS_DIR" --filter @fwlm/survey-web exec playwright test
            ;;
        lighthouse)
            # npx は実行時に lhci をレジストリから取るため、NODE_OPTIONS のモックを被せると npm が壊れる。
            (cd "$SURVEY_DIR" && env -u NODE_OPTIONS npx --yes @lhci/cli@0.15.x autorun --config="$LHCI_CONFIG_REL")
            ;;
        *)
            echo "ERROR: 内部モードの層名が不正です: ${layer}" >&2
            return 2
            ;;
    esac
}

if [ "${1:-}" = '__inside-db' ]; then
    inside_db "${2:-}"
    exit $?
fi

# --- 引数 ---------------------------------------------------------------------------------
selected=()
add_layers() {
    local csv="$1" name known layer
    local -a requested
    IFS=',' read -r -a requested <<< "$csv"
    if [ "${#requested[@]}" -eq 0 ]; then
        echo "ERROR: --only に層名がありません（${ALL_LAYERS[*]}）" >&2
        exit 2
    fi
    for name in "${requested[@]}"; do
        known=0
        for layer in "${ALL_LAYERS[@]}"; do
            [ "$layer" = "$name" ] && known=1
        done
        if [ "$known" -eq 0 ]; then
            echo "ERROR: 不明な層です: '${name}'（${ALL_LAYERS[*]}）" >&2
            exit 2
        fi
        selected+=("$name")
    done
}

while [ $# -gt 0 ]; do
    case "$1" in
        --only)
            [ $# -ge 2 ] || { echo "ERROR: --only には層名が要ります" >&2; exit 2; }
            add_layers "$2"
            shift 2
            ;;
        --only=*)
            add_layers "${1#--only=}"
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "ERROR: 不明な引数です: $1（--help を参照）" >&2
            exit 2
            ;;
    esac
done
if [ "${#selected[@]}" -eq 0 ]; then
    selected=("${ALL_LAYERS[@]}")
fi

is_selected() {
    local layer
    for layer in ${selected[@]+"${selected[@]}"}; do
        [ "$layer" = "$1" ] && return 0
    done
    return 1
}

# --- 結果の記録 -------------------------------------------------------------------------
results=()
fail=0
record() {
    # $1=層 $2=PASS|FAIL $3=秒 $4=補足
    results+=("$1|$2|$3|$4")
    [ "$2" = 'PASS' ] || fail=1
}

banner() {
    echo
    echo '=================================================================='
    echo ">> $1"
    echo '=================================================================='
}

# --- 前提の準備 -------------------------------------------------------------------------
# 利用者のシェルに残った値で結果が変わらないようにする。E2E_BASE_URL があると Playwright は
# サーバーを起動せずその URL を測り、E2E_STUB_IDP があると「通常のビルド」までスタブ入りになる。
for var in NODE_OPTIONS E2E_BASE_URL E2E_STORE_ID E2E_STUB_IDP NEXT_PUBLIC_API_BASE_URL NEXT_PUBLIC_LIFF_ID; do
    # declare -p は未設定なら 1 を返す（bash 3.2 でも使える判定。間接展開と +x の組み合わせは避ける）。
    if declare -p "$var" >/dev/null 2>&1; then
        echo "-- シェルに設定されていた ${var} を、この実行では外します"
        unset "$var"
    fi
done

ensure_node24() {
    local major candidate='' dir
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" || major=0
    if [ "${major:-0}" -ge 24 ] 2>/dev/null; then
        return 0
    fi
    for dir in "${HOME}"/.nvm/versions/node/v24.*/bin; do
        [ -x "${dir}/node" ] && candidate="$dir"
    done
    if [ -z "$candidate" ]; then
        echo "ERROR: node 24 以上が必要です（現在の major: ${major:-不明}）。nvm で v24 を入れるか、PATH を通してください" >&2
        return 1
    fi
    export PATH="${candidate}:${PATH}"
    echo "-- node ${major:-不明} を検出したため、${candidate} へ切り替えました"
}

require_cmds() {
    local cmd missing=0
    for cmd in "$@"; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            echo "ERROR: '${cmd}' が見つかりません" >&2
            missing=1
        fi
    done
    return "$missing"
}

# 設定ファイルに書かれた http://127.0.0.1:<port> を重複なしで返す。コメント行（// で始まる行）は除く。
# dashboard-web の設定はコメントに fixture 用の API の起点（別ポート）を書いているため。
ports_in() {
    sed -n -E -e "/^[[:space:]]*\/\//d" -e "s#.*http://127\\.0\\.0\\.1:([0-9]+).*#\\1#p" "$@" | sort -u
}

layer_ports() {
    case "$1" in
        survey) ports_in "${SURVEY_DIR}/playwright.config.ts" ;;
        surfaces) ports_in "${TS_DIR}/apps/dashboard-web/playwright.config.ts" "${TS_DIR}/apps/store-detail/playwright.config.ts" ;;
        lighthouse) ports_in "${SURVEY_DIR}/${LHCI_CONFIG_REL}" ;;
        *) ;;
    esac
}

# 先客がいれば stderr へ出して 1 を返す。先客は止めない。
ports_free_for() {
    local layer="$1" ports port out busy=0
    ports="$(layer_ports "$layer")"
    if [ "$layer" != 'cross-runtime' ] && [ -z "$ports" ]; then
        echo "ERROR: ${layer} のポートを設定ファイルから読めませんでした（抽出の前提が崩れています）" >&2
        return 1
    fi
    for port in $ports; do
        if out="$(lsof -nP -iTCP:"${port}" -sTCP:LISTEN 2>&1)"; then
            echo "ERROR: ポート ${port} は使用中です。止めずに、持ち主のセッションを確かめてください:" >&2
            printf '%s\n' "$out" >&2
            busy=1
        fi
    done
    return "$busy"
}

# seed.sql の stores 行から値を取る。値の並びは (id, owner_id, name, place_id, place_status) で、
# 引用符で区切ると 2 番目が id、6 番目が name になる。
seed_store_field() {
    awk -v idx="$1" '
        /^INSERT INTO stores/ { in_stores = 1; next }
        in_stores && /VALUES/ { n = split($0, part, "\047"); if (n >= idx) print part[idx]; exit }
    ' "$SEED_SQL"
}

surfaces_api_origin() {
    sed -n -E "s#^export const API_ORIGIN = '([^']+)';.*#\1#p" "$SURFACES_API_FIXTURE"
}

normal_build() {
    # 通常のビルド（スタブなし）。env -u は利用者のシェルからの持ち込みも防ぐ。
    env -u E2E_STUB_IDP -u NEXT_PUBLIC_API_BASE_URL -u NEXT_PUBLIC_LIFF_ID pnpm -C "$TS_DIR" "$@"
}

needs_web_build=0
for layer in survey surfaces lighthouse; do
    if is_selected "$layer"; then
        needs_web_build=1
    fi
done

banner "準備（選んだ層: ${selected[*]}）"
# 全層に要る前提（node 24 と pnpm）が欠けたら全層を止める。層ごとの前提は layer_blocker が見て、
# 欠けた層だけを止める（go が無いだけで survey まで止めない）。
prep_ok=1
ensure_node24 || prep_ok=0
require_cmds pnpm || prep_ok=0

seed_ok=0
store_id=''
store_name=''
if is_selected survey || is_selected lighthouse; then
    # storeId は 4 箇所（seed・fixtures・ts-ci.yml・lighthouserc.json）で一致している前提で読む。
    # ずれていると Lighthouse は存在しない店舗を測って緑になりうるので、先に既存のガードで確かめる。
    seed_ok=1
    if ! bash "${SCRIPT_DIR}/check-e2e-store-id-consistency.sh"; then
        seed_ok=0
    fi
    store_id="$(seed_store_field 2)" || store_id=''
    store_name="$(seed_store_field 6)" || store_name=''
    if ! [[ "$store_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || [ -z "$store_name" ]; then
        echo "ERROR: ${SEED_SQL#"${ROOT}"/} から店舗の id と店名を読めませんでした（id='${store_id}' name='${store_name}'）" >&2
        seed_ok=0
    else
        echo "-- seed の店舗: ${store_id}（${store_name}）"
    fi
fi

# 見つからないコマンドを空白区切りで出す（すべてあれば空）。
missing_cmds() {
    local cmd out=''
    for cmd in "$@"; do
        command -v "$cmd" >/dev/null 2>&1 || out="${out:+${out} }${cmd}"
    done
    printf '%s' "$out"
}

# 層を止める理由を出す（止めなくてよければ空）。判定は呼び出し側で行う（ここでフラグを立てない）。
layer_blocker() {
    local missing=''
    case "$1" in
        survey) missing="$(missing_cmds lsof psql initdb pg_ctl)" ;;
        surfaces) missing="$(missing_cmds lsof)" ;;
        lighthouse) missing="$(missing_cmds lsof psql initdb pg_ctl npx)" ;;
        cross-runtime) missing="$(missing_cmds psql initdb pg_ctl go)" ;;
        *) ;;
    esac
    if [ -n "$missing" ]; then
        printf 'コマンドが見つかりません: %s' "$missing"
        return 0
    fi
    case "$1" in
        survey|lighthouse)
            [ "$seed_ok" -eq 1 ] || printf 'seed の店舗を確定できません（準備の出力を参照）'
            ;;
        *) ;;
    esac
}

# 依存の導入は全層に要る。画面のビルドとブラウザの導入は画面の 3 層だけに要る（cross-runtime は
# 自分に要る依存だけを自前でビルドする）ので、成否を分けて持つ。
install_ok=0
web_ok=0
if [ "$prep_ok" -eq 1 ]; then
    echo "-- node $(node -v)・$(pnpm -v 2>/dev/null | sed 's/^/pnpm /')"
    if pnpm -C "$TS_DIR" install --frozen-lockfile; then
        install_ok=1
    fi
    if [ "$install_ok" -eq 1 ] && [ "$needs_web_build" -eq 1 ]; then
        web_ok=1
        normal_build run build || web_ok=0
        if [ "$web_ok" -eq 1 ] && is_selected survey; then
            pnpm -C "$TS_DIR" --filter @fwlm/survey-web exec playwright install chromium || web_ok=0
        fi
        if [ "$web_ok" -eq 1 ] && is_selected surfaces; then
            pnpm -C "$TS_DIR" --filter @fwlm/dashboard-web exec playwright install chromium || web_ok=0
        fi
    fi
fi

# --- 各層 -------------------------------------------------------------------------------
layer_survey() {
    E2E_SEED_STORE_ID="$store_id" bash "$WITH_TEST_DB" bash "$SELF" __inside-db survey
}

layer_surfaces() {
    local rc=0 api_origin
    api_origin="$(surfaces_api_origin)"
    if [ -z "$api_origin" ]; then
        echo "ERROR: ${SURFACES_API_FIXTURE#"${ROOT}"/} から API_ORIGIN を読めませんでした" >&2
        return 1
    fi
    echo "-- IdP をスタブへ差し替えてビルドします（API の起点: ${api_origin}）"
    # 中断（Ctrl-C）されたら戻さずに止まり、スタブ入りのビルドが残りうることと戻し方を出す。
    # 中断した利用者に数十秒のビルドを待たせないため、自動では戻さない。
    trap on_surfaces_interrupt INT TERM
    if E2E_STUB_IDP=1 NEXT_PUBLIC_API_BASE_URL="$api_origin" NEXT_PUBLIC_LIFF_ID="$SURFACES_LIFF_ID" \
        pnpm -C "$TS_DIR" --filter @fwlm/dashboard-web run build &&
        E2E_STUB_IDP=1 NEXT_PUBLIC_API_BASE_URL="$api_origin" NEXT_PUBLIC_LIFF_ID="$SURFACES_LIFF_ID" \
        pnpm -C "$TS_DIR" --filter @fwlm/store-detail run build; then
        pnpm -C "$TS_DIR" --filter @fwlm/dashboard-web exec playwright test || rc=1
        pnpm -C "$TS_DIR" --filter @fwlm/store-detail exec playwright test || rc=1
    else
        echo "ERROR: スタブ入りのビルドに失敗しました" >&2
        rc=1
    fi
    # テストの成否にかかわらず、スタブ入りのビルドを残さない。
    echo "-- 2 画面を通常のビルドへ戻します"
    if ! { normal_build --filter @fwlm/dashboard-web run build && normal_build --filter @fwlm/store-detail run build; }; then
        echo "ERROR: 通常のビルドへ戻せませんでした。dashboard-web / store-detail の .next はスタブ入りのままです" >&2
        rc=1
    fi
    trap - INT TERM
    return "$rc"
}

on_surfaces_interrupt() {
    echo >&2
    echo "中断しました。dashboard-web / store-detail の .next は IdP スタブ入りのままの可能性があります。" >&2
    echo "通常のビルドへ戻すには: pnpm -C ts --filter @fwlm/dashboard-web run build && pnpm -C ts --filter @fwlm/store-detail run build" >&2
    exit 130
}

layer_lighthouse() {
    local started
    started="$(date +%s)"
    E2E_SEED_STORE_ID="$store_id" bash "$WITH_TEST_DB" bash "$SELF" __inside-db lighthouse || return 1
    # lhci の判定（LCP・accessibility）に加えて、測った画面そのものを確かめる。
    # shellcheck disable=SC2016  # node へ渡す JS をそのまま書くため、単一引用符の中で展開させない。
    LHR_DIR="${SURVEY_DIR}/.lighthouseci" EXPECT_ID="$store_id" EXPECT_NAME="$store_name" \
        SINCE_MS="$((started * 1000))" node -e '
const fs = require("fs");
const path = require("path");
const dir = process.env.LHR_DIR;
const since = Number(process.env.SINCE_MS);
const files = fs.readdirSync(dir)
  .filter((f) => /^lhr-\d+\.json$/.test(f))
  .map((f) => path.join(dir, f))
  .filter((f) => fs.statSync(f).mtimeMs >= since);
if (files.length === 0) {
  console.error("ERROR: 今回の実行で作られた lhr-*.json がありません");
  process.exit(1);
}
let bad = 0;
for (const f of files) {
  const r = JSON.parse(fs.readFileSync(f, "utf8"));
  const url = r.finalDisplayedUrl || r.finalUrl || "";
  const node = r.audits["largest-contentful-paint-element"]?.details?.items?.[0]?.items?.[0]?.node;
  const label = node?.nodeLabel ?? "";
  const lcp = Math.round(r.audits["largest-contentful-paint"]?.numericValue ?? NaN);
  const a11y = r.categories.accessibility?.score;
  console.log(`   ${path.basename(f)}  LCP=${lcp}ms  accessibility=${a11y}  LCP要素=${label.slice(0, 40)}`);
  if (!url.includes(process.env.EXPECT_ID)) {
    console.error(`   NG: 計測した URL に seed の店舗 ID がありません: ${url}`);
    bad++;
  }
  if (!label.includes(process.env.EXPECT_NAME)) {
    console.error("   NG: LCP 要素が seed の店名ではありません（店舗が見つからない画面を測った可能性があります）");
    bad++;
  }
}
process.exit(bad === 0 ? 0 : 1);
'
}

layer_cross_runtime() {
    bash "${ROOT}/db/test/cross_runtime_integration.sh"
}

for layer in "${ALL_LAYERS[@]}"; do
    is_selected "$layer" || continue
    banner "[${layer}]"
    if [ "$prep_ok" -ne 1 ]; then
        record "$layer" FAIL 0 'node 24 か pnpm が無いため実行していません'
        continue
    fi
    blocker="$(layer_blocker "$layer")"
    if [ -n "$blocker" ]; then
        echo "ERROR: ${blocker}" >&2
        record "$layer" FAIL 0 "${blocker}"
        continue
    fi
    if [ "$install_ok" -ne 1 ]; then
        record "$layer" FAIL 0 '依存の導入に失敗したため実行していません'
        continue
    fi
    if [ "$layer" != 'cross-runtime' ] && [ "$web_ok" -ne 1 ]; then
        record "$layer" FAIL 0 '前提のビルドに失敗したため実行していません'
        continue
    fi
    if ! ports_free_for "$layer"; then
        record "$layer" FAIL 0 'ポートに先客がいるため実行していません'
        continue
    fi
    start=$SECONDS
    rc=0
    case "$layer" in
        survey) layer_survey || rc=$? ;;
        surfaces) layer_surfaces || rc=$? ;;
        lighthouse) layer_lighthouse || rc=$? ;;
        cross-runtime) layer_cross_runtime || rc=$? ;;
    esac
    if [ "$rc" -eq 0 ]; then
        record "$layer" PASS $((SECONDS - start)) ''
    else
        record "$layer" FAIL $((SECONDS - start)) "exit ${rc}"
    fi
done

# --- 集約 -------------------------------------------------------------------------------
head_sha="$(git -C "$ROOT" rev-parse --short HEAD)"
changed="$(git -C "$ROOT" status --porcelain --untracked-files=no | wc -l)"
changed=$((changed + 0))
banner "E2E 自動層の結果（検査したコミット: ${head_sha}・追跡下の未コミット変更: ${changed} 件）"
for entry in ${results[@]+"${results[@]}"}; do
    IFS='|' read -r r_layer r_status r_secs r_note <<< "$entry"
    printf '  %-4s  %-14s %5ss  %s\n' "$r_status" "$r_layer" "$r_secs" "$r_note"
done
if main_sha="$(git -C "$ROOT" rev-parse --short --verify --quiet origin/main)"; then
    if [ "$main_sha" != "$head_sha" ]; then
        echo "  WARN: 検査したコミットは origin/main（${main_sha}・最後に fetch した時点）と異なります。"
        echo "        本番のコミットの証拠にするなら、run-e2e-prod-checks.sh で本番のコミットの CI 結果を確かめてください"
    fi
fi
if [ "$fail" -ne 0 ]; then
    echo "NG: 赤の層があります（各層の出力は上にあります）" >&2
    exit 1
fi
echo "OK: 選んだ層はすべて緑です"
