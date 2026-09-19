# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/run-e2e-prod-checks.sh の自己テスト（line-on-demand-report tasks 4.5）。
#
# 本スクリプトは **CI では走らない**（本番のログを読むため・運用者用）。それでも自己テストを
# 持つのは、守りたい性質が「配信の合否の判定」だからである。判定は本番のログが無いと 1 度も
# 走らず、しかも間違っていても**緑に倒れる**（見逃す側に壊れる）。
#
# 通知は**変化があった日にだけ**送るので、旧来の「対象をすべて送信した」という判定は、新しい
# 配信では常に赤になる。かといって送信数の条件を外すだけにすると、完了後メニューが未準備の
# ままで 1 通も届かない状態（spec の Step C をやり忘れた状態）が緑になる。この 2 つを同時に
# 満たしているかは、判定へ実行サマリーを渡して確かめるしかない。
#
# 判定以外の項目（稼働イメージ・シークレット・実疎通・CI・日次ジョブ）は、この装置が呼び出す
# **境界でスタブへ差し替える**。それぞれに自前の自己テストがあり、ここで二重に検証しない。
# gcloud・gh も実物を呼ばない（hermetic）。

# --- fixture ---------------------------------------------------------------------------

repc_fixture() {
  fx_guard run-e2e-prod-checks

  # 装置は最後に HEAD を読むので、合成ツリーを 1 コミットだけの git リポジトリにする。
  # commit まで行うのは、`git rev-parse HEAD` が空のリポジトリでは失敗するためである。
  (cd "$FX" && git init -q && git add -A \
    && git -c user.email=selftest@example.com -c user.name=selftest commit -q -m 'selftest fixture') >/dev/null 2>&1
  repc_sha="$(cd "$FX" && git rev-parse --short=7 HEAD)"

  # 1〜3 の下位スクリプト（それぞれ自前の自己テストを持つ）。
  cat > "${FX}/scripts/check-prod-image-drift.sh" <<STUB
#!/usr/bin/env bash
echo 'OK: 本番の稼働イメージは origin/main と一致しています（自己テストのスタブ）'
echo 'DRIFT-SIGNATURE: job/summary-delivery=in-sync@${repc_sha};'
STUB
  cat > "${FX}/scripts/check-secret-version-drift.sh" <<'STUB'
#!/usr/bin/env bash
echo 'OK: シークレットの version 構成は宣言どおりです（自己テストのスタブ）'
STUB
  cat > "${FX}/scripts/check-external-api-smoke-freshness.sh" <<'STUB'
#!/usr/bin/env bash
echo 'OK: 実疎通の記録は有効期間内です（自己テストのスタブ）'
STUB
  chmod +x "${FX}/scripts/check-prod-image-drift.sh" "${FX}/scripts/check-secret-version-drift.sh" \
    "${FX}/scripts/check-external-api-smoke-freshness.sh"

  # 4 の gh（本番コミットに対する ts-ci の結果）。
  cat > "${FX}/stub/gh" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *'run list'*) printf '999\tcompleted\tsuccess\n' ;;
  *'run view'*) printf 'e2e\tsuccess\ne2e-surfaces\tsuccess\nlighthouse\tsuccess\ncross-runtime\tsuccess\n' ;;
esac
STUB

  # 5 の gcloud（日次ジョブの直近の実行）と、6 の致命的な失敗の照会。
  # **実行の作成時刻は常に現在時刻にする。** 固定日時を書くと、鮮度の上限（26 時間・2 時間）に
  # よって同じケースが時期によって赤にも緑にも転ぶ。
  cat > "${FX}/stub/gcloud" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *'run jobs executions list'*)
    now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '[{"metadata":{"name":"selftest-exec","creationTimestamp":"%s"},"status":{"completionTime":"%s","succeededCount":1,"failedCount":0}}]\n' "$now" "$now"
    ;;
  *'logging read'*)
    # delivery-job.fatal は 1 件も無い（配信の件数の判定は注入口が受け持つ）。
    ;;
esac
STUB

  chmod +x "${FX}/stub/gh" "${FX}/stub/gcloud"
}

# 実行サマリーの 1 件分（`gcloud logging read --format=json` と同じ形）を組み立てる。
#   $1=targetsTotal $2=delivered $3=failed $4=quotaExceeded $5=skipped
#   $6=skippedNoChange $7=skippedNotComparable $8=skippedMenuUnavailable $9=reportMenuReady
repc_summary() {
  printf '[{"timestamp":"2026-09-16T05:00:00Z","jsonPayload":{"event":"delivery-job.run","currentJstHour":14,'
  printf '"targetsTotal":%s,"delivered":%s,"failed":%s,"quotaExceeded":%s,"skipped":%s,' "$1" "$2" "$3" "$4" "$5"
  printf '"skippedNoChange":%s,"skippedNotComparable":%s,"skippedMenuUnavailable":%s,"reportMenuReady":%s}}]' "$6" "$7" "$8" "$9"
}

repc_run() {
  # $1 = 注入する実行サマリーの JSON。
  OUT=''
  RC=0
  # shellcheck disable=SC2034 # OUT / RC は run.sh の expect_* が読むハーネス側のグローバル
  OUT="$(cd "$FX" && PROJECT_ID=selftest-project PROD_DELIVERY_RUN_SNAPSHOT="$1" \
    bash scripts/run-e2e-prod-checks.sh 2>&1)" || RC=$?
}

repc_run_without_injection() {
  OUT=''
  RC=0
  # shellcheck disable=SC2034 # 同上
  OUT="$(cd "$FX" && PROJECT_ID=selftest-project bash scripts/run-e2e-prod-checks.sh 2>&1)" || RC=$?
}

# ---------------------------------------------------------------------------
# 本命 1: 1 通も送らなかった実行を合格にする。通知は変化があった日にだけ送るので、
# 「見送りだけ」は正常な 1 日である。旧来の判定（送信数 = 対象数・見送り 0 件）はここで赤になる。

t_begin 'run-e2e-prod-checks: 見送りだけ・準備判定 true の実行は合格'
repc_fixture
# 対象 4 件が、当日の集計なし 1・変化なし 2・比較不能 1 に数えられている（送信 0）。
repc_run "$(repc_summary 4 0 0 0 1 2 1 0 true)"
expect_green
expect_output_matches 'PASS +配信の件数'
expect_output_matches '送信 0・失敗 0・上限超過 0'
t_end

# ---------------------------------------------------------------------------
# 本命 2: 失敗が 1 件でもあれば不合格。
#
# **違反する条件はこのケースで 1 つだけにする。** 対象 4 件が 送信 2・失敗 1・集計なし 1 で
# すべて数えられているので、赤になる理由は「失敗 0 件」以外にない。数え上げの側でも赤になる
# 組み合わせを使うと、失敗の条件を壊す変異が別の条件に助けられて緑のままになる
# （[[guard-yardstick-independence]]。実際に一度この形で変異が素通りした）。

t_begin 'run-e2e-prod-checks: 失敗が 1 件あれば不合格'
repc_fixture
repc_run "$(repc_summary 4 2 1 0 1 0 0 0 true)"
expect_red 'NG: FAIL の項目があります'
expect_output_matches 'FAIL +配信の件数'
expect_output_matches '失敗あり'
t_end

t_begin 'run-e2e-prod-checks: 上限超過が 1 件あれば不合格'
repc_fixture
# こちらも違反は「上限超過 0 件」だけ（対象 4 件が 送信 2・上限超過 1・集計なし 1 で数え切れている）。
repc_run "$(repc_summary 4 2 0 1 1 0 0 0 true)"
expect_red 'NG: FAIL の項目があります'
expect_output_matches '上限超過あり'
t_end

# ---------------------------------------------------------------------------
# 本命 3: 準備判定が false なら不合格。**送信数が対象数と一致していても赤にする。**
# 完了後メニューの差し替え（spec の Step C）をやり忘れた状態を緑にしないための条件である。

t_begin 'run-e2e-prod-checks: 準備判定が false なら不合格（送信数が対象数と一致していても）'
repc_fixture
repc_run "$(repc_summary 3 3 0 0 0 0 0 0 false)"
expect_red 'NG: FAIL の項目があります'
expect_output_matches '完了後メニューが未準備'
t_end

# ---------------------------------------------------------------------------
# 本命 4: 送信にも理由つきの見送りにも数えられていない対象があれば不合格。
# 「送らなかった日を記録しない」経路が戻ったときに、ここが気づく唯一の場所になる。

t_begin 'run-e2e-prod-checks: 数えられていない対象があれば不合格'
repc_fixture
# 対象 3 件のうち、送信 1・集計なし 1 の 2 件しかどのバケツにも入っていない（失敗も上限超過も 0）。
repc_run "$(repc_summary 3 1 0 0 1 0 0 0 true)"
expect_red 'NG: FAIL の項目があります'
expect_output_matches '数えられていない対象が 1 件'
t_end

# ---------------------------------------------------------------------------
# 本命 5: 実行サマリーに新しい項目が無ければ不合格（旧いイメージが動いている状態）。
# 項目の不在を「条件を満たさない」ではなく「判定できない」として扱わないと、旧いイメージの
# ログが `undefined` 同士の比較で静かに緑になる。

t_begin 'run-e2e-prod-checks: 準備判定の項目を持たない実行サマリーは不合格'
repc_fixture
repc_run '[{"timestamp":"2026-09-16T05:00:00Z","jsonPayload":{"event":"delivery-job.run","currentJstHour":14,"targetsTotal":2,"delivered":2,"failed":0,"skipped":0,"quotaExceeded":0}}]'
expect_red 'NG: FAIL の項目があります'
expect_output_matches '実行サマリーの項目が欠けています.*reportMenuReady'
t_end

# ---------------------------------------------------------------------------
# 注入口の形。**設定されているかどうかで判定する**（`${VAR+x}`）。`${VAR:-}` で見ると、空文字を
# 渡した試験が実 API へ落ちる（[[dry-run-injection-empty-string-trap]]・Issue #108 と同型）。

t_begin 'run-e2e-prod-checks: 空文字の注入も注入として扱う（実 API へ落とさない）'
repc_fixture
repc_run ''
expect_red 'NG: FAIL の項目があります'
expect_output_matches '注入された実行サマリー'
# 空の注入は「対象のある実行が無い」として赤にする（緑に倒さない）。
expect_output_matches '配信対象のある実行がありません'
t_end

t_begin 'run-e2e-prod-checks: 未設定なら注入せずログを読みに行く'
repc_fixture
repc_run_without_injection
expect_red 'NG: FAIL の項目があります'
# 注入の告知は出ない。出ていれば、未設定でも注入経路へ入っている。
expect_absent '注入された実行サマリー'
t_end
