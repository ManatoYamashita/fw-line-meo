'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../lib/auth-context';

// 認可ガード。status==='ready'（登録済み・有効）のときだけ子を描画する。
// それ以外は管理情報を一切描画せず、未認証/未登録は /login へ寄せる（Req 1.1, 1.3, 7.1）。
export function AuthGuard({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'signedOut' || status === 'unregistered') {
      router.replace('/login');
    }
  }, [status, router]);

  if (status === 'ready') {
    return <>{children}</>;
  }
  if (status === 'unregistered') {
    return <p>このアカウントには利用資格がありません。運営までお問い合わせください。</p>;
  }
  // loading / signedOut は遷移するまでの一時表示。管理データは出さない。
  return <p>読み込み中...</p>;
}
