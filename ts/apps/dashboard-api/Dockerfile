# dashboard-api の Cloud Run 用イメージ（pnpm workspace・multi-stage）。
# ビルドコンテキストはリポジトリの ts/（pnpm workspace ルート）。
#   docker build -f apps/dashboard-api/Dockerfile -t dashboard-api ts/
# 注記: このマシンには docker が無いため本 Dockerfile は CI/デプロイ時に検証する。

FROM node:20-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS deps
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/db/package.json packages/db/
COPY apps/dashboard-api/package.json apps/dashboard-api/
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
RUN pnpm -C packages/db run build
RUN pnpm -C apps/dashboard-api run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/db ./packages/db
COPY --from=build /repo/apps/dashboard-api/dist ./dist
COPY --from=build /repo/apps/dashboard-api/package.json ./
EXPOSE 8080
ENV PORT=8080
CMD ["node", "dist/index.js"]
