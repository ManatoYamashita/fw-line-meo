#!/usr/bin/env bash
# Issue #500 ガードレール: 起動時に必須とする env と、Terraform が Cloud Run へ渡す env が、
# どこでも照合されていなかった。
#
# `loadConfig` に必須の env を足しても、Terraform への配線を忘れたまま CI は緑で通る。新しい
# イメージは本番で初めて `X is required` で起動に失敗し、そこで初めて気づく。#487 では
# dashboard-api の `loadConfig` に `LINE_CHANNEL_ID` / `LINE_CHANNEL_SECRET` を必須として足し、
# 配線を同じ PR に入れて手順書の順序（env をイメージより先に apply）で当てたので事故には
# ならなかったが、配線を忘れても検出する仕組みは無かった。近いガードはこの組み合わせを見ない。
#   - scripts/check-spec-env-names.sh（#148）は spec 文書の env 名と実装を照合する。tf は見ない。
#   - scripts/check-secret-declaration-coverage.sh（#63）は secret の宣言を照合する。secret でない
#     env（`LINE_CHANNEL_ID` など）と、実装が必須とする env の対応は見ない。
#
# 本スクリプトは以下を機械検証する（read-only の走査・副作用なし・連想配列を使わず bash 3.2 でも走る）:
#   1. デプロイ対象の正典（scripts/check-deploy-image-coverage.sh --print-targets）の全件が、
#      下の TARGETS 表に `check` か `skip` として宣言されている。逆に、表の行が正典に実在する。
#      新しいサービスやジョブを足した PR は、照合するか外すかを選ばされる（外すなら理由と Issue 番号）
#   2. **方向 1（実装 → tf）**: `check` の対象の出典ファイルが必須とする env が、すべて tf で配線
#      されている。必須の env は、必須であることをエラーで自己申告する 3 つの形から抜き出す
#        - `Error('<NAME> is required')`（dashboard-api の config.ts の形）
#        - `required(env, '<NAME>')`（line-webhook の config.ts のヘルパの形）
#        - `MissingConfigError('<NAME>')`（delivery-job の index.ts の形）
#   3. **方向 2（tf → 実装）**: `check` の対象へ tf が配線した env が、その対象のソース（試験を
#      除く）に語として現れる。現れない配線は、名前の打ち間違いか、読む側が消えた取り残しである。
#      モジュールが全サービスへ共通に渡す env（COMMON_ENV）は、共有パッケージが読むので除く
#   4. 空振り防止: 正典の対象 0 件・`check` の対象 0 件・出典から抜き出した必須 env が 0 件・
#      tf から抜き出した配線が 0 件は、いずれも赤（0 件のまま「乖離なし」で緑にしないため）
#
# ## 配線の読み取り方
#
#   - サービス: infra/envs/prod/main.tf の module "run_services" の `"<name>" = { … }` の中の、
#     大文字の鍵（`LINE_CHANNEL_ID = …`）。`merge(…, cond ? { … } : {})` の条件つきの枝も配線に
#     数える。line-webhook の GBP の env は、GBP を有効にしたときだけ一式で配線され、
#     `loadConfig` も一式が揃ったときだけ必須にする（config.ts の loadGbpConfig）。
#     一部だけの設定を弾くのは loadConfig の責務で、ここでは「配線の経路があるか」を見る。
#   - サービスに共通の env: infra/modules/run-services/main.tf の大文字の鍵と `name = "<NAME>"`。
#     Cloud SQL の 3 値は needs_cloudsql のサービスにだけ入るが、ここでは区別しない
#     （これらを必須にするのは共有の packages/db で、loadConfig ではないため）。
#   - ジョブ: TARGETS の第 4 列のモジュールのファイルの大文字の鍵と `name = "<NAME>"`。
#
# ## 検証しないこと（意図的な非対象）
#
#   - **値の正しさ**。ここで見るのは名前の対応だけである。値は tfvars とシークレットの領分。
#   - **必須であることを自己申告しない env**。上の 3 つの形を通らない読み方（`env.X ?? 既定値`
#     や Next.js の各所の `process.env.X`）は抜き出せない。`skip` の対象はその理由で外している。
#   - **本番の状態**。tf のコードと実装の対応だけを見る。apply 忘れ（コードにあって本番に無い）は
#     scripts/check-prod-image-drift.sh などの領分である。
#
# 使い方: bash scripts/check-run-env-wiring.sh
#   乖離があれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$ROOT"

PROD_TF='infra/envs/prod/main.tf'
RUN_SERVICES_MODULE='infra/modules/run-services/main.tf'

# デプロイ対象ごとの宣言。列はタブ区切り:
#   <kind>  <name>  check  <出典ファイル（必須 env を自己申告する）>  <ソースの根（方向 2 の走査）>  [<ジョブのモジュール>]
#   <kind>  <name>  skip   <理由（Issue #N）>
# kind と name は check-deploy-image-coverage.sh --print-targets の出力と一致させる。
TARGETS='service	line-webhook	check	ts/apps/line-webhook/src/config.ts	ts/apps/line-webhook/src
service	dashboard-api	check	ts/apps/dashboard-api/src/config.ts	ts/apps/dashboard-api/src
job	summary-delivery	check	ts/apps/delivery-job/src/index.ts	ts/apps/delivery-job/src	infra/modules/delivery-job/main.tf
service	survey-web	skip	必須の env を自己申告する loadConfig を持たない（Next.js の各経路が process.env を読む・Issue #500）
service	store-detail	skip	必須の env を自己申告する loadConfig を持たない（Next.js の各経路が process.env を読む・Issue #500）
service	dashboard-web	skip	実行時の env を持たない（NEXT_PUBLIC_* は build-arg・scripts/check-next-public-buildargs.sh の担当・Issue #500）
job	daily-batch	skip	Go の実装で、必須の env を自己申告する形が TS と異なる（Issue #500）'

# モジュールが全サービスへ渡し、共有パッケージが読む env。方向 2 の走査から外す。
# 各名前が実際に共有パッケージで読まれていることも確かめる（読む側が消えたら赤）。
COMMON_ENV='CLOUDSQL_CONNECTION_NAME DB_NAME DB_IAM_USER GOOGLE_CLOUD_PROJECT'
COMMON_ENV_READERS='ts/packages/db/src ts/packages/observability/src'

fail=0
err() { echo "NG: $*" >&2; fail=1; }

for f in "$PROD_TF" "$RUN_SERVICES_MODULE"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: 配線の読み取り元 ${f} が見つかりません（配置が変わった可能性があります）。" >&2
    exit 1
  fi
done

# --- 1. デプロイ対象の正典と TARGETS 表の両方向照合 ---

# RUN_ENV_WIRING_TARGETS_SNAPSHOT に TSV のパスを渡すと、正典の代わりにそれを読む（自己テスト用）。
# 空文字を「未設定」と同一視しないよう `+x` で判定する（空文字のまま本物へ落ちると、注入した
# つもりの試験が本物の正典を検査してしまう）。
if [ -n "${RUN_ENV_WIRING_TARGETS_SNAPSHOT+x}" ]; then
  if [ ! -f "$RUN_ENV_WIRING_TARGETS_SNAPSHOT" ]; then
    echo "ERROR: RUN_ENV_WIRING_TARGETS_SNAPSHOT のファイルが見つかりません: ${RUN_ENV_WIRING_TARGETS_SNAPSHOT}" >&2
    exit 1
  fi
  canon="$(cat "$RUN_ENV_WIRING_TARGETS_SNAPSHOT")"
else
  # 正典のスクリプトは自身の検証結果を stderr に出す。成功時は読まず、失敗時だけ見せる。
  canon_rc=0
  canon_err="$(mktemp)"
  trap 'rm -f "$canon_err"' EXIT
  canon="$(bash "${SCRIPT_DIR}/check-deploy-image-coverage.sh" --print-targets 2>"$canon_err")" || canon_rc=$?
  if [ "$canon_rc" -ne 0 ]; then
    cat "$canon_err" >&2
    echo "ERROR: デプロイ対象の正典を取得できません（check-deploy-image-coverage.sh --print-targets exit=${canon_rc}）。" >&2
    exit 1
  fi
fi
canon_count=0
while IFS=$'\t' read -r kind name; do
  [ -n "$kind" ] || continue
  canon_count=$((canon_count + 1))
  if [ "$(printf '%s\n' "$TARGETS" | awk -F'\t' -v k="$kind" -v n="$name" '$1 == k && $2 == n' | grep -c '')" -eq 0 ]; then
    err "デプロイ対象 ${kind} ${name} が TARGETS 表にありません。check（照合する）か skip（理由と Issue 番号）で宣言してください。"
  fi
done <<< "$canon"
if [ "$canon_count" -eq 0 ]; then
  echo "ERROR: デプロイ対象の正典が 0 件です（空振りを緑にしません）。" >&2
  exit 1
fi

while IFS=$'\t' read -r kind name mode _rest; do
  [ -n "$kind" ] || continue
  if [ "$(printf '%s\n' "$canon" | awk -F'\t' -v k="$kind" -v n="$name" '$1 == k && $2 == n' | grep -c '')" -eq 0 ]; then
    err "TARGETS 表の ${kind} ${name} がデプロイ対象の正典にありません（改名・撤去の取り残し）。"
  fi
  case "$mode" in
    check | skip) ;;
    *) err "TARGETS 表の ${kind} ${name} の第 3 列が check / skip のどちらでもありません: ${mode}" ;;
  esac
done <<< "$TARGETS"

# --- 抽出の道具 ---

# 出典ファイルが必須と自己申告する env 名を 1 行 1 件で出す。
required_envs() { # $1 = 出典ファイル
  local rc=0 out
  out="$(grep -oE "Error\\(['\"\`][A-Z][A-Z0-9_]* is required|required\\(env, *['\"][A-Z][A-Z0-9_]*['\"]\\)|MissingConfigError\\(['\"][A-Z][A-Z0-9_]*['\"]\\)" "$1")" || rc=$?
  if [ "$rc" -ge 2 ]; then
    echo "ERROR: ${1} を走査できません（grep exit=${rc}）。" >&2
    exit 1
  fi
  [ -n "$out" ] || return 0
  # 一致した断片には、引用符の直後に env 名が 1 つだけある（`Error` などの語は引用符に続かない）。
  printf '%s\n' "$out" | grep -oE "['\"\`][A-Z][A-Z0-9_]*" | cut -c2- | sort -u
}

# tf の中の、大文字の鍵（`NAME = …` / `"NAME" = …`）と `name = "NAME"` を 1 行 1 件で出す（標準入力）。
tf_env_names() {
  local rc=0 out
  out="$(grep -oE '(^|[{ ])"?[A-Z][A-Z0-9_]*"? *=|name *= *"[A-Z][A-Z0-9_]*"')" || rc=$?
  if [ "$rc" -ge 2 ]; then
    echo "ERROR: Terraform の配線を走査できません（grep exit=${rc}）。" >&2
    exit 1
  fi
  [ -n "$out" ] || return 0
  printf '%s\n' "$out" | grep -oE '[A-Z][A-Z0-9_]*' | sort -u
}

# main.tf の module "run_services" の中の、サービス "<name>" のブロックを出す。
service_block() { # $1 = サービス名
  awk -v svc="$1" '
    /^module "run_services"/ { in_mod = 1 }
    in_mod && !in_svc && $0 ~ "^[[:space:]]*\"" svc "\"[[:space:]]*=[[:space:]]*\\{" { in_svc = 1; depth = 0 }
    in_svc {
      print
      depth += gsub(/\{/, "{") - gsub(/\}/, "}")
      if (depth == 0) exit
    }
  ' "$PROD_TF"
}

# 語として現れるか（試験・生成物を除く）。件数を出す。
word_count_in_src() { # $1 = 名前 / $2.. = 根
  local name="$1" rc=0 out
  shift
  out="$(grep -rlwF --include='*.ts' --include='*.tsx' \
    --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next --exclude-dir=test \
    --exclude='*.test.ts' --exclude='*.test.tsx' -- "$name" "$@")" || rc=$?
  if [ "$rc" -ge 2 ]; then
    echo "ERROR: ${*} を走査できません（grep exit=${rc}・${name}）。" >&2
    exit 1
  fi
  [ -n "$out" ] || { echo 0; return; }
  printf '%s\n' "$out" | grep -c ''
}

# --- 共通の env の読み手 ---

common_wired="$(tf_env_names < "$RUN_SERVICES_MODULE")"
for name in $COMMON_ENV; do
  if [ "$(printf '%s\n' "$common_wired" | grep -cxF -- "$name")" -eq 0 ]; then
    err "共通の env ${name} を ${RUN_SERVICES_MODULE} が配線していません（COMMON_ENV の宣言が古い可能性があります）。"
  fi
  # shellcheck disable=SC2086  # 根は空白を含まない固定の列挙
  if [ "$(word_count_in_src "$name" $COMMON_ENV_READERS)" -eq 0 ]; then
    err "共通の env ${name} を読む共有パッケージ（${COMMON_ENV_READERS}）が見つかりません。"
  fi
done

# --- 2・3. check の対象ごとの両方向照合 ---

checked=0
required_total=0
wired_total=0
while IFS=$'\t' read -r kind name mode source src_root job_module; do
  [ "$mode" = check ] || continue
  checked=$((checked + 1))

  for f in "$source" "$src_root"; do
    if [ ! -e "$f" ]; then
      err "${kind} ${name} の出典 ${f} が存在しません（TARGETS 表のパスが古い可能性があります）。"
      continue 2
    fi
  done

  if [ "$kind" = service ]; then
    block="$(service_block "$name")"
    if [ -z "$block" ]; then
      err "${PROD_TF} の module \"run_services\" にサービス \"${name}\" のブロックが見つかりません。"
      continue
    fi
    own_wired="$(printf '%s\n' "$block" | tf_env_names)"
    all_wired="$(printf '%s\n%s\n' "$own_wired" "$common_wired" | sort -u)"
  else
    if [ -z "${job_module:-}" ] || [ ! -f "$job_module" ]; then
      err "ジョブ ${name} のモジュール ${job_module:-（未記入）} が見つかりません（TARGETS 表の第 6 列）。"
      continue
    fi
    all_wired="$(tf_env_names < "$job_module")"
    own_wired="$all_wired"
  fi

  if [ -z "$all_wired" ]; then
    err "${kind} ${name} の配線が 0 件です（読み取りが空振りしています）。"
    continue
  fi

  required="$(required_envs "$source")"
  if [ -z "$required" ]; then
    err "${kind} ${name} の出典 ${source} から必須の env を 1 件も抜き出せません（自己申告の形が変わった可能性があります）。"
    continue
  fi

  # 方向 1: 実装が必須とする env が配線されている。
  while IFS= read -r env_name; do
    [ -n "$env_name" ] || continue
    required_total=$((required_total + 1))
    if [ "$(printf '%s\n' "$all_wired" | grep -cxF -- "$env_name")" -eq 0 ]; then
      err "${kind} ${name}: ${source} は ${env_name} を必須にしていますが、Terraform が配線していません（本番で起動に失敗します）。"
    fi
  done <<< "$required"

  # 方向 2: 配線した env を、その対象のソースが読んでいる。
  while IFS= read -r env_name; do
    [ -n "$env_name" ] || continue
    case " ${COMMON_ENV} " in *" ${env_name} "*) continue ;; esac
    wired_total=$((wired_total + 1))
    if [ "$(word_count_in_src "$env_name" "$src_root")" -eq 0 ]; then
      err "${kind} ${name}: Terraform が ${env_name} を配線していますが、${src_root} のどこにも現れません（名前の打ち間違いか、読む側の取り残しです）。"
    fi
  done <<< "$own_wired"
done <<< "$TARGETS"

if [ "$checked" -eq 0 ]; then
  echo "ERROR: 照合する（check の）対象が 0 件です（空振りを緑にしません）。" >&2
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  echo "NG: 実装が必須とする env と Terraform の配線が食い違っています。" >&2
  exit 1
fi

echo "OK: 必須 env と Terraform の配線が一致（デプロイ対象 ${canon_count} 件・照合 ${checked} 件・必須 env ${required_total} 件・配線 ${wired_total} 件）。"
