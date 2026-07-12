# store-detail の Cloud Run 用 standalone イメージ（pnpm workspace・multi-stage）。
# LIFF からの読取専用 Web サービス（survey-web と同系の Next.js standalone 構成）。
# ビルドコンテキストはリポジトリの ts/（pnpm workspace ルート）。
#   docker build -f apps/store-detail/Dockerfile -t store-detail ts/
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
COPY apps/store-detail/package.json apps/store-detail/
RUN pnpm install --frozen-lockfile

# --- ビルド（@fwlm/db を tsc、store-detail を next build standalone） ---
FROM base AS build
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
RUN pnpm -C packages/db run build
RUN pnpm -C apps/store-detail run build

# --- 実行（standalone 最小成果物のみ） ---
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
# standalone は依存を内包した server.js を出力（node_modules 不要）。
COPY --from=build /repo/apps/store-detail/.next/standalone ./
COPY --from=build /repo/apps/store-detail/.next/static ./apps/store-detail/.next/static
EXPOSE 8080
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
CMD ["node", "apps/store-detail/server.js"]
