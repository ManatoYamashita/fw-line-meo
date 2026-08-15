#!/usr/bin/env bash
# Issue #63 ガードレール: Secret Manager の「枠」は Terraform が作るが、**値（version）は tf が
# 一切作らない**（`google_secret_manager_secret_version` はこのリポジトリの git 史上ゼロ件）。
# 値は infra/README.md の §1 項目 5 の `gcloud secrets versions add` で人間が out-of-band 投入する。
# そのため「枠はある・tf は成功・デプロイも成功・CI 全緑、しかし値が入っていない」という無音障害が
# 構造的に起き得る。実際 gemini-api-key は 2026-07-05 の枠作成直後に投入されたプレースホルダーの
# まま 2026-08-02 まで稼働し、機能A（口コミ下書き生成）は go-live 以降一度も成功していなかった
# （400 API key not valid）。Issue #33 のイメージ placeholder と同型の障害である。
#
# 「実値が投入済みである」ことの正典は **リポジトリ内の宣言ファイル** infra/secrets-provisioned.tsv
# とする（GCP の annotation ではない）。理由は、tf へ新しい枠を足した PR の時点で「宣言に無い」を
# ts-ci が即座に赤にできること — つまり **投入漏れを本番へ出す前に捕まえられる**ことである。
#
# 本スクリプトは以下を機械検証する（read-only の grep 検証・副作用なし・bash 3.2 でも走る）:
#   1. infra/modules/secrets/main.tf の locals.secret_ids（複数行リスト）を範囲抽出して正典を得る
#   2. 正典 ↔ 宣言ファイルを **両方向** 照合する（正典にあるのに宣言に無い／宣言にあるのに正典に無い）
#   3. 正典 ↔ README の投入手順（`gcloud secrets versions add <id>`）を **両方向** 照合する
#   4. 宣言ファイルの形式（4 列・version は 10 進数か PENDING・投入日・参照・secret_id の重複なし）
#   5. 消費側 infra/envs/prod/main.tf の module.secrets.secret_ids["<id>"] 参照が正典に在ること
#   6. 空振り防止: 正典 0 件・複数行リスト定義の消失・宣言 0 行・README 抽出 0 件・消費側参照 0 件は
#      いずれも赤（対象 0 件のまま「乖離なし」で緑にするのが最悪の空振りであるため）
#   7. WHITELIST の項目が 1 件も当たらなくなったら WARNING を出す
#
# **「全 secret が消費されている」は検証しない。** accessor だけを持つ枠や、ランタイムからは触らず
# 運用者だけが使う枠が正当に存在し得るため、その方向の照合は誤検出になる。代わりに消費側 → 正典の
# 一方向だけを見て、抽出が 0 件になったら赤にする（規則が空振りしたまま緑を返さない）。
#
# **値の正当性は本スクリプトの範囲外である。** 宣言と配線の整合しか見ない。実値が失効キーや別
# プロジェクトのキーである可能性は、本番のメタデータを見る scripts/check-secret-version-drift.sh
# でも塞げない（CI は payload を読めない）。外部 API への実疎通は別途行うこと。
#
# **前提の固定**: locals.secret_ids は複数行リスト定義（`secret_ids = [` で始まり `]` で閉じる）を
# 維持すること。1 行定義へ変えると範囲抽出が成立しないため、その旨を告げて赤にする
# （scripts/push-images.sh の IMAGE_NAMES が 1 行定義を要求するのと同型の前提固定）。
#
# 使い方:
#   bash scripts/check-secret-declaration-coverage.sh
#     漏れがあれば該当を stderr に出して exit 1、無ければ exit 0。
#   bash scripts/check-secret-declaration-coverage.sh --print-secrets
#     上記の検証を完走させた上で、宣言を `<secret_id>\t<version>` の TSV で stdout へ出す
#     （version は 10 進数か PENDING）。検証が赤なら stdout へ 1 行も出さず exit 1 する。壊れた
#     正典から導出した集合で下流（version ドリフト検証）を緑にするのが最悪の空振りであるため、
#     print だけの近道は用意しない（check-deploy-image-coverage.sh --print-targets と同一の契約）。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

print_secrets=0
while [ $# -gt 0 ]; do
  case "$1" in
    --print-secrets)
      print_secrets=1
      shift
      ;;
    -h|--help)
      sed -n '2,44p' "$0"
      exit 0
      ;;
    *)
      echo "ERROR: 未知の引数です: $1" >&2
      echo "       → 使い方は bash scripts/check-secret-declaration-coverage.sh --help を参照してください。" >&2
      exit 2
      ;;
  esac
done

# 人間向けの進捗出力（OK / SKIP）の出し先。--print-secrets 時は stdout を TSV 専用にするため
# stderr へ退避する。ERROR / WARNING は従来どおり常に stderr。引数なし実行の出力は不変。
if [ "$print_secrets" -eq 1 ]; then
  exec 3>&2
else
  exec 3>&1
fi

TF_FILE="${ROOT}/infra/modules/secrets/main.tf"
DECL_FILE="${ROOT}/infra/secrets-provisioned.tsv"
README_FILE="${ROOT}/infra/README.md"
CONSUMER_TF="${ROOT}/infra/envs/prod/main.tf"

# 意図的に **README の投入手順を持たないことを許す** secret（必ず理由と Issue を明記すること）。
# 除外されるのは README との両方向照合（検証3）だけで、宣言ファイルとの照合（検証2）は除外しない
# （宣言は本ガードの目的そのものであり、例外を認めない）。
# 想定する正当な例: 値を別の自動処理が書き込むため `gcloud secrets versions add` の手順を持たない枠。
# 現在は空。追加時は `WHITELIST=(name1 name2)` 形式。
WHITELIST=()

for f in "$TF_FILE" "$DECL_FILE" "$README_FILE" "$CONSUMER_TF"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: 検証対象ファイルが見つかりません: ${f#$ROOT/}" >&2
    exit 1
  fi
done

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

fail=0

# --- 検証1: 正典の抽出（複数行 locals.secret_ids の範囲抽出） -------------------------------
#
# `secret_ids = [` 〜 `]` の範囲を先に確定してから、行頭の引用符で id を取る。範囲を先に切らないと
# module 引数など範囲外の引用符まで拾ってしまう。
# **末尾の `|| true` は必須である（Issue #90）。** sed/grep は無一致で exit 1 を返し、`pipefail` と
# `set -e` の組み合わせで、直下の空振り検出へ到達する前にスクリプトが死ぬ。**出力ゼロのまま exit 1**
# は fail-closed ではあるが、原因を一切告げない赤は誤診断より始末が悪い。空判定は必ず下の分岐で行う。
tf_block="$(sed -n '/^[[:space:]]*secret_ids[[:space:]]*=[[:space:]]*\[[[:space:]]*$/,/^[[:space:]]*\][[:space:]]*$/p' "$TF_FILE" || true)"

if [ -z "$tf_block" ]; then
  echo "ERROR: ${TF_FILE#$ROOT/} に 'secret_ids = [' で始まる複数行リスト定義が見つかりません。" >&2
  echo "       → 1 行定義（secret_ids = [\"a\", \"b\"]）へ変えると範囲抽出が成立しません。" >&2
  echo "         複数行リスト定義を維持してください（terraform fmt の既定形です）。" >&2
  exit 1
fi

# 閉じ括弧まで到達しているか。到達していないと sed は EOF まで出力し、範囲外の引用符を拾う。
tf_block_last="$(printf '%s\n' "$tf_block" | tail -n 1)"
case "$tf_block_last" in
  *']'*) ;;
  *)
    echo "ERROR: ${TF_FILE#$ROOT/} の secret_ids リストが ']' で閉じていません（範囲抽出が EOF まで走っています）。" >&2
    echo "       → リストの閉じ括弧を行頭（インデントのみ）に置いてください。" >&2
    exit 1
    ;;
esac

# 行頭が引用符の行だけを id とみなす（`secret_ids = [` の行や `]` の行、行末コメントは当たらない）。
tf_secrets="$(printf '%s\n' "$tf_block" \
  | grep -oE '^[[:space:]]*"[a-z0-9-]+"' \
  | sed -E 's/^[[:space:]]*"([a-z0-9-]+)"$/\1/' | sort -u || true)"

if [ -z "$tf_secrets" ]; then
  echo "ERROR: ${TF_FILE#$ROOT/} の secret_ids から secret を1件も抽出できませんでした（抽出パターンの前提が崩れています）。" >&2
  echo "       → 対象 0 件のまま「乖離なし」で緑にするのが最悪の空振りであるため、ここで fail します。" >&2
  exit 1
fi
tf_count="$(count_lines "$tf_secrets")"

# --- 検証4: 宣言ファイルの読み込みと形式検査 -------------------------------------------------
decl_rows="$(grep -vE '^[[:space:]]*(#|$)' "$DECL_FILE" || true)"
if [ -z "$decl_rows" ]; then
  echo "ERROR: ${DECL_FILE#$ROOT/} からデータ行を1行も読めませんでした（コメントと空行しかありません）。" >&2
  echo "       → 宣言 0 行のまま「乖離なし」で緑にするのが最悪の空振りであるため、ここで fail します。" >&2
  exit 1
fi

decl_ids=""
decl_pairs=""
decl_count=0
pending_count=0
lineno=0
while IFS= read -r raw || [ -n "$raw" ]; do
  lineno=$((lineno + 1))
  trimmed="${raw#"${raw%%[![:space:]]*}"}"
  case "$trimmed" in
    ''|'#'*) continue ;;
  esac
  decl_count=$((decl_count + 1))

  d_id=''
  d_ver=''
  d_date=''
  d_ref=''
  d_extra=''
  IFS="$(printf '\t')" read -r d_id d_ver d_date d_ref d_extra <<TSVROW
$raw
TSVROW

  row_ok=1
  if [ -n "$d_extra" ]; then
    echo "ERROR: ${DECL_FILE#$ROOT/}:${lineno} の列が 4 列を超えています（列区切りはタブ 1 個です）。" >&2
    fail=1
    row_ok=0
  fi
  if [ -z "$d_id" ] || [ -z "$d_ver" ] || [ -z "$d_date" ] || [ -z "$d_ref" ]; then
    echo "ERROR: ${DECL_FILE#$ROOT/}:${lineno} は 4 列（secret_id / version / 投入日 / Issue-PR）が揃っていません。" >&2
    fail=1
    row_ok=0
  fi

  id_ok=1
  case "$d_id" in
    ''|*[!a-z0-9-]*)
      echo "ERROR: ${DECL_FILE#$ROOT/}:${lineno} の secret_id '${d_id}' が [a-z0-9-]+ の形ではありません。" >&2
      fail=1
      row_ok=0
      id_ok=0
      ;;
  esac

  ver_kind=''
  case "$d_ver" in
    PENDING) ver_kind='pending' ;;
    ''|*[!0-9]*)
      echo "ERROR: ${DECL_FILE#$ROOT/}:${lineno} の version 列は 10 進数か PENDING でなければなりません（現在: '${d_ver}'）。" >&2
      echo "       → 枠を作っただけで実値が未投入なら PENDING（投入日は '-'）を使ってください。" >&2
      fail=1
      row_ok=0
      ;;
    *) ver_kind='number' ;;
  esac

  if [ "$ver_kind" = 'pending' ]; then
    pending_count=$((pending_count + 1))
    if [ "$d_date" != '-' ]; then
      echo "ERROR: ${DECL_FILE#$ROOT/}:${lineno} は PENDING なので投入日は '-' にしてください（現在: '${d_date}'）。" >&2
      fail=1
      row_ok=0
    fi
  elif [ "$ver_kind" = 'number' ]; then
    case "$d_date" in
      [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
      *)
        echo "ERROR: ${DECL_FILE#$ROOT/}:${lineno} の投入日は YYYY-MM-DD で書いてください（現在: '${d_date}'）。" >&2
        fail=1
        row_ok=0
        ;;
    esac
  fi

  if [ "$id_ok" -eq 1 ]; then
    # shellcheck disable=SC2086 # decl_ids は改行区切りで意図的に単語分割する
    if in_list "$d_id" $decl_ids; then
      echo "ERROR: ${DECL_FILE#$ROOT/}:${lineno} の secret_id '${d_id}' が宣言ファイルに重複しています（どちらが正か決まりません）。" >&2
      fail=1
      row_ok=0
    else
      decl_ids="${decl_ids}${d_id}"$'\n'
    fi
  fi

  if [ "$row_ok" -eq 1 ]; then
    decl_pairs="${decl_pairs}${d_id}	${d_ver}"$'\n'
  fi
done < "$DECL_FILE"

# --- 検証2: 正典 ↔ 宣言（両方向） ------------------------------------------------------------
# shellcheck disable=SC2086 # tf_secrets は改行区切りで意図的に単語分割する
for s in $tf_secrets; do
  # shellcheck disable=SC2086 # decl_ids は改行区切りで意図的に単語分割する
  if ! in_list "$s" $decl_ids; then
    echo "ERROR: ${TF_FILE#$ROOT/} の secret '${s}' が ${DECL_FILE#$ROOT/} にありません。" >&2
    echo "       → 実値を投入済みなら version と投入日を書いた行を、まだ投入していない枠なら" >&2
    echo "         '${s}' / PENDING / '-' / '#<Issue>' の行を足してください（PENDING は version 検証が赤にします）。" >&2
    fail=1
  fi
done

# 宣言 → 正典。ここで報告した id は README 側で二重に報告しない（枠を消したという 1 つの原因で
# 2 行出さない）。行番号ではなく id で同定する。
orphan_decl=""
# shellcheck disable=SC2086 # decl_ids は改行区切りで意図的に単語分割する
for s in $decl_ids; do
  # shellcheck disable=SC2086 # tf_secrets は改行区切りで意図的に単語分割する
  if ! in_list "$s" $tf_secrets; then
    echo "ERROR: ${DECL_FILE#$ROOT/} の '${s}' が正典（${TF_FILE#$ROOT/} の secret_ids）にありません。" >&2
    echo "       → tf から枠を消したなら宣言の行も消してください（残すと version 検証が存在しない secret を照会し続けます）。" >&2
    orphan_decl="${orphan_decl}${s}"$'\n'
    fail=1
  fi
done

# --- 検証3: 正典 ↔ README の投入手順（両方向） -----------------------------------------------
#
# 抽出をコマンド行に限定する。README には `gcloud sql users set-password` の説明で
# db-admin-password に言及する箇所があり、素朴な出現数カウントは二重計上する。
readme_secrets="$(grep -oE 'gcloud secrets versions add[[:space:]]+[a-z0-9-]+' "$README_FILE" \
  | sed -E 's/.*[[:space:]]//' | sort -u || true)"

if [ -z "$readme_secrets" ]; then
  echo "ERROR: ${README_FILE#$ROOT/} から 'gcloud secrets versions add <id>' を1件も抽出できませんでした。" >&2
  echo "       → §1 項目 5（Secret Manager の値投入）の書式が変わっています。抽出 0 件のまま" >&2
  echo "         「乖離なし」で緑にするのが最悪の空振りであるため、ここで fail します。" >&2
  exit 1
fi
readme_count="$(count_lines "$readme_secrets")"

# shellcheck disable=SC2086 # tf_secrets は改行区切りで意図的に単語分割する
for s in $tf_secrets; do
  # ${arr[@]+...} は空配列でも set -u（bash 3.2 含む）で unbound エラーにしない安全な展開。
  if in_list "$s" ${WHITELIST[@]+"${WHITELIST[@]}"}; then
    # ホワイトリスト項目が実は手順を持っているなら、無意味な除外を残さないよう警告する。
    # shellcheck disable=SC2086 # readme_secrets は改行区切りで意図的に単語分割する
    if in_list "$s" $readme_secrets; then
      echo "WARNING: ${s} は WHITELIST に載っていますが README に投入手順があります。WHITELIST から削除してください。" >&2
    else
      echo "SKIP: ${s}（WHITELIST・理由はスクリプト内コメント参照）" >&3
    fi
    continue
  fi
  # shellcheck disable=SC2086 # readme_secrets は改行区切りで意図的に単語分割する
  if ! in_list "$s" $readme_secrets; then
    echo "ERROR: ${README_FILE#$ROOT/} の投入手順に '${s}' がありません（§1 項目 5）。" >&2
    echo "       → 手順書に無い枠は誰も値を入れず、tf 成功・CI 全緑のまま本番で死にます（Issue #63 と同型）。" >&2
    echo "         printf %s \"<VALUE>\" | gcloud secrets versions add ${s} --data-file=- --project=gen-fw-line-meo" >&2
    fail=1
  fi
done

# shellcheck disable=SC2086 # readme_secrets は改行区切りで意図的に単語分割する
for s in $readme_secrets; do
  # shellcheck disable=SC2086 # tf_secrets は改行区切りで意図的に単語分割する
  in_list "$s" $tf_secrets && continue
  # shellcheck disable=SC2086 # orphan_decl は改行区切りで意図的に単語分割する
  in_list "$s" $orphan_decl && continue
  echo "ERROR: ${README_FILE#$ROOT/} の投入手順にある '${s}' が正典にありません。" >&2
  echo "       → 存在しない secret へ値を投入させる手順が残っています。手順から削除してください。" >&2
  fail=1
done

# --- 検証5: 消費側配線 → 正典（一方向） ------------------------------------------------------
consumer_refs="$(grep -oE 'module\.secrets\.secret_ids\["[a-z0-9-]+"\]' "$CONSUMER_TF" \
  | sed -E 's/.*\["([a-z0-9-]+)"\].*/\1/' || true)"
consumer_count="$(count_lines "$consumer_refs")"

if [ "$consumer_count" -eq 0 ]; then
  echo "ERROR: ${CONSUMER_TF#$ROOT/} から module.secrets.secret_ids[\"…\"] の参照を1件も抽出できませんでした。" >&2
  echo "       → 配線の書き方が変わり、この照合が空振りしています。ts-ci は terraform を走らせないため、" >&2
  echo "         参照キーの誤りは人間が apply するまで発覚しません。抽出パターンを更新してください。" >&2
  exit 1
fi

consumer_uniq="$(printf '%s\n' "$consumer_refs" | sort -u)"
# shellcheck disable=SC2086 # consumer_uniq は改行区切りで意図的に単語分割する
for s in $consumer_uniq; do
  # shellcheck disable=SC2086 # tf_secrets は改行区切りで意図的に単語分割する
  if ! in_list "$s" $tf_secrets; then
    echo "ERROR: ${CONSUMER_TF#$ROOT/} が参照する '${s}' が正典（secret_ids）にありません。" >&2
    echo "       → terraform plan は落ちますが、ts-ci は terraform を走らせないため人間の apply まで発覚しません。" >&2
    fail=1
  fi
done

# --- WHITELIST の回収 ------------------------------------------------------------------------
# 当たらなくなった除外を残さない（check-deploy-image-coverage.sh / check-guard-selftest-coverage.sh
# と同形）。是正済みの secret を除外したままにすると、次に同じ穴が開いたとき無言で見逃す。
for wl in ${WHITELIST[@]+"${WHITELIST[@]}"}; do
  # shellcheck disable=SC2086 # tf_secrets は改行区切りで意図的に単語分割する
  if in_list "$wl" $tf_secrets; then
    continue
  fi
  echo "WARNING: ${wl} は WHITELIST に載っていますが正典に存在しません。WHITELIST から削除してください。" >&2
done

if [ "$fail" -ne 0 ]; then
  echo "NG: シークレットの宣言カバレッジに漏れがあります（上記参照）。" >&2
  exit 1
fi

echo "OK: シークレット宣言カバレッジ緑（正典 ${tf_count} 件 / 宣言 ${decl_count} 行（実値 $((decl_count - pending_count))・PENDING ${pending_count}）/ README 手順 ${readme_count} 件 / 消費側参照 ${consumer_count} 件照合・WHITELIST ${#WHITELIST[@]} 件）。" >&3

if [ "$print_secrets" -eq 1 ]; then
  printf '%s' "$decl_pairs" | sort
fi
exit 0
