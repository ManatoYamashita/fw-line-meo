# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/external-api-smoke-notify.sh の自己テスト（Issue #125）。
#
# report-ci-issue.sh は本文を加工せずそのまま送る。したがって緑（復旧）でも赤用の断定と
# 「## 対処」を組んでいると、復旧コメントが見出し付きの障害指示として描画され、不要な障害対応を
# 誘発する（Issue #102 のコメントで実測。prod-image-drift-notify.sh で同じ欠陥を踏んでいる）。
#
# **本文の組み立てをワークフローの run ブロックへ戻さないこと。** yml へ埋め込むと検証が
# 「見出しコメントを sed で抜いて実走する」形へ逆戻りし、Issue #109 では抽出対象のスクリプトが
# 存在しないことで孤児ケース検出に掛かって main の ts-ci が 3 日赤いままになった。
#
# 状態は green / warn / red の 3 つ。warn（期限間近）はジョブを緑のまま追跡 Issue で予告する
# 状態で、本文は「期限間近」「有効期限」「叩き直すコマンド」を告げる。有効期限は検証結果の
# 機械可読行 `EXTERNAL-API-SMOKE-EXPIRY: YYYY-MM-DD` から取り、無ければ組み立てない（fail-closed）。
# 逆に、その行がある検証結果を緑（復旧）として組ませると、予告中の追跡 Issue が閉じられて予告が
# 消えるため、これも拒否する（呼び出し側の状態導出の取りこぼしを赤にする）。

easn_report() {
  # 検証結果ファイル。本文へフェンス付きで埋め込まれる。
  fx_write report.txt <<'EOF'
OK: 外部 API の実疎通記録はすべて有効期間内（3 件検証・有効期間 14 日）。
EXTERNAL-API-SMOKE-SIGNATURE: gemini=ok;line-messaging=ok;places=ok;
EOF
}

easn_report_warn() {
  # 期限間近の検証結果（check-external-api-smoke-freshness.sh が exit 0 で出す形）。
  # 本文の散文へ引くのは機械可読行の有効期限だけで、WARN 行はフェンス内へ素通しされる。
  fx_write report.txt <<'EOF'
WARN: gemini（gemini-api-key）の実疎通記録が期限間近です — 最終確認 2026-09-12（12 日前）・有効期限 2026-09-26（残り 2 日）・証拠: local-20260912T184114+0900
EXTERNAL-API-SMOKE-SIGNATURE: gemini=warn;line-messaging=ok;places=ok;
EXTERNAL-API-SMOKE-EXPIRY: 2026-09-26
OK: 外部 API の実疎通記録はすべて有効期間内（3 件検証・有効期間 14 日・期限間近 1 件）。
EOF
}

easn_compose() {
  # $1 = state。組み立てを実走し、**stdout だけ**を OUT へ入れる。
  # stderr まで混ぜると、診断行を本文の一部として照合してしまう。
  fx_run_stdout external-api-smoke-notify \
    --state "$1" \
    --report report.txt \
    --run-url https://github.com/owner/repo/actions/runs/1
}

# **本命**: 緑（復旧）の本文に、赤用の断定と対処手順を出さないこと。
t_begin 'external-api-smoke 通知: 緑の本文に未実施の断定と対処手順を出さない'
fx_guard external-api-smoke-notify
easn_report
easn_compose green
# `OK:` は本スクリプト自身の要約行ではなく、**検証結果ファイルの内容がそのまま本文へ載っている**
# ことを示す。この 1 行で「exit 0」と「report を素通しで埋め込んだ」の両方を固定できる。
expect_green
expect_output_matches '## 検証結果'
expect_output_matches '3 件検証'
expect_absent '未実施または期限切れです'
expect_absent '## 対処'
expect_absent 'run-external-api-smoke.sh'
# 期限間近の予告で立った追跡 Issue もこの本文で閉じる。「期限切れは解消済み」だけを書くと、
# 予告で立った Issue の復旧コメントが事実（期限切れには一度もなっていない）と食い違う。
expect_output_matches '期限間近はいずれも解消済みです'
t_end

# 対照: 赤では断定も対処手順も出す。緑の是正で赤まで削ると障害通知が無内容になる。
t_begin 'external-api-smoke 通知: 赤の本文には断定と対処手順を出す（対照）'
fx_guard external-api-smoke-notify
easn_report
easn_compose red
expect_output_matches '未実施または期限切れです'
expect_output_matches '## 対処'
expect_output_matches 'run-external-api-smoke.sh'
# 最も危ない誤読は「日付だけ更新すれば緑になる」である。赤の本文で必ず釘を刺す。
expect_output_matches '日付だけを更新して実疎通を省略しないでください'
# 鍵を CI へ渡さない設計であることを毎回明示する（「CI で自動化すればいい」への回答）。
expect_output_matches 'Req 5.4'
t_end

# 期限間近（warn）: ジョブは緑のまま、追跡 Issue で「いつまでに・何を叩くか」を告げる。
t_begin 'external-api-smoke 通知: 期限間近の本文は有効期限と叩き直すコマンドを告げ、期限切れと断定しない'
fx_guard external-api-smoke-notify
easn_report_warn
easn_compose warn
# `OK:` は検証結果（report）の素通しから来る。予告でもジョブは緑であり、本文の組み立ても成功する。
expect_green
expect_output_matches '^外部 API への実疎通記録が期限間近です'
# 有効期限は散文の行頭に置く（フェンス内の WARN 行にも日付はあるが、埋もれて読まれない）。
expect_output_matches '^有効期限: \*\*2026-09-26\*\*'
expect_output_matches 'このジョブは緑のままです'
expect_output_matches '^## 対処（2026-09-26 までに）$'
expect_output_matches 'bash scripts/run-external-api-smoke.sh --place-id <place_id> --model <GEMINI_MODEL> --channel-id <LINE_CHANNEL_ID>'
expect_output_matches 'infra/README.md` §8'
expect_output_matches '日付だけを更新して実疎通を省略しないでください'
# 期限前に「期限切れです」と断定すると、予告と障害の区別が付かなくなる（赤の本文の断定を出さない）。
expect_absent '未実施または期限切れです'
# 復旧（緑）の文言を出さない。予告はまだ何も解消していない。
expect_absent '解消済み'
t_end

# 有効期限を告げられない予告は「いつまでに」を欠いた無内容な通知になる。欠落も書式崩れも拒否する。
t_begin 'external-api-smoke 通知: 期限間近の本文は、検証結果に有効期限の行が無ければ組み立てない'
fx_guard external-api-smoke-notify
# 期限の行を持たない検証結果（緑の report）。
easn_report
fx_run_args external-api-smoke-notify \
  --state warn \
  --report report.txt \
  --run-url https://github.com/owner/repo/actions/runs/1
expect_red '有効期限の行（EXTERNAL-API-SMOKE-EXPIRY: YYYY-MM-DD）がちょうど 1 行ありません'
expect_absent '外部 API への実疎通記録が期限間近です'
# 書式が崩れた期限の行（区切りが `/`）。行はあるが日付として読めない。
fx_write report.txt <<'EOF'
EXTERNAL-API-SMOKE-SIGNATURE: gemini=warn;
EXTERNAL-API-SMOKE-EXPIRY: 2026/09/26
EOF
fx_run_args external-api-smoke-notify \
  --state warn \
  --report report.txt \
  --run-url https://github.com/owner/repo/actions/runs/1
expect_red '有効期限の行（EXTERNAL-API-SMOKE-EXPIRY: YYYY-MM-DD）がちょうど 1 行ありません'
expect_absent '外部 API への実疎通記録が期限間近です'
t_end

# 呼び出し側（ワークフロー）が署名の warn を state へ写し損ねた形。緑の本文を組むと
# report-ci-issue.sh が予告中の追跡 Issue を「復旧」として閉じ、予告が黙って消える。
t_begin 'external-api-smoke 通知: 期限間近を示す検証結果を緑（復旧）として組み立てない'
fx_guard external-api-smoke-notify
easn_report_warn
fx_run_args external-api-smoke-notify \
  --state green \
  --report report.txt \
  --run-url https://github.com/owner/repo/actions/runs/1
expect_red '期限間近を示しています'
# 照合は緑の本文にしか現れない語へ当てる（診断文はこの語を含まない）。
expect_absent 'すべて有効期間内です'
t_end

# 期限切れと期限間近の混在（check は exit 1）。赤の本文は期限の行があっても組み立てる。
# ここで拒否すると通知ステップが落ちて report-ci-issue.sh まで届かず、期限切れが追跡 Issue へ載らない。
t_begin 'external-api-smoke 通知: 赤の本文は期限間近の行が混在していても組み立てる'
fx_guard external-api-smoke-notify
fx_write report.txt <<'EOF'
ERROR: gemini（gemini-api-key）の実疎通が 15 日前（2026-09-11）で、有効期間 14 日を超えています。
WARN: places（places-api-key）の実疎通記録が期限間近です — 最終確認 2026-09-12（14 日前）・有効期限 2026-09-26（本日が最終日）・証拠: local-20260912T184114+0900
EXTERNAL-API-SMOKE-SIGNATURE: gemini=stale;places=warn;
EXTERNAL-API-SMOKE-EXPIRY: 2026-09-26
EOF
easn_compose red
expect_output_matches '^外部 API への実疎通が未実施または期限切れです'
expect_output_matches '^## 対処$'
expect_absent '期限間近です（external-api-smoke-freshness'
t_end

t_begin 'external-api-smoke 通知: 検証結果は必ずフェンス内に置く（緑・期限間近・赤とも）'
fx_guard external-api-smoke-notify
for easn_state in green warn red; do
  # 状態ごとに、その状態で実際に渡される形の検証結果を置く（warn は期限の行が要る）。
  if [ "$easn_state" = 'warn' ]; then
    easn_report_warn
  else
    easn_report
  fi
  easn_compose "$easn_state"
  # 裸で置くと出力中の #123 が他 Issue への参照通知を、@name が誤メンションを飛ばす。
  # **件数取得を後置 true で潰さない。** 潰すと評価不能（exit 2 以上）まで「0 件」へ化け、
  # フェンスが無いのに `FENCES: 0` として素通りする（Issue #120）。無一致（1）と評価不能（2 以上）
  # を分ける。`grep -c` は入力を読み切るので上流へ SIGPIPE を送らない（Issue #78）。
  easn_fences_rc=0
  easn_fences="$(printf '%s\n' "$OUT" | grep -cE '^```$')" || easn_fences_rc=$?
  if [ "$easn_fences_rc" -gt 1 ]; then
    _t_fail "フェンス数の抽出パターンを評価できません（grep exit=${easn_fences_rc}）"
  fi
  OUT="FENCES: ${easn_fences:-0}"
  expect_output_matches '^FENCES: 2$'
done
t_end

t_begin 'external-api-smoke 通知: 未知の state を緑として扱わない'
fx_guard external-api-smoke-notify
easn_report
fx_run_args external-api-smoke-notify \
  --state gren \
  --report report.txt \
  --run-url https://github.com/owner/repo/actions/runs/1
expect_red '--state は green / warn / red のいずれかでなければなりません'
# 綴り誤りが緑の本文として通ると、未実施のまま復旧通知が飛ぶ。本文を 1 行も出していないこと。
expect_absent 'すべて有効期間内です'
t_end

t_begin 'external-api-smoke 通知: 検証結果ファイルが無ければ無内容の本文を返さない'
fx_guard external-api-smoke-notify
fx_run_args external-api-smoke-notify \
  --state red \
  --report missing-report.txt \
  --run-url https://github.com/owner/repo/actions/runs/1
expect_red '検証結果ファイルがありません'
# **照合は本文にしか現れない語へ当てる。** 見出し（`## 検証結果`）はエラーメッセージ自身が
# 説明のために含んでおり、診断文の言い回しを変えただけでケースが赤/緑へ転ぶ。
expect_absent '外部 API への実疎通が'
t_end

t_begin 'external-api-smoke 通知: run URL が空なら本文を返さない（通知から run へ辿れなくなる）'
fx_guard external-api-smoke-notify
easn_report
fx_run_args external-api-smoke-notify \
  --state red \
  --report report.txt
expect_red '--run-url が空です'
expect_absent '外部 API への実疎通が'
t_end
