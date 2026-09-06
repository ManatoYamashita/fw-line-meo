# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/check-workspace-package-dockerfiles.sh の自己テスト（Issue #234）。
#
# 対象は grep / sed 検証のみで実行環境に依存しないため、skip 条件を持たない。
#
# **偽陽性を出さないことの検証を含める。** 本ガードの初版は推移的依存を辿らず、
# ui → design-tokens（dev 経由）を「宣言のない取り込み」として叩いた。実ツリーの
# dashboard-web / store-detail が正しく持っている取り込みを違反と報告する状態だった。
# 誤検知するガードは、そのうち除外で黙らされて空振りに退化する。

# 共有パッケージ 3 種を置く。db と design-tokens はビルド成果物を持ち、ui は持たない。
# ui は design-tokens へ **dev 経由**で依存する（実ツリーと同じ形）。
wpd_packages() {
  fx_write ts/packages/db/package.json <<'EOF'
{
  "name": "@fwlm/db",
  "scripts": {
    "build": "tsc -p tsconfig.json"
  }
}
EOF
  fx_write ts/packages/design-tokens/package.json <<'EOF'
{
  "name": "@fwlm/design-tokens",
  "scripts": {
    "build": "tsc -p tsconfig.json"
  }
}
EOF
  fx_write ts/packages/ui/package.json <<'EOF'
{
  "name": "@fwlm/ui",
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@fwlm/design-tokens": "workspace:*"
  }
}
EOF
}

# 成果物を内包しない形式（Node を直接実行する面）。3 段すべてが要る。
wpd_direct_app() {
  fx_write ts/apps/demo/package.json <<'EOF'
{
  "name": "@fwlm/demo",
  "dependencies": {
    "@fwlm/db": "workspace:*"
  }
}
EOF
  fx_write ts/apps/demo/Dockerfile <<'EOF'
FROM node:24-slim AS deps
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile

FROM node:24-slim AS build
RUN pnpm -C packages/db run build

FROM node:24-slim AS runner
COPY --from=build /repo/packages/db ./packages/db
CMD ["node", "apps/demo/dist/index.js"]
EOF
}

t_begin 'check-workspace-package-dockerfiles: 3 段そろっていれば緑'
fx_guard check-workspace-package-dockerfiles
wpd_packages
wpd_direct_app
fx_run check-workspace-package-dockerfiles
expect_green
expect_output_matches '1 app / 1 依存'
t_end

t_begin 'check-workspace-package-dockerfiles: 依存解決の段の欠落を検出する'
fx_guard check-workspace-package-dockerfiles
wpd_packages
wpd_direct_app
fx_write ts/apps/demo/Dockerfile <<'EOF'
FROM node:24-slim AS deps
RUN pnpm install --frozen-lockfile

FROM node:24-slim AS build
RUN pnpm -C packages/db run build

FROM node:24-slim AS runner
COPY --from=build /repo/packages/db ./packages/db
CMD ["node", "apps/demo/dist/index.js"]
EOF
fx_run check-workspace-package-dockerfiles
expect_red '依存解決の段に取り込みがありません'
t_end

t_begin 'check-workspace-package-dockerfiles: ビルドの段の欠落を検出する'
fx_guard check-workspace-package-dockerfiles
wpd_packages
wpd_direct_app
fx_write ts/apps/demo/Dockerfile <<'EOF'
FROM node:24-slim AS deps
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile

FROM node:24-slim AS build
RUN pnpm -C apps/demo run build

FROM node:24-slim AS runner
COPY --from=build /repo/packages/db ./packages/db
CMD ["node", "apps/demo/dist/index.js"]
EOF
fx_run check-workspace-package-dockerfiles
expect_red 'ビルドの段がありません'
t_end

t_begin 'check-workspace-package-dockerfiles: 実行時配置の段の欠落を検出する'
fx_guard check-workspace-package-dockerfiles
wpd_packages
wpd_direct_app
fx_write ts/apps/demo/Dockerfile <<'EOF'
FROM node:24-slim AS deps
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile

FROM node:24-slim AS build
RUN pnpm -C packages/db run build

FROM node:24-slim AS runner
CMD ["node", "apps/demo/dist/index.js"]
EOF
fx_run check-workspace-package-dockerfiles
expect_red '実行時配置の段に取り込みがありません'
t_end

# ---------------------------------------------------------------------------
# 偽陽性を出さないことの検証（ここからの 3 件が本ガードの初版で壊れていた軸）

t_begin 'check-workspace-package-dockerfiles: 成果物を内包する形式へ実行時配置の段を要求しない'
fx_guard check-workspace-package-dockerfiles
wpd_packages
fx_write ts/apps/demo/package.json <<'EOF'
{
  "name": "@fwlm/demo",
  "dependencies": {
    "@fwlm/db": "workspace:*"
  }
}
EOF
# standalone 出力を配置する形式。packages を個別に写さないのが正しく、
# ここへ実行時配置の段を足すと存在しないパスの複写でビルドが落ちる。
fx_write ts/apps/demo/Dockerfile <<'EOF'
FROM node:24-slim AS deps
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile

FROM node:24-slim AS build
RUN pnpm -C packages/db run build
RUN pnpm -C apps/demo run build

FROM node:24-slim AS runner
COPY --from=build /repo/apps/demo/.next/standalone ./
CMD ["node", "apps/demo/server.js"]
EOF
fx_run check-workspace-package-dockerfiles
expect_green
expect_absent '実行時配置の段'
t_end

t_begin 'check-workspace-package-dockerfiles: 間接依存の取り込みを違反として叩かない'
fx_guard check-workspace-package-dockerfiles
wpd_packages
# demo は ui にだけ依存する。design-tokens は ui の dev 依存として間接的に到達するため、
# 依存解決の段への取り込みは正しい（pnpm が lockfile 全体を解決するため必要になる）。
fx_write ts/apps/demo/package.json <<'EOF'
{
  "name": "@fwlm/demo",
  "dependencies": {
    "@fwlm/ui": "workspace:*"
  }
}
EOF
fx_write ts/apps/demo/Dockerfile <<'EOF'
FROM node:24-slim AS deps
COPY packages/ui/package.json packages/ui/
COPY packages/design-tokens/package.json packages/design-tokens/
RUN pnpm install --frozen-lockfile

FROM node:24-slim AS build
RUN pnpm -C apps/demo run build

FROM node:24-slim AS runner
COPY --from=build /repo/apps/demo/.next/standalone ./
CMD ["node", "apps/demo/server.js"]
EOF
fx_run check-workspace-package-dockerfiles
expect_green
expect_absent '到達しません'
t_end

t_begin 'check-workspace-package-dockerfiles: dev 経由で到達する成果物にビルドの段を要求しない'
fx_guard check-workspace-package-dockerfiles
wpd_packages
# design-tokens はビルド成果物を持つが、ui の **dev 依存**としてしか到達しない。
# 実行時には要らないのでビルドの段は不要であり、要求すると偽の赤になる。
fx_write ts/apps/demo/package.json <<'EOF'
{
  "name": "@fwlm/demo",
  "dependencies": {
    "@fwlm/ui": "workspace:*"
  }
}
EOF
fx_write ts/apps/demo/Dockerfile <<'EOF'
FROM node:24-slim AS deps
COPY packages/ui/package.json packages/ui/
COPY packages/design-tokens/package.json packages/design-tokens/
RUN pnpm install --frozen-lockfile

FROM node:24-slim AS build
RUN pnpm -C apps/demo run build

FROM node:24-slim AS runner
COPY --from=build /repo/apps/demo/.next/standalone ./
CMD ["node", "apps/demo/server.js"]
EOF
fx_run check-workspace-package-dockerfiles
expect_green
expect_absent 'ビルドの段がありません'
t_end

# ---------------------------------------------------------------------------
# 逆方向と空振り防止

t_begin 'check-workspace-package-dockerfiles: 到達しない packages の取り込みを検出する'
fx_guard check-workspace-package-dockerfiles
wpd_packages
wpd_direct_app
fx_write ts/apps/demo/Dockerfile <<'EOF'
FROM node:24-slim AS deps
COPY packages/db/package.json packages/db/
COPY packages/design-tokens/package.json packages/design-tokens/
RUN pnpm install --frozen-lockfile

FROM node:24-slim AS build
RUN pnpm -C packages/db run build

FROM node:24-slim AS runner
COPY --from=build /repo/packages/db ./packages/db
CMD ["node", "apps/demo/dist/index.js"]
EOF
fx_run check-workspace-package-dockerfiles
expect_red '到達しません'
t_end

t_begin 'check-workspace-package-dockerfiles: 検証対象 0 件で緑を返さない（空振り防止）'
fx_guard check-workspace-package-dockerfiles
wpd_packages
# workspace 依存を 1 つも持たないアプリだけを置く
fx_write ts/apps/demo/package.json <<'EOF'
{
  "name": "@fwlm/demo",
  "dependencies": {
    "hono": "^4.0.0"
  }
}
EOF
fx_write ts/apps/demo/Dockerfile <<'EOF'
FROM node:24-slim AS runner
CMD ["node", "apps/demo/dist/index.js"]
EOF
fx_run check-workspace-package-dockerfiles
expect_red '1 件も抽出できませんでした'
t_end
