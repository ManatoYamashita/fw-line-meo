#!/usr/bin/env bash
# Cloud Run が予約する URL パスをルートにしていないことの機械強制（Issue #219）。
#
# 背景: Cloud Run は `/_ah/` で始まるパスと「z で終わる一部のパス」を予約しており、該当する
# リクエストはコンテナへ届く前に Google Frontend が 404 を返す。一次情報
# （https://docs.cloud.google.com/run/docs/known-issues）は、予約パスとの衝突を避けるために
# **z で終わるパスはすべて避ける**ことを推奨している。
#
# 全 5 サービスが Kubernetes 慣習の `/healthz` をヘルスエンドポイントにしており、本番では
# 5 つとも到達不能だった。**ローカルの standalone 起動でも E2E でも 200 が返る**ため、テストでは
# 原理的に落ちない。404 はアプリの手前で返るので、アプリのログにも何も残らない。
#
# 判定:
#   Hono 形式  `.get|post|put|patch|delete|all|options|route('<path>'` の path が z で終わる、
#              または /_ah/ で始まる。ルート定義だけでなく、同じ形の呼び出し（API クライアント）
#              も拾う。z で終わる先を呼べば、本番では同じく 404 になる。
#   Next.js    app/（または src/app/）配下の route / page が作る URL の末尾セグメントが z で
#              終わる。ルートグループ `(x)` と並列ルート `@x` は URL に現れないので外してから
#              見る。`_` で始まる非公開フォルダは URL にならないので対象外。
#
# 射程外: テスト（test/・e2e/・*.test.*・*.spec.*）はアプリを本番へ出さないので見ない。
# 動的セグメント（`[id]`）で終わる経路は実値が分からないので咎めない。Go（go/）は Cloud Run
# の Job だけで HTTP を受けないので見ない。HTTP を受けるものが現れたらここを広げること。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOC_URL='https://docs.cloud.google.com/run/docs/known-issues'

# 以降の出力をリポジトリ相対のパスにするため、ROOT へ移ってから相対で走査する。
cd "$ROOT"
APPS_DIR='ts/apps'

if [ ! -d "$APPS_DIR" ]; then
  echo "ERROR: 走査対象 ${ROOT}/${APPS_DIR} が存在しません（配置が変わった可能性があります）。" >&2
  exit 1
fi

# --- Hono 形式 ----------------------------------------------------------------

GREP_OPTS=(
  -rn --include='*.ts' --include='*.tsx'
  --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=dist --exclude-dir=.turbo
  --exclude-dir=test --exclude-dir=e2e
  --exclude='*.test.ts' --exclude='*.test.tsx' --exclude='*.spec.ts' --exclude='*.spec.tsx'
)

Q="['\"\`]"
NQ="[^'\"\`]"
METHODS='(get|post|put|patch|delete|all|options|route)'
ROUTE_ERE="\\.${METHODS}\\([[:space:]]*${Q}/"
RESERVED_ERE="\\.${METHODS}\\([[:space:]]*${Q}(/_ah/${NQ}*|/${NQ}*z)${Q}"

# grep の exit を握り潰さない。1（無一致）は正常、2 以上（評価不能・読み取り不能）は
# 「検出できなかった」であって「違反が無い」ではない。潰すと壊れたガードが緑を返す。
#
# **結果は標準出力ではなく変数で返す。** `out="$(scan ...)"` の形にすると grep は二重の
# 部分シェルの中で走り、`rc=$?` の代入も `exit` も外へ伝わらない。
scan_out=''
scan() { # $1 = ERE → scan_out へ入れる
  local rc=0
  scan_out="$(grep -E "${GREP_OPTS[@]}" "$1" "$APPS_DIR")" || rc=$?
  if [ "$rc" -ge 2 ]; then
    echo "ERROR: 走査を評価できません（grep exit=${rc}・pattern=$1）。" >&2
    exit 1
  fi
}

count_lines() { [ -z "$1" ] && { echo 0; return; }; printf '%s\n' "$1" | grep -c ''; }

scan "$ROUTE_ERE"
hono_total="$(count_lines "$scan_out")"
scan "$RESERVED_ERE"
hono_bad="$scan_out"

# --- Next.js App Router -------------------------------------------------------

# find が途中で失敗した（読めないディレクトリがある等）とき、得られた一部だけで緑を返さない。
find_rc=0
route_files="$(find "$APPS_DIR" \
  \( -name node_modules -o -name .next -o -name dist -o -name .turbo \) -prune -o \
  -type f \( -name route.ts -o -name route.js -o -name page.tsx -o -name page.ts \
  -o -name page.jsx -o -name page.js \) -print)" || find_rc=$?
if [ "$find_rc" -ne 0 ]; then
  echo "ERROR: Next.js の route / page の列挙を評価できません（find exit=${find_rc}）。" >&2
  exit 1
fi

# アプリ直下の app/ か src/app/ に置かれたものだけがルートになる。
APP_ROUTER_RE='^ts/apps/[^/]+/(src/)?app/(.*)$'
next_total=0
next_bad=''
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [[ $f =~ $APP_ROUTER_RE ]] || continue
  rel="${BASH_REMATCH[2]}"
  case "$rel" in
    */*) dir="${rel%/*}" ;;
    *) dir='' ;;
  esac

  url=''
  last=''
  private=0
  segs=()
  [ -z "$dir" ] || IFS='/' read -r -a segs <<< "$dir"
  for s in ${segs[@]+"${segs[@]}"}; do
    case "$s" in
      _*) private=1 ;;
      '('*')' | @*) ;;
      *) url="${url}/${s}"; last="$s" ;;
    esac
  done
  [ "$private" -eq 0 ] || continue

  next_total=$((next_total + 1))
  # 動的セグメント（`[id]`）は `]` で終わるので、ここでは自然に対象外になる。
  case "$last" in
    *z) next_bad="${next_bad}  ${f} → ${url}"$'\n' ;;
  esac
done <<< "$route_files"

# --- 判定 ---------------------------------------------------------------------

# 空振り防止。0 件は「守っている」ではなく「何も見ていない」である。片方の走査だけが壊れても
# 合計では気づけないので、2 系統を別々に要求する。
if [ "$hono_total" -eq 0 ]; then
  echo "ERROR: ts/apps 配下に Hono 形式の path リテラルが 1 件も見つかりません。" >&2
  echo "  → 走査が壊れているか、Hono のサービスが無くなっています。後者なら判定からこの系統を外してください。" >&2
  exit 1
fi
if [ "$next_total" -eq 0 ]; then
  echo "ERROR: ts/apps 配下に Next.js の route / page が 1 件も見つかりません。" >&2
  echo "  → find の条件か app/・src/app/ の配置の前提が崩れています。" >&2
  exit 1
fi

if [ -n "$hono_bad" ] || [ -n "$next_bad" ]; then
  echo "ERROR: Cloud Run が予約する URL パスを使っています（z で終わるパス・/_ah/ で始まるパス）:" >&2
  if [ -n "$hono_bad" ]; then
    printf '%s\n' "$hono_bad" | sed 's/^/  /' >&2
  fi
  if [ -n "$next_bad" ]; then
    printf '%s' "$next_bad" >&2
  fi
  echo "" >&2
  echo "  → z で終わらないパスへ変えてください（ヘルスチェックは /health）。" >&2
  echo "    該当するリクエストはコンテナへ届く前に Google Frontend が 404 を返します。" >&2
  echo "    ローカル起動でも E2E でも 200 が返るので、テストでは落ちません（Issue #219）。" >&2
  echo "    一次情報: ${DOC_URL}" >&2
  exit 1
fi

echo "OK: Cloud Run の予約パスを使うルートはありません（Hono 形式 ${hono_total} 件 / Next.js ${next_total} 件検証）。"
