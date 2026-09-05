# scripts/check-e2e-idp-stub-isolation.sh の自己テスト（Issue #53）。
#
# 本ガードが守るのは「E2E 専用の IdP 差し替えが出荷経路へ漏れないこと」である。漏れた場合の
# 症状は**エラーではなく正常動作**（ログインを求められないダッシュボード・LINE 外でも開く LIFF 面）
# であり、通常のテストでは検出できない。したがって検出の各分岐が本当に到達することを、
# 条件を 1 つだけ戻すと緑になる対照付きで固定する。

eis_tree() {
  fx_guard check-e2e-idp-stub-isolation

  # 差し替えを持つアプリ（正常形）。
  fx_write ts/apps/liff-face/Dockerfile <<'EOF'
FROM node:20-slim AS base
ARG NEXT_PUBLIC_LIFF_ID
ENV NEXT_PUBLIC_LIFF_ID=$NEXT_PUBLIC_LIFF_ID
EOF
  fx_write ts/apps/liff-face/next.config.ts <<'EOF'
const nextConfig = {
  turbopack: {
    ...(process.env.E2E_STUB_IDP === '1'
      ? { resolveAlias: { '@line/liff': './e2e/stubs/liff.ts' } }
      : {}),
  },
};
export default nextConfig;
EOF
  fx_write ts/apps/liff-face/e2e/stubs/liff.ts <<'EOF'
export default { init: async () => {} };
EOF
  fx_write ts/apps/liff-face/app/page.tsx <<'EOF'
import liff from '@line/liff';
export default function Page() { return null; }
EOF

  # 差し替えを持たないアプリ（対象外として素通りすることの対照）。
  fx_write ts/apps/plain-face/Dockerfile <<'EOF'
FROM node:20-slim AS base
EOF
  fx_write ts/apps/plain-face/next.config.ts <<'EOF'
const nextConfig = { turbopack: {} };
export default nextConfig;
EOF

  fx_write scripts/push-images.sh <<'EOF'
#!/usr/bin/env bash
BUILD_ARGS="--build-arg NEXT_PUBLIC_LIFF_ID=${NEXT_PUBLIC_LIFF_ID:-}"
EOF
  fx_write .github/workflows/deploy.yml <<'EOF'
name: deploy
jobs:
  deploy-prod:
    steps:
      - run: bash scripts/push-images.sh
EOF
}

t_begin 'check-e2e-idp-stub-isolation: 正常なツリーで緑（件数まで照合）'
eis_tree
fx_run check-e2e-idp-stub-isolation
expect_green
# 「OK」だけでなく件数を照合する。走査が空振りしたまま緑になる経路と区別するため。
expect_output_matches '出荷経路 4 ファイル / スタブを持つアプリ 1 件 / resolveAlias 1 件'
t_end

# ---------------------------------------------------------------------------
# 1. 出荷経路への漏れ。3 経路それぞれで到達することを示す。

t_begin 'check-e2e-idp-stub-isolation: Dockerfile へ env が漏れると赤'
eis_tree
fx_write ts/apps/liff-face/Dockerfile <<'EOF'
FROM node:20-slim AS base
ARG E2E_STUB_IDP
ENV E2E_STUB_IDP=$E2E_STUB_IDP
EOF
fx_run check-e2e-idp-stub-isolation
expect_red 'ts/apps/liff-face/Dockerfile に E2E_STUB_IDP が 2 件現れます（出荷経路への漏れ）。'
t_end

t_begin 'check-e2e-idp-stub-isolation: push-images.sh へ env が漏れると赤'
eis_tree
fx_write scripts/push-images.sh <<'EOF'
#!/usr/bin/env bash
BUILD_ARGS="--build-arg E2E_STUB_IDP=${E2E_STUB_IDP:-}"
EOF
fx_run check-e2e-idp-stub-isolation
expect_red 'scripts/push-images.sh に E2E_STUB_IDP が 1 件現れます（出荷経路への漏れ）。'
t_end

t_begin 'check-e2e-idp-stub-isolation: deploy.yml へ env が漏れると赤'
eis_tree
fx_write .github/workflows/deploy.yml <<'EOF'
name: deploy
jobs:
  deploy-prod:
    env:
      E2E_STUB_IDP: '1'
    steps:
      - run: bash scripts/push-images.sh
EOF
fx_run check-e2e-idp-stub-isolation
expect_red '.github/workflows/deploy.yml に E2E_STUB_IDP が 1 件現れます（出荷経路への漏れ）。'
t_end

# ---------------------------------------------------------------------------
# 2. スタブと resolveAlias の双方向一致。片方だけ足す／消すのどちらも赤にする。

t_begin 'check-e2e-idp-stub-isolation: スタブはあるが resolveAlias が無いと赤'
eis_tree
fx_write ts/apps/liff-face/next.config.ts <<'EOF'
const nextConfig = { turbopack: {} };
export default nextConfig;
EOF
fx_run check-e2e-idp-stub-isolation
expect_red 'liff-face は e2e/stubs/ を持ちますが next.config.ts に resolveAlias がありません。'
t_end

t_begin 'check-e2e-idp-stub-isolation: resolveAlias はあるがスタブが無いと赤'
eis_tree
rm -rf "${FX}/ts/apps/liff-face/e2e"
fx_run check-e2e-idp-stub-isolation
expect_red 'liff-face は next.config.ts に resolveAlias を持ちますが e2e/stubs/ がありません。'
t_end

# ---------------------------------------------------------------------------
# 3. fail-open の検出。**これが本ガードの核心である。**
# 真偽値評価へ変えると、空文字や '0' でも差し替えが有効になる。構文としては妥当で、
# ビルドも E2E も緑のまま通るため、この形でしか捕まえられない。

t_begin 'check-e2e-idp-stub-isolation: 等値比較を真偽値評価へ変えると赤（fail-open の検出）'
eis_tree
fx_write ts/apps/liff-face/next.config.ts <<'EOF'
const nextConfig = {
  turbopack: {
    ...(process.env.E2E_STUB_IDP
      ? { resolveAlias: { '@line/liff': './e2e/stubs/liff.ts' } }
      : {}),
  },
};
export default nextConfig;
EOF
fx_run check-e2e-idp-stub-isolation
expect_red 'liff-face の next.config.ts の resolveAlias が E2E_STUB_IDP との等値比較で囲われていません。'
expect_output_matches "期待する形: process\.env\.E2E_STUB_IDP === '1'"
t_end

# ---------------------------------------------------------------------------
# 4. 本番ソースからの参照。env と無関係にスタブが束ねられる経路。

t_begin 'check-e2e-idp-stub-isolation: 本番ソースがスタブを参照すると赤'
eis_tree
fx_write ts/apps/liff-face/app/page.tsx <<'EOF'
import liff from '../e2e/stubs/liff';
export default function Page() { return null; }
EOF
fx_run check-e2e-idp-stub-isolation
expect_red 'liff-face の本番ソースが e2e/stubs/ を参照しています:'
expect_output_matches 'ts/apps/liff-face/app/page\.tsx'
t_end

t_begin 'check-e2e-idp-stub-isolation: 対照 — 参照が e2e/ の内側なら緑'
eis_tree
fx_write ts/apps/liff-face/e2e/surface.spec.ts <<'EOF'
import liff from './stubs/liff';
export const probe = liff;
EOF
fx_run check-e2e-idp-stub-isolation
expect_green
t_end

# ---------------------------------------------------------------------------
# 5. 空振り防止。対象 0 件のまま「違反 0 件だから緑」を返すのが最悪の結果である。

t_begin 'check-e2e-idp-stub-isolation: 出荷経路を 1 件も走査できないとき緑を返さない'
fx_guard check-e2e-idp-stub-isolation
fx_write ts/apps/liff-face/next.config.ts <<'EOF'
const nextConfig = { turbopack: {} };
export default nextConfig;
EOF
fx_run check-e2e-idp-stub-isolation
expect_red '出荷経路のファイルを 1 件も走査できませんでした。ガードが空振りしています。'
t_end

t_begin 'check-e2e-idp-stub-isolation: スタブを持つアプリが 0 件のとき緑を返さない'
eis_tree
rm -rf "${FX}/ts/apps/liff-face"
fx_run check-e2e-idp-stub-isolation
expect_red 'e2e/stubs/ を持つアプリが 1 件もありません。ガードが空振りしています。'
t_end

t_begin 'check-e2e-idp-stub-isolation: ts/apps 消失を空振りとして報告する'
fx_guard check-e2e-idp-stub-isolation
fx_write scripts/push-images.sh <<'EOF'
#!/usr/bin/env bash
EOF
fx_run check-e2e-idp-stub-isolation
expect_red 'ts/apps がありません。走査の前提が崩れています。'
t_end

# ---------------------------------------------------------------------------
# 分岐到達性。判別子が定数化して片側が実質デッドコードになった状態は、赤ケースを
# 期待文字列まで照合しても緑のまま残る。最小改変で到達できること自体を assert する。

t_begin 'check-e2e-idp-stub-isolation: 漏れ検出の判定を定数化すると正常ツリーが赤くなる'
eis_tree
fx_guard_mutate check-e2e-idp-stub-isolation -e 's/if \[ "\$csf_n" -gt 0 \]; then/if [ "$csf_n" -ge 0 ]; then/'
fx_run check-e2e-idp-stub-isolation
expect_red '（出荷経路への漏れ）'
t_end
