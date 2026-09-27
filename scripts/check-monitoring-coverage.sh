#!/usr/bin/env bash
# Issue #230 ガードレール（静的・GCP に触れない）: Cloud Run サービス監視の構造検証。
#
# 本 Issue の実態は「監視が無い」ではなく **「監視はあったがコードが失われた」** だった
# （2026-09-09 実測: 本番に alert policy 4 本と logging metric 1 本が稼働し terraform state
# にも入っていたのに、対応する .tf が origin/main にも 49 本のリモートブランチのいずれにも
# 存在しなかった）。しかもその指標は、アプリ側の出力コードが一緒に失われたため
# **「指標は存在するのに一致するログが 1 件も出ない」** 状態で生き残っていた。
#
# この 2 つは別の失敗であり、別の網が要る:
#   - 「コードが消えても本番は生きている」は静的には見えない → monitoring-drift（定期・本番照会）
#   - 「宣言の中で辻褄が合っていない」はここで見える → 本スクリプト（ts-ci）
#
# 検証内容（read-only の grep/awk 検証・副作用なし・bash 3.2 でも走る）:
#   1. 5xx 率のポリシーが **サービス名を述語に持たない** こと。持った瞬間、サービスを足した
#      ときに忘れる余地が生まれる（#151 の教訓。述語が無ければその忘れ方は起き得ない）
#   2. p95 遅延の列挙（latency_watched_services）が、デプロイ正典のサービスに実在すること
#   3. **ログベース指標が読む event 名が、その指標が指すサービスのソースから実際に出力されて
#      いること。** 今回の「指標だけが生きている」を静的に捕まえる唯一の網である
#   4. **ログベース指標を読む alert policy が実在すること。** 指標だけが生き残り、それを読む
#      アラートが消えると、値は数え続けるのに誰にも通知されない（#230 の鏡像であり、指標側の
#      検査 3 だけでは素通りする）。アラートを持たない指標は tf 内へ理由を in-band で宣言する
#      （分析専用 = analytics-only、CI の定期検証が読む = ci-read。後者は読み手のスクリプトが
#      指標名を実際に書いていることまで照合する・Issue #139）
#   5. 全 alert policy が通知チャネルへ接続されていること（鳴っても届かない状態の検出）
#   6. 全 alert policy が auto_close を持つこと（既定 7 日では復旧を短時間で観測できない）
#   7. 空振り防止: resource ブロック 0 件・policy 0 件・metric 0 件・正典 0 件はいずれも赤
#
# **サービス名の一覧をこのスクリプトへ列挙しない。** 正典は
# check-deploy-image-coverage.sh --print-targets であり、上流が赤ならここも即座に落ちる。
#
# **アプリのディレクトリ対応を書き写さない。** 指標の filter が参照する var 名を root の
# module 配線から module.run_services.service_names["<key>"] へ解決し、その <key> を
# ts/apps/<key>/src の実体へ当てる。表へ書き写すと、配線を変えた瞬間にガードが実物から切れる。
# ジョブの指標（job_name で絞るもの・Issue #139）は root の `<var> = module.<mod>.job_name` から
# ジョブ名を解決し、scripts/push-images.sh の Dockerfile 対応が指す置き場所（go/ や
# ts/apps/delivery-job）を探す。イメージを実際に組む装置から導くので、ここも書き写さない。
#
# 使い方: bash scripts/check-monitoring-coverage.sh
#   漏れがあれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ $# -gt 0 ]; then
  case "$1" in
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *)
      echo "ERROR: 未知の引数です: $1" >&2
      echo "       → 使い方は bash scripts/check-monitoring-coverage.sh --help を参照してください。" >&2
      exit 2
      ;;
  esac
fi

GUARDRAILS_TF="${ROOT}/infra/modules/guardrails/main.tf"
ROOT_TF="${ROOT}/infra/envs/prod/main.tf"
COVERAGE_GUARD="${SCRIPT_DIR}/check-deploy-image-coverage.sh"
PUSH_IMAGES="${SCRIPT_DIR}/push-images.sh"
APPS_DIR="${ROOT}/ts/apps"

for f in "$GUARDRAILS_TF" "$ROOT_TF" "$COVERAGE_GUARD" "$PUSH_IMAGES"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: 検証対象ファイルが見つかりません: ${f#"$ROOT"/}" >&2
    exit 1
  fi
done
if [ ! -d "$APPS_DIR" ]; then
  echo "ERROR: アプリのソース木が見つかりません: ${APPS_DIR#"$ROOT"/}" >&2
  exit 1
fi

in_list() {
  # $1=needle, 残り=list
  needle="$1"
  shift
  for x in "$@"; do
    [ "$x" = "$needle" ] && return 0
  done
  return 1
}

count_lines() {
  # $1=改行区切りの文字列。空なら 0。`wc -l` は入力を最後まで読むので SIGPIPE を起こさない
  # （`grep -c` を素で代入すると無一致の exit 1 で set -e に殺されるため、件数はこちらで数える）。
  if [ -z "$1" ]; then
    printf '0\n'
    return 0
  fi
  printf '%s\n' "$1" | wc -l | tr -d '[:space:]'
}

has_match() {
  # $1=ERE, $2=ファイル。1 件以上なら 0、0 件なら 1、評価不能なら 2 を返す。
  # `grep -q` はパイプ下流だと入力サイズ依存で SIGPIPE を起こすため使わない。
  _cnt_rc=0
  _cnt="$(grep -cE "$1" "$2")" || _cnt_rc=$?
  if [ "$_cnt_rc" -gt 1 ]; then
    return 2
  fi
  if [ "${_cnt:-0}" -gt 0 ]; then
    return 0
  fi
  return 1
}

# 属性 $2 への代入を、**角括弧が閉じるまで**読んで 1 行へ畳む（$1 = ファイル）。
#
# **1 行 grep で読んではならない。** terraform fmt は要素の多いリストを複数行のまま許す
# （実測: `latency_watched_services = [` + 要素 + `]` の 3 行は fmt -check を通る）。1 行だけ
# 読むと、3 つ目の要素を足した瞬間に抽出が空になり、原因を名指ししない赤が出る。しかも
# 「そこへ足せ」と誘っているのは本ガード自身のコメントである。
#
# 角括弧を持たない代入は最初の 1 行で確定する。行全体がコメントの行は畳み込みから除く。
read_assignment_span() {
  ras_rc=0
  ras_out="$(awk -v attr="$2" '
    !collecting && $0 ~ ("^[[:space:]]*" attr "[[:space:]]*=") { collecting = 1 }
    collecting {
      probe = $0
      if (probe ~ /^[[:space:]]*#/) { next }
      buf = buf " " probe
      depth += gsub(/\[/, "[", probe) - gsub(/\]/, "]", probe)
      if (depth <= 0) { print buf; exit }
    }
  ' "$1")" || ras_rc=$?
  if [ "$ras_rc" -ne 0 ]; then
    echo "ERROR: 代入 $2 の読み取りに失敗しました（awk exit=${ras_rc}）: $1" >&2
    return 2
  fi
  printf '%s\n' "$ras_out"
  return 0
}

# 指標ブロック $1 が宣言する指標名を列挙する（for_each を展開する）。
metric_names() {
  mn_tmpl="$(grep -E '^[[:space:]]*name[[:space:]]*=' "$1" | sed -n '1,1p' | sed -E 's/^[[:space:]]*name[[:space:]]*=[[:space:]]*//; s/^"//; s/"[[:space:]]*$//')" || return 2
  [ -n "$mn_tmpl" ] || return 2
  mn_fe="$(read_assignment_span "$1" for_each)" || return 2
  mn_keys="$(printf '%s\n' "$mn_fe" | tr ',' '\n' | sed -nE 's/.*"([A-Za-z0-9_.-]+)".*/\1/p')"
  if [ -z "$mn_keys" ]; then
    case "$mn_tmpl" in
      *'each.key'*) return 2 ;;
    esac
    printf '%s\n' "$mn_tmpl"
    return 0
  fi
  for mn_k in $mn_keys; do
    case "$mn_tmpl" in
      'each.key') printf '%s\n' "$mn_k" ;;
      *'${each.key}'*) printf '%s\n' "$mn_tmpl" | sed "s/\${each.key}/${mn_k}/g" ;;
      *) printf '%s\n' "$mn_tmpl" ;;
    esac
  done
  return 0
}

fail=0

TMPDIR_BLOCKS="$(mktemp -d "${TMPDIR:-/tmp}/monitoring-coverage.XXXXXX")"
trap 'rm -rf "$TMPDIR_BLOCKS"' EXIT

# --- 準備: guardrails の resource ブロックを 1 件ずつ切り出す --------------------------------
#
# terraform fmt が「トップレベルの resource は 0 桁から始まり、対応する } も 0 桁」を保証する
# ので、行頭の波括弧の深さで区切れる。深さの計算からは **行全体がコメントの行だけ** を除く
# （tf の文字列リテラルに # は現れないが、コメント中には {"event":"…"} のような対の括弧が
# 実際に書かれている）。
awk -v outdir="$TMPDIR_BLOCKS" '
  /^resource "/ {
    rtype = $2; rname = $3
    gsub(/"/, "", rtype); gsub(/"/, "", rname)
    depth = 0
    inblock = 1
    file = outdir "/" rtype "." rname ".hcl"
  }
  inblock {
    print $0 > file
    probe = $0
    if (probe ~ /^[[:space:]]*#/) { probe = "" }
    opens = gsub(/\{/, "{", probe)
    closes = gsub(/\}/, "}", probe)
    depth += opens - closes
    if (depth <= 0) { inblock = 0; close(file) }
  }
' "$GUARDRAILS_TF"

block_files_rc=0
block_files="$(ls -1 "$TMPDIR_BLOCKS" 2>/dev/null | sort)" || block_files_rc=$?
if [ "$block_files_rc" -ne 0 ] || [ -z "$block_files" ]; then
  echo "ERROR: ${GUARDRAILS_TF#"$ROOT"/} から resource ブロックを1件も切り出せませんでした。" >&2
  echo "       → 対象 0 件のまま「漏れなし」で緑にするのが最悪の空振りであるため、ここで fail します。" >&2
  exit 1
fi

policy_files=""
metric_files=""
for bf in $block_files; do
  case "$bf" in
    google_monitoring_alert_policy.*) policy_files="${policy_files}${bf}
" ;;
    google_logging_metric.*) metric_files="${metric_files}${bf}
" ;;
  esac
done
policy_files="${policy_files%
}"
metric_files="${metric_files%
}"

if [ -z "$policy_files" ]; then
  echo "ERROR: google_monitoring_alert_policy のブロックを1件も抽出できませんでした。" >&2
  echo "       → 監視 0 件のまま緑にするのが最悪の空振りであるため、ここで fail します。" >&2
  exit 1
fi
if [ -z "$metric_files" ]; then
  echo "ERROR: google_logging_metric のブロックを1件も抽出できませんでした。" >&2
  echo "       → 指標 0 件のまま緑にするのが最悪の空振りであるため、ここで fail します。" >&2
  exit 1
fi

# --- 検証1: デプロイ正典の取得（列挙を二重管理しない） ----------------------------------------
canon_rc=0
canon_tsv="$(bash "$COVERAGE_GUARD" --print-targets)" || canon_rc=$?
if [ "$canon_rc" -ne 0 ]; then
  echo "ERROR: デプロイ正典を取得できません（check-deploy-image-coverage.sh が exit=${canon_rc}）。" >&2
  echo "       → 先にデプロイカバレッジの赤を直してください。壊れた正典から導出した集合で" >&2
  echo "         本ガードを緑にすると、監視の母数そのものが誤ったまま通ります。" >&2
  exit 1
fi

canon_services_rc=0
canon_services="$(printf '%s\n' "$canon_tsv" | awk -F'\t' '$1 == "service" { print $2 }' | sort -u)" || canon_services_rc=$?
if [ "$canon_services_rc" -ne 0 ]; then
  echo "ERROR: デプロイ正典から service 行を抽出できません（awk exit=${canon_services_rc}）。" >&2
  exit 1
fi
if [ -z "$canon_services" ]; then
  echo "ERROR: デプロイ正典から service を1件も抽出できませんでした（--print-targets の書式が変わっています）。" >&2
  echo "       → 対象 0 件のまま「漏れなし」で緑にするのが最悪の空振りであるため、ここで fail します。" >&2
  exit 1
fi
canon_count="$(count_lines "$canon_services")"

# ジョブは空でも赤にしない（ジョブの指標を持たない構成はあり得る）。ジョブの指標が在るのに
# 正典が空なら、下の解決で「正典に存在しません」として赤になる。
canon_jobs_rc=0
canon_jobs="$(printf '%s\n' "$canon_tsv" | awk -F'\t' '$1 == "job" { print $2 }' | sort -u)" || canon_jobs_rc=$?
if [ "$canon_jobs_rc" -ne 0 ]; then
  echo "ERROR: デプロイ正典から job 行を抽出できません（awk exit=${canon_jobs_rc}）。" >&2
  exit 1
fi

# --- 検証2: 5xx 率がサービス名を述語に持たないこと -------------------------------------------
#
# ここが「5 サービス全部が監視下にある」ことの根拠である。述語を持たないポリシーが 1 本ある
# ことをもって、正典の全サービス（と、まだ存在しない 6 本目）が構造的に覆われる。
# 逆に言えば、ここに service_name が足された瞬間、この根拠は消える。
FIVEXX_BLOCK="${TMPDIR_BLOCKS}/google_monitoring_alert_policy.service_5xx_rate.hcl"
if [ ! -f "$FIVEXX_BLOCK" ]; then
  echo "ERROR: google_monitoring_alert_policy.service_5xx_rate が ${GUARDRAILS_TF#"$ROOT"/} にありません。" >&2
  echo "       → サービス名を列挙しない述語を持つポリシーが、全 ${canon_count} サービスを覆う唯一の根拠です。" >&2
  fail=1
else
  fivexx_filter_rc=0
  fivexx_filter="$(grep -E '^[[:space:]]*filter[[:space:]]*=' "$FIVEXX_BLOCK")" || fivexx_filter_rc=$?
  if [ "$fivexx_filter_rc" -gt 1 ]; then
    echo "ERROR: service_5xx_rate の filter を評価できません（grep exit=${fivexx_filter_rc}）。" >&2
    fail=1
  elif [ -z "$fivexx_filter" ]; then
    echo "ERROR: service_5xx_rate に filter がありません（抽出パターンの前提が崩れています）。" >&2
    fail=1
  else
    # 述語は filter / denominator_filter の式にしか現れない。集約軸
    # （group_by_fields = ["resource.label.service_name"]）は「サービスごとに率を出す」ための
    # 指定であって絞り込みではないので、ブロック全体を素で grep すると誤検出する。
    fivexx_filters="${TMPDIR_BLOCKS}/fivexx-filters.txt"
    grep -E '^[[:space:]]*(filter|denominator_filter)[[:space:]]*=' "$FIVEXX_BLOCK" > "$fivexx_filters"
    has_match 'service_name' "$fivexx_filters" && sn_rc=0 || sn_rc=$?
    if [ "$sn_rc" -eq 2 ]; then
      echo "ERROR: service_5xx_rate の service_name 検査を評価できません。" >&2
      fail=1
    elif [ "$sn_rc" -eq 0 ]; then
      echo "ERROR: service_5xx_rate が service_name を述語に持っています。" >&2
      echo "       → サービス名で絞ると、サービスを足すたびにここへ足すことを思い出す必要が生まれ、" >&2
      echo "         思い出さなかったときに無音になります（Issue #151 で Job 側が実際にそうなり、" >&2
      echo "         60 execution 以上が誰にも通知されないまま経過しました）。" >&2
      echo "       → 現在この 1 本が正典の ${canon_count} サービスを覆う唯一の根拠です。" >&2
      fail=1
    fi
  fi
fi

# --- 検証3: p95 遅延の列挙が正典に実在すること ------------------------------------------------
latency_raw_rc=0
latency_raw="$(read_assignment_span "$ROOT_TF" latency_watched_services)" || latency_raw_rc=$?
if [ "$latency_raw_rc" -ne 0 ]; then
  echo "ERROR: latency_watched_services の宣言を読めません。" >&2
  fail=1
elif [ -z "$latency_raw" ]; then
  echo "ERROR: ${ROOT_TF#"$ROOT"/} に latency_watched_services の配線がありません。" >&2
  echo "       → 客向け面の遅延監視が誰にも渡されていない状態です。" >&2
  fail=1
else
  latency_names="$(printf '%s\n' "$latency_raw" | tr ',' '\n' | sed -nE 's/.*"([A-Za-z0-9_-]+)".*/\1/p' | sort -u)"
  if [ -z "$latency_names" ]; then
    echo "ERROR: latency_watched_services からサービス名を1件も抽出できませんでした。" >&2
    echo "       → 列挙 0 件のまま緑にするのが最悪の空振りであるため、ここで fail します。" >&2
    fail=1
  else
    for name in $latency_names; do
      if ! in_list "$name" $canon_services; then
        echo "ERROR: latency_watched_services の \"${name}\" はデプロイ正典に存在しません。" >&2
        echo "       → 正典（check-deploy-image-coverage.sh --print-targets）の service: $(printf '%s' "$canon_services" | tr '\n' ' ')" >&2
        echo "       → 綴り違い、あるいは撤去済みのサービスを監視し続けています（そのポリシーは永久に鳴りません）。" >&2
        fail=1
      fi
    done
  fi
fi

# --- 検証4: 指標が読む event 名を、その指標が指すサービスが実際に出力していること --------------
#
# **今回の事故を捕まえる網。** 指標（tf）とアプリ（ts）は別の層にあり、片方だけを直しても
# CI は緑のままだった。2026-09-06〜09-09 の本番はまさにその状態（指標は存在し、それを読む
# アラートも生きていたが、アプリが event を出さないので値は永久に 0）だった。
checked_events=0
for mf in $metric_files; do
  mname="${mf#google_logging_metric.}"
  mname="${mname%.hcl}"
  mpath="${TMPDIR_BLOCKS}/${mf}"

  mfilter_rc=0
  mfilter="$(grep -E '^[[:space:]]*filter[[:space:]]*=' "$mpath")" || mfilter_rc=$?
  if [ "$mfilter_rc" -gt 1 ]; then
    echo "ERROR: google_logging_metric.${mname} の filter を評価できません（grep exit=${mfilter_rc}）。" >&2
    fail=1
    continue
  fi
  if [ -z "$mfilter" ]; then
    echo "ERROR: google_logging_metric.${mname} に filter がありません。" >&2
    fail=1
    continue
  fi

  # filter が jsonPayload.event を見ていない指標（将来 event 以外で数えるもの）は対象外。
  case "$mfilter" in
    *jsonPayload.event*) ;;
    *) continue ;;
  esac

  # --- 対象の解決 ---
  #   サービス: var.<name> → root の module 配線 → service_names["<key>"] → ts/apps/<key>/src
  #   ジョブ  : var.<name> → root の `<name> = module.<mod>.job_name` → そのモジュールの job_name
  #             （root での上書き、無ければモジュールの variables.tf の既定値）→ デプロイ正典の job →
  #             push-images.sh の Dockerfile 対応の置き場所（Issue #139）
  # ジョブのソース木を表へ書き写さないのはサービスと同じ理由である。push-images.sh は実際に
  # イメージを組む装置なので、そこから導けば「組まれるコード」と「探すコード」が切れない。
  svc_var="$(printf '%s\n' "$mfilter" | sed -nE 's/.*service_name = \\"\$\{var\.([a-z_]+)\}\\".*/\1/p')"
  job_var="$(printf '%s\n' "$mfilter" | sed -nE 's/.*job_name = \\"\$\{var\.([a-z_]+)\}\\".*/\1/p')"
  if [ -n "$svc_var" ]; then
    svc_key="$(sed -nE "s/^[[:space:]]*${svc_var}[[:space:]]*=[[:space:]]*module\.run_services\.service_names\[\"([A-Za-z0-9_-]+)\"\].*/\1/p" "$ROOT_TF")"
    if [ -z "$svc_key" ]; then
      echo "ERROR: ${ROOT_TF#"$ROOT"/} で ${svc_var} が module.run_services.service_names[...] から配線されていません。" >&2
      fail=1
      continue
    fi
    if ! in_list "$svc_key" $canon_services; then
      echo "ERROR: ${svc_var} が指す \"${svc_key}\" はデプロイ正典に存在しません。" >&2
      fail=1
      continue
    fi
    src_dir="${APPS_DIR}/${svc_key}/src"
  elif [ -n "$job_var" ]; then
    job_mod="$(sed -nE "s/^[[:space:]]*${job_var}[[:space:]]*=[[:space:]]*module\.([a-z_]+)\.job_name[[:space:]]*$/\1/p" "$ROOT_TF")"
    if [ -z "$job_mod" ]; then
      echo "ERROR: ${ROOT_TF#"$ROOT"/} で ${job_var} が module.<name>.job_name から配線されていません。" >&2
      echo "       → ジョブ名をリテラルで渡すと、ジョブのモジュールと切れてもここが気づけなくなります。" >&2
      fail=1
      continue
    fi
    # root の module ブロックから source と job_name の上書きを読む。
    job_mod_body="$(awk -v m="$job_mod" '
      $0 ~ ("^module \"" m "\"") { inb = 1; next }
      inb && /^}/ { exit }
      inb { print }
    ' "$ROOT_TF")"
    job_mod_dir="$(printf '%s\n' "$job_mod_body" | sed -nE 's/^[[:space:]]*source[[:space:]]*=[[:space:]]*"\.\.\/\.\.\/modules\/([A-Za-z0-9_-]+)".*/\1/p')"
    if [ -z "$job_mod_dir" ]; then
      echo "ERROR: ${ROOT_TF#"$ROOT"/} の module \"${job_mod}\" から source を解決できません。" >&2
      fail=1
      continue
    fi
    job_key="$(printf '%s\n' "$job_mod_body" | sed -nE 's/^[[:space:]]*job_name[[:space:]]*=[[:space:]]*"([A-Za-z0-9_-]+)".*/\1/p')"
    if [ -z "$job_key" ]; then
      job_vars_tf="${ROOT}/infra/modules/${job_mod_dir}/variables.tf"
      if [ -f "$job_vars_tf" ]; then
        job_key="$(awk '
          /^variable "job_name"/ { inb = 1; next }
          inb && /^}/ { exit }
          inb && /^[[:space:]]*default[[:space:]]*=/ { print; exit }
        ' "$job_vars_tf" | sed -nE 's/.*"([A-Za-z0-9_-]+)".*/\1/p')"
      fi
    fi
    if [ -z "$job_key" ]; then
      echo "ERROR: module \"${job_mod}\" のジョブ名を解決できません（root の上書きも variables.tf の既定値もありません）。" >&2
      fail=1
      continue
    fi
    if ! in_list "$job_key" $canon_jobs; then
      echo "ERROR: ${job_var} が指すジョブ \"${job_key}\" はデプロイ正典に存在しません。" >&2
      fail=1
      continue
    fi
    job_dockerfile="$(sed -nE "s/^[[:space:]]*\[${job_key}\]=\"([A-Za-z0-9_./-]+)\/Dockerfile\".*/\1/p" "$PUSH_IMAGES")"
    if [ -z "$job_dockerfile" ]; then
      echo "ERROR: ${PUSH_IMAGES#"$ROOT"/} の Dockerfile 対応にジョブ \"${job_key}\" がありません。" >&2
      fail=1
      continue
    fi
    svc_key="$job_key"
    src_dir="${ROOT}/${job_dockerfile}"
  else
    echo "ERROR: google_logging_metric.${mname} の filter から対象サービスの変数名を解決できません（ジョブなら job_name の変数名）。" >&2
    echo "       → service_name / job_name は \${var.<name>} で受けてください。リテラルを直書きすると、" >&2
    echo "         run-services やジョブのモジュールの実体と切れてもここが気づけなくなります。" >&2
    fail=1
    continue
  fi

  # --- event 名の解決: リテラル、または for_each = toset([...]) の各要素 ---
  events="$(printf '%s\n' "$mfilter" | sed -nE 's/.*jsonPayload\.event = \\"([a-z0-9_.-]+)\\".*/\1/p')"
  if [ -z "$events" ]; then
    fe_rc=0
    fe_line="$(read_assignment_span "$mpath" for_each)" || fe_rc=$?
    if [ "$fe_rc" -ne 0 ]; then
      echo "ERROR: google_logging_metric.${mname} の for_each を読めません。" >&2
      fail=1
      continue
    fi
    events="$(printf '%s\n' "$fe_line" | tr ',' '\n' | sed -nE 's/.*"([a-z0-9_.-]+)".*/\1/p' | sort -u)"
  fi
  if [ -z "$events" ]; then
    echo "ERROR: google_logging_metric.${mname} から event 名を1件も解決できませんでした。" >&2
    echo "       → 対象 0 件のまま「アプリが出している」と見なすのが最悪の空振りであるため、ここで fail します。" >&2
    fail=1
    continue
  fi

  if [ ! -d "$src_dir" ]; then
    echo "ERROR: google_logging_metric.${mname} が指すサービス \"${svc_key}\" のソース木がありません: ${src_dir#"$ROOT"/}" >&2
    fail=1
    continue
  fi

  for ev in $events; do
    checked_events=$((checked_events + 1))
    # pipefail 下では pipeline の終了状態が grep のものになる。**無一致（1）と評価不能
    # （2 以上）を分ける。** 潰すと「出力していない」という本命の診断が「探索できない」へ
    # 化け、赤の理由が別物にすり替わる（Issue #120。この誤りは本ケースの赤側が実際に暴いた）。
    #
    # 事象名の `.` は正規表現の任意 1 文字なので逃がす（`delivery-job.run` が `delivery-jobXrun`
    # に一致して緑になるのを防ぐ）。テストコードは除く。テストだけが事象名を書いている状態は
    # 「アプリが出している」ではない。Go の日次バッチ（Issue #139）のため .go も探す。
    ev_re="$(printf '%s' "$ev" | sed 's/\./\\./g')"
    hit_rc=0
    hit_count="$(grep -rlE "['\"]${ev_re}['\"]" --include='*.ts' --include='*.tsx' --include='*.go' \
      --exclude='*_test.go' --exclude='*.test.ts' --exclude='*.test.tsx' "$src_dir" | wc -l | tr -d '[:space:]')" || hit_rc=$?
    if [ "$hit_rc" -gt 1 ]; then
      echo "ERROR: 事象名 ${ev} の探索を評価できません（grep exit=${hit_rc}）。" >&2
      fail=1
      continue
    fi
    if [ "$hit_count" -eq 0 ]; then
      echo "ERROR: 指標 ${mname} が数える事象 \"${ev}\" を ${svc_key} が出力していません。" >&2
      echo "       → ${src_dir#"$ROOT"/} 配下の .ts/.tsx/.go（テストを除く）にこの文字列がありません。" >&2
      echo "       → 指標は存在するのに値が永久に 0 という静かな失敗です。2026-09-06〜09-09 の本番が" >&2
      echo "         実際にこの状態で、署名検証が全件失敗しても誰にも通知されない構成になっていました。" >&2
      fail=1
    fi
  done
done

if [ "$checked_events" -eq 0 ]; then
  echo "ERROR: event 名を照合した指標が 0 件でした（抽出パターンの前提が崩れています）。" >&2
  echo "       → 検査 0 件のまま緑にするのが最悪の空振りであるため、ここで fail します。" >&2
  fail=1
fi

# --- 検証4-b: 指標を読む alert policy が実在すること ------------------------------------------
#
# 検証4 は「指標 → アプリ」を見るが、「指標 → アラート」は見ない。実測（セルフレビュー）で、
# webhook_signature_failure のポリシーブロックだけを消しても本ガードは緑のままだった。
# 指標は数え続け、アプリは event を出し続け、しかし誰にも通知されない。#230 の鏡像である。
#
# 分析専用の指標（survey_funnel 等）まで一律に要求すると偽陽性になるため、除外は **tf の中へ
# in-band で** 宣言させる（スクリプト内の除外表を併設すると、同じ意味を 2 箇所で書けてしまい
# どちらが正かが決まらない）。書式は run-db-test-suites.sh の SKIP 表と同じく Issue 番号必須:
#
#   # monitoring-coverage: analytics-only (#137)
#
# 照合は「宣言された名前が、いずれかの policy の filter に現れること」で行う。tf は指標名を
# ${google_logging_metric.<res>.name} で参照するのが正しい書き方なので、リテラル名と
# その参照式の**どちらか**が現れれば接続されているとみなす。
policy_filters="${TMPDIR_BLOCKS}/all-policy-filters.txt"
: > "$policy_filters"
for pf in $policy_files; do
  pf_rc=0
  pf_lines="$(grep -E '^[[:space:]]*(filter|denominator_filter)[[:space:]]*=' "${TMPDIR_BLOCKS}/${pf}")" || pf_rc=$?
  if [ "$pf_rc" -gt 1 ]; then
    echo "ERROR: alert policy の filter を評価できません（grep exit=${pf_rc}）: ${pf}" >&2
    fail=1
    continue
  fi
  if [ -n "$pf_lines" ]; then
    printf '%s\n' "$pf_lines" >> "$policy_filters"
  fi
done

linked_checked=0
for mf in $metric_files; do
  mres="${mf#google_logging_metric.}"
  mres="${mres%.hcl}"
  mpath="${TMPDIR_BLOCKS}/${mf}"

  mnames="$(metric_names "$mpath")" || {
    echo "ERROR: google_logging_metric.${mres} の name を解決できません。" >&2
    fail=1
    continue
  }
  if [ -z "$mnames" ]; then
    echo "ERROR: google_logging_metric.${mres} から指標名を1件も解決できませんでした。" >&2
    fail=1
    continue
  fi

  # in-band の除外（Issue 番号必須）。
  has_match '^[[:space:]]*#[[:space:]]*monitoring-coverage:[[:space:]]*analytics-only[[:space:]]*\(#[0-9]+\)' "$mpath" && ao_rc=0 || ao_rc=$?
  if [ "$ao_rc" -eq 2 ]; then
    echo "ERROR: ${mres} の analytics-only 宣言を評価できません。" >&2
    fail=1
    continue
  fi
  if [ "$ao_rc" -eq 0 ]; then
    continue
  fi

  # CI の定期検証が読む指標（Issue #139）。書式は Issue 番号と読み手のスクリプトが必須:
  #
  #   # monitoring-coverage: ci-read (#139) scripts/check-external-api-liveness.sh
  #
  # **宣言だけで逃がさない。** 読み手が実在し、かつ指標名をそのスクリプトが実際に書いている
  # ことまで要求する。宣言だけを見ると、読み手から指標名が消えても（＝誰も読んでいない）緑になり、
  # analytics-only を装った「面倒だから逃がす」と区別できなくなる。
  ci_re='^[[:space:]]*#[[:space:]]*monitoring-coverage:[[:space:]]*ci-read[[:space:]]*\(#[0-9]+\)[[:space:]]+scripts/[A-Za-z0-9_.-]+\.sh[[:space:]]*$'
  has_match "$ci_re" "$mpath" && ci_rc=0 || ci_rc=$?
  if [ "$ci_rc" -eq 2 ]; then
    echo "ERROR: ${mres} の ci-read 宣言を評価できません。" >&2
    fail=1
    continue
  fi
  if [ "$ci_rc" -eq 0 ]; then
    ci_reader="$(sed -nE 's/^[[:space:]]*#[[:space:]]*monitoring-coverage:[[:space:]]*ci-read[[:space:]]*\(#[0-9]+\)[[:space:]]+(scripts\/[A-Za-z0-9_.-]+\.sh)[[:space:]]*$/\1/p' "$mpath" | sed -n '1,1p')"
    if [ ! -f "${ROOT}/${ci_reader}" ]; then
      echo "ERROR: ${mres} の ci-read 宣言が指す読み手 ${ci_reader} がありません。" >&2
      echo "       → 読み手の無い指標は、数え続けるだけで誰も見ていません（#230 の鏡像）。" >&2
      fail=1
      continue
    fi
    for mn in $mnames; do
      linked_checked=$((linked_checked + 1))
      has_match "(^|[^A-Za-z0-9_-])${mn}([^A-Za-z0-9_-]|$)" "${ROOT}/${ci_reader}" && cr_rc=0 || cr_rc=$?
      if [ "$cr_rc" -eq 2 ]; then
        echo "ERROR: 指標 ${mn} と読み手 ${ci_reader} の接続を評価できません。" >&2
        fail=1
        continue
      fi
      if [ "$cr_rc" -ne 0 ]; then
        echo "ERROR: 指標 ${mn} を ci-read の読み手 ${ci_reader} が参照していません。" >&2
        echo "       → 宣言だけが残り、実際には誰もこの指標を読んでいない状態です。" >&2
        fail=1
      fi
    done
    continue
  fi

  for mn in $mnames; do
    linked_checked=$((linked_checked + 1))
    has_match "logging\.googleapis\.com/user/(${mn}|\\$\{google_logging_metric\.${mres}\.name\})" "$policy_filters" && ln_rc=0 || ln_rc=$?
    if [ "$ln_rc" -eq 2 ]; then
      echo "ERROR: 指標 ${mn} とアラートの接続を評価できません。" >&2
      fail=1
      continue
    fi
    if [ "$ln_rc" -ne 0 ]; then
      echo "ERROR: 指標 ${mn} を読む alert policy がありません。" >&2
      echo "       → 指標は数え続けますが、誰にも通知されません（#230 の鏡像）。" >&2
      echo "       → 通知が要らない分析専用の指標なら、その resource ブロックの中へ" >&2
      echo "         「# monitoring-coverage: analytics-only (#NNN)」を Issue 番号つきで書いてください。" >&2
      fail=1
    fi
  done
done

if [ "$linked_checked" -eq 0 ]; then
  ao_all_rc=0
  has_match 'monitoring-coverage:[[:space:]]*analytics-only' "$GUARDRAILS_TF" && ao_all_rc=0 || ao_all_rc=$?
  if [ "$ao_all_rc" -ne 0 ]; then
    echo "ERROR: アラート接続を照合した指標が 0 件でした（抽出パターンの前提が崩れています）。" >&2
    fail=1
  fi
fi

# --- 検証5/6: 全 alert policy の通知先と auto_close ------------------------------------------
policy_count=0
for pf in $policy_files; do
  pname="${pf#google_monitoring_alert_policy.}"
  pname="${pname%.hcl}"
  ppath="${TMPDIR_BLOCKS}/${pf}"
  policy_count=$((policy_count + 1))

  has_match 'notification_channels[[:space:]]*=[[:space:]]*\[google_monitoring_notification_channel\.email\.id\]' "$ppath" && nc_rc=0 || nc_rc=$?
  if [ "$nc_rc" -eq 2 ]; then
    echo "ERROR: ${pname} の通知チャネル検査を評価できません。" >&2
    fail=1
  elif [ "$nc_rc" -ne 0 ]; then
    echo "ERROR: alert policy ${pname} が共用の通知チャネルへ接続されていません。" >&2
    echo "       → notification_channels = [google_monitoring_notification_channel.email.id] が必要です。" >&2
    echo "       → 接続の無いポリシーは Incident を作るだけで、誰のメールにも届きません。" >&2
    fail=1
  fi

  has_match '^[[:space:]]*auto_close[[:space:]]*=' "$ppath" && ac_rc=0 || ac_rc=$?
  if [ "$ac_rc" -eq 2 ]; then
    echo "ERROR: ${pname} の auto_close 検査を評価できません。" >&2
    fail=1
  elif [ "$ac_rc" -ne 0 ]; then
    echo "ERROR: alert policy ${pname} に alert_strategy.auto_close がありません。" >&2
    echo "       → 既定の自動クローズは 7 日で、復旧を短時間で観測できません（直したのに閉じないので、" >&2
    echo "         開いているインシデントが「今も壊れている」ことを意味しなくなります）。" >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi

metric_count="$(count_lines "$metric_files")"
echo "OK: サービス監視カバレッジ緑（正典 ${canon_count} サービス / alert policy ${policy_count} 本 / logging metric ${metric_count} 本 / 事象名 ${checked_events} 件をアプリの実体と照合）。"
