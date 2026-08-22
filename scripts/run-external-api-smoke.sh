#!/usr/bin/env bash
# Issue #125: 外部 API への実疎通を本番に対して 1 回だけ実行する（運用者用）。
#
# **このスクリプトは CI から呼ばない。** 実疎通には値そのものが要るが、CI の責務はイメージ更新で
# あり外部 API 呼出ではない。CI へ roles/secretmanager.secretAccessor を付けることは Req 5.4
# （各実行環境は自身の責務に必要なシークレットのみ読み取り可能）に反する。走らせるのは運用者で
# あり、使うのは運用者自身の gcloud 資格情報である（infra/README.md §5・§8）。
#
# なぜ必要か: infra/secrets-provisioned.tsv の二層検証は「宣言どおりの version が入っている」
# までしか言えない。プレースホルダー文字列・失効キー・別プロジェクトのキー・課金無効はいずれも
# メタデータからは見えず、実際に叩くまで分からない（2026-07-05〜08-02 の gemini-api-key）。
#
# **出力は allowlist である。** 出すのは PASS/FAIL・HTTP ステータス・API が返した `status`
# フィールド（`[A-Z_]` のみ受理）だけで、応答本文も鍵も一切出さない。エラー本文にはリクエスト
# URL がそのまま含まれることがあり、素朴に出すと鍵がターミナル履歴や貼り付け先へ漏れる。
# 同じ理由で `set -x` を使わない（有効にすると鍵を含むコマンド行が stderr へ出る）。
#
# 鍵をプロセス引数に置かない: curl のヘッダと POST 本文は 600 の一時ファイル経由で渡す
# （コマンドラインに置くと同一ホストの他ユーザーが `ps` で読める）。
#
# 無害性（infra/README.md §8 と同一の契約）:
#   gemini         出力 1 トークン上限の generateContent 1 回。外部に何も残らない。
#   places         フィールドマスク `id` のみの Place Details 1 回（read-only・最安 SKU）。
#   line-messaging トークン発行 → GET /v2/bot/info。**メッセージを一切送信しない。**
#                  push / multicast / broadcast は実疎通に使ってはならない（実送信は受信者への
#                  迷惑であり、無料メッセージ通数枠を消費する）。
#   gbp            意図的に無効な refresh token で token endpoint を 1 回叩くだけ。ユーザー認可を
#                  要さず、トークンも発行されず、GBP 側に何も残らない。
#
# 使い方:
#   bash scripts/run-external-api-smoke.sh \
#     --place-id <本番 stores.place_id> \
#     --model <本番の GEMINI_MODEL> \
#     --channel-id <本番の LINE_CHANNEL_ID> \
#     --gbp-client-id <本番の GBP_OAUTH_CLIENT_ID> \
#     [--project gen-fw-line-meo] [--api <api>]...
#
#   `--api` の語彙をこのスクリプトへ列挙しない。正典は infra/external-api-smoke.tsv の api 列で
#   あり、そこから導出する。ハードコードすると TSV へ api を足しても既定の一括実行が追従せず、
#   **照合するガードが無いまま静かに乖離する**（PR #121 レビュー指摘）。
#
#   --model / --channel-id に既定値を持たせないのは意図的である。アプリ側コードの既定値を
#   写経すると、本番が別モデル・別チャネルへ移った瞬間に「動くはずのない構成が緑」になる。
#   本番稼働中の値の調べ方は infra/README.md §8-0 を参照。
#
#   全て成功したら、末尾に出る行で infra/external-api-smoke.tsv を更新すること。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

project='gen-fw-line-meo'
place_id=''
model=''
channel_id=''
gbp_client_id=''
selected=''

# 実疎通対象の語彙は infra/external-api-smoke.tsv の api 列（'-' 以外）が正典。列挙を二重管理しない。
DECL_FILE="${ROOT}/infra/external-api-smoke.tsv"
if [ ! -f "$DECL_FILE" ]; then
  echo "ERROR: ${DECL_FILE#"$ROOT"/} が見つかりません（実疎通対象の正典）。" >&2
  exit 1
fi
known_apis="$(grep -vE '^[[:space:]]*(#|$)' "$DECL_FILE" | cut -f2 | grep -v '^-$' | sort -u | tr '\n' ' ')"
if [ -z "${known_apis// /}" ]; then
  echo "ERROR: ${DECL_FILE#"$ROOT"/} に実疎通対象（api が '-' 以外）の行が 1 件もありません。" >&2
  echo "       → 対象 0 件のまま成功と報告するのが最悪の空振りであるため、ここで落とします。" >&2
  exit 1
fi

# 値を伴うオプションで値が無いまま `shift 2` すると、`set -e` の下で **何も出さずに rc=1 で
# 終了する**（`--model` を末尾に置いた実行が無言で死ぬ）。無言の失敗は、実行し忘れたのか
# 失敗したのかを運用者が区別できず、このスクリプトが守ろうとしている記録の信頼を直接壊す。
need_value() {
  # $1 = オプション名、$2 = 残りの引数個数
  if [ "$2" -lt 2 ]; then
    echo "ERROR: ${1} には値が必要です。" >&2
    echo "       → 使い方は bash scripts/run-external-api-smoke.sh --help を参照してください。" >&2
    exit 2
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project) need_value "$1" "$#"; project="$2"; shift 2 ;;
    --place-id) need_value "$1" "$#"; place_id="$2"; shift 2 ;;
    --model) need_value "$1" "$#"; model="$2"; shift 2 ;;
    --channel-id) need_value "$1" "$#"; channel_id="$2"; shift 2 ;;
    --gbp-client-id) need_value "$1" "$#"; gbp_client_id="$2"; shift 2 ;;
    --api) need_value "$1" "$#"; selected="${selected}${2} "; shift 2 ;;
    -h|--help) sed -n '2,39p' "$0"; exit 0 ;;
    *)
      echo "ERROR: 未知の引数です: $1" >&2
      echo "       → 使い方は bash scripts/run-external-api-smoke.sh --help を参照してください。" >&2
      exit 2
      ;;
  esac
done

if [ -z "$selected" ]; then
  selected="$known_apis"
fi

selected_count=0
# shellcheck disable=SC2086 # selected は空白区切りで意図的に単語分割する
for a in $selected; do
  case " ${known_apis}" in
    *" ${a} "*) ;;
    *)
      echo "ERROR: --api は infra/external-api-smoke.tsv が宣言する ${known_apis% } のいずれかです（現在: '${a}'）。" >&2
      exit 2
      ;;
  esac
  selected_count=$((selected_count + 1))
done

# **対象 0 件のまま先へ進まない。** `--api ''` は selected を空白 1 文字にするため
# 「空だから既定の 3 件」へも落ちず、上の語彙チェックも 1 度も回らず、wants が全て偽になって
# **1 件も叩かずに末尾の「すべて成功しました」へ到達する**（実測）。0 件実行を成功と数えるのは、
# このスクリプトが塞ごうとしている無音障害そのものを実疎通の器の側で再生産する形である。
if [ "$selected_count" -eq 0 ]; then
  echo "ERROR: 実疎通の対象が 1 件もありません（--api に空の値が渡っています）。" >&2
  echo "       → 対象 0 件のまま「すべて成功しました」と報告するのが最悪の空振りであるため、ここで落とします。" >&2
  echo "       → 全 API を叩くなら --api を付けずに実行してください。" >&2
  exit 2
fi

wants() {
  case " ${selected}" in
    *" $1 "*) return 0 ;;
  esac
  return 1
}

require_arg() {
  # $1=値 $2=引数名 $3=補足
  if [ -z "$1" ]; then
    echo "ERROR: ${2} は必須です。" >&2
    echo "       → ${3}" >&2
    exit 2
  fi
}

# `wants X && require_arg …` の形にしないこと。`set -e` の下では、対象外で wants が 1 を返した
# 瞬間にリスト全体の終了ステータスが 1 になり、**スクリプトが無言で終了する**（--api places だけを
# 指定した実行が、何も出さずに rc=1 で死ぬ）。
if wants gemini; then
  require_arg "$model" '--model' '本番 survey-web の env GEMINI_MODEL と同じ値を渡してください（infra/README.md §8-0）。'
fi
if wants places; then
  require_arg "$place_id" '--place-id' '本番 stores.place_id の実値を渡してください（infra/README.md §3 の Auth Proxy 経由 psql で取得）。'
fi
if wants line-messaging; then
  require_arg "$channel_id" '--channel-id' '本番 line-webhook の env LINE_CHANNEL_ID と同じ値を渡してください（infra/README.md §8-0）。'
fi
if wants gbp; then
  require_arg "$gbp_client_id" '--gbp-client-id' '本番 line-webhook の env GBP_OAUTH_CLIENT_ID と同じ値を渡してください（infra/README.md §8-0）。GBP の認証情報がまだ未投入（§10-2）なら、`--api gemini --api places --api line-messaging` で対象を絞って実行してください。'
fi

for cmd in gcloud curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: ${cmd} が見つかりません。" >&2
    exit 1
  fi
done

umask 077
TMPDIR_SMOKE="$(mktemp -d)"
cleanup() { rm -rf "$TMPDIR_SMOKE"; }
trap cleanup EXIT INT TERM

fail=0
results=''

# API 応答から `"status": "XXX"` だけを取り出す。**受理するのは [A-Z_] のみ**（1〜64 文字）。
# 本文をそのまま出すと、Google の 400 応答に含まれるリクエスト URL 経由で鍵が漏れる。
extract_status() {
  _s="$(sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([A-Z_]\{1,64\}\)".*/\1/p' "$1")"
  printf '%s' "${_s%%$'\n'*}"
}

# OAuth 2.0 の `"error": "xxx"` だけを取り出す（RFC 6749 のエラーコードは小文字とアンダースコア）。
# `error_description` は入力のエコーを含みうるので絶対に読まない。**受理するのは [a-z_] のみ。**
# 繰り返し回数を書かないのは line-messaging 側と同じ理由（BSD sed の RE_DUP_MAX 255）。
extract_oauth_error() {
  _e="$(sed -n 's/.*"error"[[:space:]]*:[[:space:]]*"\([a-z_][a-z_]*\)".*/\1/p' "$1")"
  printf '%s' "${_e%%$'\n'*}"
}

# curl を 600 の設定ファイル経由で叩き、HTTP ステータスだけを stdout へ返す。
# $1=出力先ボディファイル、$2=url、$3 以降=ヘッダ行（`Name: value`）。
# POST 本文は $CURL_DATA_FILE（設定済みなら）を --data で渡す。
curl_status() {
  _body="$1"; shift
  _url="$1"; shift
  _cfg="${TMPDIR_SMOKE}/curl.cfg"
  : > "$_cfg"
  printf 'url = "%s"\n' "$_url" >> "$_cfg"
  for _h in "$@"; do
    printf 'header = "%s"\n' "$_h" >> "$_cfg"
  done
  if [ -n "${CURL_DATA_FILE:-}" ]; then
    curl -sS --max-time 30 -K "$_cfg" --data "@${CURL_DATA_FILE}" -o "$_body" -w '%{http_code}' || printf '000'
  else
    curl -sS --max-time 30 -K "$_cfg" -o "$_body" -w '%{http_code}' || printf '000'
  fi
  rm -f "$_cfg"
}

record() {
  # $1=api $2=PASS|FAIL $3=詳細
  printf '%-4s  %-14s  %s\n' "$2" "$1" "$3"
  results="${results}${1}	${2}"$'\n'
  [ "$2" = 'FAIL' ] && fail=1
  return 0
}

read_secret() {
  # $1=secret_id。値は変数へ入れるだけで、決して出力しない。
  gcloud secrets versions access latest --secret="$1" --project="$project" 2>"${TMPDIR_SMOKE}/gcloud.err"
}

echo "外部 API 実疎通（project=${project}・対象: ${selected% }）"
echo "※ 応答本文と鍵は一切出力しません（出すのは HTTP ステータスと status フィールドのみ）。"
echo ""

# --- gemini ------------------------------------------------------------------------------------
if wants gemini; then
  if ! key="$(read_secret gemini-api-key)"; then
    record gemini FAIL "gemini-api-key を読めません（roles/secretmanager.secretAccessor が要ります）"
  else
    body="${TMPDIR_SMOKE}/gemini.json"
    data="${TMPDIR_SMOKE}/gemini-req.json"
    printf '%s' '{"contents":[{"parts":[{"text":"ping"}]}],"generationConfig":{"maxOutputTokens":1}}' > "$data"
    code="$(CURL_DATA_FILE="$data" curl_status "$body" \
      "https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent" \
      "x-goog-api-key: ${key}" 'Content-Type: application/json')"
    unset key
    if [ "$code" = '200' ]; then
      record gemini PASS "http=${code}（model=${model}）"
    else
      st="$(extract_status "$body")"
      record gemini FAIL "http=${code}${st:+ status=${st}}（model=${model}）"
    fi
  fi
fi

# --- places ------------------------------------------------------------------------------------
if wants places; then
  if ! key="$(read_secret places-api-key)"; then
    record places FAIL "places-api-key を読めません（roles/secretmanager.secretAccessor が要ります）"
  else
    body="${TMPDIR_SMOKE}/places.json"
    code="$(CURL_DATA_FILE='' curl_status "$body" \
      "https://places.googleapis.com/v1/places/${place_id}" \
      "X-Goog-Api-Key: ${key}" 'X-Goog-FieldMask: id')"
    unset key
    if [ "$code" = '200' ]; then
      record places PASS "http=${code}"
    else
      st="$(extract_status "$body")"
      record places FAIL "http=${code}${st:+ status=${st}}（place_id が正しいかも確認してください）"
    fi
  fi
fi

# --- line-messaging ------------------------------------------------------------------------------
if wants line-messaging; then
  if ! secret="$(read_secret line-channel-secret)"; then
    record line-messaging FAIL "line-channel-secret を読めません（roles/secretmanager.secretAccessor が要ります）"
  else
    body="${TMPDIR_SMOKE}/line-token.json"
    data="${TMPDIR_SMOKE}/line-req.txt"
    # 本文にチャネルシークレットが入るため、必ずファイル経由で渡す（`ps` に出さない）。
    printf 'grant_type=client_credentials&client_id=%s&client_secret=%s' "$channel_id" "$secret" > "$data"
    unset secret
    code="$(CURL_DATA_FILE="$data" curl_status "$body" \
      'https://api.line.me/oauth2/v3/token' \
      'Content-Type: application/x-www-form-urlencoded')"
    rm -f "$data"
    if [ "$code" != '200' ]; then
      # LINE のエラー本文は出さない（入力のエコーを含み得るため）。HTTP コードで切り分けられる。
      record line-messaging FAIL "トークン発行に失敗 http=${code}（channel_id とシークレットの組を確認してください）"
    else
      # 繰り返し回数を明示しないこと。BSD sed（macOS）の RE_DUP_MAX は 255 で、`\{1,4096\}` は
      # `RE error: invalid repetition count(s)` になる（GNU sed は通るため Linux だけで気づけない）。
      # `[^"]` が `"` で区切られる範囲を既に限っているので、上限を書く必要がない。
      token="$(sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\([^"][^"]*\)".*/\1/p' "$body")"
      token="${token%%$'\n'*}"
      if [ -z "$token" ]; then
        record line-messaging FAIL "トークン応答に access_token がありません（http=${code}）"
      else
        info="${TMPDIR_SMOKE}/line-info.json"
        # **送信系エンドポイントを使わない。** /v2/bot/info は read-only であり、
        # メッセージを一切送らずにチャネル資格情報の正当性を証明できる。
        code2="$(CURL_DATA_FILE='' curl_status "$info" \
          'https://api.line.me/v2/bot/info' \
          "Authorization: Bearer ${token}")"
        unset token
        if [ "$code2" = '200' ]; then
          record line-messaging PASS "http=${code2}（トークン発行 → /v2/bot/info・送信なし）"
        else
          record line-messaging FAIL "/v2/bot/info が http=${code2}"
        fi
      fi
    fi
  fi
fi

# --- gbp -----------------------------------------------------------------------------------------
# **HTTP ステータスでは判定しない。** Google はこの 2 ケース（invalid_grant / invalid_client）の
# HTTP コードを公開文書に明記していないため、判定は `error` フィールドで行う。アプリ側の
# ts/apps/line-webhook/src/gbp/token-store.ts の isInvalidGrantError も同じく error を一次情報にする。
if wants gbp; then
  if ! secret="$(read_secret gbp-oauth-client-secret)"; then
    record gbp FAIL "gbp-oauth-client-secret を読めません（未投入なら infra/README.md §10-2 を先に）"
  else
    body="${TMPDIR_SMOKE}/gbp-token.json"
    data="${TMPDIR_SMOKE}/gbp-req.txt"
    # 意図的に無効な refresh token を送る。クライアント資格情報が正当なら Google は
    # 「grant が無効」とだけ答えるので、invalid_grant が返ること自体が client の正当性を証明する。
    # ユーザー認可を要さず、トークンも発行されず、GBP 側に何も残らない。
    printf 'grant_type=refresh_token&refresh_token=smoke-invalid&client_id=%s&client_secret=%s' \
      "$gbp_client_id" "$secret" > "$data"
    unset secret
    code="$(CURL_DATA_FILE="$data" curl_status "$body" \
      'https://oauth2.googleapis.com/token' \
      'Content-Type: application/x-www-form-urlencoded')"
    rm -f "$data"
    oerr="$(extract_oauth_error "$body")"
    case "$oerr" in
      invalid_grant)
        record gbp PASS "http=${code} error=${oerr}（クライアント資格情報は正当・トークン発行なし）" ;;
      invalid_client)
        record gbp FAIL "http=${code} error=${oerr}（client_id と client_secret の組が誤りです）" ;;
      '')
        record gbp FAIL "http=${code}（応答に error フィールドがありません）" ;;
      *)
        record gbp FAIL "http=${code} error=${oerr}" ;;
    esac
  fi
fi

echo ""

# 成功を断定する直前の空振り防止。上流の引数検証をすり抜ける経路が将来できても、
# **1 件も record していないなら成功と言わせない。** 判定の直前に置くことに意味がある
# （引数検証は入口の 1 経路しか守らないが、ここは成功断定の唯一の門である）。
if [ -z "$results" ]; then
  echo "NG: 実疎通を 1 件も実行していません（対象の選択が空です）。" >&2
  echo "    → 対象 0 件のまま「すべて成功しました」と報告するのが最悪の空振りであるため、ここで落とします。" >&2
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  echo "NG: 実疎通に失敗した API があります。" >&2
  echo "    → キーそのものが死んでいる可能性があります。infra/README.md §1 項目 5 で実値を投入し直し、" >&2
  echo "      infra/secrets-provisioned.tsv も同じ PR で更新してください。" >&2
  echo "    → **失敗したまま infra/external-api-smoke.tsv の日付を更新しないこと。**" >&2
  exit 1
fi

# **記録へ押す日時は必ず JST で取る（TZ を実行者の環境へ委ねない）。** 宣言の最終確認日は JST と
# 定めてあり（infra/external-api-smoke.tsv の列定義・infra/README.md §8-5）、鮮度検証（層2）も
# JST を基準日に判定する。ここが実行者のローカル日付だと、JST 圏外から叩いた記録が層2 の未来日
# 判定に掛かり、正当な実施が「日付だけ埋めた捏造」として追跡 Issue へ立つ。証拠欄の刻も同じ理由で
# JST に揃える（オフセットが実行環境ごとに変わると、後から読む人が実施時刻を復元できない）。
today="$(TZ=Asia/Tokyo date +%Y-%m-%d)"
stamp="local-$(TZ=Asia/Tokyo date +%Y%m%dT%H%M%S%z)"

echo "OK: 対象の実疎通はすべて成功しました。"
echo ""
echo "infra/external-api-smoke.tsv の該当行を、最終確認日と証拠を差し替えて更新してください:"
echo ""
# 現在の宣言から該当 api の行を引き、日付と証拠だけを差し替えた行を提示する。
# 宣言を直接書き換えないのは、レビューされる差分として人間の手で入れるべきだからである。
# DECL_FILE は冒頭で解決・存在確認済み（実疎通対象の語彙もそこから導出している）。
while IFS= read -r line; do
  api="$(printf '%s' "$line" | cut -f2)"
  case " ${selected}" in
    *" ${api} "*) ;;
    *) continue ;;
  esac
  printf '  %s\n' "$(printf '%s' "$line" | awk -F'\t' -v d="$today" -v e="$stamp" \
    'BEGIN{OFS="\t"} {$3=d; $4=e; print}')"
done < <(grep -vE '^[[:space:]]*(#|$)' "$DECL_FILE")
echo ""
echo "証拠欄は実行時刻です。run URL や execution id など、より辿りやすい識別子があれば置き換えてください。"
