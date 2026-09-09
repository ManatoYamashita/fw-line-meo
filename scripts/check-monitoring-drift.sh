#!/usr/bin/env bash
# Issue #230 ガードレール（層2・本番照会）: 本番の監視構成が、リポジトリ内の宣言
# infra/modules/guardrails/main.tf と一致していることを定期検証する。
#
# **この検証がなぜ要るか。** #230 の実態は「監視が無い」ではなく **「apply されたが
# コードが失われた」** だった。2026-09-06 に alert policy 4 本と logging metric 1 本が
# 本番へ apply されたが、対応する .tf は commit されないまま作業ツリーから消え、
# 2026-09-09 の実測時点で origin/main にも 49 本のリモートブランチのいずれにも存在しなかった。
# terraform state（serial 38）だけがそれを保持しており、**次の apply が監視を消す**寸前だった。
#
# 静的な照合（ts-ci の check-monitoring-coverage.sh）は「宣言の中で辻褄が合っているか」まで
# しか言えない。「宣言が本番の実物と一致しているか」は本番を見ないと分からない。しかもこの
# 欠陥はマージと無関係に恒常的に成り立つ（コードが消えている間、CI は何度でも緑になる）ので、
# デプロイ契機ではなく時間で回す（#91 / #63 で学んだのと同じ理由）。
#
# **ログを 1 行も読まない。** ログベース指標の存在確認には Monitoring の metricDescriptors を
# 使い、`gcloud logging metrics list` は使わない。後者に必要な logging.logMetrics.* は
# roles/monitoring.viewer に含まれず（実測確認済み）、代わりに roles/logging.viewer を付けると
# logging.logEntries.list まで付いて CI がログ本文を読めるようになる。#227「越えてはならない線」
# と Req 5.4 の思想に反するため、その経路は採らない。metricDescriptors は指標の**定義**だけを
# 返し、値もログ本文も返さない。
#
# 本スクリプトは以下を機械検証する（read-only の照会・副作用なし・bash 3.2 でも走る）:
#   1. 宣言された alert policy が本番に存在すること（apply 忘れ・誤削除の検出）
#   2. 宣言された logging metric が本番に存在すること
#   3. **本番に在って宣言に無いもの**が無いこと（= 今回の事故。コードだけが消えた状態）
#   4. 空振り防止: 宣言 0 件・snapshot 0 行・検証 0 件はいずれも赤
#
# **検出範囲外**: ポリシーの中身（閾値・filter・通知先）の一致は見ない。display_name の集合と
# 指標名の集合だけを見る。中身は terraform plan の差分が担当する（本ガードが中身まで写すと、
# 宣言の書き写しが 2 箇所になり、どちらが正かが決まらなくなる）。
#
# 使い方: PROJECT_ID=<id> bash scripts/check-monitoring-drift.sh
#   乖離があれば該当を stderr に出して exit 1、無ければ exit 0。
#
# 環境変数（既定はすべて本番挙動）:
#   PROJECT_ID                GCP プロジェクト ID。**必須**（既定値を置かない）
#   PROD_MONITORING_SNAPSHOT  クラウド実測の注入。未設定なら gcloud / Monitoring API を叩く
#
# **時刻の注入は持たない。** 判定は集合の一致だけで決まり、猶予や経過時間の閾値を持たない。
#
# snapshot の形式（TSV 2 列・`#` 始まりと空行は読み飛ばす）:
#   <kind>\t<name>
#     kind : policy（alert policy の displayName）| metric（logging metric の名前）
#   live 収集もこの 2 列を組み立ててから比較へ渡す。live と fixture が完全に同一経路を通る。
#
# 呼び出し（read-only・値もログ本文も読まない）:
#   gcloud monitoring policies list --project=<P> --format='value(displayName)'
#   GET https://monitoring.googleapis.com/v3/projects/<P>/metricDescriptors
#       ?filter=metric.type = starts_with("logging.googleapis.com/user/")

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ $# -gt 0 ]; then
  case "$1" in
    -h|--help)
      sed -n '2,50p' "$0"
      exit 0
      ;;
    *)
      echo "ERROR: 未知の引数です: $1" >&2
      echo "       → 使い方は bash scripts/check-monitoring-drift.sh --help を参照してください。" >&2
      exit 2
      ;;
  esac
fi

PROJECT_ID="${PROJECT_ID:-}"
PROD_MONITORING_SNAPSHOT="${PROD_MONITORING_SNAPSHOT:-}"

GUARDRAILS_TF="${ROOT}/infra/modules/guardrails/main.tf"
ROOT_TF="${ROOT}/infra/envs/prod/main.tf"

# 意図的に許容する (kind|name|判定) の組（必ず理由と Issue を明記すること）。
# 想定する正当な例: 別 spec が一時的に手で作った検証用ポリシーを撤去するまでの期間。
# 現在は空。
WHITELIST=()

NL='
'

# 早期異常でも必ず MONITORING-SIGNATURE を出してから落ちる。**署名は本スクリプトの契約**であり、
# 空のまま通知側（report-ci-issue.sh）へ渡すと「状態が変わっていない」判定ができず、赤が続く限り
# 実行のたびに追跡 Issue へコメントが増えてしまう。
fail_early() {
  reason="$1"
  shift
  for line in "$@"; do
    echo "$line" >&2
  done
  echo "MONITORING-SIGNATURE: early-exit=${reason};"
  exit 1
}

in_list() {
  needle="$1"
  shift
  for x in "$@"; do
    [ "$x" = "$needle" ] && return 0
  done
  return 1
}

count_lines() {
  if [ -z "$1" ]; then
    printf '0\n'
    return 0
  fi
  printf '%s\n' "$1" | wc -l | tr -d '[:space:]'
}

if [ -z "$PROJECT_ID" ]; then
  fail_early config-error \
    "ERROR: PROJECT_ID が未設定です。" \
    "       → 既定値を置くと誤ったプロジェクトの監視構成と比較して緑になり得るため、明示を必須にしています。"
fi

for f in "$GUARDRAILS_TF" "$ROOT_TF"; do
  if [ ! -f "$f" ]; then
    fail_early config-error "ERROR: 宣言ファイルが見つかりません: ${f#"$ROOT"/}"
  fi
done

injected_note=""
if [ -n "$PROD_MONITORING_SNAPSHOT" ]; then
  echo "WARNING: 注入モードで実行中です（本番の実測ではありません）: PROD_MONITORING_SNAPSHOT" >&2
  injected_note="（注入モード）"
fi

# ---------------------------------------------------------------------------
# 1. 宣言（tf）の読み取り
# ---------------------------------------------------------------------------
TMPWORK="$(mktemp -d "${TMPDIR:-/tmp}/monitoring-drift.XXXXXX")"
trap 'rm -rf "$TMPWORK"' EXIT

# terraform fmt が「トップレベルの resource は 0 桁から始まり対応する } も 0 桁」を保証するので、
# 行頭の波括弧の深さで区切れる。深さの計算からは **行全体がコメントの行だけ** を除く
# （コメント中には {"event":"…"} のような対の括弧が実際に書かれている）。
awk -v outdir="$TMPWORK" '
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

# for_each のキー集合を解決する。
#   for_each = toset(["a", "b"])   → リテラル
#   for_each = toset(var.X)        → root 配線の X = ["a", "b"]
# for_each を持たないブロックは何も出さない（呼び出し側が「単一」として扱う）。
resolve_for_each() {
  rfe_rc=0
  rfe_line="$(grep -E '^[[:space:]]*for_each[[:space:]]*=' "$1")" || rfe_rc=$?
  if [ "$rfe_rc" -gt 1 ]; then
    echo "ERROR: for_each の行を評価できません（grep exit=${rfe_rc}）: $1" >&2
    return 2
  fi
  [ -n "$rfe_line" ] || return 0

  rfe_var="$(printf '%s\n' "$rfe_line" | sed -nE 's/.*toset\(var\.([a-z_]+)\).*/\1/p')"
  if [ -n "$rfe_var" ]; then
    rfe_line="$(grep -E "^[[:space:]]*${rfe_var}[[:space:]]*=" "$ROOT_TF")" || rfe_rc=$?
    if [ "$rfe_rc" -gt 1 ] || [ -z "$rfe_line" ]; then
      echo "ERROR: for_each が参照する var.${rfe_var} を ${ROOT_TF#"$ROOT"/} から解決できません。" >&2
      return 2
    fi
  fi
  printf '%s\n' "$rfe_line" | tr ',' '\n' | sed -nE 's/.*"([A-Za-z0-9_-]+)".*/\1/p'
  return 0
}

# 属性 $2 の値（引用符を剥いだもの）を $1 のブロックから取り出す。
read_attr() {
  ra_rc=0
  ra_line="$(grep -E "^[[:space:]]*$2[[:space:]]*=" "$1")" || ra_rc=$?
  if [ "$ra_rc" -gt 1 ]; then
    echo "ERROR: 属性 $2 を評価できません（grep exit=${ra_rc}）: $1" >&2
    return 2
  fi
  [ -n "$ra_line" ] || return 0
  # 先頭 1 行の取り出しに head を使わない（早期終了 consumer は上流へ EPIPE を送り、
  # pipefail の下で入力サイズ依存の失敗になる）。q を持たない sed で範囲指定する。
  printf '%s\n' "$ra_line" | sed -n '1,1p' | sed -E "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*//; s/^\"//; s/\"[[:space:]]*\$//"
  return 0
}

declared=""
declare_from_block() {
  # $1 = ブロックファイル, $2 = kind（policy|metric）, $3 = 名前を持つ属性
  dfb_tmpl="$(read_attr "$1" "$3")" || return 2
  if [ -z "$dfb_tmpl" ]; then
    echo "ERROR: $(basename "$1") に $3 がありません（宣言の抽出パターンの前提が崩れています）。" >&2
    return 2
  fi
  dfb_keys="$(resolve_for_each "$1")" || return 2

  if [ -z "$dfb_keys" ]; then
    case "$dfb_tmpl" in
      *'each.key'*)
        echo "ERROR: $(basename "$1") は each.key を使うのに for_each を解決できません。" >&2
        return 2
        ;;
    esac
    printf '%s\t%s\n' "$2" "$dfb_tmpl"
    return 0
  fi

  for dfb_k in $dfb_keys; do
    case "$dfb_tmpl" in
      'each.key') printf '%s\t%s\n' "$2" "$dfb_k" ;;
      *'${each.key}'*)
        dfb_name="$(printf '%s\n' "$dfb_tmpl" | sed "s/\${each.key}/${dfb_k}/g")"
        printf '%s\t%s\n' "$2" "$dfb_name"
        ;;
      *) printf '%s\t%s\n' "$2" "$dfb_tmpl" ;;
    esac
  done
  return 0
}

block_list="$(ls -1 "$TMPWORK" | sort)" || fail_early decl-unreadable \
  "ERROR: ${GUARDRAILS_TF#"$ROOT"/} から resource ブロックを切り出せませんでした。"
if [ -z "$block_list" ]; then
  fail_early decl-empty \
    "ERROR: ${GUARDRAILS_TF#"$ROOT"/} から resource ブロックを1件も切り出せませんでした。" \
    "       → 宣言 0 件のまま「乖離なし」で緑にするのが最悪の空振りであるため、ここで fail します。"
fi

for bf in $block_list; do
  case "$bf" in
    google_monitoring_alert_policy.*)
      out="$(declare_from_block "${TMPWORK}/${bf}" policy display_name)" \
        || fail_early decl-unreadable "ERROR: alert policy の宣言を読めません: ${bf}"
      declared="${declared}${out}${NL}"
      ;;
    google_logging_metric.*)
      out="$(declare_from_block "${TMPWORK}/${bf}" metric name)" \
        || fail_early decl-unreadable "ERROR: logging metric の宣言を読めません: ${bf}"
      declared="${declared}${out}${NL}"
      ;;
  esac
done

# 無一致（1）と評価不能（2 以上）を分ける。潰すと「抽出パターンが壊れた」が「宣言 0 件」へ化け、
# 原因の異なる 2 つが同じ診断へ落ちる（Issue #120）。
decl_grep_rc=0
declared="$(printf '%s' "$declared" | grep -E '^(policy|metric)	.+$' | sort -u)" || decl_grep_rc=$?
if [ "$decl_grep_rc" -gt 1 ]; then
  fail_early decl-unreadable "ERROR: 宣言の正規化を評価できません（grep exit=${decl_grep_rc}）。"
fi
if [ -z "${declared:-}" ]; then
  fail_early decl-empty \
    "ERROR: 宣言から監視資産を1件も抽出できませんでした。" \
    "       → 宣言 0 件のまま「乖離なし」で緑にするのが最悪の空振りであるため、ここで fail します。"
fi
declared_count="$(count_lines "$declared")"

# ---------------------------------------------------------------------------
# 2. クラウド実測（snapshot）
# ---------------------------------------------------------------------------
collect_live_snapshot() {
  cls_rc=0
  cls_policies="$(gcloud monitoring policies list --project="$PROJECT_ID" --format='value(displayName)' 2>&1)" || cls_rc=$?
  if [ "$cls_rc" -ne 0 ]; then
    echo "ERROR: alert policy を照会できません（gcloud exit=${cls_rc}）。" >&2
    printf '%s\n' "$cls_policies" >&2
    echo "       → CI に roles/monitoring.viewer が付いているか確認してください（infra/modules/cicd-wif）。" >&2
    return 1
  fi

  cls_token="$(gcloud auth print-access-token 2>/dev/null)" || cls_rc=$?
  if [ -z "${cls_token:-}" ]; then
    echo "ERROR: アクセストークンを取得できません。" >&2
    return 1
  fi

  # ログベース指標は Monitoring の metricDescriptors として見える（実測確認済み）。
  # **ここでログ本文へ触れる API は使わない。** 返るのは指標の定義（type / kind / valueType）
  # だけで、値もログエントリも含まない。
  cls_url="https://monitoring.googleapis.com/v3/projects/${PROJECT_ID}/metricDescriptors"
  cls_filter='metric.type%20%3D%20starts_with(%22logging.googleapis.com%2Fuser%2F%22)'
  cls_body="$(curl -sS -f -H "Authorization: Bearer ${cls_token}" "${cls_url}?filter=${cls_filter}")" || cls_rc=$?
  if [ "$cls_rc" -ne 0 ]; then
    echo "ERROR: metricDescriptors を照会できません（curl exit=${cls_rc}）。" >&2
    return 1
  fi

  printf '%s\n' "$cls_policies" | sed -E '/^[[:space:]]*$/d; s/^/policy\t/'
  printf '%s\n' "$cls_body" \
    | sed -nE 's#.*"type"[[:space:]]*:[[:space:]]*"logging\.googleapis\.com/user/([A-Za-z0-9_]+)".*#metric\t\1#p'
  return 0
}

if [ -n "$PROD_MONITORING_SNAPSHOT" ]; then
  if [ ! -f "$PROD_MONITORING_SNAPSHOT" ]; then
    fail_early config-error "ERROR: PROD_MONITORING_SNAPSHOT が見つかりません: ${PROD_MONITORING_SNAPSHOT}"
  fi
  snapshot="$(cat "$PROD_MONITORING_SNAPSHOT")"
else
  if ! snapshot="$(collect_live_snapshot)"; then
    fail_early live-unreadable \
      "ERROR: 本番の監視構成を収集できませんでした（上記参照）。" \
      "       → 収集失敗を「乖離なし」で緑にするのが最悪の空振りであるため、ここで fail します。"
  fi
fi

live_grep_rc=0
live="$(printf '%s\n' "$snapshot" | grep -vE '^[[:space:]]*(#|$)' | sort -u)" || live_grep_rc=$?
if [ "$live_grep_rc" -gt 1 ]; then
  fail_early live-unreadable "ERROR: 本番の実測を正規化できません（grep exit=${live_grep_rc}）。"
fi
if [ -z "${live:-}" ]; then
  fail_early live-empty \
    "ERROR: 本番から監視資産を1行も読めませんでした。" \
    "       → 実測 0 件のまま「乖離なし」で緑にするのが最悪の空振りであるため、ここで fail します。"
fi
live_count="$(count_lines "$live")"

# ---------------------------------------------------------------------------
# 3. 両方向の照合
# ---------------------------------------------------------------------------
fail=0
checked=0
signature=""
used_whitelist=""

# 集合の所属判定。**パイプの下流へ grep -q を置かない。** 最初の一致で抜けると上流の printf が
# EPIPE で 141 になり、pipefail の下では「一致した」が「失敗」として返る。しかもこの退行は
# 入力サイズ依存で、宣言が数件のうちは何度走らせても緑のまま潜る（Issue #117 の実測）。
# 判定は実ファイルに対する grep -c の件数で行い、無一致（1）と評価不能（2 以上）を分ける。
DECLARED_FILE="${TMPWORK}/declared.tsv"
LIVE_FILE="${TMPWORK}/live.tsv"
printf '%s\n' "$declared" > "$DECLARED_FILE"
printf '%s\n' "$live" > "$LIVE_FILE"

has_row() {
  # $1 = 対象ファイル, $2 = kind, $3 = name
  hr_rc=0
  hr_n="$(grep -cxF "$2$(printf '\t')$3" "$1")" || hr_rc=$?
  if [ "$hr_rc" -gt 1 ]; then
    echo "ERROR: 所属判定を評価できません（grep exit=${hr_rc}）: $2 $3" >&2
    return 2
  fi
  if [ "${hr_n:-0}" -gt 0 ]; then
    return 0
  fi
  return 1
}

report_drift() {
  # $1 = kind, $2 = name, $3 = status, $4.. = 診断行
  rd_kind="$1"; rd_name="$2"; rd_status="$3"
  shift 3
  signature="${signature}${rd_kind}:${rd_name}=${rd_status};"
  if in_list "${rd_kind}|${rd_name}|${rd_status}" ${WHITELIST[@]+"${WHITELIST[@]}"}; then
    echo "SKIP: ${rd_kind} ${rd_name}（${rd_status}・WHITELIST・理由はスクリプト内コメント参照）"
    used_whitelist="${used_whitelist}${rd_kind}|${rd_name}|${rd_status}${NL}"
    return 0
  fi
  for rd_line in "$@"; do
    echo "$rd_line" >&2
  done
  fail=1
}

# 宣言 → 本番（apply 忘れ・誤削除）
while IFS="$(printf '\t')" read -r d_kind d_name; do
  [ -n "${d_kind:-}" ] || continue
  checked=$((checked + 1))
  has_row "$LIVE_FILE" "$d_kind" "$d_name" && hr_rc=0 || hr_rc=$?
  if [ "$hr_rc" -eq 2 ]; then
    fail_early live-unreadable "ERROR: 本番側の所属判定が評価不能です: ${d_kind} ${d_name}"
  fi
  if [ "$hr_rc" -eq 0 ]; then
    signature="${signature}${d_kind}:${d_name}=ok;"
    echo "OK: ${d_kind} ${d_name} → 本番に存在"
    continue
  fi
  report_drift "$d_kind" "$d_name" missing-in-prod \
    "ERROR: 宣言されている ${d_kind} \"${d_name}\" が本番にありません。" \
    "       → apply されていないか、本番から削除されています。宣言だけが在る監視は 1 件も鳴りません。" \
    "       → make tf-plan で差分を確認し、意図した削除なら宣言も同じ PR で消してください。"
done <<DROWS
$declared
DROWS

# 本番 → 宣言（**今回の事故**: コードだけが消えた）
while IFS="$(printf '\t')" read -r l_kind l_name; do
  [ -n "${l_kind:-}" ] || continue
  has_row "$DECLARED_FILE" "$l_kind" "$l_name" && hr_rc=0 || hr_rc=$?
  if [ "$hr_rc" -eq 2 ]; then
    fail_early decl-unreadable "ERROR: 宣言側の所属判定が評価不能です: ${l_kind} ${l_name}"
  fi
  if [ "$hr_rc" -eq 0 ]; then
    continue
  fi
  checked=$((checked + 1))
  report_drift "$l_kind" "$l_name" undeclared-in-prod \
    "ERROR: 本番に在る ${l_kind} \"${l_name}\" が宣言にありません。" \
    "       → これは 2026-09-06 に実際に起きた形です（apply 済みなのに .tf が commit されず、" \
    "         state だけが保持していた）。**次の terraform apply がこれを destroy します。**" \
    "       → 手で作ったなら tf へ書き起こして state と突き合わせ、不要なら宣言と本番の両方から消してください。"
done <<LROWS
$live
LROWS

for wl in ${WHITELIST[@]+"${WHITELIST[@]}"}; do
  case "$used_whitelist" in
    *"${NL}${wl}${NL}"*) continue ;;
  esac
  echo "WARNING: ${wl} は WHITELIST に載っていますが乖離として検出されませんでした。WHITELIST から削除してください。" >&2
done

if [ "$checked" -eq 0 ]; then
  fail_early no-assets-checked \
    "ERROR: 1 件も検証できませんでした（宣言または実測の読み取りが壊れています）。" \
    "       → 検証 0 件のまま「乖離なし」で緑にするのが最悪の空振りであるため、ここで fail します。"
fi

echo ""
echo "MONITORING-SIGNATURE: ${signature}"

if [ "$fail" -ne 0 ]; then
  echo "NG: 本番の監視構成が宣言と乖離しています（宣言 ${declared_count} 件 / 本番 ${live_count} 件・上記参照）。${injected_note}" >&2
  exit 1
fi

echo "OK: 本番の監視構成は宣言と一致（宣言 ${declared_count} 件 / 本番 ${live_count} 件 / ${checked} 件検証・WHITELIST ${#WHITELIST[@]} 件）。${injected_note}"
exit 0
