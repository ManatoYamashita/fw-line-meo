import path from 'node:path';
import type { NextConfig } from 'next';

// pnpm workspace ルート（ts/）。cwd 非依存で解決する（import.meta.dirname = このファイルのある apps/dashboard-web）。
const workspaceRoot = path.join(import.meta.dirname, '..', '..');

/**
 * Firebase Auth のヘルパー（/__/auth/handler など）を自ドメインで配るための中継先（Issue #146）。
 *
 * authDomain を独自ドメイン（dashboard.firstweb-works.com）にすると、ログインのポップアップは
 * そのドメインの /__/auth/ を開く。そこを <project>.firebaseapp.com へ透過的に中継する
 * （Firebase の「redirect best practices」Option 3。302 では不可なので rewrite で行う）。
 * NEXT_PUBLIC_FIREBASE_PROJECT_ID は Dockerfile の build-arg で next build 前に入る。
 * 未設定（ローカル・テスト）なら中継しない。
 */
export function firebaseAuthProxyTarget(projectId: string | undefined): string | null {
  if (!projectId) return null;
  if (!/^[a-z0-9-]+$/.test(projectId)) {
    throw new Error(`NEXT_PUBLIC_FIREBASE_PROJECT_ID が不正です: ${projectId}`);
  }
  return `https://${projectId}.firebaseapp.com/__/auth`;
}

const authProxyTarget = firebaseAuthProxyTarget(process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID);

const nextConfig: NextConfig = {
  // Cloud Run セルフホスト用の自己完結出力（.next/standalone に最小 server.js）。
  output: 'standalone',
  // monorepo のためルートを明示（Turbopack のルート誤推論と standalone の依存トレース起点を固定）。
  turbopack: {
    root: workspaceRoot,
    // E2E 専用の IdP 差し替え（Issue #53）。env が無ければ空のまま = 本物の SDK を束ねる。
    ...(process.env.E2E_STUB_IDP === '1'
      ? { resolveAlias: { 'firebase/auth': './e2e/stubs/firebase-auth.ts' } }
      : {}),
  },
  outputFileTracingRoot: workspaceRoot,
  async rewrites() {
    return authProxyTarget ? [{ source: '/__/auth/:path*', destination: `${authProxyTarget}/:path*` }] : [];
  },
};

export default nextConfig;
