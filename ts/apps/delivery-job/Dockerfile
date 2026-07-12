# delivery-job の Cloud Run Job 用イメージ（pnpm workspace・multi-stage）。
# サーバーではなく毎時起動のバッチ Job のため、PORT 待受やヘルスチェックは持たない（実行→終了）。
# ビルドコンテキストはリポジトリの ts/（pnpm workspace ルート）。
#   docker build -f apps/delivery-job/Dockerfile -t delivery-job ts/
# 注記: このマシンには docker が無いため本 Dockerfile は CI/デプロイ時に検証する。

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS deps
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/db/package.json packages/db/
COPY apps/delivery-job/package.json apps/delivery-job/
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
RUN pnpm -C packages/db run build
RUN pnpm -C apps/delivery-job run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/db ./packages/db
COPY --from=build /repo/apps/delivery-job/dist ./dist
COPY --from=build /repo/apps/delivery-job/package.json ./
USER node
CMD ["node", "dist/index.js"]
