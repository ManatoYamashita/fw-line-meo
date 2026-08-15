#!/usr/bin/env bash
# Issue #63 ガードレール: 本番 Secret Manager の version 構成が、リポジトリ内の宣言
# infra/secrets-provisioned.tsv と一致していることを定期検証する。
#
# 枠は Terraform が作るが **値（version）は tf が一切作らない**。値は infra/README.md の
# §1 項目 5 で人間が out-of-band 投入する。静的な照合（ts-ci の
# check-secret-declaration-coverage.sh）は「宣言があるか」までしか言えず、「宣言どおりに
# 投入されたか」は本番を見ないと分からない。gemini-api-key は枠作成直後に投入された
# プレースホルダーのまま 2026-07-05 から 08-02 まで稼働し、機能A は go-live 以降一度も
# 成功していなかった。
#
# **値（payload）は読まない。** CI（WIF principalSet）へ付与するのは secret 単位の
# roles/secretmanager.viewer だけで、このロールは secretmanager.versions.access を含まない
# （実測で確認済み）。したがって本スクリプトが観測できるのは version 番号・state・作成時刻
# だけであり、値そのものの正当性（失効キー・別プロジェクトのキー・課金無効なキー）は
# **原理的に検出できない**。外部 API への実疎通は別途行うこと。
#
# 本スクリプトは以下を機械検証する（read-only の照会・副作用なし・bash 3.2 でも走る）:
#   1. 宣言された secret の枠が本番に存在すること
#   2. 宣言 version が本番に存在し、ENABLED であること
#   3. 宣言 version が「DESTROYED でない最大番号」かつ「唯一の ENABLED」であること
#   4. PENDING 宣言（実値未投入）は必ず赤にすること
#   5. 空振り防止: 正典 0 件・snapshot 0 行・検証 0 件はいずれも赤
#   6. WHITELIST の項目が 1 件も当たらなくなったら WARNING を出す
#
# **規則 3 の根拠**: Cloud Run は infra/modules/run-services/main.tf のとおり
# `version = "latest"` でマウントし pin を持たない。`latest` の解決は「最新に作られた version」
# とも「最新の ENABLED」とも読めるため、**どちらの解釈でも同じ結論になる条件**を要求する。
# 宣言 version が DESTROYED でない最大番号であり、かつ唯一の ENABLED である限り、`latest` は
# 必ず宣言 version へ解決する。この設計は解釈に依存しない。
#
# **検出範囲外**: 「正典に無い secret が本番に在る（unmanaged）」は見ない。secret 単位の
# viewer binding では project スコープの列挙操作を認可できず（secretmanager.secrets.list は
# project で評価される）、project 単位の付与は Req 5.4 で禁止されているためである。枠は tf の
# 所有物なので、その方向は `terraform plan` の差分が担当する。
#
# 使い方: bash scripts/check-secret-version-drift.sh
#   乖離があれば該当を stderr に出して exit 1、無ければ exit 0。
#
# 環境変数（既定はすべて本番挙動）:
#   PROJECT_ID            GCP プロジェクト ID。**必須**（既定値を置かない）
#   SECRET_TARGETS_FILE   正典の注入。未設定なら check-secret-declaration-coverage.sh --print-secrets
#   PROD_SECRET_SNAPSHOT  クラウド実測の注入。未設定なら gcloud を 2×N 回叩く（宣言 6 件なら 12 回）
#
# **時刻の注入は持たない。** 判定はすべて version の番号と state だけで決まり、猶予や経過時間の
# 閾値を一切持たないため、決定的テストに時刻の固定が要らない。作成時刻は診断文へ添えるためだけに
# snapshot が運ぶ。
#
# snapshot の形式（TSV 5 列・`#` 始まりと空行は読み飛ばす）:
#   <kind>\t<secret_id>\t<version>\t<state>\t<create_time>
#     kind        : secret（枠の存在。version 列は '-'）| version
#     version     : 10 進数（kind=secret の行は '-'）
#     state       : ENABLED | DISABLED | DESTROYED（kind=secret の行は '-' か MISSING）
#     create_time : RFC3339 または '-'
#   live 収集もこの 5 列を組み立ててから比較へ渡す。live と fixture が完全に同一経路を通る。
#
# gcloud 呼び出し（read-only・値は読まない）:
#   gcloud secrets describe <id> --project=<P> --format='value(name)'
#   gcloud secrets versions list <id> --project=<P> --format='csv[no-heading](name.basename(),state,createTime)'

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ $# -gt 0 ]; then
  case "$1" in
    -h|--help)
      sed -n '2,60p' "$0"
      exit 0
      ;;
    *)
      echo "ERROR: 未知の引数です: $1" >&2
      echo "       → 使い方は bash scripts/check-secret-version-drift.sh --help を参照してください。" >&2
      exit 2
      ;;
  esac
fi

PROJECT_ID="${PROJECT_ID:-}"
SECRET_TARGETS_FILE="${SECRET_TARGETS_FILE:-}"
PROD_SECRET_SNAPSHOT="${PROD_SECRET_SNAPSHOT:-}"

# 意図的に許容する (secret, 判定) の組（必ず理由と Issue を明記すること）。
# 形式: `WHITELIST=('places-api-key|stale-enabled-version')`。**同定に version 番号は使わない**
# （番号はローテのたびに変わり、意図しない別の違反を無言で抑止するため）。
# 想定する正当な例: ローリングローテ中に 2 つの ENABLED version を意図的に併存させる期間。
# 現在は空。
WHITELIST=()

# 早期異常でも必ず SECRET-SIGNATURE を出してから落ちる。**署名は本スクリプトの契約**であり、
# 空のまま通知側（report-ci-issue.sh）へ渡すと「状態が変わっていない」判定ができず、赤が続く限り
# 実行のたびに追跡 Issue へコメントが増えてしまう。
# $1 = 署名に使う理由キー、$2 以降 = stderr へ出す行。
fail_early() {
  reason="$1"
  shift
  for line in "$@"; do
    echo "$line" >&2
  done
  echo "SECRET-SIGNATURE: early-exit=${reason};"
  exit 1
}

in_list() {
  # $1=needle, 残り=list
  needle="$1"
  shift
  for x in "$@"; do
    [ "$x" = "$needle" ] && return 0
  done
  return 1
}

count_re() {
  # 標準入力の行のうち $1（ERE）に一致する件数を出す。
  # `grep -q` は最初の一致で抜けて上流へ SIGPIPE を送り、pipefail により入力サイズ依存の
  # 偽陽性を生む（#78 で実測）。`grep -c` は入力を最後まで読むので起きない。ただし **`|| true`
  # で潰してもいけない**: 評価できない ERE に対する exit 2 まで飲み込み、件数が空文字のまま
  # 後段の算術比較へ渡って偽 PASS になる。無一致（1）と評価不能（2 以上）を分けて扱う。
  cr_rc=0
  cr_n="$(grep -cE "$1")" || cr_rc=$?
  if [ "$cr_rc" -gt 1 ]; then
    echo "ERROR: パターンを評価できません（grep exit=${cr_rc}）: $1" >&2
    return 2
  fi
  printf '%s\n' "${cr_n:-0}"
  return 0
}

if [ -z "$PROJECT_ID" ]; then
  fail_early config-error \
    "ERROR: PROJECT_ID が未設定です。" \
    "       → 既定値を置くと誤ったプロジェクトの secret と比較して緑になり得るため、明示を必須にしています。"
fi

# 注入モードの明示（fixture 実行を本番の緑と誤読させないため）。
injected=""
if [ -n "$PROD_SECRET_SNAPSHOT" ]; then injected="${injected}PROD_SECRET_SNAPSHOT "; fi
if [ -n "$SECRET_TARGETS_FILE" ]; then injected="${injected}SECRET_TARGETS_FILE "; fi
injected_note=""
if [ -n "$injected" ]; then
  echo "WARNING: 注入モードで実行中です（本番の実測ではありません）: ${injected}" >&2
  injected_note="（注入モード）"
fi

# ---------------------------------------------------------------------------
# 1. 正典（宣言）
# ---------------------------------------------------------------------------
canon_source="scripts/check-secret-declaration-coverage.sh --print-secrets"
if [ -n "$SECRET_TARGETS_FILE" ]; then
  if [ ! -f "$SECRET_TARGETS_FILE" ]; then
    fail_early config-error "ERROR: SECRET_TARGETS_FILE が見つかりません: ${SECRET_TARGETS_FILE}"
  fi
  targets="$(cat "$SECRET_TARGETS_FILE")"
  canon_source="$SECRET_TARGETS_FILE"
else
  # --print-secrets は検証を完走させた上で TSV を出す。検証が赤なら 1 行も出さず exit 1 するので、
  # 「壊れた正典で緑」にはならない。宣言ファイルを直接読まないのはこのためである（宣言だけが
  # 正典ではなく、tf・README・消費側配線と整合していてはじめて正典になる）。
  if ! targets="$(bash "${ROOT}/scripts/check-secret-declaration-coverage.sh" --print-secrets)"; then
    fail_early canon-red \
      "ERROR: 正典（check-secret-declaration-coverage.sh）が赤のため、version 検証を打ち切りました。" \
      "       → 先に宣言カバレッジを是正してください（上記のエラー参照）。"
  fi
fi

target_count="$(printf '%s\n' "$targets" | count_re '^[a-z0-9-]+	([0-9]+|PENDING)$')"
if [ "$target_count" -eq 0 ]; then
  fail_early canon-empty \
    "ERROR: 宣言を1件も取得できませんでした（正典の供給が壊れています）。" \
    "       → 対象 0 件のまま「乖離なし」で緑にするのが最悪の空振りであるため、ここで fail します。"
fi

# ---------------------------------------------------------------------------
# 2. クラウド実測（snapshot）
# ---------------------------------------------------------------------------
collect_live_snapshot() {
  # gcloud の失敗を握り潰さない。$(...) に素で入れると失敗が空文字として返り「対象 0 件で緑」に
  # なる = #63 と同型の空振りである。終了コードを必ず見る。
  # 返り値: 0=成功 / 1=収集失敗 / 2=権限不足（または判別不能なエラー）
  local sid dver d_out v_csv line ver state ctime

  while IFS="$(printf '\t')" read -r sid dver; do
    [ -n "${sid:-}" ] || continue
    if ! d_out="$(gcloud secrets describe "$sid" --project="$PROJECT_ID" --format='value(name)' 2>&1)"; then
      case "$d_out" in
        *NOT_FOUND*|*'was not found'*|*'not found'*)
          # 枠が無い。その secret だけを赤にすれば足りるので収集は続ける。
          printf 'secret\t%s\t-\tMISSING\t-\n' "$sid"
          continue
          ;;
        *)
          # PERMISSION_DENIED、および **判別不能なエラーもここへ倒す**（fail-closed）。
          # 権限不足を「枠が無い」と読み替えると、tf apply 前の CI が誤った原因を指し示す。
          echo "ERROR: gcloud secrets describe ${sid} に失敗しました（project=${PROJECT_ID}）。" >&2
          printf '%s\n' "$d_out" | sed 's/^/       | /' >&2
          echo "       → CI（WIF principalSet）には **secret 単位** の roles/secretmanager.viewer が要ります。" >&2
          echo "         infra/modules/cicd-wif の metadata_viewer_secret_ids を配線して make tf-apply したか確認してください。" >&2
          echo "         このロールは secretmanager.versions.access を含まないため、CI は値（payload）を読めません。" >&2
          echo "         project 単位のロール付与は Req 5.4 で禁止されています（secret 単位のみ）。" >&2
          return 2
          ;;
      esac
    fi
    printf 'secret\t%s\t-\t-\t-\n' "$sid"

    if ! v_csv="$(gcloud secrets versions list "$sid" --project="$PROJECT_ID" \
      --format='csv[no-heading](name.basename(),state,createTime)')"; then
      echo "ERROR: gcloud secrets versions list ${sid} に失敗しました。" >&2
      echo "       → describe は成功しているため、権限以外の原因（API 障害・課金）を疑ってください。" >&2
      return 1
    fi
    printf '%s\n' "$v_csv" | while IFS= read -r line; do
      [ -n "$line" ] || continue
      ver="$(printf '%s' "$line" | cut -d, -f1)"
      # state は API の enum だが、gcloud の表示変換に依存しないよう大文字へ正規化する。
      state="$(printf '%s' "$line" | cut -d, -f2 | tr '[:lower:]' '[:upper:]')"
      ctime="$(printf '%s' "$line" | cut -d, -f3)"
      [ -n "$ctime" ] || ctime='-'
      printf 'version\t%s\t%s\t%s\t%s\n' "$sid" "$ver" "$state" "$ctime"
    done
  done <<EOF
$(printf '%s\n' "$targets" | grep -E '^[a-z0-9-]+	([0-9]+|PENDING)$')
EOF
}

if [ -n "$PROD_SECRET_SNAPSHOT" ]; then
  if [ ! -f "$PROD_SECRET_SNAPSHOT" ]; then
    fail_early config-error "ERROR: PROD_SECRET_SNAPSHOT が見つかりません: ${PROD_SECRET_SNAPSHOT}"
  fi
  snapshot="$(grep -vE '^[[:space:]]*(#|$)' "$PROD_SECRET_SNAPSHOT" || true)"
else
  collect_rc=0
  snapshot="$(collect_live_snapshot)" || collect_rc=$?
  if [ "$collect_rc" -eq 2 ]; then
    # collect_live_snapshot 側が原因と是正手順を stderr へ出している。
    fail_early permission-denied
  elif [ "$collect_rc" -ne 0 ]; then
    fail_early collection-failed
  fi
fi

snapshot_rows="$(printf '%s\n' "$snapshot" | count_re '^[^[:space:]]')"
if [ "$snapshot_rows" -eq 0 ]; then
  fail_early snapshot-empty \
    "ERROR: 本番の version 構成を1行も取得できませんでした（snapshot が空です）。" \
    "       → 実測 0 件のまま「乖離なし」で緑にするのが最悪の空振りであるため、ここで fail します。"
fi

# snapshot の形式検査。壊れた行を黙って読み飛ばすと、その secret だけ検証されないまま緑になる。
snapshot_valid="$(printf '%s\n' "$snapshot" | count_re '^secret	[a-z0-9-]+	-	(-|MISSING)	-$|^version	[a-z0-9-]+	[0-9]+	(ENABLED|DISABLED|DESTROYED)	[^	]+$')"
if [ "$snapshot_valid" -ne "$snapshot_rows" ]; then
  bad_line="$(printf '%s\n' "$snapshot" \
    | grep -vE '^secret	[a-z0-9-]+	-	(-|MISSING)	-$|^version	[a-z0-9-]+	[0-9]+	(ENABLED|DISABLED|DESTROYED)	[^	]+$' \
    | sed -n '1,3p' || true)"
  fail_early snapshot-malformed \
    "ERROR: snapshot に形式の合わない行が $((snapshot_rows - snapshot_valid)) 件あります（先頭 3 件）:" \
    "$(printf '%s\n' "$bad_line" | sed 's/^/       | /')" \
    "       → 列は <kind>/<secret_id>/<version>/<state>/<create_time> の 5 列（タブ区切り）です。" \
    "         壊れた行を読み飛ばすと、その secret だけ検証されないまま緑になるため、ここで fail します。"
fi

snapshot_lookup_frame() {
  printf '%s\n' "$snapshot" | grep -E "^secret	$1	" || true
}
snapshot_versions() {
  printf '%s\n' "$snapshot" | grep -E "^version	$1	" || true
}

# ---------------------------------------------------------------------------
# 3. 比較
# ---------------------------------------------------------------------------
echo "シークレット version 検証: 本番 Secret Manager × infra/secrets-provisioned.tsv${injected_note}"
echo "  プロジェクト: ${PROJECT_ID}"
echo "  正典        : ${canon_source}（${target_count} 件）"
echo "  読むのは    : version 番号・state・作成時刻のみ（値は読みません）"
echo ""

fail=0
checked=0
signature=""
used_whitelist=""
NL='
'
used_whitelist="$NL"

while IFS="$(printf '\t')" read -r sid dver; do
  [ -n "${sid:-}" ] || continue
  checked=$((checked + 1))

  frame_row="$(snapshot_lookup_frame "$sid")"
  frame_state="$(printf '%s' "$frame_row" | cut -f4)"

  v_rows="$(snapshot_versions "$sid")"
  ver_count=0
  enabled_count=0
  enabled_other=""
  declared_state=""
  declared_ctime=""
  max_live=-1
  newer_live=""
  while IFS="$(printf '\t')" read -r _vk _vs v_num v_state v_ctime; do
    [ -n "${v_num:-}" ] || continue
    ver_count=$((ver_count + 1))
    if [ "$v_state" != 'DESTROYED' ] && [ "$v_num" -gt "$max_live" ]; then
      max_live="$v_num"
    fi
    if [ "$v_state" = 'ENABLED' ]; then
      enabled_count=$((enabled_count + 1))
    fi
    if [ "$v_num" = "$dver" ]; then
      declared_state="$v_state"
      declared_ctime="$v_ctime"
    else
      if [ "$v_state" = 'ENABLED' ]; then
        enabled_other="${enabled_other}${v_num} "
      fi
      if [ "$v_state" != 'DESTROYED' ] && [ "$dver" != 'PENDING' ] && [ "$v_num" -gt "$dver" ]; then
        newer_live="${newer_live}${v_num} "
      fi
    fi
  done <<VROWS
$v_rows
VROWS

  # 判定は先勝ち。1 secret につき 1 件しか報告しない（原因が 1 つなのに指示を重ねて出さない）。
  status='ok'
  detail=''
  hint=''
  if [ -z "$frame_row" ] || [ "$frame_state" = 'MISSING' ]; then
    status='missing-frame'
    detail="tf の枠が本番にありません。"
    hint="make tf-apply を実行したか確認してください（枠が無ければ値も入りません）。"
  elif [ "$dver" = 'PENDING' ]; then
    status='pending-declaration'
    detail="実値が未投入と宣言されています（PENDING）。"
    hint="infra/README.md の §1 項目 5 で投入し、同じ PR で宣言の version と投入日と参照を更新してください。"
  elif [ "$ver_count" -eq 0 ]; then
    status='no-version'
    detail="version が 1 件もありません（枠だけが存在します）。"
    hint="実値を投入してください。Cloud Run は latest を解決できず起動できません。"
  elif [ "$enabled_count" -eq 0 ]; then
    status='no-enabled-version'
    detail="有効な version がありません（${ver_count} 件すべてが DISABLED か DESTROYED です）。"
    hint="Cloud Run は latest の解決に失敗して起動できません。いずれかを enable するか実値を投入してください。"
  elif [ -z "$declared_state" ]; then
    status='declared-version-missing'
    detail="宣言 version ${dver} が本番にありません（本番の最大 version は ${max_live} です）。"
    hint="投入していないのに宣言した（宣言が先走った）か、投入した version 番号が違います。"
  elif [ "$declared_state" = 'DISABLED' ] || [ "$declared_state" = 'DESTROYED' ]; then
    status="declared-version-$(printf '%s' "$declared_state" | tr '[:upper:]' '[:lower:]')"
    detail="宣言 version ${dver} は ${declared_state} です。"
    hint="実際に読まれる値は宣言と別物です。宣言を実態へ合わせるか、その version を enable してください。"
  elif [ -n "$newer_live" ]; then
    status='newer-version-undeclared'
    detail="宣言 version ${dver} より新しい version（${newer_live%% }）が DESTROYED でない状態で残っています。"
    hint="ローテしたなら宣言を更新し、不要なら disable してください（latest が宣言より新しい方へ解決します）。"
  elif [ -n "$enabled_other" ]; then
    status='stale-enabled-version'
    detail="宣言 version ${dver} のほかに version ${enabled_other%% } が ENABLED のまま残っています。"
    hint="gcloud secrets versions disable ${enabled_other%% } --secret=${sid} --project=${PROJECT_ID}"
  fi

  signature="${signature}${sid}=${status}@${dver};"

  if [ "$status" = 'ok' ]; then
    echo "OK: ${sid} → 宣言 version ${dver}（ENABLED・${declared_ctime}）・ENABLED は宣言 version のみ"
    continue
  fi

  # ${arr[@]+...} は空配列でも set -u（bash 3.2 含む）で unbound エラーにしない安全な展開。
  if in_list "${sid}|${status}" ${WHITELIST[@]+"${WHITELIST[@]}"}; then
    echo "SKIP: ${sid}（${status}・WHITELIST・理由はスクリプト内コメント参照）"
    used_whitelist="${used_whitelist}${sid}|${status}${NL}"
    continue
  fi

  echo "ERROR: ${sid} の version 構成が ${status} です。" >&2
  echo "       → ${detail}" >&2
  echo "         ${hint}" >&2
  fail=1
done <<TROWS
$(printf '%s\n' "$targets" | grep -E '^[a-z0-9-]+	([0-9]+|PENDING)$')
TROWS

# 当たらなくなった除外を残さない（check-deploy-image-coverage.sh / check-workflow-step-names.sh と
# 同形）。是正済みの組を除外したままにすると、次に同じ乖離が起きたとき無言で見逃す。
for wl in ${WHITELIST[@]+"${WHITELIST[@]}"}; do
  case "$used_whitelist" in
    *"${NL}${wl}${NL}"*) continue ;;
  esac
  echo "WARNING: ${wl} は WHITELIST に載っていますが乖離として検出されませんでした。WHITELIST から削除してください。" >&2
done

if [ "$checked" -eq 0 ]; then
  fail_early no-secrets-checked \
    "ERROR: 1 件も検証できませんでした（正典の読み取りが壊れています）。" \
    "       → 検証 0 件のまま「乖離なし」で緑にするのが最悪の空振りであるため、ここで fail します。"
fi

echo ""
echo "SECRET-SIGNATURE: ${signature}"

if [ "$fail" -ne 0 ]; then
  echo "NG: 本番シークレットの version 構成が宣言と乖離しています（${checked} 件検証・上記参照）。${injected_note}" >&2
  exit 1
fi

echo "OK: 本番シークレットの version 構成は宣言と一致（${checked} 件検証・WHITELIST ${#WHITELIST[@]} 件）。${injected_note}"
exit 0
