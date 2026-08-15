# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/check-secret-version-drift.sh の自己テスト（Issue #63）。
#
# 本ガードは「宣言どおりの version が現に稼働しているか」を本番のメタデータで確かめる。
# 静的な照合（層1）は「宣言があるか」までしか言えないため、宣言が実態と乖離しても緑になる。
#
# 実測（2026-08-15）で本番は 3 件が stale-enabled-version だった。枠作成直後に一斉投入された
# プレースホルダー version 1 が ENABLED のまま残っており、`version = "latest"` の解決先が
# 宣言から決まらない状態である。この形をケース 2 で赤に固定する。
#
# **時刻に依存しない。** 判定は version の番号と state だけで決まるので、決定的テストに時刻の
# 固定（DRIFT_NOW_EPOCH 相当）が要らない。作成時刻は診断文へ添えるためだけに snapshot が運ぶ。

svd_targets() {
  # $1 以降 = '<secret_id>|<version>'。`|` を実タブへ変換して書く（heredoc へ実タブを
  # 埋め込むと編集や diff で見えないまま壊れるため、区切りは目に見える文字で書く）。
  {
    for svd_row in "$@"; do
      printf '%s\n' "$svd_row" | tr '|' '\t'
    done
  } > "${FX}/targets.tsv"
}

svd_snapshot() {
  # $1 以降 = '<kind>|<secret_id>|<version>|<state>|<create_time>'。同じく `|` を実タブへ変換する。
  {
    printf '# 自己テストの snapshot fixture（Issue #63）\n'
    printf '\n'
    for svd_row in "$@"; do
      printf '%s\n' "$svd_row" | tr '|' '\t'
    done
  } > "${FX}/snapshot.tsv"
}

svd_fixture() {
  fx_guard check-secret-version-drift
  svd_targets 'alpha-key|2' 'ops-only|1'
  svd_snapshot \
    'secret|alpha-key|-|-|-' \
    'version|alpha-key|2|ENABLED|2026-07-12T00:54:00Z' \
    'version|alpha-key|1|DISABLED|2026-07-05T01:33:00Z' \
    'secret|ops-only|-|-|-' \
    'version|ops-only|1|ENABLED|2026-07-20T08:40:00Z'
}

svd_canon_fixture() {
  # 層1 を実際に呼ばせる経路（live-canon）のために、層1 の検証対象を合成ツリーへ揃える。
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
  fx_write infra/README.md <<'EOF'
# infra runbook（自己テスト fixture）

5. Secret Manager の値投入:
   printf %s "<VALUE>" | gcloud secrets versions add alpha-key --data-file=- --project=proj
   printf %s "<VALUE>" | gcloud secrets versions add ops-only  --data-file=- --project=proj
EOF
  fx_write infra/envs/prod/main.tf <<'EOF'
module "run_services" {
  secret_env = {
    ALPHA = module.secrets.secret_ids["alpha-key"]
  }
}
EOF
}

svd_run() {
  # 注入用の環境変数はこの関数の中で閉じる（ケース間に漏らさない）。fx_run 相当だが、
  # このガードだけは環境変数で状態を注入するため専用の runner を持つ。
  # $1 が 'live-canon' なら SECRET_TARGETS_FILE を渡さず、層1 を実際に呼ばせる（層間の接続の検証）。
  # PROJECT_ID は SVD_PROJECT_ID で上書きできる（`-` 展開なので空文字も渡せる＝未設定の検証用）。
  OUT=''
  RC=0
  if [ "${1:-}" = 'live-canon' ]; then
    # shellcheck disable=SC2034 # OUT / RC は run.sh の expect_* が読むハーネス側のグローバル
    OUT="$(cd "$FX" && \
      PROJECT_ID="${SVD_PROJECT_ID-proj}" \
      PROD_SECRET_SNAPSHOT="${FX}/snapshot.tsv" \
      bash scripts/check-secret-version-drift.sh 2>&1)" || RC=$?
  else
    # shellcheck disable=SC2034 # OUT / RC は run.sh の expect_* が読むハーネス側のグローバル
    OUT="$(cd "$FX" && \
      PROJECT_ID="${SVD_PROJECT_ID-proj}" \
      SECRET_TARGETS_FILE="${FX}/targets.tsv" \
      PROD_SECRET_SNAPSHOT="${FX}/snapshot.tsv" \
      bash scripts/check-secret-version-drift.sh 2>&1)" || RC=$?
  fi
}

svd_whitelist() {
  # 合成ツリーへ複製したガードの `WHITELIST=()` へ項目を注入する（$1 = 括弧の中身をそのまま）。
  awk -v entry="$1" '
    /^WHITELIST=\(\)$/ { print "WHITELIST=(" entry ")"; next }
    { print }
  ' "${FX}/scripts/check-secret-version-drift.sh" > "${FX}/scripts/svd-whitelist.tmp"
  mv "${FX}/scripts/svd-whitelist.tmp" "${FX}/scripts/check-secret-version-drift.sh"

  # **注入が当たったことを先に確かめる。** 空振りしたまま走らせると、ガードが元のまま緑を
  # 返した結果を「WHITELIST が効いた証拠」と読み違える（[[guard-before-fix-discipline]]）。
  if [ "$(grep -cF "$1" "${FX}/scripts/check-secret-version-drift.sh")" -eq 0 ]; then
    _t_fail "WHITELIST の注入が空振りしました: $1"
  fi
}

t_begin 'check-secret-version-drift: 宣言 version が唯一の ENABLED なら緑（署名まで照合）'
svd_fixture
svd_run
expect_green
expect_output_matches '2 件検証'
# 署名は通知側との契約。状態が変わらない間に追跡 Issue へコメントを増やさないための鍵である。
expect_output_matches 'SECRET-SIGNATURE: alpha-key=ok@2;ops-only=ok@1;'
# fixture 実行を本番の実測と誤読させない。
expect_output_matches '注入モードで実行中です'
t_end

# ---------------------------------------------------------------------------
# 本命 1: 枠作成直後に投入されたプレースホルダーが ENABLED のまま残る形。実測で本番の
# 3 件（places-api-key / db-admin-password / gemini-api-key）がこの状態だった。
# Cloud Run は version = "latest" でマウントし pin を持たないため、この状態では
# 「どの値が読まれているか」が宣言から決まらない。

t_begin 'check-secret-version-drift: 旧 version が ENABLED のまま残っていたら赤'
svd_fixture
svd_snapshot \
  'secret|alpha-key|-|-|-' \
  'version|alpha-key|2|ENABLED|2026-07-12T00:54:00Z' \
  'version|alpha-key|1|ENABLED|2026-07-05T01:33:00Z' \
  'secret|ops-only|-|-|-' \
  'version|ops-only|1|ENABLED|2026-07-20T08:40:00Z'
svd_run
expect_red 'stale-enabled-version'
expect_output_matches 'version 1 が ENABLED のまま残っています'
# そのまま貼れる是正コマンドを出す（「disable せよ」だけでは対象と project が決まらない）。
expect_output_matches 'gcloud secrets versions disable 1 --secret=alpha-key --project=proj'
t_end

t_begin 'check-secret-version-drift: 対照 — 旧 version を DISABLED へ戻すと緑（1 条件差）'
svd_fixture
svd_snapshot \
  'secret|alpha-key|-|-|-' \
  'version|alpha-key|2|ENABLED|2026-07-12T00:54:00Z' \
  'version|alpha-key|1|DISABLED|2026-07-05T01:33:00Z' \
  'secret|ops-only|-|-|-' \
  'version|ops-only|1|ENABLED|2026-07-20T08:40:00Z'
svd_run
expect_green
expect_absent 'stale-enabled-version'
t_end

# ---------------------------------------------------------------------------
# 本命 2: 宣言が実態より先走った形。「投入したつもりで宣言だけ更新した」がこれになる。

t_begin 'check-secret-version-drift: 宣言 version が本番に存在しなければ赤'
svd_fixture
svd_snapshot \
  'secret|alpha-key|-|-|-' \
  'version|alpha-key|1|ENABLED|2026-07-05T01:33:00Z' \
  'secret|ops-only|-|-|-' \
  'version|ops-only|1|ENABLED|2026-07-20T08:40:00Z'
svd_run
expect_red 'declared-version-missing'
expect_output_matches '宣言が先走った|投入していないのに宣言した'
t_end

t_begin 'check-secret-version-drift: 宣言 version が DISABLED なら赤'
svd_fixture
svd_snapshot \
  'secret|alpha-key|-|-|-' \
  'version|alpha-key|2|DISABLED|2026-07-12T00:54:00Z' \
  'version|alpha-key|1|DISABLED|2026-07-05T01:33:00Z' \
  'secret|ops-only|-|-|-' \
  'version|ops-only|1|ENABLED|2026-07-20T08:40:00Z'
svd_run
expect_red 'no-enabled-version'
t_end

t_begin 'check-secret-version-drift: 宣言 version が DISABLED で他に ENABLED があっても 1 件だけ報告する'
svd_fixture
svd_snapshot \
  'secret|alpha-key|-|-|-' \
  'version|alpha-key|2|DISABLED|2026-07-12T00:54:00Z' \
  'version|alpha-key|1|ENABLED|2026-07-05T01:33:00Z' \
  'secret|ops-only|-|-|-' \
  'version|ops-only|1|ENABLED|2026-07-20T08:40:00Z'
svd_run
# 原因は 1 つ（宣言 version が有効でない）なので、指示を重ねて出してはいけない。
expect_red 'declared-version-disabled'
expect_absent 'stale-enabled-version'
t_end

t_begin 'check-secret-version-drift: version が 1 件も無ければ赤（枠だけが存在する）'
svd_fixture
svd_snapshot \
  'secret|alpha-key|-|-|-' \
  'version|alpha-key|2|ENABLED|2026-07-12T00:54:00Z' \
  'secret|ops-only|-|-|-'
svd_run
expect_red 'no-version'
t_end

t_begin 'check-secret-version-drift: 宣言より新しい非 DESTROYED version が残っていたら赤'
svd_fixture
svd_snapshot \
  'secret|alpha-key|-|-|-' \
  'version|alpha-key|3|DISABLED|2026-08-02T00:00:00Z' \
  'version|alpha-key|2|ENABLED|2026-07-12T00:54:00Z' \
  'secret|ops-only|-|-|-' \
  'version|ops-only|1|ENABLED|2026-07-20T08:40:00Z'
svd_run
expect_red 'newer-version-undeclared'
t_end

t_begin 'check-secret-version-drift: 対照 — 新しい version が DESTROYED なら緑（latest の解決に影響しない）'
svd_fixture
svd_snapshot \
  'secret|alpha-key|-|-|-' \
  'version|alpha-key|3|DESTROYED|2026-08-02T00:00:00Z' \
  'version|alpha-key|2|ENABLED|2026-07-12T00:54:00Z' \
  'secret|ops-only|-|-|-' \
  'version|ops-only|1|ENABLED|2026-07-20T08:40:00Z'
svd_run
expect_green
expect_absent 'newer-version-undeclared'
t_end

t_begin 'check-secret-version-drift: PENDING 宣言は必ず赤（実値未投入を埋もれさせない）'
svd_fixture
svd_targets 'alpha-key|2' 'ops-only|PENDING'
svd_run
# 層1 は PENDING を緑にする（枠を足す PR をマージ可能にするため）。その代わりここで必ず赤にし、
# 「宣言された未完了」が誰にも読まれないまま残ることを防ぐ。
expect_red 'pending-declaration'
expect_output_matches '§1 項目 5'
t_end

t_begin 'check-secret-version-drift: 枠が本番に無ければ赤（tf 未適用）'
svd_fixture
svd_snapshot \
  'secret|alpha-key|-|MISSING|-' \
  'secret|ops-only|-|-|-' \
  'version|ops-only|1|ENABLED|2026-07-20T08:40:00Z'
svd_run
expect_red 'missing-frame'
expect_output_matches 'make tf-apply'
t_end

# ---------------------------------------------------------------------------
# 空振り防止。対象 0 件・実測 0 件のまま「乖離なし」で緑を返すのが最悪の結果である。
# 早期異常でも **必ず署名を出してから** 落ちる（空の署名を通知側へ渡すと状態変化の判定が
# できず、赤が続く限り 6 時間ごとに追跡 Issue へコメントが増える）。

t_begin 'check-secret-version-drift: snapshot が空なら緑を返さず署名を出す'
svd_fixture
svd_snapshot
svd_run
expect_red '1行も取得できませんでした'
expect_output_matches 'SECRET-SIGNATURE: early-exit=snapshot-empty;'
t_end

t_begin 'check-secret-version-drift: 正典が空なら緑を返さず署名を出す'
svd_fixture
svd_targets
svd_run
expect_red '宣言を1件も取得できませんでした'
expect_output_matches 'SECRET-SIGNATURE: early-exit=canon-empty;'
t_end

t_begin 'check-secret-version-drift: snapshot に形式の合わない行があれば読み飛ばさず赤'
svd_fixture
svd_snapshot \
  'secret|alpha-key|-|-|-' \
  'version|alpha-key|latest|ENABLED|2026-07-12T00:54:00Z' \
  'secret|ops-only|-|-|-' \
  'version|ops-only|1|ENABLED|2026-07-20T08:40:00Z'
svd_run
# 壊れた行を黙って読み飛ばすと、その secret だけ検証されないまま緑になる。
expect_red 'SECRET-SIGNATURE: early-exit=snapshot-malformed;'
expect_output_matches 'version	alpha-key	latest'
t_end

t_begin 'check-secret-version-drift: PROJECT_ID 未設定なら既定値へ落ちず赤'
svd_fixture
SVD_PROJECT_ID=''
svd_run
unset SVD_PROJECT_ID
expect_red 'PROJECT_ID が未設定'
expect_output_matches 'SECRET-SIGNATURE: early-exit=config-error;'
t_end

# ---------------------------------------------------------------------------
# 層間の接続。正典は宣言ファイルを直接読むのではなく層1 の --print-secrets から得る
# （宣言だけが正典ではなく、tf・README・消費側配線と整合していてはじめて正典になる）。

t_begin 'check-secret-version-drift: 層1 から正典を受け取って検証できる（接続の正常系）'
svd_fixture
svd_canon_fixture
svd_run live-canon
expect_green
expect_output_matches '2 件検証'
t_end

t_begin 'check-secret-version-drift: 層1 が赤なら version 検証を打ち切る'
svd_fixture
# 層1 は複製するが検証対象を 1 つも置かない（＝層1 が赤になる）。
fx_guard check-secret-declaration-coverage
svd_run live-canon
expect_red '正典（check-secret-declaration-coverage.sh）が赤'
expect_output_matches 'SECRET-SIGNATURE: early-exit=canon-red;'
t_end

# ---------------------------------------------------------------------------
# WHITELIST。同定は (secret, 判定) の組で行い、**version 番号は使わない**
# （番号はローテのたびに変わり、意図しない別の違反を無言で抑止する）。

t_begin 'check-secret-version-drift: WHITELIST は (secret, 判定) の組で除外できる'
svd_fixture
svd_snapshot \
  'secret|alpha-key|-|-|-' \
  'version|alpha-key|2|ENABLED|2026-07-12T00:54:00Z' \
  'version|alpha-key|1|ENABLED|2026-07-05T01:33:00Z' \
  'secret|ops-only|-|-|-' \
  'version|ops-only|1|ENABLED|2026-07-20T08:40:00Z'
svd_whitelist "'alpha-key|stale-enabled-version'"
svd_run
expect_green
expect_output_matches 'SKIP: alpha-key（stale-enabled-version'
t_end

t_begin 'check-secret-version-drift: 別の判定の WHITELIST では除外されない'
svd_fixture
svd_snapshot \
  'secret|alpha-key|-|-|-' \
  'version|alpha-key|2|ENABLED|2026-07-12T00:54:00Z' \
  'version|alpha-key|1|ENABLED|2026-07-05T01:33:00Z' \
  'secret|ops-only|-|-|-' \
  'version|ops-only|1|ENABLED|2026-07-20T08:40:00Z'
svd_whitelist "'alpha-key|declared-version-missing'"
svd_run
expect_red 'stale-enabled-version'
t_end

t_begin 'check-secret-version-drift: 当たらなくなった WHITELIST 項目を WARNING で報告する'
svd_fixture
svd_whitelist "'alpha-key|stale-enabled-version'"
svd_run
expect_green
expect_output_matches 'WARNING: .*は WHITELIST に載っていますが乖離として検出されませんでした'
t_end

t_begin 'check-secret-version-drift: 未知の引数は使い方の誤りとして落とす'
svd_fixture
fx_run_args check-secret-version-drift --nope
expect_red '未知の引数です'
t_end
