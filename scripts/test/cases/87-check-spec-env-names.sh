# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
#
# check-spec-env-names（Issue #148）のケース。
#
# 検証の主眼は 2 つある。
#   1. **起票理由の 2 つを実際に赤にすること** — 表に実在しない env 名（`CORS_ORIGIN`）と、
#      出典の必須 env が表から落ちていること（`SURVEY_BASE_URL`）。
#   2. **散文中の env 名を叩かないこと** — 是正済みの tasks.md は「`CORS_ORIGIN` という名前は
#      存在しない」と読者へ教えるために、その名前を意図的に本文へ残している。素朴な grep ガードは
#      この最も正しく書かれた行を真っ先に落とす。ケース 4 がその回帰である。
#
# 合成ツリーの WHITELIST は既定で空にする（実リポジトリの項目は fixture の表に当たらないため、
# 残したままだと全ケースが WARNING を出し、緑の中身が読めなくなる）。

spen_whitelist() {
  # 複製したガードの WHITELIST ブロックを差し替える（引数なし = 空にする）。
  # sed -i はプラットフォームで引数が異なるため awk と mv で行う。
  spen_entry="${1:-}"
  awk -v entry="$spen_entry" -v q="'" '
    /^WHITELIST=\($/ {
      if (entry == "") { print "WHITELIST=()" }
      else { print "WHITELIST=("; print "  " q entry q; print ")" }
      skip = 1
      next
    }
    skip == 1 { if ($0 == ")") { skip = 0 } ; next }
    { print }
  ' "${FX}/scripts/check-spec-env-names.sh" > "${FX}/scripts/spen-whitelist.tmp"
  mv "${FX}/scripts/spen-whitelist.tmp" "${FX}/scripts/check-spec-env-names.sh"

  # **注入が当たったことを先に確かめる。** 空振りしたまま走らせると、ガードが元のまま返した
  # 結果を「WHITELIST が効いた証拠」と読み違える。
  if [ -z "$spen_entry" ]; then
    spen_probe='WHITELIST=()'
  else
    spen_probe="$spen_entry"
  fi
  if [ "$(grep -cF "$spen_probe" "${FX}/scripts/check-spec-env-names.sh")" -eq 0 ]; then
    _t_fail "WHITELIST の注入が空振りしました: ${spen_probe}"
  fi
}

spen_src() {
  # 必須 env をエラーメッセージへ再掲する実装（dashboard-api の loadConfig 規約と同形）。
  fx_write ts/apps/demo/src/config.ts <<'EOF'
export function loadConfig(env) {
  const base = env.DEMO_BASE_URL;
  if (!base) {
    throw new Error('DEMO_BASE_URL is required');
  }
  const key = env.DEMO_API_KEY;
  if (!key) {
    throw new Error('DEMO_API_KEY is required');
  }
  return { base, key, port: Number(env.DEMO_PORT ?? '8080') };
}
EOF
}

spen_src_helper() {
  # 必須 env をヘルパ経由で組み立てる実装（line-webhook の config.ts と同形）。
  # env 名が式なので `Error('<NAME> is required')` のリテラルを持たず、方向 2 の対象から外れる。
  fx_write ts/apps/demo/src/helper-config.ts <<'EOF'
function required(env, key) {
  const value = env[key];
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}
export function loadConfig(env) {
  return { base: required(env, 'DEMO_BASE_URL') };
}
EOF
}

spen_rename_env() {
  # 合成ツリーの config.ts の env 名を改名する（$1 = 旧名 / $2 = 新名）。
  #
  # **改名は「実在しない env 名が手順に残る」最も普通の経路である**（Issue #176）。旧名は新名の
  # 部分文字列として当たり続けるため、実在確認を部分一致で行っているとガードは緑のまま通る。
  #
  # fixture の定義は spen_src の 1 箇所に置いたまま**派生させる**。別途リテラルで書き直すと、
  # 片方だけが更新される日が来る — fixtures.sh 冒頭が禁じている二重定義そのものである。
  # sed -i はプラットフォームで引数が異なるため、spen_whitelist と同じく sed と mv で行う。
  spen_from="$1"
  spen_to="$2"
  spen_cfg="${FX}/ts/apps/demo/src/config.ts"
  sed "s/${spen_from}/${spen_to}/g" "$spen_cfg" > "${spen_cfg}.tmp"
  mv "${spen_cfg}.tmp" "$spen_cfg"

  # **着弾を先に確かめる**（fx_guard_mutate と同じ規律）。空振りしたまま走らせると、無改変の
  # ツリーを検査した結果を「改名を検出できた／できなかった」と読み違える。旧名の残存も見るのは、
  # 部分置換で `DEMO_PORT` と `DEMO_PORT_V2` が同居した木を「改名済み」と誤認しないため。
  assert_count=$((assert_count + 1))
  if [ "$(grep -cwF -- "$spen_to" "$spen_cfg")" -eq 0 ]; then
    _t_fail "改名の注入が空振りしました: ${spen_from} -> ${spen_to}"
  fi
  if [ "$(grep -cwF -- "$spen_from" "$spen_cfg")" -ne 0 ]; then
    _t_fail "改名したのに旧名が語として残っています: ${spen_from}"
  fi
}

spen_base() {
  spen_src
  fx_guard check-spec-env-names
  spen_whitelist
}

# ---------------------------------------------------------------------------
# 1. 緑（件数まで照合する）

t_begin 'check-spec-env-names: 表と実装が一致していれば緑（件数まで照合）'
spen_base
fx_write .kiro/specs/demo/tasks.md <<'EOF'
# デモ spec

## 実施手順

| env | 出典 | ローカルでの値 |
|---|---|---|
| `DEMO_BASE_URL` | `ts/apps/demo/src/config.ts` | 基点 URL |
| `DEMO_API_KEY` | 同上 | 実キー |
| `DEMO_PORT` | 同上 | 省略時 8080 |

以上。
EOF
fx_run check-spec-env-names
expect_green
# 「OK」だけでなく母数を照合する。走査が空振りしたまま緑になる経路と区別するため。
expect_output_matches 'spec 1 件 / 表 1 件 / 行 3 件 / 出典 1 件（方向 2 の対象 1 件）照合・WHITELIST 0 件'
t_end

# ---------------------------------------------------------------------------
# 2-3. 本命: 起票理由（#148）の 2 つを再現する。

t_begin 'check-spec-env-names: 表の env 名が実装に無ければ赤（方向 1・CORS_ORIGIN と同型）'
spen_base
fx_write .kiro/specs/demo/tasks.md <<'EOF'
| env | 出典 | ローカルでの値 |
|---|---|---|
| `DEMO_BASE_URL` | `ts/apps/demo/src/config.ts` | 基点 URL |
| `DEMO_API_KEY` | 同上 | 実キー |
| `DEMO_CORS_ORIGIN` | 同上 | 許可するオリジン |
EOF
fx_run check-spec-env-names
expect_red '`DEMO_CORS_ORIGIN` は出典 '"'"'ts/apps/demo/src/config.ts'"'"' に存在しません'
expect_output_matches 'NG: spec の env 宣言表と実装の必須 env に乖離があります'
# 部分一致すらしない名前なので、改名ヒント（#176）は出してはならない。誤射すると
# 「実在しない名前」と「改名の取り残し」を読み手が区別できなくなる。
expect_absent '部分一致では'
t_end

t_begin 'check-spec-env-names: 出典の必須 env が表に無ければ赤（方向 2・SURVEY_BASE_URL と同型）'
spen_base
fx_write .kiro/specs/demo/tasks.md <<'EOF'
| env | 出典 | ローカルでの値 |
|---|---|---|
| `DEMO_BASE_URL` | `ts/apps/demo/src/config.ts` | 基点 URL |
EOF
fx_run check-spec-env-names
expect_red 'の必須 env `DEMO_API_KEY` がありません（手順どおりでは起動しません）'
# 表にある側は報告しない（同一の表を二重に叩かない）。
expect_absent '必須 env `DEMO_BASE_URL` がありません'
t_end

# ---------------------------------------------------------------------------
# 4. 誤検知の回帰: 散文は見ない。

t_begin 'check-spec-env-names: 散文中の実在しない env 名は叩かない（誤検知の回帰）'
spen_base
fx_write .kiro/specs/demo/tasks.md <<'EOF'
# デモ spec

CORS の許可元は `DEMO_BASE_URL` であり、**`DEMO_CORS_ORIGIN` という名前は存在しない**。
以前の手順は `DEMO_LEGACY_ORIGIN` を設定するよう指示していたが、これも実装には無い。

| env | 出典 | ローカルでの値 |
|---|---|---|
| `DEMO_BASE_URL` | `ts/apps/demo/src/config.ts` | 基点 URL |
| `DEMO_API_KEY` | 同上 | 実キー |

> この手順は実行して確かめていない。`DEMO_CORS_ORIGIN` を残したのがその原因だった。
EOF
fx_run check-spec-env-names
expect_green
expect_absent 'DEMO_CORS_ORIGIN'
expect_absent 'DEMO_LEGACY_ORIGIN'
t_end

# ---------------------------------------------------------------------------
# 5-9. 表の構造と出典の解決。

t_begin 'check-spec-env-names: 出典のパスが実在しなければ赤（パスの腐り）'
spen_base
fx_write .kiro/specs/demo/tasks.md <<'EOF'
| env | 出典 | ローカルでの値 |
|---|---|---|
| `DEMO_BASE_URL` | `ts/apps/demo/src/config.ts` | 基点 URL |
| `DEMO_API_KEY` | `config.ts` | 実キー |
EOF
fx_run check-spec-env-names
expect_red "の出典 'config.ts' がリポジトリに存在しません"
t_end

t_begin 'check-spec-env-names: 表の先頭行の 同上 は継ぐ出典が無いので赤'
spen_base
fx_write .kiro/specs/demo/tasks.md <<'EOF'
| env | 出典 | ローカルでの値 |
|---|---|---|
| `DEMO_BASE_URL` | 同上 | 基点 URL |
| `DEMO_API_KEY` | `ts/apps/demo/src/config.ts` | 実キー |
EOF
fx_run check-spec-env-names
expect_red "の '同上' が表の先頭行にあり、継ぐ出典がありません"
t_end

t_begin 'check-spec-env-names: 第 1 列が env 名の形でなければ赤'
spen_base
fx_write .kiro/specs/demo/tasks.md <<'EOF'
| env | 出典 | ローカルでの値 |
|---|---|---|
| DEMO_BASE_URL | `ts/apps/demo/src/config.ts` | バッククォートが無い |
| `DEMO_API_KEY` | 同上 | 実キー |
EOF
fx_run check-spec-env-names
expect_red 'の env 宣言表の第 1 列が env 名の形ではありません'
t_end

t_begin 'check-spec-env-names: ヘッダの直後が区切り行でなければ表として扱わず赤'
spen_base
fx_write .kiro/specs/demo/tasks.md <<'EOF'
| env | 出典 | ローカルでの値 |
| `DEMO_BASE_URL` | `ts/apps/demo/src/config.ts` | 区切り行が無い |
EOF
fx_run check-spec-env-names
expect_red 'の env 宣言表がヘッダの直後に区切り行を持ちません'
t_end

t_begin 'check-spec-env-names: 表はあるが本文行が 0 件なら赤'
spen_base
fx_write .kiro/specs/demo/tasks.md <<'EOF'
| env | 出典 | ローカルでの値 |
|---|---|---|

本文行が消えた表。
EOF
fx_run check-spec-env-names
expect_red 'の env 宣言表に本文行が 1 件もありません'
t_end

# ---------------------------------------------------------------------------
# 10-12. 空振り防止（対象 0 件を緑と報告しない）。

t_begin 'check-spec-env-names: 空振り防止 — env 宣言表が 1 件も無ければ赤'
spen_base
fx_write .kiro/specs/demo/tasks.md <<'EOF'
# デモ spec

env 宣言表を持たない spec。`DEMO_BASE_URL` への言及はあるが表は無い。

| # | 確認すること | 対応 |
|---|---|---|
| 1 | 別の表は表として拾わない | 1.1 |
EOF
fx_run check-spec-env-names
expect_red 'env 宣言表（'"'"'| env | 出典 | … |'"'"' のヘッダを持つ表）を 1 件も抽出できませんでした'
t_end

t_begin 'check-spec-env-names: 空振り防止 — 追跡下の spec md が 0 件なら赤'
spen_src
fx_write docs/placeholder.md <<'EOF'
placeholder
EOF
fx_guard check-spec-env-names
spen_whitelist
fx_run check-spec-env-names
expect_red '追跡下の .kiro/specs/**/*.md が 1 件もありません'
t_end

t_begin 'check-spec-env-names: 空振り防止 — 方向 2 の対象出典が 0 件なら赤'
spen_src_helper
fx_guard check-spec-env-names
spen_whitelist
fx_write .kiro/specs/demo/tasks.md <<'EOF'
| env | 出典 | ローカルでの値 |
|---|---|---|
| `DEMO_BASE_URL` | `ts/apps/demo/src/helper-config.ts` | 基点 URL |
EOF
fx_run check-spec-env-names
expect_red '必須 env を抽出できた出典が 1 件もありません'
# ヘルパ経由の出典は「対象外」として数え上げられる（黙って落とさない）。
expect_output_matches 'SKIP: ts/apps/demo/src/helper-config.ts（必須 env をリテラルで自己申告していないため方向 2 の対象外）'
t_end

# ---------------------------------------------------------------------------
# 13-14. WHITELIST。

t_begin 'check-spec-env-names: WHITELIST は方向 1 の照合だけを外す'
spen_src
fx_guard check-spec-env-names
spen_whitelist 'ts/apps/demo/src/config.ts::DEMO_IMPLICIT_CREDENTIALS'
fx_write .kiro/specs/demo/tasks.md <<'EOF'
| env | 出典 | ローカルでの値 |
|---|---|---|
| `DEMO_BASE_URL` | `ts/apps/demo/src/config.ts` | 基点 URL |
| `DEMO_API_KEY` | 同上 | 実キー |
| `DEMO_IMPLICIT_CREDENTIALS` | 同上 | SDK が暗黙に読むためソースに文字列が無い |
EOF
fx_run check-spec-env-names
expect_green
expect_output_matches 'SKIP: ts/apps/demo/src/config.ts::DEMO_IMPLICIT_CREDENTIALS（WHITELIST'
expect_output_matches 'WHITELIST 1 件'
t_end

t_begin 'check-spec-env-names: 当たらなくなった WHITELIST 項目は WARNING で回収を促す'
spen_src
fx_guard check-spec-env-names
spen_whitelist 'ts/apps/demo/src/config.ts::DEMO_ALREADY_FIXED'
fx_write .kiro/specs/demo/tasks.md <<'EOF'
| env | 出典 | ローカルでの値 |
|---|---|---|
| `DEMO_BASE_URL` | `ts/apps/demo/src/config.ts` | 基点 URL |
| `DEMO_API_KEY` | 同上 | 実キー |
EOF
fx_run check-spec-env-names
expect_green
expect_output_matches "WARNING: 'ts/apps/demo/src/config.ts::DEMO_ALREADY_FIXED' は WHITELIST に載っていますが、対応する表の行がありません"
t_end

# ---------------------------------------------------------------------------
# 15-16. 分界と分岐到達性。

t_begin 'check-spec-env-names: 未追跡の spec md は走査しない（追跡下だけを見る前提）'
spen_src
fx_guard check-spec-env-names
spen_whitelist
fx_write .kiro/specs/demo/tasks.md <<'EOF'
| env | 出典 | ローカルでの値 |
|---|---|---|
| `DEMO_BASE_URL` | `ts/apps/demo/src/config.ts` | 基点 URL |
| `DEMO_API_KEY` | 同上 | 実キー |
EOF
fx_track_now
# ここから先は未追跡のまま残る。違反を含む spec を置いても走査対象に入らない。
fx_write .kiro/specs/untracked/tasks.md <<'EOF'
| env | 出典 | ローカルでの値 |
|---|---|---|
| `DEMO_NOT_IN_SOURCE` | `ts/apps/demo/src/config.ts` | 追跡されていない |
EOF
fx_run check-spec-env-names
expect_green
expect_absent 'DEMO_NOT_IN_SOURCE'
expect_output_matches 'spec 1 件 / 表 1 件 / 行 2 件'
t_end

t_begin 'check-spec-env-names: 必須 env の抽出が壊れたら空振り防止が発火する（分岐到達性）'
spen_src
fx_guard_mutate check-spec-env-names -e 's/grep -oE "Error/grep -oE "XError/'
spen_whitelist
fx_write .kiro/specs/demo/tasks.md <<'EOF'
| env | 出典 | ローカルでの値 |
|---|---|---|
| `DEMO_BASE_URL` | `ts/apps/demo/src/config.ts` | 基点 URL |
| `DEMO_API_KEY` | 同上 | 実キー |
EOF
fx_run check-spec-env-names
expect_red '必須 env を抽出できた出典が 1 件もありません'
t_end

# ---------------------------------------------------------------------------
# 17-18. 改名の取り残し（Issue #176）。
#
# 方向 1 の実在確認が部分一致（`grep -cF`）だと、実装側が **より長い env 名へ改名された**とき
# 旧名が新名の部分文字列として当たり続け、ガードは緑のまま通る。#148 が塞ごうとした形
# （手順が実在しない env 名を指示している）そのものが、そこだけ素通りしていた。

t_begin 'check-spec-env-names: より長い env 名への改名を表が取り残していれば赤（方向 1・部分一致では素通りしない）'
spen_base
# **改名するのは任意 env（DEMO_PORT）である。** 穴が露出するのは方向 2（実装 → 文書）が守らない
# 行だけで、必須 env を改名すると「新名が表に無い」と方向 2 が先に赤にする。それでは方向 2 の
# 守りを方向 1 の検出と読み違えるうえ、exit code が現行実装でも 1 になり穴を示せない。
# 実リポジトリで露出しているのも DATABASE_URL（条件付き必須）と PORT（任意）の 2 行だけである。
spen_rename_env DEMO_PORT DEMO_PORT_V2
fx_write .kiro/specs/demo/tasks.md <<'EOF'
| env | 出典 | ローカルでの値 |
|---|---|---|
| `DEMO_BASE_URL` | `ts/apps/demo/src/config.ts` | 基点 URL |
| `DEMO_API_KEY` | 同上 | 実キー |
| `DEMO_PORT` | 同上 | 省略時 8080 |
EOF
fx_run check-spec-env-names
expect_red '`DEMO_PORT` は出典 '"'"'ts/apps/demo/src/config.ts'"'"' に存在しません'
# 素朴に grep すると DEMO_PORT_V2 に当たるため、読み手は「ガードのほうが誤っている」と読む。
# 部分一致の件数を添えて、改名の取り残しであることを名指しする。
expect_output_matches 'ただし部分一致では 1 件当たります'
# 方向 2 は無関係である（必須 env は表に載ったまま）。赤の原因を取り違えないことを固定する。
expect_absent '必須 env `DEMO_BASE_URL` がありません'
expect_absent '必須 env `DEMO_API_KEY` がありません'
t_end

t_begin 'check-spec-env-names: 対照 — 改名へ表を追随させれば緑（赤の原因は取り残しの一点）'
spen_base
spen_rename_env DEMO_PORT DEMO_PORT_V2
fx_write .kiro/specs/demo/tasks.md <<'EOF'
| env | 出典 | ローカルでの値 |
|---|---|---|
| `DEMO_BASE_URL` | `ts/apps/demo/src/config.ts` | 基点 URL |
| `DEMO_API_KEY` | 同上 | 実キー |
| `DEMO_PORT_V2` | 同上 | 省略時 8080 |
EOF
fx_run check-spec-env-names
expect_green
expect_absent 'DEMO_PORT_V2` は出典'
t_end
