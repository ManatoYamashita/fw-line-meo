# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/check-external-api-smoke.sh の自己テスト（Issue #125）。
#
# 本ガードは「外部 API を叩く鍵の棚卸しが網羅されているか」「実疎通の記録が形として成立して
# いるか」を見る。#63 の二層は値そのものの正当性へ原理的に到達できない（CI は payload を
# 読めない）ため、実疎通は人手の out-of-band 作業であり、リポジトリ内の宣言だけが正典になる。
#
# **層1 は日付を一切見ない。** 鮮度は層2（check-external-api-smoke-freshness.sh）が持つ。
# ts-ci が時間依存になると、何も触っていない PR がある日突然赤くなり、規律は「実疎通せずに
# 日付だけ更新する」空洞化へ倒れる。この分界は宣言ではなく **ガード本体に date が 1 箇所も
# 無いという構造** で担保する（最後のケースがそれを機械検証する）。

eas_decl() {
  # $1 以降 = '<secret_id>|<api>|<最終確認日>|<証拠>|<Issue-PR>|<説明>'。
  # `|` を実タブへ変換して書く（heredoc へ実タブを埋め込むと編集や diff で見えないまま壊れる）。
  {
    printf '# 自己テストの宣言 fixture（Issue #125）\n'
    for eas_row in "$@"; do
      printf '%s\n' "$eas_row" | tr '|' '\t'
    done
  } > "${FX}/infra/external-api-smoke.tsv"
}

eas_readme() {
  # §1 項目 5（層1 が呼ぶ check-secret-declaration-coverage.sh の照合対象）と
  # §8（本ガードの照合対象）の両方を持つ README を書く。
  # $1 以降 = §8 に置く api 名。
  {
    printf '# infra runbook（自己テスト fixture）\n'
    printf '\n'
    printf '5. Secret Manager の値投入:\n'
    printf '   printf %%s "<VALUE>" | gcloud secrets versions add alpha-key --data-file=- --project=proj\n'
    printf '   printf %%s "<VALUE>" | gcloud secrets versions add ops-only  --data-file=- --project=proj\n'
    printf '\n'
    printf '## 8. 外部 API 実疎通の手順\n'
    printf '\n'
    printf '### 8-0. 一括実行\n'
    printf '\n'
    for eas_api in "$@"; do
      printf '### 8-1. %s: 自己テスト用の節\n' "$eas_api"
      printf '\n'
    done
    printf '### 8-4. 記録の更新\n'
  } > "${FX}/infra/README.md"
}

eas_fixture() {
  fx_guard check-external-api-smoke
  # 層1 は secret 正典を check-secret-declaration-coverage.sh --print-secrets から導出する
  # （列挙を二重管理しない）。したがって上流ガードも合成ツリーへ要る。
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
  eas_readme alpha
  eas_decl \
    'alpha-key|alpha|PENDING|-|#125|外部 API を叩く鍵' \
    'ops-only|-|-|-|#125|運用者だけが使う枠で外部 API を叩かない'
}

t_begin 'check-external-api-smoke: 正典・宣言・README §8 が揃っていれば緑（PENDING は層1 では通す）'
eas_fixture
fx_run check-external-api-smoke
expect_green
# 空振り防止の可視化。件数が出ない緑は「何も検証していない緑」と区別できない。
expect_output_matches 'secret 正典 2 件'
expect_output_matches '実疎通対象 1・うち PENDING 1'
expect_output_matches 'README §8 手順 1 件'
t_end

# ---------------------------------------------------------------------------
# 本命 1: 棚卸しの漏れ。tf へ枠を足したのに宣言へ行を足さなかった形。分類（api か '-' か）を
# 必ず選ばせることで、漏れが「行が無い」という不可視の形にならないようにしている。

t_begin 'check-external-api-smoke: 正典にある secret が宣言に無ければ赤'
eas_fixture
eas_decl 'alpha-key|alpha|PENDING|-|#125|外部 API を叩く鍵'
fx_run check-external-api-smoke
expect_red "secret 正典の 'ops-only' が infra/external-api-smoke.tsv にありません"
t_end

t_begin 'check-external-api-smoke: 対照 — 対象外として 1 行足すと緑（1 条件差）'
eas_fixture
eas_decl \
  'alpha-key|alpha|PENDING|-|#125|外部 API を叩く鍵' \
  'ops-only|-|-|-|#125|外部 API を叩かない'
fx_run check-external-api-smoke
expect_green
t_end

t_begin 'check-external-api-smoke: 宣言にある secret が正典に無ければ赤（枠を消した取り残し）'
eas_fixture
eas_decl \
  'alpha-key|alpha|PENDING|-|#125|外部 API を叩く鍵' \
  'ops-only|-|-|-|#125|外部 API を叩かない' \
  'ghost-key|-|-|-|#125|正典から消えた枠'
fx_run check-external-api-smoke
expect_red "infra/external-api-smoke.tsv の 'ghost-key' が secret 正典にありません"
t_end

# ---------------------------------------------------------------------------
# 本命 2: api の綴りと手順書の対応。api の語彙をガードへ列挙しないので、
# **宣言と README が互いの正典になる**。片側の綴り間違いは必ず両方向のどちらかで落ちる。

t_begin 'check-external-api-smoke: 宣言の api に対応する §8 の節が無ければ赤'
eas_fixture
eas_decl \
  'alpha-key|alfa|PENDING|-|#125|api の綴りを間違えた' \
  'ops-only|-|-|-|#125|外部 API を叩かない'
fx_run check-external-api-smoke
expect_red "api 'alfa' に対応する手順が infra/README.md §8 にありません"
# 逆方向も同時に鳴る（README の 'alpha' に対応する行が無い）。片側だけの照合では
# 「綴りを両方同時に間違えた」ときに素通りする。
expect_output_matches "§8 の手順にある api 'alpha' が"
t_end

t_begin 'check-external-api-smoke: §8 に節があって宣言に行が無ければ赤（手順だけが残る）'
eas_fixture
eas_readme alpha beta
fx_run check-external-api-smoke
expect_red "§8 の手順にある api 'beta' が infra/external-api-smoke.tsv にありません"
t_end

# ---------------------------------------------------------------------------
# 本命 3: 記録の形。証拠の無い日付は「叩いたことにした」を許してしまう。

t_begin 'check-external-api-smoke: 実施日が入っているのに証拠が - なら赤'
eas_fixture
eas_decl \
  'alpha-key|alpha|2026-08-16|-|#125|証拠を書かなかった' \
  'ops-only|-|-|-|#125|外部 API を叩かない'
fx_run check-external-api-smoke
expect_red '実施日が入っているのに証拠が'
t_end

t_begin 'check-external-api-smoke: 対照 — 証拠を書けば緑（1 条件差）'
eas_fixture
eas_decl \
  'alpha-key|alpha|2026-08-16|run-12345|#125|証拠あり' \
  'ops-only|-|-|-|#125|外部 API を叩かない'
fx_run check-external-api-smoke
expect_green
# 層1 は日付の新旧を見ない。古い日付でも緑であることを固定する（鮮度は層2 の責務）。
expect_absent '期限切れ'
t_end

t_begin 'check-external-api-smoke: 層1 は日付が古くても緑（鮮度は層2 の責務）'
eas_fixture
eas_decl \
  'alpha-key|alpha|2001-01-01|run-old|#125|20 年以上前' \
  'ops-only|-|-|-|#125|外部 API を叩かない'
fx_run check-external-api-smoke
expect_green
t_end

t_begin 'check-external-api-smoke: PENDING なのに証拠が入っていたら赤'
eas_fixture
eas_decl \
  'alpha-key|alpha|PENDING|run-12345|#125|未実施なのに証拠がある' \
  'ops-only|-|-|-|#125|外部 API を叩かない'
fx_run check-external-api-smoke
expect_red 'PENDING（未実施）なので証拠は'
t_end

t_begin 'check-external-api-smoke: 対象外なのに日付が入っていたら赤'
eas_fixture
eas_decl \
  'alpha-key|alpha|PENDING|-|#125|外部 API を叩く鍵' \
  'ops-only|-|2026-08-16|-|#125|対象外なのに日付がある'
fx_run check-external-api-smoke
expect_red "api が '-'（実疎通の対象外）なので最終確認日と証拠は"
t_end

t_begin 'check-external-api-smoke: 最終確認日が YYYY-MM-DD でも PENDING でもなければ赤'
eas_fixture
eas_decl \
  'alpha-key|alpha|2026/08/16|run-12345|#125|書式違反' \
  'ops-only|-|-|-|#125|外部 API を叩かない'
fx_run check-external-api-smoke
expect_red '最終確認日は YYYY-MM-DD か PENDING で書いてください'
t_end

t_begin 'check-external-api-smoke: 列が 6 列を超えたら赤（タブの混入を読み飛ばさない）'
eas_fixture
eas_decl \
  'alpha-key|alpha|PENDING|-|#125|説明|余計な列' \
  'ops-only|-|-|-|#125|外部 API を叩かない'
fx_run check-external-api-smoke
expect_red '列が 6 列を超えています'
t_end

t_begin 'check-external-api-smoke: 6 列に満たない行は赤（説明の書き忘れを含む）'
eas_fixture
eas_decl \
  'alpha-key|alpha|PENDING|-|#125' \
  'ops-only|-|-|-|#125|外部 API を叩かない'
fx_run check-external-api-smoke
expect_red '6 列（secret_id / api / 最終確認日 / 証拠 / Issue-PR / 説明）が揃っていません'
t_end

t_begin 'check-external-api-smoke: secret_id の重複は赤（どちらが正か決まらない）'
eas_fixture
eas_decl \
  'alpha-key|alpha|PENDING|-|#125|外部 API を叩く鍵' \
  'alpha-key|-|-|-|#125|重複行' \
  'ops-only|-|-|-|#125|外部 API を叩かない'
fx_run check-external-api-smoke
expect_red '宣言ファイルに重複しています'
t_end

t_begin 'check-external-api-smoke: Issue-PR 列の書式違反は赤'
eas_fixture
eas_decl \
  'alpha-key|alpha|PENDING|-|125|# が無い' \
  'ops-only|-|-|-|#125|外部 API を叩かない'
fx_run check-external-api-smoke
expect_red "Issue-PR 列は '#<番号>' の形で書いてください"
t_end

# ---------------------------------------------------------------------------
# 空振り防止。対象 0 件のまま「乖離なし」で緑を返すのが最悪の結果である。
# とくに **全行を対象外へ倒す** 形は、層2 が何も見ないまま恒久的に緑になるため必ず赤にする。

t_begin 'check-external-api-smoke: 全行を対象外へ倒したら赤（層2 が空振りするのを防ぐ）'
eas_fixture
eas_decl \
  'alpha-key|-|-|-|#125|対象外へ倒した' \
  'ops-only|-|-|-|#125|外部 API を叩かない'
fx_run check-external-api-smoke
expect_red "実疎通の対象（api が '-' 以外）が1件もありません"
t_end

t_begin 'check-external-api-smoke: 宣言がコメントだけなら赤'
eas_fixture
eas_decl
fx_run check-external-api-smoke
expect_red 'データ行を1行も読めませんでした'
t_end

t_begin 'check-external-api-smoke: §8 の見出し書式が変わって抽出 0 件なら赤'
eas_fixture
eas_readme
fx_run check-external-api-smoke
expect_red '見出しを1件も抽出できませんでした'
t_end

t_begin 'check-external-api-smoke: 上流の secret 正典が赤なら緑を返さず打ち切る'
eas_fixture
# 正典の複数行リスト定義を 1 行へ潰す（上流ガードが赤になる形）。
fx_write infra/modules/secrets/main.tf <<'EOF'
locals {
  secret_ids = ["alpha-key", "ops-only"]
}
EOF
fx_run check-external-api-smoke
expect_red 'secret 正典を取得できません'
# 壊れた正典から導出した集合で下流を緑にするのが最悪の空振りであるため、救済しない。
expect_absent '宣言カバレッジ緑'
t_end

t_begin 'check-external-api-smoke: 未知の引数は使い方の誤りとして落とす'
eas_fixture
fx_run_args check-external-api-smoke --nope
expect_red '未知の引数です'
t_end

# ---------------------------------------------------------------------------
# 分界の構造的検証。「層1 は日付を見ない」は宣言ではなく **コードに date が無いこと** で
# 担保する。コメントで約束しただけでは、次に鮮度判定を足したくなった人が層1 へ書いてしまい、
# 無関係な PR が突然赤くなる形が戻ってくる（[[stale-safety-notes-are-misdirection]] と同型）。

t_begin 'check-external-api-smoke: 層1 のコード行に date 呼び出しが 1 件も無い（時間非依存の構造保証）'
eas_fixture
eas_date_rc=0
# 全行コメント（`#` 始まり）を除いてからコード行だけを見る。ヘッダの解説文には date の語が
# 出るため、これを数えると常に 1 件以上になり、アサーションが空振りする。
eas_date_hits="$(grep -vE '^[[:space:]]*#' "${FX}/scripts/check-external-api-smoke.sh" \
  | grep -cE '(^|[^[:alnum:]_-])date([^[:alnum:]_-]|$)')" || eas_date_rc=$?
if [ "$eas_date_rc" -gt 1 ]; then
  _t_fail "date 呼び出しの抽出パターンを評価できません（grep exit=${eas_date_rc}）"
fi
# shellcheck disable=SC2034 # OUT / RC は run.sh の expect_* が読むハーネス側のグローバル
OUT="DATE_CALLS: ${eas_date_hits:-0}"
# shellcheck disable=SC2034 # 同上
RC=0
expect_output_matches '^DATE_CALLS: 0$'
t_end
