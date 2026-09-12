#!/usr/bin/env bash
# Issue #125 ガードレール（層2・鮮度）: 外部 API の実疎通は人手の out-of-band 作業であり、
# 記録は infra/external-api-smoke.tsv が正典である（層1 = scripts/check-external-api-smoke.sh が
# 構造を検証する）。本スクリプトは **その記録が古びていないか** だけを時間で回して見る。
#
# なぜ時間で回すか: この欠陥（キーが失効している・そもそも一度も叩いていない）はマージと無関係に
# 恒常的に成り立つ。デプロイ契機の検証では、main が動かない期間に run 自体が生成されず、
# 「失敗という兆候すら出ない」（#91 で学んだのと同じ理由）。
#
# なぜ ts-ci へ置かないか: 日付で赤くなる検証を PR ごとの CI へ置くと、**何も触っていない PR が
# ある日突然赤くなる**。そのとき人間が取る最も安い行動は「実疎通せずに日付だけ更新する」ことで、
# 規律そのものが空洞化する。層1（ts-ci）には date を 1 箇所も置かないことでこれを構造的に防ぎ、
# 鮮度は追跡 Issue というブロックしない経路へ流す。
#
# **本スクリプトは外部 API を一切叩かない。** 鍵も読まない。読むのはリポジトリ内の宣言だけである
# （実疎通を CI から行わない理由は infra/README.md §5・§8 を参照）。
#
# 判定（api が '-' 以外の行のみ・'-' は実疎通の対象外）:
#   pending      最終確認日が PENDING = 一度も本番で叩いていない。go-live の完了条件を満たしていない。
#   future-date  最終確認日が基準日より未来 = 叩かずに日付だけ埋めた形。
#   stale        最終確認日が MAX_AGE_DAYS より古い。
#   warn         有効期間内だが残り WARN_WITHIN_DAYS 日以内（期限間近）。**赤にしない**（exit 0）。
#   ok           上記以外。
# 有効期限は「最終確認日 + MAX_AGE_DAYS 日」で、その日の検証までは有効・翌日の検証から stale になる。
#
# 機械可読な出力（通知側との契約。散文は読ませない）:
#   EXTERNAL-API-SMOKE-SIGNATURE: <api>=<判定>;…  追跡 Issue の重複抑止の鍵。判定だけを載せる。
#                                                ワークフローは <api>=warn; の有無で予告を決める。
#   EXTERNAL-API-SMOKE-EXPIRY: YYYY-MM-DD        期限間近の API のうち最も早い有効期限。
#                                                期限間近が 1 件も無ければ出さない。
#
# 環境変数:
#   EXTERNAL_API_SMOKE_NOW  「今日」を YYYY-MM-DD で注入する（既定は JST の今日）。
#                           自己テストと、赤・予告の実証（workflow_dispatch の now 入力）で使う。
#                           注入値も JST として解釈する（記録側が JST であるため）。
#
# 使い方: bash scripts/check-external-api-smoke-freshness.sh
#   期限切れ・未実施があれば該当を stderr に出して exit 1。期限間近は WARN を出して exit 0、
#   いずれも無ければ exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ $# -gt 0 ]; then
  case "$1" in
    -h|--help)
      sed -n '2,39p' "$0"
      exit 0
      ;;
    *)
      echo "ERROR: 未知の引数です: $1" >&2
      echo "       → 使い方は bash scripts/check-external-api-smoke-freshness.sh --help を参照してください。" >&2
      exit 2
      ;;
  esac
fi

# 実疎通の記録が有効とみなされる日数。**単一の定数として置き、env で上書きできるようにしない。**
# 上書き口があると、赤くなったとき最も安い行動が「閾値を伸ばす」になる。閾値の変更はレビューを
# 伴う差分として残すべきである。両側の境界は EXTERNAL_API_SMOKE_NOW を動かせば検証できる。
MAX_AGE_DAYS=14

# 期限間近として予告する窓（日）。残り日数（MAX_AGE_DAYS − 経過日数）がこの値以下なら warn。
# MAX_AGE_DAYS=14 に対して 2 なら、経過 12・13・14 日が予告、15 日から stale（赤）になる。
#
# なぜ要るか: stale は有効期限の **翌朝** に初めて鳴る。実疎通は運用者が自分の資格情報で叩き、
# PR で記録を更新して main へ載せるまでが 1 セットの人手作業であり、赤を見てから始めると
# その間ずっと「期限切れ」が続く。期限の前に知らせれば、赤を一度も出さずに更新できる。
#
# なぜ赤にしないか: 赤は「今まさに記録が無効」だけを意味させる。期限前に赤くすると有効期間が
# 実質的に縮み、赤の意味そのものが薄まる。予告はワークフローが署名の warn を見て追跡 Issue へ
# 流し、ジョブは緑のまま保つ。
#
# MAX_AGE_DAYS と同じ理由で env から上書きできるようにしない（窓の変更はレビューを伴う差分で行う）。
WARN_WITHIN_DAYS=2

DECL_FILE="${ROOT}/infra/external-api-smoke.tsv"
STRUCTURE_GUARD="${SCRIPT_DIR}/check-external-api-smoke.sh"

# 早期異常でも必ず EXTERNAL-API-SMOKE-SIGNATURE を出してから落ちる。**署名は本スクリプトの契約**
# であり、空のまま通知側（report-ci-issue.sh）へ渡すと「状態が変わっていない」判定ができず、
# 赤が続く限り実行のたびに追跡 Issue へコメントが増えてしまう。
# $1 = 署名に使う理由キー、$2 以降 = stderr へ出す行。
fail_early() {
  reason="$1"
  shift
  for line in "$@"; do
    echo "$line" >&2
  done
  echo "EXTERNAL-API-SMOKE-SIGNATURE: early-exit=${reason};"
  exit 1
}

# YYYY-MM-DD を 1970-01-01 起点の通日へ変換する（Howard Hinnant の days_from_civil）。
# **`date -d`（GNU）や `date -j -f`（BSD）へ寄せない。** 両者は非互換であり、どちらかに寄せると
# もう一方の環境で黙って壊れる（開発機は macOS・CI は ubuntu）。整数演算だけなら差が出ない。
# 10# を付けるのは、`08` / `09` を 8 進数と解釈させないため（bash の算術評価は 0 始まりを 8 進と読む）。
days_from_civil() {
  _y=$((10#${1%%-*}))
  _rest="${1#*-}"
  _m=$((10#${_rest%%-*}))
  _d=$((10#${_rest#*-}))

  if [ "$_m" -le 2 ]; then
    _y=$((_y - 1))
  fi
  _era=$(( (_y >= 0 ? _y : _y - 399) / 400 ))
  _yoe=$((_y - _era * 400))
  _mp=$(( (_m + 9) % 12 ))
  _doy=$(( (153 * _mp + 2) / 5 + _d - 1 ))
  _doe=$((_yoe * 365 + _yoe / 4 - _yoe / 100 + _doy))
  printf '%s\n' $((_era * 146097 + _doe - 719468))
}

# 1970-01-01 起点の通日を YYYY-MM-DD へ戻す（Howard Hinnant の civil_from_days・上の逆変換）。
# 有効期限（最終確認日 + MAX_AGE_DAYS）を人間に告げるために使う。上と同じ理由で date には寄せない。
# 誤った日付を告げる予告は予告が無いより悪いため、月末・年末・うるう日は自己テストが固定している。
civil_from_days() {
  _cz=$(($1 + 719468))
  _cera=$(( (_cz >= 0 ? _cz : _cz - 146096) / 146097 ))
  _cdoe=$((_cz - _cera * 146097))
  _cyoe=$(( (_cdoe - _cdoe / 1460 + _cdoe / 36524 - _cdoe / 146096) / 365 ))
  _cy=$((_cyoe + _cera * 400))
  _cdoy=$((_cdoe - (365 * _cyoe + _cyoe / 4 - _cyoe / 100)))
  _cmp=$(( (5 * _cdoy + 2) / 153 ))
  _cd=$((_cdoy - (153 * _cmp + 2) / 5 + 1))
  _cm=$(( _cmp < 10 ? _cmp + 3 : _cmp - 9 ))
  if [ "$_cm" -le 2 ]; then
    _cy=$((_cy + 1))
  fi
  printf '%04d-%02d-%02d\n' "$_cy" "$_cm" "$_cd"
}

if [ ! -f "$DECL_FILE" ]; then
  fail_early missing-declaration \
    "ERROR: 宣言ファイルが見つかりません: infra/external-api-smoke.tsv"
fi
if [ ! -f "$STRUCTURE_GUARD" ]; then
  fail_early missing-structure-guard \
    "ERROR: 層1 ガードが見つかりません: scripts/check-external-api-smoke.sh"
fi

# --- 前提: 層1（構造）が緑であること -----------------------------------------------------------
#
# 構造が壊れたまま鮮度だけを見ると、行が消えている・分類が抜けているといった欠落が
# 「対象外だから緑」へ化ける。上流が赤なら鮮度は判定せず、構造の赤をそのまま報告する。
echo "--- 層1（構造）の検証 ---"
structure_rc=0
bash "$STRUCTURE_GUARD" || structure_rc=$?
if [ "$structure_rc" -ne 0 ]; then
  fail_early structure-broken \
    "ERROR: 宣言の構造が壊れています（check-external-api-smoke.sh が exit=${structure_rc}）。" \
    "       → 先に構造の赤を直してください。壊れた宣言のうえで鮮度だけを緑にすると、" \
    "         行の欠落が「対象外だから緑」へ化けます。"
fi
echo ""

# --- 「今日」の決定 ---------------------------------------------------------------------------
#
# **基準日は必ず JST で取る（TZ を実行環境へ委ねない）。** 記録側の最終確認日は JST と定めて
# あり（infra/external-api-smoke.tsv の列定義・infra/README.md §8-4）、一方 GitHub の runner は
# UTC である。素の `date` を使うと両者が最大 1 日ずれ、本ワークフローの cron は 21:07 UTC ＝
# **JST 翌 06:07** に当たるため、JST 00:00〜06:07 に実疎通して記録を更新した当日、正当な記録が
# 未来日（＝叩かずに日付だけ埋めた捏造）と誤判定される。手順どおり叩いた運用者を追跡 Issue で
# 名指しする形になり、偽の障害通知は通知そのものの信頼を壊す（steering #118 の規律）。
# 逆向きにも 1 日ぶんの甘さが出て、有効期間 14 日が実効 15 日になる。
now="${EXTERNAL_API_SMOKE_NOW:-}"
injected_note=""
if [ -n "$now" ]; then
  injected_note="（EXTERNAL_API_SMOKE_NOW=${now} を注入）"
else
  # tzdata が無い環境では `TZ=Asia/Tokyo` が **黙って UTC へ落ちる**（エラーにならない）。
  # そのとき基準日は実行環境のローカル日付へ戻り、上に書いた分界が音もなく消える。
  # 落ちたことを観測できるのはここだけなので、緑を返す前に解決を確かめる。
  tz_offset="$(TZ=Asia/Tokyo date +%z)"
  if [ "$tz_offset" != '+0900' ]; then
    fail_early tzdata-unavailable \
      "ERROR: TZ=Asia/Tokyo を解決できません（オフセットが '${tz_offset}' で +0900 になりません）。" \
      "       → tzdata が無い環境の可能性があります。" \
      "       → 基準日が実行環境のローカル日付へ落ち、JST で書かれた記録と最大 1 日ずれます。" \
      "         ずれたまま緑を返すより、解決できないことを赤で告げるほうが安全です。"
  fi
  now="$(TZ=Asia/Tokyo date +%Y-%m-%d)"
fi
case "$now" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
  *)
    fail_early bad-now \
      "ERROR: EXTERNAL_API_SMOKE_NOW は YYYY-MM-DD で指定してください（現在: '${now}'）。"
    ;;
esac
now_days="$(days_from_civil "$now")"

# --- 鮮度の判定 --------------------------------------------------------------------------------
echo "--- 層2（鮮度）の検証・基準日 ${now}・有効期間 ${MAX_AGE_DAYS} 日 ${injected_note} ---"

signature=""
checked=0
fail=0
# 期限間近の件数と、そのうち最も早い有効期限（通日と YYYY-MM-DD）。判定フラグと同じく
# **ループ本体（親シェル）で更新する**。`$( )` の中で立てると subshell ごと消える。
warn_count=0
earliest_expiry_days=''
earliest_expiry=''

while IFS= read -r raw || [ -n "$raw" ]; do
  trimmed="${raw#"${raw%%[![:space:]]*}"}"
  case "$trimmed" in
    ''|'#'*) continue ;;
  esac

  d_id=''
  d_api=''
  d_last=''
  d_evid=''
  IFS="$(printf '\t')" read -r d_id d_api d_last d_evid _rest <<TSVROW
$raw
TSVROW

  # 実疎通の対象外。層1 が「api が '-' なら日付も証拠も '-'」を既に強制しているため、
  # ここでは黙って飛ばす（対象外の件数は層1 のサマリに出る）。
  [ "$d_api" = '-' ] && continue

  checked=$((checked + 1))

  if [ "$d_last" = 'PENDING' ]; then
    signature="${signature}${d_api}=pending;"
    echo "ERROR: ${d_api}（${d_id}）は本番で一度も実疎通していません（PENDING）。" >&2
    echo "       → 外部 API に依存する機能は、本番で 1 回叩いて成功を観測するまで go-live 完了ではありません。" >&2
    echo "         手順は infra/README.md §8。実施したら最終確認日と証拠を宣言へ書いてください。" >&2
    fail=1
    continue
  fi

  last_days="$(days_from_civil "$d_last")"
  age=$((now_days - last_days))

  if [ "$age" -lt 0 ]; then
    # 未来日は「叩いていないのに日付だけ埋めた」典型的な形。stale と混ぜず別の判定にする。
    signature="${signature}${d_api}=future-date;"
    echo "ERROR: ${d_api}（${d_id}）の最終確認日 ${d_last} が基準日 ${now} より未来です。" >&2
    echo "       → 実施していない日付が入っています。実際に叩いた日を書いてください。" >&2
    fail=1
    continue
  fi

  if [ "$age" -gt "$MAX_AGE_DAYS" ]; then
    signature="${signature}${d_api}=stale;"
    echo "ERROR: ${d_api}（${d_id}）の実疎通が ${age} 日前（${d_last}）で、有効期間 ${MAX_AGE_DAYS} 日を超えています。" >&2
    echo "       → キーの失効・課金無効・別プロジェクトのキーへの差し替えは、メタデータ検証では" >&2
    echo "         検出できません（#63 の穴そのもの）。infra/README.md §8 の手順で叩き直してください。" >&2
    fail=1
    continue
  fi

  # ここへ来るのは 0 ≤ age ≤ MAX_AGE_DAYS の行だけである。**期限切れの判定より後に置くこと。**
  # 前へ出すと、残り日数が負（期限切れ）でも「残り WARN_WITHIN_DAYS 日以下」を満たして予告に化け、
  # 赤が消える。
  remaining=$((MAX_AGE_DAYS - age))
  if [ "$remaining" -le "$WARN_WITHIN_DAYS" ]; then
    expiry_days=$((last_days + MAX_AGE_DAYS))
    expiry_ymd="$(civil_from_days "$expiry_days")"
    signature="${signature}${d_api}=warn;"
    warn_count=$((warn_count + 1))
    if [ -z "$earliest_expiry_days" ] || [ "$expiry_days" -lt "$earliest_expiry_days" ]; then
      earliest_expiry_days="$expiry_days"
      earliest_expiry="$expiry_ymd"
    fi
    # 残り 0 日を「残り 0 日」と書くと期限切れと読み違えるため、最終日であることを明示する。
    if [ "$remaining" -eq 0 ]; then
      remaining_note='本日が最終日'
    else
      remaining_note="残り ${remaining} 日"
    fi
    echo "WARN: ${d_api}（${d_id}）の実疎通記録が期限間近です — 最終確認 ${d_last}（${age} 日前）・有効期限 ${expiry_ymd}（${remaining_note}）・証拠: ${d_evid}"
    continue
  fi

  signature="${signature}${d_api}=ok;"
  echo "OK: ${d_api}（${d_id}）→ ${d_last}（${age} 日前・証拠: ${d_evid}）"
done < "$DECL_FILE"

if [ "$checked" -eq 0 ]; then
  # 層1 が「実疎通対象 0 件」を既に赤にするため通常は到達しない。到達したなら層1 との前提が
  # ずれている（＝どちらかの読み取りが壊れている）ので、緑を返さず落とす。
  fail_early no-targets-checked \
    "ERROR: 実疎通対象を1件も検証できませんでした（層1 との読み取りがずれています）。" \
    "       → 検証 0 件のまま「鮮度に問題なし」で緑にするのが最悪の空振りであるため、ここで fail します。"
fi

echo ""
# 署名には **判定だけを載せ、経過日数を載せない。** 日数を載せると赤が続く限り毎日署名が変わり、
# 追跡 Issue へ毎日コメントが増える（report-ci-issue.sh の重複抑止が効かなくなる）。
# 予告（warn）も同じで、経過 12 日と 14 日で署名が変わらないため、予告の間はコメントが増えない。
echo "EXTERNAL-API-SMOKE-SIGNATURE: ${signature}"
# 有効期限は日付そのもの（絶対値）なので、署名と違って日が進んでも変わらない。通知側は
# この行から「いつまでに」を取る（WARN 行の散文を解析させない）。
if [ "$warn_count" -gt 0 ]; then
  echo "EXTERNAL-API-SMOKE-EXPIRY: ${earliest_expiry}"
fi

if [ "$fail" -ne 0 ]; then
  echo "NG: 外部 API の実疎通記録に未実施または期限切れがあります（${checked} 件検証・上記参照）。${injected_note}" >&2
  exit 1
fi

if [ "$warn_count" -gt 0 ]; then
  # 期限間近は赤にしない（WARN_WITHIN_DAYS の注記を参照）。exit 0 のまま、ワークフローが
  # 署名の warn を見て追跡 Issue で予告する。
  echo "WARN: ${warn_count} 件が期限間近です（最も早い有効期限 ${earliest_expiry}）。期限を過ぎると翌日の検証から赤になります。"
  echo "      → 期限までに infra/README.md §8 の手順で叩き直し、infra/external-api-smoke.tsv の最終確認日と証拠を更新してください。"
  echo "OK: 外部 API の実疎通記録はすべて有効期間内（${checked} 件検証・有効期間 ${MAX_AGE_DAYS} 日・期限間近 ${warn_count} 件）。${injected_note}"
  exit 0
fi

echo "OK: 外部 API の実疎通記録はすべて有効期間内（${checked} 件検証・有効期間 ${MAX_AGE_DAYS} 日）。${injected_note}"
exit 0
