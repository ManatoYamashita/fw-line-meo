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
#   4. 全 alert policy が通知チャネルへ接続されていること（鳴っても届かない状態の検出）
#   5. 全 alert policy が auto_close を持つこと（既定 7 日では復旧を短時間で観測できない）
#   6. 空振り防止: resource ブロック 0 件・policy 0 件・metric 0 件・正典 0 件はいずれも赤
#
# **サービス名の一覧をこのスクリプトへ列挙しない。** 正典は
# check-deploy-image-coverage.sh --print-targets であり、上流が赤ならここも即座に落ちる。
#
# **アプリのディレクトリ対応を書き写さない。** 指標の filter が参照する var 名を root の
# module 配線から module.run_services.service_names["<key>"] へ解決し、その <key> を
# ts/apps/<key>/src の実体へ当てる。表へ書き写すと、配線を変えた瞬間にガードが実物から切れる。
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
APPS_DIR="${ROOT}/ts/apps"

for f in "$GUARDRAILS_TF" "$ROOT_TF" "$COVERAGE_GUARD"; do
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
latency_raw="$(grep -E '^[[:space:]]*latency_watched_services[[:space:]]*=' "$ROOT_TF")" || latency_raw_rc=$?
if [ "$latency_raw_rc" -gt 1 ]; then
  echo "ERROR: latency_watched_services の宣言を評価できません（grep exit=${latency_raw_rc}）。" >&2
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

  # --- 対象サービスの解決: var.<name> → root の module 配線 → service_names["<key>"] ---
  svc_var="$(printf '%s\n' "$mfilter" | sed -nE 's/.*service_name = \\"\$\{var\.([a-z_]+)\}\\".*/\1/p')"
  if [ -z "$svc_var" ]; then
    echo "ERROR: google_logging_metric.${mname} の filter から対象サービスの変数名を解決できません。" >&2
    echo "       → service_name は \${var.<name>} で受けてください。リテラルを直書きすると、" >&2
    echo "         run-services の実体と切れてもここが気づけなくなります。" >&2
    fail=1
    continue
  fi
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

  # --- event 名の解決: リテラル、または for_each = toset([...]) の各要素 ---
  events="$(printf '%s\n' "$mfilter" | sed -nE 's/.*jsonPayload\.event = \\"([a-z0-9_]+)\\".*/\1/p')"
  if [ -z "$events" ]; then
    fe_rc=0
    fe_line="$(grep -E '^[[:space:]]*for_each[[:space:]]*=' "$mpath")" || fe_rc=$?
    if [ "$fe_rc" -gt 1 ]; then
      echo "ERROR: google_logging_metric.${mname} の for_each を評価できません（grep exit=${fe_rc}）。" >&2
      fail=1
      continue
    fi
    events="$(printf '%s\n' "$fe_line" | tr ',' '\n' | sed -nE 's/.*"([a-z0-9_]+)".*/\1/p' | sort -u)"
  fi
  if [ -z "$events" ]; then
    echo "ERROR: google_logging_metric.${mname} から event 名を1件も解決できませんでした。" >&2
    echo "       → 対象 0 件のまま「アプリが出している」と見なすのが最悪の空振りであるため、ここで fail します。" >&2
    fail=1
    continue
  fi

  src_dir="${APPS_DIR}/${svc_key}/src"
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
    hit_rc=0
    hit_count="$(grep -rlE "['\"]${ev}['\"]" --include='*.ts' --include='*.tsx' "$src_dir" | wc -l | tr -d '[:space:]')" || hit_rc=$?
    if [ "$hit_rc" -gt 1 ]; then
      echo "ERROR: 事象名 ${ev} の探索を評価できません（grep exit=${hit_rc}）。" >&2
      fail=1
      continue
    fi
    if [ "$hit_count" -eq 0 ]; then
      echo "ERROR: 指標 ${mname} が数える事象 \"${ev}\" を ${svc_key} が出力していません。" >&2
      echo "       → ${src_dir#"$ROOT"/} 配下の .ts/.tsx にこの文字列がありません。" >&2
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
