# daily-batch の Cloud Run Job 用イメージ（go.mod は go/ ルート・multi-stage・distroless 実行時）。
# ビルドコンテキストはリポジトリの go/。
#   docker build -t daily-batch go/
# 注記: このマシンには docker/apple-container が無いため、本 Dockerfile の実ビルドは CI/デプロイ時に検証する。

FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# CGO 無効・静的リンクで distroless 実行時に依存を持ち込まない。
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/daily-batch ./cmd/daily-batch

FROM gcr.io/distroless/static-debian12:nonroot AS runner
# distroless:nonroot は非 root ユーザー（uid 65532）で実行される。
COPY --from=build /out/daily-batch /daily-batch
USER nonroot:nonroot
ENTRYPOINT ["/daily-batch"]
