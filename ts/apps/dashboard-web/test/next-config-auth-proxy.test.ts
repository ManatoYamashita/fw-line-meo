import { afterEach, describe, expect, it, vi } from 'vitest';

// Firebase Auth のヘルパーを自ドメインで配るための中継（Issue #146）。
// authDomain を独自ドメインにしたとき、/__/auth/ が firebaseapp.com へ届かないとログインできない。

async function loadConfig(projectId: string | undefined) {
  vi.resetModules();
  if (projectId === undefined) vi.stubEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID', '');
  else vi.stubEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID', projectId);
  return import('../next.config');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('next.config の /__/auth/ 中継', () => {
  it('プロジェクト ID があれば /__/auth/:path* を firebaseapp.com へ rewrite する', async () => {
    const mod = await loadConfig('gen-fw-line-meo');
    const rewrites = await mod.default.rewrites!();
    expect(rewrites).toEqual([
      { source: '/__/auth/:path*', destination: 'https://gen-fw-line-meo.firebaseapp.com/__/auth/:path*' },
    ]);
  });

  it('プロジェクト ID が無ければ中継しない', async () => {
    const mod = await loadConfig(undefined);
    expect(await mod.default.rewrites!()).toEqual([]);
  });

  it('ホスト名に使えない文字を含むプロジェクト ID は拒否する', async () => {
    const { firebaseAuthProxyTarget } = await loadConfig(undefined);
    expect(() => firebaseAuthProxyTarget('evil.example.com/x')).toThrow(/不正/);
  });
});
