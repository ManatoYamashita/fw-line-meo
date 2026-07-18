# dashboard-web の Cloud Run 用 standalone イメージ（pnpm workspace・multi-stage）。
# 運営・代理店向けダッシュボード UI（survey-web / store-detail と同系の Next.js standalone 構成）。
# このアプリは @fwlm/db に依存せず、業務データは dashboard-api 越しに HTTP で取得する。
# ビルドコンテキストはリポジトリの ts/（pnpm workspace ルート）。
#   docker build -f apps/dashboard-web/Dockerfile -t dashboard-web ts/
# 注記: このマシンには docker が無いため本 Dockerfile は CI/デプロイ時に検証する。

FROM node:20-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# --- 依存インストール（workspace 全体・lockfile 厳守） ---
FROM base AS deps
WORKDIR /repo
# dashboard-web は workspace パッケージ（@fwlm/db 等）に依存しないため、
# ルート workspace ファイルと自アプリの package.json のみで解決できる。
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/dashboard-web/package.json apps/dashboard-web/
RUN pnpm install --frozen-lockfile

# --- ビルド（dashboard-web を next build standalone） ---
FROM base AS build
WORKDIR /repo
# deps ステージ全体をコピー（pnpm はパッケージ単位で node_modules を持つため、
# ルートの node_modules だけでなく apps/dashboard-web 配下の
# node_modules シンボリックリンクも必要）。
COPY --from=deps /repo ./
COPY . .
# NEXT_PUBLIC_* はクライアントバンドルへ next build 時にインライン化される（ランタイム env では
# クライアントに反映されない）。build-arg 未指定なら空値が焼き込まれ、Firebase 初期化や
# dashboard-api 呼び出しが本番で必ず失敗する。デプロイ側（push-images.sh の BUILD_ARGS）で必ず渡すこと。
ARG NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_FIREBASE_API_KEY
ENV NEXT_PUBLIC_FIREBASE_API_KEY=$NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ENV NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID
ENV NEXT_PUBLIC_FIREBASE_PROJECT_ID=$NEXT_PUBLIC_FIREBASE_PROJECT_ID
RUN pnpm -C apps/dashboard-web run build

# --- 実行（standalone 最小成果物のみ） ---
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
# standalone は依存を内包した server.js を出力（node_modules 不要）。
COPY --from=build /repo/apps/dashboard-web/.next/standalone ./
COPY --from=build /repo/apps/dashboard-web/.next/static ./apps/dashboard-web/.next/static
EXPOSE 8080
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
CMD ["node", "apps/dashboard-web/server.js"]
