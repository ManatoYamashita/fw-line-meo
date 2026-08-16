# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/check-external-api-smoke-freshness.sh の自己テスト（Issue #125）。
#
# 本ガードは「実疎通の記録が古びていないか」だけを時間で回して見る。この欠陥（キーが失効して
# いる・そもそも一度も叩いていない）はマージと無関係に恒常的に成り立つため、デプロイ契機では
# run 自体が生成されず「失敗という兆候すら出ない」（#91 で学んだのと同じ理由）。
#
# **時刻は必ず注入する。** `date +%Y-%m-%d` をそのまま使うケースは、閾値をまたいだ日に
# 自分から赤くなる。fixture の日付を「今日」から相対で作るのも同じ罠で、日付演算の誤りを
# テスト側と実装側の両方で同じ向きに間違えると打ち消し合って気づけない。基準日と実施日の
# 両方を定数で置く。

easf_decl() {
  # $1 以降 = '<secret_id>|<api>|<最終確認日>|<証拠>|<Issue-PR>|<説明>'。`|` を実タブへ変換する。
  {
    printf '# 自己テストの宣言 fixture（Issue #125）\n'
    for easf_row in "$@"; do
      printf '%s\n' "$easf_row" | tr '|' '\t'
    done
  } > "${FX}/infra/external-api-smoke.tsv"
}

easf_fixture() {
  fx_guard check-external-api-smoke-freshness
  # 層2 は層1 を実際に呼ぶ（構造が壊れたまま鮮度だけを見ない）。層1 はさらに
  # check-secret-declaration-coverage.sh --print-secrets を呼ぶ。3 本とも合成ツリーへ要る。
  fx_guard check-external-api-smoke
  fx_guard check-secret-declaration-coverage
  fx_write infra/modules/secrets/main.tf <<'EOF'
locals {
  secret_ids = [
    "alpha-key",
    "ops-only",
  ]
}
EOF
  {
    printf 'alpha-key\t2\t2026-07-12\t#63\n'
    printf 'ops-only\t1\t2026-07-20\t#63\n'
  } > "${FX}/infra/secrets-provisioned.tsv"
  fx_write infra/envs/prod/main.tf <<'EOF'
module "run_services" {
  secret_env = {
    ALPHA = module.secrets.secret_ids["alpha-key"]
  }
}
EOF
  fx_write infra/README.md <<'EOF'
# infra runbook（自己テスト fixture）

5. Secret Manager の値投入:
   printf %s "<VALUE>" | gcloud secrets versions add alpha-key --data-file=- --project=proj
   printf %s "<VALUE>" | gcloud secrets versions add ops-only  --data-file=- --project=proj

## 8. 外部 API 実疎通の手順

### 8-1. alpha: 自己テスト用の節

### 8-4. 記録の更新
EOF
  easf_decl \
    'alpha-key|alpha|PENDING|-|#125|外部 API を叩く鍵' \
    'ops-only|-|-|-|#125|外部 API を叩かない'
}

easf_run() {
  # $1 = 基準日（EXTERNAL_API_SMOKE_NOW へ注入）。注入は関数内に閉じてケース間へ漏らさない。
  OUT=''
  RC=0
  # shellcheck disable=SC2034 # OUT / RC は run.sh の expect_* が読むハーネス側のグローバル
  OUT="$(cd "$FX" && EXTERNAL_API_SMOKE_NOW="$1" \
    bash scripts/check-external-api-smoke-freshness.sh 2>&1)" || RC=$?
}

# ---------------------------------------------------------------------------
# 本命 1: 未実施（PENDING）。go-live の完了条件そのものであり、必ず赤で鳴り続けなければ
# ならない。層1 が PENDING を通す（枠を足す PR をマージ可能にする）代償をここで払う。

t_begin 'check-external-api-smoke-freshness: PENDING は必ず赤（go-live の完了条件）'
easf_fixture
easf_run 2026-08-16
expect_red '本番で一度も実疎通していません（PENDING）'
expect_output_matches 'go-live 完了ではありません'
# 署名は通知側との契約。状態が変わらない間に追跡 Issue へコメントを増やさないための鍵である。
expect_output_matches 'EXTERNAL-API-SMOKE-SIGNATURE: alpha=pending;'
t_end

t_begin 'check-external-api-smoke-freshness: 対照 — 実施日と証拠を入れると緑（1 条件差）'
easf_fixture
easf_decl \
  'alpha-key|alpha|2026-08-16|run-12345|#125|外部 API を叩く鍵' \
  'ops-only|-|-|-|#125|外部 API を叩かない'
easf_run 2026-08-16
expect_green
expect_output_matches 'EXTERNAL-API-SMOKE-SIGNATURE: alpha=ok;'
expect_output_matches '1 件検証'
t_end

# ---------------------------------------------------------------------------
# 本命 2: 閾値の両側。片側だけを固定すると、比較演算子の向きやオフフバイワンが素通りする。

t_begin 'check-external-api-smoke-freshness: 境界 — 有効期間ちょうど（14 日前）は緑'
easf_fixture
easf_decl \
  'alpha-key|alpha|2026-08-02|run-12345|#125|外部 API を叩く鍵' \
  'ops-only|-|-|-|#125|外部 API を叩かない'
easf_run 2026-08-16
expect_green
expect_absent '有効期間 14 日を超えています'
t_end

t_begin 'check-external-api-smoke-freshness: 境界 — 有効期間 +1 日（15 日前）は赤'
easf_fixture
easf_decl \
  'alpha-key|alpha|2026-08-01|run-12345|#125|外部 API を叩く鍵' \
  'ops-only|-|-|-|#125|外部 API を叩かない'
easf_run 2026-08-16
expect_red '15 日前（2026-08-01）で、有効期間 14 日を超えています'
expect_output_matches 'EXTERNAL-API-SMOKE-SIGNATURE: alpha=stale;'
t_end

# **署名に経過日数を載せない**という契約。載せると赤が続く限り毎日署名が変わり、
# report-ci-issue.sh の重複抑止が効かず追跡 Issue へ毎日コメントが増える。
t_begin 'check-external-api-smoke-freshness: 期限切れの署名は日数が変わっても不変（コメント増殖の防止）'
easf_fixture
easf_decl \
  'alpha-key|alpha|2026-08-01|run-12345|#125|外部 API を叩く鍵' \
  'ops-only|-|-|-|#125|外部 API を叩かない'
easf_run 2026-08-16
easf_sig_a="$(printf '%s\n' "$OUT" | sed -n 's/^EXTERNAL-API-SMOKE-SIGNATURE: //p')"
easf_run 2026-09-30
easf_sig_b="$(printf '%s\n' "$OUT" | sed -n 's/^EXTERNAL-API-SMOKE-SIGNATURE: //p')"
# 経過日数（15 日 / 60 日）は診断文には出るが署名には出ない。
expect_output_matches '60 日前'
OUT="SIG_A: ${easf_sig_a} / SIG_B: ${easf_sig_b}"
RC=0
expect_output_matches '^SIG_A: alpha=stale; / SIG_B: alpha=stale;$'
t_end

t_begin 'check-external-api-smoke-freshness: 未来日は stale と別判定にする（叩かずに日付だけ埋めた形）'
easf_fixture
easf_decl \
  'alpha-key|alpha|2026-12-31|run-12345|#125|外部 API を叩く鍵' \
  'ops-only|-|-|-|#125|外部 API を叩かない'
easf_run 2026-08-16
expect_red '基準日 2026-08-16 より未来です'
expect_output_matches 'EXTERNAL-API-SMOKE-SIGNATURE: alpha=future-date;'
# 未来日を stale と同じ診断に混ぜると、原因（記録の捏造 / 単なる放置）を取り違える。
expect_absent '有効期間 14 日を超えています'
t_end

# ---------------------------------------------------------------------------
# 日付演算の移植性。`date -d`（GNU）と `date -j -f`（BSD）は非互換なので、通日換算は
# 整数演算だけで行っている。うるう年・世紀境界・8 進解釈（08 / 09）が壊れやすい。

t_begin 'check-external-api-smoke-freshness: うるう日をまたいでも日数が合う（2024-02-29 起点）'
easf_fixture
easf_decl \
  'alpha-key|alpha|2024-02-29|run-12345|#125|うるう日' \
  'ops-only|-|-|-|#125|外部 API を叩かない'
easf_run 2024-03-08
# 2/29 → 3/8 は 8 日。うるう日を落とすと 7 日、二重に数えると 9 日になる。
expect_green
expect_output_matches '8 日前'
t_end

t_begin 'check-external-api-smoke-freshness: 先頭 0 の月日を 8 進数と解釈しない（08 / 09）'
easf_fixture
easf_decl \
  'alpha-key|alpha|2026-09-08|run-12345|#125|8 進解釈で落ちる並び' \
  'ops-only|-|-|-|#125|外部 API を叩かない'
easf_run 2026-09-09
expect_green
expect_output_matches '1 日前'
t_end

# ---------------------------------------------------------------------------
# 層間の接続と空振り防止。早期異常でも **必ず署名を出してから** 落ちる（空の署名を通知側へ
# 渡すと状態変化の判定ができず、赤が続く限り実行のたびにコメントが増える）。

t_begin 'check-external-api-smoke-freshness: 層1 が赤なら鮮度を判定せず打ち切る'
easf_fixture
# 正典にある ops-only の行を落とす（層1 の両方向照合が赤になる形）。
easf_decl 'alpha-key|alpha|2026-08-16|run-12345|#125|外部 API を叩く鍵'
easf_run 2026-08-16
expect_red 'EXTERNAL-API-SMOKE-SIGNATURE: early-exit=structure-broken;'
# 構造が壊れたまま鮮度を緑にすると、行の欠落が「対象外だから緑」へ化ける。
expect_absent 'すべて有効期間内'
t_end

t_begin 'check-external-api-smoke-freshness: 基準日の書式が不正なら緑を返さず署名を出す'
easf_fixture
easf_run '2026/08/16'
expect_red 'EXTERNAL-API-SMOKE-SIGNATURE: early-exit=bad-now;'
expect_output_matches 'YYYY-MM-DD で指定してください'
t_end

t_begin 'check-external-api-smoke-freshness: 宣言ファイルが無ければ緑を返さず署名を出す'
easf_fixture
rm -f "${FX}/infra/external-api-smoke.tsv"
easf_run 2026-08-16
expect_red 'EXTERNAL-API-SMOKE-SIGNATURE: early-exit=missing-declaration;'
t_end

t_begin 'check-external-api-smoke-freshness: 層1 ガードが無ければ緑を返さず署名を出す'
easf_fixture
rm -f "${FX}/scripts/check-external-api-smoke.sh"
easf_run 2026-08-16
expect_red 'EXTERNAL-API-SMOKE-SIGNATURE: early-exit=missing-structure-guard;'
t_end

t_begin 'check-external-api-smoke-freshness: 未知の引数は使い方の誤りとして落とす'
easf_fixture
fx_run_args check-external-api-smoke-freshness --nope
expect_red '未知の引数です'
t_end
