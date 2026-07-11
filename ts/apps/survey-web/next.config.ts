import path from 'node:path';
import type { NextConfig } from 'next';

// pnpm workspace ルート（ts/）。cwd 非依存で解決する（import.meta.dirname = このファイルのある apps/survey-web）。
const workspaceRoot = path.join(import.meta.dirname, '..', '..');

const nextConfig: NextConfig = {
  // Cloud Run セルフホスト用の自己完結出力（.next/standalone に最小 server.js）。
  output: 'standalone',
  // monorepo のためルートを明示（Turbopack のルート誤推論と standalone の依存トレース起点を固定）。
  turbopack: {
    root: workspaceRoot,
  },
  outputFileTracingRoot: workspaceRoot,
};

export default nextConfig;
