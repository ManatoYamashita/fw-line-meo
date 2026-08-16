# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/check-design-tokens.sh の自己テスト（Issue #90）。
#
# 本ガードは「色はデザイントークンを単一情報源とする」を守る。直書き hex と生パレット色クラスは
# 検出経路が別（前者は hex 一致・後者はクラス名パターン）であり、片方だけ壊れる形が起きうるため
# 両方に赤ケースを置く。

dt_fixture() {
  fx_guard check-design-tokens
  fx_write ts/packages/design-tokens/src/colors.ts <<'EOF'
export const colors = {
  primary: '#1F7A5C',
  surface: '#FFFFFF',
};
EOF
  fx_write ts/packages/ui/src/theme.css <<'EOF'
:root {
  --color-primary: #1F7A5C;
  --color-surface: #FFFFFF;
}
EOF
  fx_write ts/packages/ui/src/components/button.tsx <<'EOF'
export const Button = () => null;
EOF
  fx_write ts/apps/demo/page.tsx <<'EOF'
export const Page = () => null;
EOF
}

t_begin 'check-design-tokens: 直書きなし・theme.css がトークンと同値なら緑'
dt_fixture
fx_run check-design-tokens
expect_green
expect_output_matches 'theme.css 2 色'
t_end

t_begin 'check-design-tokens: アプリ層への直書き hex を検出する'
dt_fixture
fx_write ts/apps/demo/page.tsx <<'EOF'
export const style = { color: '#FF0000' };
EOF
fx_run check-design-tokens
expect_red '直書きの色指定が検出されました'
t_end

t_begin 'check-design-tokens: Tailwind 既定パレットの生色クラスを検出する'
dt_fixture
fx_write ts/apps/demo/page.tsx <<'EOF'
export const cls = 'bg-red-500 p-4';
EOF
fx_run check-design-tokens
expect_red '生色クラス'
t_end

t_begin 'check-design-tokens: theme.css にトークン未定義の色があると検出する'
dt_fixture
fx_write ts/packages/ui/src/theme.css <<'EOF'
:root {
  --color-primary: #1F7A5C;
  --color-rogue: #123456;
}
EOF
fx_run check-design-tokens
expect_red 'design-tokens に定義がありません'
t_end

t_begin 'check-design-tokens: theme.css から色を拾えないとき緑を返さない（空振り防止）'
dt_fixture
fx_write ts/packages/ui/src/theme.css <<'EOF'
:root {
  --spacing-md: 1rem;
}
EOF
fx_run check-design-tokens
expect_red '1 件も抽出できませんでした'
t_end

# ---------------------------------------------------------------------------
# Issue #117: トークン一覧が嵩んでも定義済みの色を誤検出しないこと。
#
# `$token_hexes` は **多行**である。照合を quiet 判定（最初の一致で打ち切る形）で書くと、
# 一覧が pipe buffer を超えた時点で上流の printf が EPIPE を受けて 141 を返し、`pipefail` に
# よりパイプライン全体が失敗になる。この照合は `if !` の内側なので `set -e` では中断せず、
# 141 が「無一致」と読まれて **定義済みの色を未定義として報告する偽の赤**へ化ける。
#
# 本リポジトリの 4 件の同型のうち、多行入力ゆえに実際に到達できるのはこの箇所だけである
# （残り 3 件は入力が単一行で、grep が行末まで読まざるを得ず早期終了できない）。
#
# 閾値には十分な倍率を取る（規律 3）。実測の発火点は 20,000 行（約 160KB）、非発火は
# 2,000 行（約 16KB）。1 行 8 バイト × 30,000 行 = 約 240KB とし、128KB を大きく超えさせる。
# 中途半端な余裕で組むと同じケースが赤にも緑にも転び、フレークな赤ケースは無いより悪い。
t_begin 'check-design-tokens: 多行のトークン一覧でも定義済みの色を誤検出しない（Issue #117）'
dt_fixture
# 30,000 件の一意な色定義。ループではなく awk で組む（bash 3.2 の逐次 printf は遅い）。
awk 'BEGIN { for (i = 0; i < 30000; i++) printf "  c%d: %s%06X,\n", i, "#", i }' \
  | fx_write ts/packages/design-tokens/src/colors.ts
# 一覧の先頭付近に実在する色だけを参照する。早期終了が起きるなら「最初の一致で打ち切る」形
# なので、先頭で一致させたほうが上流に書き残しが多くなり EPIPE が起きやすい。
fx_write ts/packages/ui/src/theme.css <<'EOF'
:root {
  --color-a: #00000A;
}
EOF
fx_run check-design-tokens
expect_green
expect_output_matches 'theme.css 1 色'
t_end

# ---------------------------------------------------------------------------
# Issue #120: 検出パターンが評価不能になったとき、緑ではなく赤にすること。
#
# 起票時の実測では、82 行目の照合が `2>/dev/null` と後置 `true` を併用していたため、
# `bg-red-500` の違反をツリーに置いたままガードが「生パレット色クラスゼロ」と申告して
# exit 0 を返した。しかも `2>/dev/null` が grep のエラーごと捨てるため、stderr を全部
# 拾っても痕跡が 1 行も残らなかった。違反があるのに緑、かつ痕跡ゼロという最悪形である。
t_begin 'check-design-tokens: 検出パターンが評価不能なら緑ではなく赤にする（Issue #120）'
dt_fixture
fx_write ts/apps/demo/page.tsx <<'EOF'
export const cls = 'bg-red-500 p-4';
EOF
awk '/^PALETTE_PATTERN=/ { print "PALETTE_PATTERN='"'"'['"'"'"; next } { print }' \
  "${FX}/scripts/check-design-tokens.sh" > "${FX}/scripts/dt-broken.tmp"
mv "${FX}/scripts/dt-broken.tmp" "${FX}/scripts/check-design-tokens.sh"
fx_run check-design-tokens
expect_red '生パレット色クラスの検出パターンを評価できません'
t_end

# ---------------------------------------------------------------------------
# Issue 132: Issue 番号が 3 桁に達し、hex の 3 桁短縮形（#RGB）と表記が衝突するようになった。
# `（Issue #132）` というコメントが「直書き色」として検出され CI が赤になったのが発端である。
#
# 除外を入れる以上、それが広がりすぎていないことを同時に固定しなければならない。
# 「Issue 参照が緑になる」だけを置くと、除外が全 hex を飲み込んでも緑のままになる。
t_begin 'check-design-tokens: 種別を前置した Issue / PR 参照は色として検出しない（Issue 132）'
dt_fixture
fx_write ts/apps/demo/page.tsx <<'EOF'
// Issue #132 の対応。関連: PR #133、過去の経緯は Issue #120 を参照。
export const Page = () => null;
EOF
fx_run check-design-tokens
expect_green
t_end

t_begin 'check-design-tokens: 種別を前置しない裸の #132 は依然として検出する（除外の広がり過ぎ防止）'
dt_fixture
fx_write ts/apps/demo/page.tsx <<'EOF'
export const style = { color: '#132' };
EOF
fx_run check-design-tokens
expect_red '直書きの色指定が検出されました'
t_end

t_begin 'check-design-tokens: 同一行に Issue 参照と直書き色があれば色を検出する（行ごと捨てない）'
dt_fixture
fx_write ts/apps/demo/page.tsx <<'EOF'
// Issue #132 の暫定対応
export const style = { color: '#FF0000' }; // Issue #132 で恒久対応する
EOF
fx_run check-design-tokens
expect_red '直書きの色指定が検出されました'
t_end

# Issue 参照の打ち消しは sed、その後の判定は grep と、別のコマンドが担う。両者を 1 本のパイプへ
# 繋ぐと grep の exit 1（無一致＝違反なし）と sed の失敗が pipefail 下で同じ 1 に潰れ、
# **壊れた ISSUE_REF_PATTERN が「違反 0 件」に化ける**。Issue 120 と同型の偽緑であり、
# 実装では段を分けて防いでいる。その分離が外れたらここが赤で気づけるようにする。
t_begin 'check-design-tokens: Issue 参照の打ち消しが評価不能なら緑ではなく赤にする（Issue 132）'
dt_fixture
fx_write ts/apps/demo/page.tsx <<'EOF'
// Issue #132 の対応
export const Page = () => null;
EOF
awk '/^ISSUE_REF_PATTERN=/ { print "ISSUE_REF_PATTERN='"'"'['"'"'"; next } { print }' \
  "${FX}/scripts/check-design-tokens.sh" > "${FX}/scripts/dt-broken-ref.tmp"
mv "${FX}/scripts/dt-broken-ref.tmp" "${FX}/scripts/check-design-tokens.sh"
fx_run check-design-tokens
expect_red 'Issue 参照の打ち消しを評価できません'
t_end
