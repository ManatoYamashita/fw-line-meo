# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/check-next-public-buildargs.sh の自己テスト（Issue #90）。
#
# 対象は grep 検証のみで実行環境に依存しないため、skip 条件を持たない。

npb_fixture() {
  fx_guard check-next-public-buildargs
  fx_write ts/apps/demo/page.tsx <<'EOF'
export const url = process.env.NEXT_PUBLIC_LIFF_ID;
EOF
  fx_write ts/apps/demo/Dockerfile <<'EOF'
FROM node:20-alpine AS build
ARG NEXT_PUBLIC_LIFF_ID
ENV NEXT_PUBLIC_LIFF_ID=$NEXT_PUBLIC_LIFF_ID
RUN npm run build
EOF
}

t_begin 'check-next-public-buildargs: ARG が揃っていれば緑'
npb_fixture
fx_run check-next-public-buildargs
expect_green
expect_output_matches '1 app / 1 var'
t_end

t_begin 'check-next-public-buildargs: ARG 欠落を検出する'
npb_fixture
fx_write ts/apps/demo/Dockerfile <<'EOF'
FROM node:20-alpine AS build
RUN npm run build
EOF
fx_run check-next-public-buildargs
expect_red "'ARG NEXT_PUBLIC_LIFF_ID' がありません"
t_end

t_begin 'check-next-public-buildargs: Dockerfile 欠落を検出する'
npb_fixture
rm -f "${FX}/ts/apps/demo/Dockerfile"
fx_run check-next-public-buildargs
expect_red 'Dockerfile がありません'
t_end

# ---------------------------------------------------------------------------
# 空振り防止。他の 4 本のガード（design-tokens / deploy-image-coverage /
# typecheck-coverage / test-code-coverage）はいずれも「1 件も検証できなければ赤」を持つが、
# 本ガードだけ持っていなかった（Issue #90 の調査で実測）。
#
# 検証対象が 0 件のまま緑を返すと、grep の除外条件が壊れて全ファイルを取りこぼした場合でも
# CI は緑のまま通る。本ガードが防ごうとしている「空値が焼き込まれて本番で必ず失敗する」障害を、
# ガード自身が見逃す形になる。

t_begin 'check-next-public-buildargs: 検証対象 0 件で緑を返さない（空振り防止）'
fx_guard check-next-public-buildargs
# NEXT_PUBLIC_* を一切参照しないアプリだけを置く
fx_write ts/apps/demo/page.tsx <<'EOF'
export const x = 1;
EOF
fx_run check-next-public-buildargs
expect_red '1 件も検証できませんでした'
t_end
