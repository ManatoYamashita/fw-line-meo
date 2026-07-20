# survey-web の Cloud Run 用 standalone イメージ（pnpm workspace・multi-stage）。
# ビルドコンテキストはリポジトリの ts/（pnpm workspace ルート）。
#   docker build -f apps/survey-web/Dockerfile -t survey-web ts/
# 注記: このマシンには docker が無いため本 Dockerfile は CI/デプロイ時に検証する。

FROM node:20-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# --- 依存インストール（workspace 全体・lockfile 厳守） ---
FROM base AS deps
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/db/package.json packages/db/
COPY apps/survey-web/package.json apps/survey-web/
RUN pnpm install --frozen-lockfile

# --- ビルド（@fwlm/db を tsc、survey-web を next build standalone） ---
FROM base AS build
WORKDIR /repo
# deps ステージ全体をコピー（pnpm はパッケージ単位で node_modules を持つため、
# ルートの node_modules だけでなく packages/db・apps/survey-web 配下の
# node_modules シンボリックリンクも必要）。
COPY --from=deps /repo ./
COPY . .
RUN pnpm -C packages/db run build
RUN pnpm -C apps/survey-web run build

# --- 実行（standalone 最小成果物のみ） ---
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
# standalone は依存を内包した server.js を出力（node_modules 不要）。
# survey-web は public/ ディレクトリを持たないため static のみコピーする（存在しない
# パスの COPY はビルドエラーになる）。
COPY --from=build /repo/apps/survey-web/.next/standalone ./
COPY --from=build /repo/apps/survey-web/.next/static ./apps/survey-web/.next/static
EXPOSE 8080
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
CMD ["node", "apps/survey-web/server.js"]
