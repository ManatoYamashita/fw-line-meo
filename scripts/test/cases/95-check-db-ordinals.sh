# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/check-db-ordinals.sh の自己テスト（Issue #128）。
#
# 本ガードが防ぐのは「git が衝突として報告しない番号衝突」である。単一ツリーだけを見ても
# **原理的に検出できない**（main 単体も branch 単体も重複なし・並べたときだけ 2 つになる）ため、
# ここで最も重要なのは **合成の有無だけを変えた対照** である。合成無しで緑・合成有りで赤に
# なることを示せなければ、このガードは「常に緑の装置」と区別できない。
#
# 合成ツリーは実リポジトリの規約差を再現する:
#   (1) db/migrations は 4 桁固定・欠番なし
#   (2) db/test/assertions は **桁数混在**（0000 と 10）で **飛び番が正常**
#       → 欠番検査を課してはならず、辞書順=数値順の検査はここでこそ効く

dbo_fixture() {
  # $1 が 'collide' なら main と同じ番号を branch 側に置く（PR #121 で実際に起きた形）。
  fx_guard check-db-ordinals

  fx_write db/migrations/0001_four_tier_baseline.sql <<'EOF'
-- baseline
EOF
  fx_write db/migrations/0002_reference_seed.sql <<'EOF'
-- seed
EOF
  case "${1:-clean}" in
    collide)
      # main 側が 0003_agency_dashboard.sql を持つ番号へ、branch 側が別名で衝突させる。
      fx_write db/migrations/0003_gbp_post_review_reply.sql <<'EOF'
-- 衝突する側
EOF
      ;;
    renumbered)
      # 衝突を避けて次の空き番号へ改番した状態（main 側 0003 が欠番を埋める）。
      fx_write db/migrations/0004_gbp_post_review_reply.sql <<'EOF'
-- 改番済み
EOF
      ;;
  esac

  fx_write db/test/assertions/0000_harness_selfcheck.sql <<'EOF'
-- selfcheck
EOF
  fx_write db/test/assertions/10_constraints.sql <<'EOF'
-- constraints
EOF
}

dbo_snapshot() {
  # main 側パス一覧の注入。引数は 1 行 1 パス。無引数なら main 側 0 件（= 単体判定へ退化）。
  : > "${FX}/_main_paths.txt"
  for p in "$@"; do
    printf '%s\n' "$p" >> "${FX}/_main_paths.txt"
  done
  DB_ORDINAL_MAIN_SNAPSHOT="${FX}/_main_paths.txt"
  export DB_ORDINAL_MAIN_SNAPSHOT
}

dbo_main_full() {
  # main 側の正典（migrations 0001-0003・assertions 0000/10/20）。
  dbo_snapshot \
    db/migrations/0001_four_tier_baseline.sql \
    db/migrations/0002_reference_seed.sql \
    db/migrations/0003_agency_dashboard.sql \
    db/test/assertions/0000_harness_selfcheck.sql \
    db/test/assertions/10_constraints.sql \
    db/test/assertions/20_agency_dashboard.sql
}

# ---------------------------------------------------------------------------
# 中核: 合成の有無だけを変えた対照
# ---------------------------------------------------------------------------

t_begin 'check-db-ordinals: main と合成すると番号衝突を検出する'
dbo_fixture collide
dbo_main_full
fx_run check-db-ordinals
expect_red 'db/migrations の番号 3 が重複しています'
expect_output_matches '0003_agency_dashboard\.sql'
expect_output_matches '0003_gbp_post_review_reply\.sql'
t_end

t_begin 'check-db-ordinals: 同じツリーでも main 側が空なら緑になる（単体では原理的に見えない）'
# **この対照が本ガードの存在理由そのものである。** 上のケースと違うのは main 側の集合だけで、
# ツリーは 1 バイトも変えていない。ここが赤になるなら、上の赤は別原因で出ている。
dbo_fixture collide
dbo_snapshot
fx_run check-db-ordinals
expect_green
t_end

t_begin 'check-db-ordinals: 改番すれば緑（main 側が欠番を埋めるので欠番検査も通る）'
dbo_fixture renumbered
dbo_main_full
fx_run check-db-ordinals
expect_green
expect_output_matches '2 ディレクトリ'
t_end

# ---------------------------------------------------------------------------
# assertions の規約差（飛び番は正常・桁数混在）
# ---------------------------------------------------------------------------

t_begin 'check-db-ordinals: assertions の飛び番は緑（0000 と 10 の間を埋めることを要求しない）'
dbo_fixture renumbered
dbo_main_full
fx_run check-db-ordinals
expect_green
# 0000 と 10 が隣接していても欠番エラーを出していないこと。
expect_absent 'db/test/assertions の番号が連番ではありません'
t_end

t_begin 'check-db-ordinals: assertions でも番号衝突は検出する'
dbo_fixture renumbered
dbo_snapshot \
  db/migrations/0001_four_tier_baseline.sql \
  db/migrations/0002_reference_seed.sql \
  db/migrations/0003_agency_dashboard.sql \
  db/test/assertions/0000_harness_selfcheck.sql \
  db/test/assertions/10_agency_dashboard.sql
fx_run check-db-ordinals
expect_red 'db/test/assertions の番号 10 が重複しています'
t_end

t_begin 'check-db-ordinals: 辞書順と数値順がずれると赤（桁数混在の assertions で発火する）'
dbo_fixture renumbered
# 100_ は辞書順で 10_ の直後・数値順では最後になる。
fx_write db/test/assertions/100_late.sql <<'EOF'
-- lexicographic trap
EOF
dbo_main_full
fx_run check-db-ordinals
expect_red '辞書順と数値順が一致しません'
t_end

# ---------------------------------------------------------------------------
# migrations 固有の規約
# ---------------------------------------------------------------------------

t_begin 'check-db-ordinals: migrations の欠番は赤'
dbo_fixture
# main 側に 0003 を置かず、branch 側が 0005 を足す（0003/0004 が欠番）。
fx_write db/migrations/0005_gap.sql <<'EOF'
-- gap
EOF
dbo_snapshot \
  db/migrations/0001_four_tier_baseline.sql \
  db/migrations/0002_reference_seed.sql \
  db/test/assertions/0000_harness_selfcheck.sql \
  db/test/assertions/10_constraints.sql
fx_run check-db-ordinals
expect_red 'db/migrations の番号が連番ではありません'
t_end

t_begin 'check-db-ordinals: 欠番を埋めれば緑（直前のケースの対照）'
dbo_fixture
fx_write db/migrations/0003_filled.sql <<'EOF'
-- filled
EOF
dbo_snapshot \
  db/migrations/0001_four_tier_baseline.sql \
  db/migrations/0002_reference_seed.sql \
  db/test/assertions/0000_harness_selfcheck.sql \
  db/test/assertions/10_constraints.sql
fx_run check-db-ordinals
expect_green
t_end

t_begin 'check-db-ordinals: 番号を機械抽出できない命名は赤'
dbo_fixture renumbered
fx_write db/migrations/add_index.sql <<'EOF'
-- 番号を持たない
EOF
dbo_main_full
fx_run check-db-ordinals
expect_red '命名規約 <番号>_<snake_case>.sql に合いません'
t_end

# ---------------------------------------------------------------------------
# 空振り防止と注入経路（装置自身が壊れていないこと）
# ---------------------------------------------------------------------------

t_begin 'check-db-ordinals: migrations が 0 件なら赤（走査前提の崩壊を緑にしない）'
fx_guard check-db-ordinals
fx_write db/test/assertions/0000_harness_selfcheck.sql <<'EOF'
-- selfcheck
EOF
dbo_snapshot db/test/assertions/0000_harness_selfcheck.sql
fx_run check-db-ordinals
expect_red 'db/migrations に .sql が 1 件もありません'
t_end

t_begin 'check-db-ordinals: snapshot が空文字なら赤（注入したつもりの空を実 git へ落とさない）'
dbo_fixture renumbered
DB_ORDINAL_MAIN_SNAPSHOT=''
export DB_ORDINAL_MAIN_SNAPSHOT
fx_run check-db-ordinals
expect_red 'DB_ORDINAL_MAIN_SNAPSHOT が空文字です'
unset DB_ORDINAL_MAIN_SNAPSHOT
t_end

t_begin 'check-db-ordinals: snapshot 未設定かつ main ref を解決できなければ赤（単体判定へ退化させない）'
dbo_fixture renumbered
unset DB_ORDINAL_MAIN_SNAPSHOT
DB_ORDINAL_MAIN_REF='refs/heads/__absent__'
export DB_ORDINAL_MAIN_REF
fx_run check-db-ordinals
expect_red 'を解決できません'
unset DB_ORDINAL_MAIN_REF
t_end

t_begin 'check-db-ordinals: 注入経路を通ったことが出力に現れる（実 git を引いていないことの確認）'
dbo_fixture renumbered
dbo_main_full
fx_run check-db-ordinals
expect_green
expect_output_matches 'main 側は snapshot から読みます'
t_end
