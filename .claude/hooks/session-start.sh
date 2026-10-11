#!/bin/bash
# Claude Code on the web 用。ローカル（devcontainer / mac）の環境には触れない。
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
TS_DIR="${ROOT}/ts"
NODE_MAJOR=24

# クラウドの既定 node は 22 だが ts/package.json の engines は >=24。
# CI（setup-node の node-version: 24）と同じく 24 系の最新を使う。
export NVM_DIR="${NVM_DIR:-/opt/nvm}"
set +u
# shellcheck disable=SC1091
. "${NVM_DIR}/nvm.sh"
nvm install "${NODE_MAJOR}" >/dev/null
NODE_BIN="$(dirname "$(nvm which "${NODE_MAJOR}")")"
set -u
export PATH="${NODE_BIN}:${PATH}"

# 以後の Bash ツール呼び出しでも node 24 を先に見つけさせる（既定 PATH の /opt/node22 より前）。
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"${NODE_BIN}:\${PATH}\"" >> "${CLAUDE_ENV_FILE}"
fi

PNPM_VERSION="$(node -p "require('${TS_DIR}/package.json').packageManager.split('@')[1]")"
if [ "$(pnpm -v 2>/dev/null || true)" != "${PNPM_VERSION}" ] || [ "$(dirname "$(command -v pnpm)")" != "${NODE_BIN}" ]; then
  npm install -g "pnpm@${PNPM_VERSION}" >/dev/null
fi

# lockfile を書き換えない（CI と同じ解決結果を使う）。
pnpm --dir "${TS_DIR}" install --frozen-lockfile

# go.mod の要求版がクラウド既定の go より新しいため、toolchain と依存を先に取得しておく。
if command -v go >/dev/null 2>&1; then
  (cd "${ROOT}/go" && go mod download)
fi

echo "session-start: node $(node -v) / pnpm $(pnpm -v) / $(cd "${ROOT}/go" && go version 2>/dev/null || echo 'go なし')"
