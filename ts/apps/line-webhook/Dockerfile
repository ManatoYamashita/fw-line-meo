# line-webhook の Cloud Run 用イメージ（pnpm workspace・multi-stage）。
# ビルドコンテキストはリポジトリの ts/（pnpm workspace ルート）。
#   docker build -f apps/line-webhook/Dockerfile -t line-webhook ts/
# 注記: このマシンには docker が無いため本 Dockerfile は CI/デプロイ時に検証する。
# @line/bot-sdk の次期メジャーが Node >=22 を要求するため node:22-slim を使用する。

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS deps
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/db/package.json packages/db/
COPY apps/line-webhook/package.json apps/line-webhook/
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /repo
# deps ステージ全体をコピー（pnpm はパッケージ単位で node_modules を持つため、
# ルートの node_modules だけでなく packages/db・apps/line-webhook 配下の
# node_modules シンボリックリンクも必要。delivery-job/store-detail と同一パターン）。
COPY --from=deps /repo ./
COPY . .
RUN pnpm -C packages/db run build
RUN pnpm -C apps/line-webhook run build

FROM base AS runner
# pnpm workspace のパッケージ間シンボリックリンク（例:
# apps/line-webhook/node_modules/@fwlm/db -> ../../../../packages/db）は
# 相対パスの深さに依存するため、build ステージと同じ /repo 階層を保ったまま
# 必要なディレクトリのみをコピーする（/app 直下へ再配置すると相対リンクが壊れる）。
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/db ./packages/db
COPY --from=build /repo/apps/line-webhook/node_modules ./apps/line-webhook/node_modules
COPY --from=build /repo/apps/line-webhook/dist ./apps/line-webhook/dist
COPY --from=build /repo/apps/line-webhook/package.json ./apps/line-webhook/package.json
EXPOSE 8080
ENV PORT=8080
USER node
CMD ["node", "apps/line-webhook/dist/index.js"]
