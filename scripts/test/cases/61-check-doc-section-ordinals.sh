# scripts/check-doc-section-ordinals.sh の自己テスト（Issue #202）。
#
# 本ガードは「文書の節番号が二重になっても git は衝突として報告しない」を機械検出する。
# 2026-09-06 の実測では、`docs/design/design-language.md` の §7.8〜7.11 が 2 組できた状態で
# `check-markdown-emphasis.sh` も `design-language-doc.test.ts`（145 件）も緑を返した。
# **この網は他のどの検査も持っていなかった。**
#
# 誤検出しないことの担保が要る観点が 3 つある。いずれも実在の文書に存在する形である。
#   1. 見出しの階層をまたぐ同じ数字（`## 7.` と `### 7.1`）は衝突ではない
#   2. `### 2026-09-06 の記録` のような日付見出しは序数ではない（同じ日付の記録は普通に 2 つ在る）
#   3. `### 7-1.` のハイフン方言（infra/README.md が使う）も同じ規則で扱う
# 1 を落とすと全文書が赤くなり、2 を落とすと実施記録を書くたびに赤くなる。
#
# fixture は走査対象の 3 アンカーを必ず備える。アンカーが欠けると本ガードは
# 「アンカーが走査対象に含まれていません」で赤くなり、**どのケースも意図した経路を検査できない**。

dso_fixture() {
  fx_guard check-doc-section-ordinals

  # --- grep スタブ -------------------------------------------------------
  # 既定は実物へ委譲し、DSO_GREP_FAIL の子プロセスでだけ exit 2 を返す。**どの grep を
  # 落とすかを引数で指定する。** 一律に落とすと最初の grep で必ず赤くなり、後続の経路の
  # exit 2 分岐を 1 件も検査しないまま「覆った」と誤認する（81 番ケースと同じ理由）。
  # chmod は使えない（CI は --require-full で skip を失敗として扱うため uid 依存にできない）。
  dso_real_grep="$(PATH="$FX_BASE_PATH" command -v grep)"
  cat > "${STUB_DIR}/grep" <<STUB
#!/usr/bin/env bash
if [ -n "\${DSO_GREP_FAIL:-}" ]; then
  case "\$*" in
    *"\${DSO_GREP_FAIL}"*) echo "grep-stub: simulated read error" >&2; exit 2 ;;
  esac
fi
exec "${dso_real_grep}" "\$@"
STUB
  chmod +x "${STUB_DIR}/grep"

  # --- アンカー 3 件（規律を満たす正常形） --------------------------------
  fx_write docs/design/design-language.md <<'EOF'
# デザイン言語

## 1. この文書の位置づけ

本文。

## 2. 色

### 2.1 役割

本文。

### 2.2 実効コントラスト

本文。

## 7. 面適用で共有する設計判断

### 7.1 星は ink で描く

本文。

### 7.8 帯の高さと現在地の示し方

本文。
EOF

  fx_write infra/README.md <<'EOF'
# インフラ運用手順

## 1. IaC 例外リスト

本文。

## 7. コンテナイメージの push

### 7-0. 前提

本文。

### 7-1. build と push

本文。
EOF

  fx_write requirements.md <<'EOF'
# 要件定義書

## 1. 背景

本文。

## 2. スコープ

本文。
EOF

  fx_track_now
}

# 合成ツリーのガードを走らせる（grep スタブへ渡す env を指定できる版）。
dso_run_with_grep_fail() {
  # $1 = exit 2 を返させる grep の引数に含まれる文字列。
  RC=0
  OUT="$(cd "$FX" && PATH="${STUB_DIR}:${FX_BASE_PATH}" DSO_GREP_FAIL="$1" bash scripts/check-doc-section-ordinals.sh 2>&1)" || RC=$?
}

# ---------------------------------------------------------------------------
# 正常形。件数まで照合する（走査が空振りしたまま緑になる経路と区別するため）。

t_begin 'check-doc-section-ordinals: 序数が一意なら緑（件数とアンカー数まで照合）'
dso_fixture
fx_run check-doc-section-ordinals
expect_green
expect_output_matches '3 ファイル / 13 件の番号付き見出し / アンカー 3 件'
t_end

# ---------------------------------------------------------------------------
# 本命: 2026-09-06 に実際に起きた形そのもの。§7.8 が 2 つ。

t_begin 'check-doc-section-ordinals: 同じ節番号の見出しが 2 つあると赤（実際に起きた形）'
dso_fixture
cat >> "${FX}/docs/design/design-language.md" <<'EOF'

### 7.8 LINE 面の意匠は Web 面と別の律で決める

本文。
EOF
fx_track_now
fx_run check-doc-section-ordinals
expect_red 'docs/design/design-language.md に同じ節番号の見出しが複数あります'
# **衝突している両方の行を出すこと。** 片方だけでは「どちらを繰り下げるか」を判断できない。
expect_output_matches '帯の高さと現在地の示し方'
expect_output_matches 'LINE 面の意匠は Web 面と別の律で決める'
t_end

t_begin 'check-doc-section-ordinals: 対照 — 片方を繰り下げれば緑（赤の原因が重複であることの担保）'
dso_fixture
cat >> "${FX}/docs/design/design-language.md" <<'EOF'

### 7.9 LINE 面の意匠は Web 面と別の律で決める

本文。
EOF
fx_track_now
fx_run check-doc-section-ordinals
expect_green
t_end

t_begin 'check-doc-section-ordinals: ハイフン方言（infra の 7-1.）の重複も検出する'
dso_fixture
cat >> "${FX}/infra/README.md" <<'EOF'

### 7-1. 別の手順が同じ番号を取った

本文。
EOF
fx_track_now
fx_run check-doc-section-ordinals
expect_red 'infra/README.md に同じ節番号の見出しが複数あります'
expect_output_matches '序数 7-1'
t_end

# ---------------------------------------------------------------------------
# 偽陽性の担保。いずれも実在の文書に在る形であり、落とすと導入即赤になる。

t_begin 'check-doc-section-ordinals: 階層をまたぐ同じ数字（## 7. と ### 7.1）は衝突ではない'
dso_fixture
fx_run check-doc-section-ordinals
expect_green
# fixture は既に `## 7.` と `### 7.1` を持つ。取り違えていればここで赤くなる。
expect_absent '序数 7:'
t_end

t_begin 'check-doc-section-ordinals: 同じ日付の見出しが 2 つあっても序数と読まない'
dso_fixture
cat >> "${FX}/docs/design/design-language.md" <<'EOF'

### 2026-09-06 の記録

本文。

### 2026-09-06 別の記録

本文。
EOF
fx_track_now
fx_run check-doc-section-ordinals
expect_green
expect_absent '2026'
t_end

t_begin 'check-doc-section-ordinals: 序数の . を正規表現として解釈しない（7.8 が 718 に当たらない）'
dso_fixture
cat >> "${FX}/docs/design/design-language.md" <<'EOF'

### 7.8 二重になった側

本文。

### 718 まぎらわしい見出し

本文。
EOF
fx_track_now
fx_run check-doc-section-ordinals
expect_red 'docs/design/design-language.md に同じ節番号の見出しが複数あります'
# `.` を生のまま渡すと 718 の行が「7.8 の片割れ」として並ぶ。
expect_absent '718 まぎらわしい見出し'
t_end

# ---------------------------------------------------------------------------
# 空振り防止。対象 0 件のまま「重複 0 件だから緑」を返すのが最悪の結果である。

t_begin 'check-doc-section-ordinals: 走査対象が 1 件も無いとき緑を返さない'
fx_guard check-doc-section-ordinals
fx_track_now
fx_run check-doc-section-ordinals
expect_red '走査対象の Markdown が 1 件もありません'
t_end

t_begin 'check-doc-section-ordinals: アンカーが走査対象から外れると赤（改名・移動の検出）'
dso_fixture
mv "${FX}/docs/design/design-language.md" "${FX}/docs/design/design-language-v2.md"
(cd "$FX" && git add -A) >/dev/null 2>&1
fx_run check-doc-section-ordinals
expect_red 'アンカー docs/design/design-language.md が走査対象に含まれていません'
t_end

t_begin 'check-doc-section-ordinals: アンカーに番号付き見出しが無いと赤（走査しても何も検査していない）'
dso_fixture
fx_write docs/design/design-language.md <<'EOF'
# デザイン言語

## 色について

番号を持たない見出しだけになった。
EOF
fx_track_now
fx_run check-doc-section-ordinals
expect_red 'アンカー docs/design/design-language.md に番号付き見出しが 1 つもありません'
t_end

t_begin 'check-doc-section-ordinals: 番号付き見出しを 1 つも拾えないとき緑を返さない（抽出規則の崩壊）'
fx_guard check-doc-section-ordinals
fx_write docs/design/design-language.md <<'EOF'
# デザイン言語

## 色について
EOF
fx_write infra/README.md <<'EOF'
# インフラ

## 手順について
EOF
fx_write requirements.md <<'EOF'
# 要件

## 背景について
EOF
fx_track_now
fx_run check-doc-section-ordinals
# アンカー 3 件の「見出し 0 件」が先に出る。どちらの経路でも緑にはならないことが要点。
expect_red 'アンカー docs/design/design-language.md に番号付き見出しが 1 つもありません'
expect_output_matches 'アンカー infra/README.md に番号付き見出しが 1 つもありません'
t_end

# ---------------------------------------------------------------------------
# 走査が評価不能（grep exit 2）だったときに、それを「重複 0 件」と読まないこと。
# **chmod ではなく grep スタブで作る**（uid 非依存にするため。CI は skip を失敗として扱う）。

t_begin 'check-doc-section-ordinals: 見出しの計数が評価不能（exit 2）なら赤'
dso_fixture
dso_run_with_grep_fail 'design-language.md'
if [ "$RC" -eq 0 ]; then
  _t_fail "grep exit 2 の注入下でガードが緑を返しました（fail-closed になっていません）"
fi
expect_output_matches '走査が評価不能でした'
t_end

t_begin 'check-doc-section-ordinals: 対照 — 注入しなければ同じ fixture は緑（注入が原因であることの担保）'
dso_fixture
dso_run_with_grep_fail 'この文字列はどの grep 引数にも現れない'
if [ "$RC" -ne 0 ]; then
  _t_fail "注入なしの同じ fixture が赤になりました（赤の原因が exit 2 ではありません）: ${OUT}"
fi
t_end

# ---------------------------------------------------------------------------
# WHITELIST。当たらなくなった除外を残さないこと（他ガードと同形）。

t_begin 'check-doc-section-ordinals: WHITELIST に載せた文書は走査から外れる'
dso_fixture
cat >> "${FX}/docs/design/design-language.md" <<'EOF'

### 7.8 二重になった側

本文。
EOF
fx_track_now
awk '
  /^WHITELIST=\(\)$/ { print "WHITELIST=('\''docs/design/design-language.md|理由 #202'\'')"; next }
  { print }
' "${FX}/scripts/check-doc-section-ordinals.sh" > "${FX}/scripts/dso.tmp"
mv "${FX}/scripts/dso.tmp" "${FX}/scripts/check-doc-section-ordinals.sh"
# **注入が当たったことを先に確かめる。** 空振りしたまま走らせると、ガードが元のまま
# 赤を返した結果を読み違える。ここは逆に、緑になったことを「WHITELIST が効いた」と
# 読み違える経路である。
if [ "$(grep -cF 'docs/design/design-language.md|理由 #202' "${FX}/scripts/check-doc-section-ordinals.sh")" -eq 0 ]; then
  _t_fail "WHITELIST の注入が空振りしました"
fi
fx_run check-doc-section-ordinals
# 除外された文書はアンカー検査でも見出し 0 件にはならない（アンカー検査は WHITELIST を通らない）。
# ここで確かめたいのは「重複が報告されなくなること」だけである。
expect_absent '同じ節番号の見出しが複数あります'
t_end

t_begin 'check-doc-section-ordinals: 当たらない WHITELIST は警告する'
dso_fixture
awk '
  /^WHITELIST=\(\)$/ { print "WHITELIST=('\''docs/存在しない.md|理由 #202'\'')"; next }
  { print }
' "${FX}/scripts/check-doc-section-ordinals.sh" > "${FX}/scripts/dso.tmp"
mv "${FX}/scripts/dso.tmp" "${FX}/scripts/check-doc-section-ordinals.sh"
if [ "$(grep -cF 'docs/存在しない.md' "${FX}/scripts/check-doc-section-ordinals.sh")" -eq 0 ]; then
  _t_fail "WHITELIST の注入が空振りしました"
fi
fx_run check-doc-section-ordinals
expect_green
expect_output_matches 'WHITELIST に載っていますが走査対象に見当たりません'
t_end
