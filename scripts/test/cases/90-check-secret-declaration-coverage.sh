# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/check-secret-declaration-coverage.sh の自己テスト（Issue #63）。
#
# 本ガードが防ぐのは「枠はある・tf 成功・デプロイ成功・CI 全緑、しかし値が入っていない」である。
# Secret Manager の値（version）は tf が作らず人間が out-of-band 投入するため、投入漏れは
# どの機械検証にも映らない（gemini-api-key で 4 週間実発生）。
#
# 合成ツリーは実リポジトリの罠を 2 つ再現する:
#   (1) tf の secret_ids は **複数行** リスト定義である（push-images.sh の 1 行 IMAGE_NAMES とは
#       違い、範囲を先に確定しないと範囲外の引用符まで拾う）。
#   (2) README は §1 項目 6 の散文でも secret 名に言及する。素朴な出現数カウントは二重計上する
#       ため、抽出は `gcloud secrets versions add <id>` の行に限らねばならない。
#
# fixture の secret は 2 件。alpha-key は消費側から参照され、ops-only は参照されない
# （accessor だけの枠・運用者専用の枠が正当に存在し得ることの再現。本ガードは「全 secret が
#  消費されている」を検証しない）。

sdc_tf() {
  # 正典（複数行リスト定義）。$1 が 'oneline' なら 1 行定義、'unclosed' なら閉じ括弧を
  # 行頭に置かない形で書く（どちらも範囲抽出の前提が崩れる形）。
  case "${1:-multiline}" in
    oneline)
      fx_write infra/modules/secrets/main.tf <<'EOF'
locals {
  secret_ids = ["alpha-key", "ops-only"]
}
EOF
      ;;
    unclosed)
      fx_write infra/modules/secrets/main.tf <<'EOF'
locals {
  secret_ids = [
    "alpha-key",
    "ops-only" ]
}
EOF
      ;;
    *)
      fx_write infra/modules/secrets/main.tf <<'EOF'
locals {
  secret_ids = [
    "alpha-key", # 消費側から参照される
    "ops-only",  # 運用者専用（消費側からは参照しない）
  ]
}

resource "google_secret_manager_secret" "frames" {
  for_each = toset(local.secret_ids)
}
EOF
      ;;
  esac
}

sdc_decl() {
  # 宣言ファイルを書く。$1 以降 = '<id>|<version>|<投入日>|<Issue>'。`|` を実タブへ変換する。
  # heredoc へ実タブを埋め込むと編集や diff で見えないまま壊れるため、区切りは目に見える
  # 文字で書いて書き出す直前に変換する。
  mkdir -p "${FX}/infra"
  {
    printf '# 自己テストの宣言 fixture（Issue #63）\n'
    printf '\n'
    for sdc_row in "$@"; do
      printf '%s\n' "$sdc_row" | tr '|' '\t'
    done
  } > "${FX}/infra/secrets-provisioned.tsv"
}

sdc_readme() {
  # $1 が 'no-ops' なら項目 5 から ops-only の投入コマンドだけを落とす（**項目 6 の散文言及は
  # 残す**）。$1 が 'ghost' なら正典に無い secret の投入手順を足す。'empty' なら投入手順を全消し。
  case "${1:-full}" in
    no-ops)
      fx_write infra/README.md <<'EOF'
# infra runbook（自己テスト fixture）

5. Secret Manager の値投入:
   printf %s "<VALUE>" | gcloud secrets versions add alpha-key --data-file=- --project=proj

6. postgres 管理ユーザーのパスワード設定（値は ops-only 枠へ）:
   gcloud sql users set-password postgres --instance=pg --project=proj
EOF
      ;;
    no-prose)
      fx_write infra/README.md <<'EOF'
# infra runbook（自己テスト fixture）

5. Secret Manager の値投入:
   printf %s "<VALUE>" | gcloud secrets versions add alpha-key --data-file=- --project=proj
   printf %s "<VALUE>" | gcloud secrets versions add ops-only  --data-file=- --project=proj
EOF
      ;;
    ghost)
      fx_write infra/README.md <<'EOF'
# infra runbook（自己テスト fixture）

5. Secret Manager の値投入:
   printf %s "<VALUE>" | gcloud secrets versions add alpha-key --data-file=- --project=proj
   printf %s "<VALUE>" | gcloud secrets versions add ops-only  --data-file=- --project=proj
   printf %s "<VALUE>" | gcloud secrets versions add ghost-key --data-file=- --project=proj
EOF
      ;;
    empty)
      fx_write infra/README.md <<'EOF'
# infra runbook（自己テスト fixture）

5. Secret Manager の値投入手順は別紙へ移した。
EOF
      ;;
    *)
      fx_write infra/README.md <<'EOF'
# infra runbook（自己テスト fixture）

5. Secret Manager の値投入:
   printf %s "<VALUE>" | gcloud secrets versions add alpha-key --data-file=- --project=proj
   printf %s "<VALUE>" | gcloud secrets versions add ops-only  --data-file=- --project=proj

6. postgres 管理ユーザーのパスワード設定（値は ops-only 枠へ）:
   gcloud sql users set-password postgres --instance=pg --project=proj
EOF
      ;;
  esac
}

sdc_consumer() {
  # $1 が 'ghost' なら正典に無いキーを参照、'none' なら参照を 1 件も持たない。
  case "${1:-full}" in
    ghost)
      fx_write infra/envs/prod/main.tf <<'EOF'
module "run_services" {
  services = {
    "web" = {
      secret_env = {
        ALPHA = module.secrets.secret_ids["alpha-key"]
        GHOST = module.secrets.secret_ids["ghost-key"]
      }
    }
  }
}
EOF
      ;;
    none)
      fx_write infra/envs/prod/main.tf <<'EOF'
module "run_services" {
  services = {
    "web" = {
      secret_env = {}
    }
  }
}
EOF
      ;;
    *)
      fx_write infra/envs/prod/main.tf <<'EOF'
module "run_services" {
  services = {
    "web" = {
      secret_env = {
        ALPHA = module.secrets.secret_ids["alpha-key"]
      }
    }
  }
}
EOF
      ;;
  esac
}

sdc_fixture() {
  fx_guard check-secret-declaration-coverage
  sdc_tf
  sdc_decl 'alpha-key|2|2026-07-12|#63' 'ops-only|1|2026-07-20|#63'
  sdc_readme
  sdc_consumer
}

sdc_whitelist() {
  # 合成ツリーへ複製したガードの `WHITELIST=()` へ項目を注入する（$1 = 括弧の中身をそのまま）。
  # `sed -i` はプラットフォームで引数が異なるため awk と mv で行う。
  awk -v entry="$1" '
    /^WHITELIST=\(\)$/ { print "WHITELIST=(" entry ")"; next }
    { print }
  ' "${FX}/scripts/check-secret-declaration-coverage.sh" > "${FX}/scripts/sdc-whitelist.tmp"
  mv "${FX}/scripts/sdc-whitelist.tmp" "${FX}/scripts/check-secret-declaration-coverage.sh"

  # **注入が当たったことを先に確かめる。** 空振りしたまま走らせると、ガードが元のまま緑を
  # 返した結果を「WHITELIST が効いた証拠」と読み違える（[[guard-before-fix-discipline]]）。
  if [ "$(grep -cF "$1" "${FX}/scripts/check-secret-declaration-coverage.sh")" -eq 0 ]; then
    _t_fail "WHITELIST の注入が空振りしました: $1"
  fi
}

t_begin 'check-secret-declaration-coverage: 正典・宣言・README・消費側が揃っていれば緑（件数まで照合）'
sdc_fixture
fx_run check-secret-declaration-coverage
expect_green
# 「OK」だけでなく件数を照合する。走査が空振りしたまま緑になる経路と区別するため。
expect_output_matches '正典 2 件'
expect_output_matches '宣言 2 行'
expect_output_matches 'README 手順 2 件'
expect_output_matches '消費側参照 1 件照合'
t_end

# ---------------------------------------------------------------------------
# 本命 1: tf へ枠を足して宣言を忘れた形。これを赤にできることが、投入漏れを本番へ出す前に
# 捕まえられる唯一の根拠である（GCP の annotation 方式ではこの時点で赤にできない）。

t_begin 'check-secret-declaration-coverage: 正典にあるのに宣言に無い枠を検出する'
sdc_fixture
sdc_decl 'alpha-key|2|2026-07-12|#63'
fx_run check-secret-declaration-coverage
expect_red "の secret 'ops-only' が infra/secrets-provisioned.tsv にありません"
# 未投入の枠を足す道（PENDING）まで指示する。指示が無いと「宣言に嘘の version を書く」へ倒れる。
expect_output_matches 'PENDING'
t_end

# ---------------------------------------------------------------------------
# 本命 2: README の投入手順から抜けている形。現行 main の survey-session-key と同型であり、
# このガードを入れた時点で実リポジトリが赤になった（是正は同 PR の後続コミット）。
#
# 対照の作り方が要点である。項目 6 の散文には ops-only が出ているので、素朴な出現数カウントの
# 実装ならこのケースは緑になってしまう。散文の有無を 1 条件だけ変えた 2 ケースで、判定が
# 投入コマンド行にのみ依存することを両方向から固定する。

t_begin 'check-secret-declaration-coverage: README の投入手順から抜けている枠を検出する'
sdc_fixture
sdc_readme no-ops
fx_run check-secret-declaration-coverage
expect_red "の投入手順に 'ops-only' がありません"
# 手順書に無い枠は誰も値を入れない、という因果まで出す。
expect_output_matches 'gcloud secrets versions add ops-only'
t_end

t_begin 'check-secret-declaration-coverage: 対照 — 項目 6 の散文言及は投入手順として数えない'
sdc_fixture
# 項目 6 の散文を消し、投入コマンド行だけを残す。散文が判定へ寄与しているなら結果が変わる。
sdc_readme no-prose
fx_run check-secret-declaration-coverage
expect_green
expect_output_matches 'README 手順 2 件'
t_end

# ---------------------------------------------------------------------------
# 逆方向。片方向だけの照合では、正典から枠を消したあとの取り残しが不活性のまま残り続ける。

t_begin 'check-secret-declaration-coverage: 宣言にあるのに正典に無い行を検出する'
sdc_fixture
sdc_decl 'alpha-key|2|2026-07-12|#63' 'ops-only|1|2026-07-20|#63' 'ghost-key|1|2026-07-20|#63'
fx_run check-secret-declaration-coverage
expect_red "の 'ghost-key' が正典"
t_end

t_begin 'check-secret-declaration-coverage: README にあるのに正典に無い投入手順を検出する'
sdc_fixture
sdc_readme ghost
fx_run check-secret-declaration-coverage
expect_red "の投入手順にある 'ghost-key' が正典にありません"
t_end

t_begin 'check-secret-declaration-coverage: 枠を消したときの報告を宣言側の 1 件に絞る（二重報告しない）'
sdc_fixture
sdc_decl 'alpha-key|2|2026-07-12|#63' 'ops-only|1|2026-07-20|#63' 'ghost-key|1|2026-07-20|#63'
sdc_readme ghost
fx_run check-secret-declaration-coverage
# 原因は 1 つ（正典から消えた）なので、宣言と README で 2 種類の指示を重ねて出してはいけない。
expect_red "の 'ghost-key' が正典"
expect_absent '投入手順にある'
t_end

t_begin 'check-secret-declaration-coverage: 消費側が正典に無いキーを参照していたら赤'
sdc_fixture
sdc_consumer ghost
fx_run check-secret-declaration-coverage
expect_red "が参照する 'ghost-key' が正典"
t_end

# ---------------------------------------------------------------------------
# 空振り防止。対象 0 件のまま「乖離 0 件だから緑」を返すのが最悪の結果である。

t_begin 'check-secret-declaration-coverage: secret_ids を 1 行定義へ変えたら赤（範囲抽出の前提固定）'
sdc_fixture
sdc_tf oneline
fx_run check-secret-declaration-coverage
expect_red '複数行リスト定義が見つかりません'
t_end

t_begin 'check-secret-declaration-coverage: リストが行頭の ] で閉じていなければ赤（EOF まで走る形）'
sdc_fixture
sdc_tf unclosed
fx_run check-secret-declaration-coverage
expect_red "']' で閉じていません"
t_end

t_begin 'check-secret-declaration-coverage: 宣言がコメントと空行だけなら緑を返さない（空振り防止）'
sdc_fixture
sdc_decl
fx_run check-secret-declaration-coverage
expect_red 'データ行を1行も読めませんでした'
t_end

t_begin 'check-secret-declaration-coverage: README から投入手順が消えたら緑を返さない（空振り防止）'
sdc_fixture
sdc_readme empty
fx_run check-secret-declaration-coverage
expect_red "'gcloud secrets versions add <id>' を1件も抽出できませんでした"
t_end

t_begin 'check-secret-declaration-coverage: 消費側の参照を 1 件も拾えないとき緑を返さない（空振り防止）'
sdc_fixture
sdc_consumer none
fx_run check-secret-declaration-coverage
expect_red 'の参照を1件も抽出できませんでした'
t_end

# ---------------------------------------------------------------------------
# 宣言ファイルの形式。ここが緩いと、宣言はあるのに version 検証が読めない行が生まれ、
# 「宣言してあるつもり」で本番の実測と突き合わせられなくなる。

t_begin 'check-secret-declaration-coverage: version 列が 10 進数でも PENDING でもなければ赤'
sdc_fixture
sdc_decl 'alpha-key|latest|2026-07-12|#63' 'ops-only|1|2026-07-20|#63'
fx_run check-secret-declaration-coverage
expect_red 'version 列は 10 進数か PENDING'
t_end

t_begin 'check-secret-declaration-coverage: PENDING の行は緑で、件数の内訳に現れる'
sdc_fixture
sdc_decl 'alpha-key|2|2026-07-12|#63' 'ops-only|PENDING|-|#63'
fx_run check-secret-declaration-coverage
# 枠を足す PR は apply 前で version 番号を持てない。PENDING を層1 で赤にすると、その PR が
# 永久にマージできなくなる。未完了は「行が無い」ではなく「宣言された未完了」として残す。
expect_green
expect_output_matches 'PENDING 1'
t_end

t_begin 'check-secret-declaration-coverage: PENDING なのに投入日が入っていたら赤'
sdc_fixture
sdc_decl 'alpha-key|2|2026-07-12|#63' 'ops-only|PENDING|2026-07-20|#63'
fx_run check-secret-declaration-coverage
expect_red "PENDING なので投入日は '-' にしてください"
t_end

t_begin 'check-secret-declaration-coverage: 投入日が YYYY-MM-DD でなければ赤'
sdc_fixture
sdc_decl 'alpha-key|2|2026/07/12|#63' 'ops-only|1|2026-07-20|#63'
fx_run check-secret-declaration-coverage
expect_red '投入日は YYYY-MM-DD で書いてください'
t_end

t_begin 'check-secret-declaration-coverage: secret_id の重複を赤にする（どちらが正か決まらない）'
sdc_fixture
sdc_decl 'alpha-key|2|2026-07-12|#63' 'ops-only|1|2026-07-20|#63' 'alpha-key|3|2026-08-02|#63'
fx_run check-secret-declaration-coverage
expect_red '宣言ファイルに重複しています'
t_end

t_begin 'check-secret-declaration-coverage: 列が 4 列を超えていたら赤'
sdc_fixture
sdc_decl 'alpha-key|2|2026-07-12|#63|余分' 'ops-only|1|2026-07-20|#63'
fx_run check-secret-declaration-coverage
expect_red '4 列を超えています'
t_end

t_begin 'check-secret-declaration-coverage: 列が欠けていたら赤'
sdc_fixture
sdc_decl 'alpha-key|2|2026-07-12|' 'ops-only|1|2026-07-20|#63'
fx_run check-secret-declaration-coverage
expect_red '4 列（secret_id / version / 投入日 / Issue-PR）が揃っていません'
t_end

# ---------------------------------------------------------------------------
# WHITELIST。除外は README との照合にだけ効き、宣言との照合には効かない（宣言は本ガードの
# 目的そのものであり、例外を認めない）。当たらなくなった項目は WARNING で回収を促す。

t_begin 'check-secret-declaration-coverage: WHITELIST は README 手順の欠落を除外できる'
sdc_fixture
sdc_readme no-ops
sdc_whitelist 'ops-only'
fx_run check-secret-declaration-coverage
expect_green
expect_output_matches 'SKIP: ops-only'
t_end

t_begin 'check-secret-declaration-coverage: WHITELIST は宣言との照合には効かない（例外を認めない）'
sdc_fixture
sdc_decl 'alpha-key|2|2026-07-12|#63'
sdc_whitelist 'ops-only'
fx_run check-secret-declaration-coverage
expect_red "の secret 'ops-only' が infra/secrets-provisioned.tsv にありません"
t_end

t_begin 'check-secret-declaration-coverage: 既に手順がある項目を WHITELIST に残していたら WARNING'
sdc_fixture
sdc_whitelist 'ops-only'
fx_run check-secret-declaration-coverage
expect_green
expect_output_matches 'WARNING: ops-only は WHITELIST に載っていますが README に投入手順があります'
t_end

t_begin 'check-secret-declaration-coverage: 正典から消えた項目を WHITELIST に残していたら WARNING'
sdc_fixture
sdc_whitelist 'ghost-key'
fx_run check-secret-declaration-coverage
expect_green
expect_output_matches 'WARNING: ghost-key は WHITELIST に載っていますが正典に存在しません'
t_end

# ---------------------------------------------------------------------------
# --print-secrets。層2（version ドリフト検証）へ正典を供給する経路であり、赤のまま 1 行でも
# 出すと「壊れた正典から導出した集合で下流が緑になる」という最悪の空振りを作る。

t_begin 'check-secret-declaration-coverage: --print-secrets が <id>\t<version> の TSV を出す'
sdc_fixture
sdc_decl 'alpha-key|2|2026-07-12|#63' 'ops-only|PENDING|-|#63'
fx_run_args check-secret-declaration-coverage --print-secrets
expect_green
fx_run_stdout check-secret-declaration-coverage --print-secrets
expect_output_matches "$(printf '^alpha-key\t2$')"
expect_output_matches "$(printf '^ops-only\tPENDING$')"
# stdout は機械可読専用。人間向けの行が混ざると下流のパースが壊れる。
expect_absent 'OK:'
t_end

t_begin 'check-secret-declaration-coverage: 検証が赤のとき --print-secrets は 1 行も出さない'
sdc_fixture
sdc_decl 'alpha-key|2|2026-07-12|#63'
fx_run_args check-secret-declaration-coverage --print-secrets
expect_red "が infra/secrets-provisioned.tsv にありません"
fx_run_stdout check-secret-declaration-coverage --print-secrets
expect_output_empty
t_end
