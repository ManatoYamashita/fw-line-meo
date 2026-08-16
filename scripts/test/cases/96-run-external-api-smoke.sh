# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/run-external-api-smoke.sh の自己テスト（Issue #125）。
#
# 本スクリプトは **CI では走らない**（鍵を CI へ渡さない設計）。それでも自己テストを持つのは、
# 最も守りたい性質が「出力の allowlist」だからである。応答本文をそのまま出すと、Google の 400
# 応答に含まれるリクエスト URL 経由で鍵がターミナル履歴や貼り付け先へ漏れる。この性質は
# 読むだけでは確かめられず、**実走して出力を検査して初めて**固定できる。
#
# もう 1 つの本命は「LINE の送信系エンドポイントを叩かないこと」。実疎通で push を使うと
# 受信者への実送信になり、無料メッセージ通数枠を消費する。スタブが叩かれた URL を記録し、
# 送信系が 1 度も現れないことを照合する。
#
# gcloud / curl はスタブへ差し替える。実 API も実 gcloud も呼ばない（hermetic）。

# 出力へ現れてはならない番兵。スタブは鍵としてこれを返し、応答本文にも埋め込む。
REAS_KEY_SENTINEL='SUPER-SECRET-KEY-abc123'
REAS_BODY_SENTINEL='LEAKY-BODY-MARKER-xyz789'

reas_stubs() {
  # $1 = スタブ curl が返す HTTP ステータス。
  # スタブは t_begin が PATH の先頭へ置く ${FX}/stub へ設置する（npx スタブと同居）。
  mkdir -p "${FX}/stub"

  cat > "${FX}/stub/gcloud" <<STUB
#!/usr/bin/env bash
# secrets versions access だけを模擬する。値は番兵をそのまま返す。
printf '%s' '${REAS_KEY_SENTINEL}'
STUB

  cat > "${FX}/stub/curl" <<STUB
#!/usr/bin/env bash
# -o <file> だけ解釈し、叩かれた URL を \${STUB_DIR}/urls.txt へ記録する。
# 応答本文には必ず番兵を埋める（allowlist が効いていなければ出力へ漏れる）。
set -u
out=''
prev=''
for a in "\$@"; do
  if [ "\$prev" = '-o' ]; then out="\$a"; fi
  prev="\$a"
done
# curl の設定ファイル（-K）に url = "..." の形で入るため、そこから拾う。
for a in "\$@"; do
  if [ -f "\$a" ]; then
    sed -n 's/^url = "\(.*\)"\$/\1/p' "\$a" >> "\${STUB_DIR}/urls.txt"
  fi
done
code='${1}'
if [ -n "\$out" ]; then
  if [ "\$code" = '200' ]; then
    printf '{"access_token":"TOK-${REAS_BODY_SENTINEL}","note":"${REAS_BODY_SENTINEL}"}' > "\$out"
  else
    printf '{"error":{"code":%s,"message":"${REAS_BODY_SENTINEL} key=${REAS_KEY_SENTINEL}","status":"INVALID_ARGUMENT"}}' "\$code" > "\$out"
  fi
fi
printf '%s' "\$code"
STUB

  chmod +x "${FX}/stub/gcloud" "${FX}/stub/curl"
  : > "${FX}/stub/urls.txt"
}

reas_fixture() {
  # $1 = スタブ curl が返す HTTP ステータス。
  fx_guard run-external-api-smoke
  reas_stubs "$1"
  # 末尾で貼り付け用の行を組むため、宣言ファイルも要る。
  mkdir -p "${FX}/infra"
  {
    printf '# 自己テストの宣言 fixture（Issue #125）\n'
    printf 'alpha-key\talpha\tPENDING\t-\t#125\t説明\n'
    printf 'ops-only\t-\t-\t-\t#125\t対象外\n'
  } > "${FX}/infra/external-api-smoke.tsv"
}

reas_run() {
  OUT=''
  RC=0
  # shellcheck disable=SC2034 # OUT / RC は run.sh の expect_* が読むハーネス側のグローバル
  OUT="$(cd "$FX" && bash scripts/run-external-api-smoke.sh "$@" 2>&1)" || RC=$?
}

reas_run_tz() {
  # $1 = 実行環境の TZ、$2 以降 = スクリプト引数。
  reas_tz="$1"
  shift
  OUT=''
  RC=0
  # shellcheck disable=SC2034 # OUT / RC は run.sh の expect_* が読むハーネス側のグローバル
  OUT="$(cd "$FX" && TZ="$reas_tz" bash scripts/run-external-api-smoke.sh "$@" 2>&1)" || RC=$?
}

reas_expect_no_leak() {
  # 鍵と応答本文の番兵が出力へ 1 度も現れないこと。**この 2 つが本スクリプトの存在理由である。**
  expect_absent "$REAS_KEY_SENTINEL"
  expect_absent "$REAS_BODY_SENTINEL"
}

# ---------------------------------------------------------------------------
# 本命 1: 出力 allowlist。成功・失敗のどちらの経路でも鍵と応答本文を出さない。

t_begin 'run-external-api-smoke: 成功経路で鍵も応答本文も出力しない'
reas_fixture 200
reas_run --place-id ChIJTEST --model test-model --channel-id 1234567890
expect_green
reas_expect_no_leak
# 出すのは PASS / HTTP ステータスだけ。
expect_output_matches 'PASS  gemini'
expect_output_matches 'PASS  places'
expect_output_matches 'PASS  line-messaging'
t_end

t_begin 'run-external-api-smoke: 失敗経路でも鍵も応答本文も出力しない（status だけ出す）'
reas_fixture 400
reas_run --place-id ChIJTEST --model test-model --channel-id 1234567890
expect_red '実疎通に失敗した API があります'
reas_expect_no_leak
# 応答本文のうち allowlist された status フィールドだけは出る（切り分けに要るため）。
expect_output_matches 'FAIL  gemini +http=400 status=INVALID_ARGUMENT'
# 失敗したまま記録を更新させない。
expect_output_matches '日付を更新しないこと'
t_end

# ---------------------------------------------------------------------------
# 本命 2: LINE の送信系を叩かない。実疎通で push を使うと実送信になり通数枠を消費する。

t_begin 'run-external-api-smoke: LINE は送信系エンドポイントを 1 度も叩かない'
reas_fixture 200
reas_run --api line-messaging --channel-id 1234567890
expect_green
reas_urls_rc=0
reas_sends="$(grep -cE 'message/(push|multicast|broadcast|reply)' "${FX}/stub/urls.txt")" || reas_urls_rc=$?
if [ "$reas_urls_rc" -gt 1 ]; then
  _t_fail "送信系 URL の抽出パターンを評価できません（grep exit=${reas_urls_rc}）"
fi
reas_info_rc=0
reas_info="$(grep -cE 'api\.line\.me/v2/bot/info' "${FX}/stub/urls.txt")" || reas_info_rc=$?
if [ "$reas_info_rc" -gt 1 ]; then
  _t_fail "/v2/bot/info の抽出パターンを評価できません（grep exit=${reas_info_rc}）"
fi
# 送信系は 0 件、かつ /v2/bot/info は 1 件以上。前者だけでは「そもそも何も叩いていない」空振りと
# 区別できない（[[invariance-evidence-needs-firing-count]]）。
# shellcheck disable=SC2034 # OUT / RC は run.sh の expect_* が読むハーネス側のグローバル
OUT="SENDS: ${reas_sends:-0} / INFO: ${reas_info:-0}"
# shellcheck disable=SC2034 # 同上
RC=0
expect_output_matches '^SENDS: 0 / INFO: [1-9]'
t_end

# ---------------------------------------------------------------------------
# 本命 3: 記録へ押す日付の TZ（PR #130 レビュー指摘）。宣言（infra/external-api-smoke.tsv）の
# 最終確認日は **JST** と定めてあり、鮮度検証（層2）も JST を基準日に判定する。ここが実行者の
# ローカル日付だと、JST 圏外から叩いた記録が層2 の未来日判定に掛かり、正当な実施が「日付だけ
# 埋めた捏造」として追跡 Issue へ立つ。基準日側だけを直しても、記録側がずれていれば同じ穴が残る。
#
# 時間依存にしないため「ある TZ で緑」ではなく **「実行環境の TZ に依らず一定」** を照合する
# （理由は 94-check-external-api-smoke-freshness.sh の同名ケースに詳しい）。

t_begin 'run-external-api-smoke: 記録へ押す日付は実行環境の TZ に依らず JST で一定'
reas_fixture 200
# 貼り付け用の行は選んだ api の行しか出ない。既定 fixture の api は 'alpha' でどの --api にも
# 一致せず 1 行も出ないため、このケースでは実在の api 名を持つ宣言へ差し替える。
{
  printf '# 自己テストの宣言 fixture（Issue #125）\n'
  printf 'places-api-key\tplaces\tPENDING\t-\t#125\t説明\n'
} > "${FX}/infra/external-api-smoke.tsv"
reas_jst_today="$(TZ=Asia/Tokyo date +%Y-%m-%d)"
reas_offs=''
reas_dates=''
reas_stamps=''
for reas_tz in Etc/GMT+12 UTC Pacific/Kiritimati; do
  reas_offs="${reas_offs}$(TZ="$reas_tz" date +%z),"
  reas_run_tz "$reas_tz" --api places --place-id ChIJTEST
  # 貼り付け行は `  places-api-key<TAB>places<TAB><日付><TAB>local-<刻>…` の形。
  reas_row="$(printf '%s\n' "$OUT" | grep 'places-api-key' | sed -n '1p')"
  reas_dates="${reas_dates}$(printf '%s\n' "$reas_row" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' | sed -n '1p'),"
  reas_stamps="${reas_stamps}$(printf '%s\n' "$reas_row" | grep -oE 'local-[0-9]{8}T[0-9]{6}[+-][0-9]{4}' | sed -n '1p'),"
done
# shellcheck disable=SC2034 # OUT / RC は run.sh の expect_* が読むハーネス側のグローバル
OUT="OFFSETS: ${reas_offs} DATES: ${reas_dates} STAMPS: ${reas_stamps}"
# shellcheck disable=SC2034 # 同上
RC=0
# 空振り防止: tzdata が無く date が黙って UTC へ落ちた環境では 3 本とも同じになり、
# 「TZ を振ったつもりの 1 通り」を緑にする。オフセットが実際に散っていることを先に見る。
expect_output_matches '^OFFSETS: -1200,\+0000,\+1400,'
expect_output_matches "DATES: ${reas_jst_today},${reas_jst_today},${reas_jst_today},"
# 証拠欄の刻も JST。オフセットが実行環境ごとに変わると、後から読む人が実施時刻を復元できない。
expect_output_matches 'STAMPS: local-[0-9]{8}T[0-9]{6}\+0900,local-[0-9]{8}T[0-9]{6}\+0900,local-[0-9]{8}T[0-9]{6}\+0900,$'
t_end

# ---------------------------------------------------------------------------
# 引数の扱い。`wants X && require_arg …` の形は set -e の下で無言終了する（実測で踏んだ）。

t_begin 'run-external-api-smoke: --api で 1 つだけ選んでも無言終了しない'
reas_fixture 200
reas_run --api places --place-id ChIJTEST
expect_green
expect_output_matches 'PASS  places'
# 選ばなかった API は叩かない。
expect_absent 'PASS  gemini'
t_end

# ---------------------------------------------------------------------------
# 空振り防止。**対象 0 件を「すべて成功しました」と報告してはならない。** これは本スクリプトが
# 塞ごうとしている無音障害（成功しているように見えるが一度も実際には動いていない）そのものを
# 実疎通の器の側で再生産する形である（[[zero-count-escapes-coverage-gate]]）。
# `--api ''` は selected を空白 1 文字にするため「空だから既定の 3 件」へも落ちず、
# 語彙チェックの for も 1 度も回らず、wants が全て偽になって 0 件のまま末尾の OK へ到達した。

t_begin 'run-external-api-smoke: 対象 0 件を「すべて成功」と報告しない（--api の値が空）'
reas_fixture 200
reas_run --api '' --place-id ChIJTEST
expect_red '実疎通の対象が 1 件もありません'
# 0 件で緑を返すのが最悪の形。成功の断定も、貼り付け用の行も出してはならない。
# **成功断定の行そのものへアンカーする。** 部分文字列で見ると、診断文がその語を引用しただけで
# 落ちる（実際に一度これで赤くなった）。曖昧な一致は誤検出と見逃しの両方を生む。
expect_absent 'OK: 対象の実疎通はすべて成功しました'
expect_absent '最終確認日と証拠を差し替えて更新してください'
t_end

t_begin 'run-external-api-smoke: 値を伴うオプションで値が無ければ無言終了しない'
reas_fixture 200
reas_run --model
expect_red '--model には値が必要です'
t_end

t_begin 'run-external-api-smoke: 値の無い --api でも無言終了しない（shift 2 が set -e に殺される形）'
reas_fixture 200
reas_run --api
expect_red '--api には値が必要です'
t_end

t_begin 'run-external-api-smoke: 必須引数が無ければ既定値へ落とさず落とす'
reas_fixture 200
reas_run --api gemini
expect_red '--model は必須です'
# 既定値を持たせると、本番が別モデルへ移った瞬間に「動くはずのない構成が緑」になる。
expect_absent 'PASS  gemini'
t_end

t_begin 'run-external-api-smoke: 未知の --api は落とす'
reas_fixture 200
reas_run --api bogus
expect_red '--api は gemini / places / line-messaging のいずれかです'
t_end

t_begin 'run-external-api-smoke: 未知の引数は使い方の誤りとして落とす'
reas_fixture 200
reas_run --nope
expect_red '未知の引数です'
t_end
