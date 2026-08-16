# dashboard-api の Cloud Run 用イメージ（pnpm workspace・multi-stage）。
# ビルドコンテキストはリポジトリの ts/（pnpm workspace ルート）。
#   docker build -f apps/dashboard-api/Dockerfile -t dashboard-api ts/
# 構成は CI 実績のある apps/delivery-job/Dockerfile と同型（deps 全体コピー・/repo 階層維持）。

FROM node:20-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS deps
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/db/package.json packages/db/
COPY packages/store-identification/package.json packages/store-identification/
COPY apps/dashboard-api/package.json apps/dashboard-api/
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /repo
# deps ステージ全体をコピー（pnpm はパッケージ単位で node_modules を持つため、
# ルートの node_modules だけでなく packages/*・apps/dashboard-api 配下の
# node_modules シンボリックリンクも必要）。
COPY --from=deps /repo ./
COPY . .
RUN pnpm -C packages/db run build
RUN pnpm -C packages/store-identification run build
RUN pnpm -C apps/dashboard-api run build

FROM base AS runner
# pnpm workspace のパッケージ間シンボリックリンク（例:
# apps/dashboard-api/node_modules/@fwlm/db -> ../../../../packages/db）は
# 相対パスの深さに依存するため、build ステージと同じ /repo 階層を保ったまま
# 必要なディレクトリのみをコピーする（/app 直下へ再配置すると相対リンクが壊れる）。
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/db ./packages/db
COPY --from=build /repo/packages/store-identification ./packages/store-identification
COPY --from=build /repo/apps/dashboard-api/node_modules ./apps/dashboard-api/node_modules
COPY --from=build /repo/apps/dashboard-api/dist ./apps/dashboard-api/dist
COPY --from=build /repo/apps/dashboard-api/package.json ./apps/dashboard-api/package.json
EXPOSE 8080
ENV PORT=8080
USER node
CMD ["node", "apps/dashboard-api/dist/index.js"]
