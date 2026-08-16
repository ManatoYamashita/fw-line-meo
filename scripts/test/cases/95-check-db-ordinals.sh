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
  # smoke も run.sh が同じ無検査 glob で流すため、対象表に含まれていないと空振りする。
  fx_write db/test/smoke/12_enums_reftables.sql <<'EOF'
-- smoke
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
  # main 側の正典（migrations 0001-0003・assertions 0000/10/20・smoke 12/21）。
  dbo_snapshot \
    db/migrations/0001_four_tier_baseline.sql \
    db/migrations/0002_reference_seed.sql \
    db/migrations/0003_agency_dashboard.sql \
    db/test/assertions/0000_harness_selfcheck.sql \
    db/test/assertions/10_constraints.sql \
    db/test/assertions/20_agency_dashboard.sql \
    db/test/smoke/12_enums_reftables.sql \
    db/test/smoke/21_hierarchy.sql
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
expect_output_matches '3 ディレクトリ'
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

t_begin 'check-db-ordinals: 番号で始まるのに区切りが規約外なら赤'
# 数字で始まる＝番号付き成果物のつもり。区切りが `-` だと番号を機械抽出する前提が崩れる。
dbo_fixture renumbered
fx_write db/migrations/0005-hyphen-separated.sql <<'EOF'
-- 区切りがアンダースコアではない
EOF
dbo_main_full
fx_run check-db-ordinals
expect_red '0005-hyphen-separated.sql が命名規約'
t_end

# ---------------------------------------------------------------------------
# 空振り防止と注入経路（装置自身が壊れていないこと）
# ---------------------------------------------------------------------------

t_begin 'check-db-ordinals: migrations ディレクトリごと消えたら赤（走査前提の崩壊を緑にしない）'
fx_guard check-db-ordinals
fx_write db/test/assertions/0000_harness_selfcheck.sql <<'EOF'
-- selfcheck
EOF
fx_write db/test/smoke/12_enums_reftables.sql <<'EOF'
-- smoke
EOF
dbo_snapshot db/test/assertions/0000_harness_selfcheck.sql db/test/smoke/12_enums_reftables.sql
fx_run check-db-ordinals
expect_red 'db/migrations に番号付きの .sql が 1 件もありません'
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

# ---------------------------------------------------------------------------
# PR #129 レビュー指摘への回帰ケース
# ---------------------------------------------------------------------------

t_begin 'check-db-ordinals: 判定がロケールで変わらない（en_US.UTF-8 でも 50 と 500 を赤にする）'
# LC_ALL=C なら 500_ < 50_、en_US.UTF-8 なら 50_ < 500_ と**シェル glob ごと反転する**。
# ガードが環境の照合順序を引き継ぐと、同じツリーが CI と手元で違う色になる。
dbo_fixture renumbered
fx_write db/test/assertions/500_new_feature.sql <<'EOF'
-- 辞書順では 50_ より前に来る
EOF
dbo_snapshot \
  db/migrations/0001_four_tier_baseline.sql \
  db/migrations/0002_reference_seed.sql \
  db/migrations/0003_agency_dashboard.sql \
  db/test/assertions/0000_harness_selfcheck.sql \
  db/test/assertions/10_constraints.sql \
  db/test/assertions/50_agency_dashboard.sql \
  db/test/smoke/12_enums_reftables.sql
LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 fx_run check-db-ordinals
expect_red '辞書順と数値順が一致しません'
unset LC_ALL LANG
t_end

t_begin 'check-db-ordinals: 対照 — 桁を揃えれば同じロケールでも緑'
# 直前のケースとの差は 500_ を 60_ にした 1 点のみ。赤の原因が桁数混在であることを示す。
dbo_fixture renumbered
fx_write db/test/assertions/60_new_feature.sql <<'EOF'
-- 桁を揃えた
EOF
dbo_snapshot \
  db/migrations/0001_four_tier_baseline.sql \
  db/migrations/0002_reference_seed.sql \
  db/migrations/0003_agency_dashboard.sql \
  db/test/assertions/0000_harness_selfcheck.sql \
  db/test/assertions/10_constraints.sql \
  db/test/assertions/50_agency_dashboard.sql \
  db/test/smoke/12_enums_reftables.sql
LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 fx_run check-db-ordinals
expect_green
unset LC_ALL LANG
t_end

t_begin 'check-db-ordinals: db/test/smoke の番号衝突も検出する'
# smoke は assertions と同じ $(RUN) db/test/smoke 経由で *.sql を辞書順に流す。
# 対象表から漏れると同型の衝突が丸ごと素通りする。
dbo_fixture renumbered
fx_write db/test/smoke/21_gbp_post_review_reply.sql <<'EOF'
-- main の 21_hierarchy.sql と番号衝突する
EOF
dbo_main_full
fx_run check-db-ordinals
expect_red 'db/test/smoke の番号 21 が重複しています'
t_end

t_begin 'check-db-ordinals: smoke の飛び番は緑（12 と 21 の間を埋めることを要求しない）'
dbo_fixture renumbered
dbo_main_full
fx_run check-db-ordinals
expect_green
expect_absent 'db/test/smoke の番号が連番ではありません'
expect_output_matches '3 ディレクトリ'
t_end

t_begin 'check-db-ordinals: HEAD 側だけに在る .SQL も命名違反として赤（列挙範囲の非対称を作らない）'
# 片側だけ *.sql で絞ると、ブランチが足した .SQL は HEAD 側の列挙から漏れて緑になり、
# 同じファイルが main 側に在るときだけ赤くなる（判定がファイルの居場所に依存する）。
# 実行時の glob も *.sql なので、この形は「適用されないまま緑」になる。
dbo_fixture renumbered
fx_write db/migrations/0005_uppercase_ext.SQL <<'EOF'
-- run.sh の *.sql glob から外れる
EOF
dbo_main_full
fx_run check-db-ordinals
expect_red '0005_uppercase_ext.SQL が命名規約'
expect_output_matches '適用されないまま緑になります'
t_end

t_begin 'check-db-ordinals: 数字で始まらないファイルは対象外（README を置いても緑）'
# 番号付き成果物ではないので適用順に関与しない。ここを赤にすると正当な追加を止めてしまう。
dbo_fixture renumbered
fx_write db/migrations/README.md <<'EOF'
# 命名規約の説明
EOF
dbo_main_full
fx_run check-db-ordinals
expect_green
t_end

t_begin 'check-db-ordinals: 番号付きが 0 件なら赤（README だけを走査できたと誤認しない）'
fx_guard check-db-ordinals
fx_write db/migrations/README.md <<'EOF'
# 番号付きファイルが 1 件も無い
EOF
fx_write db/test/assertions/0000_harness_selfcheck.sql <<'EOF'
-- selfcheck
EOF
fx_write db/test/smoke/12_enums_reftables.sql <<'EOF'
-- smoke
EOF
dbo_snapshot db/test/assertions/0000_harness_selfcheck.sql db/test/smoke/12_enums_reftables.sql
fx_run check-db-ordinals
expect_red 'db/migrations に番号付きの .sql が 1 件もありません'
t_end
