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
