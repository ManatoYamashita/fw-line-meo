'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../lib/auth-context';

// ルートの振り分け（design File Structure Plan: 未認証→/login・認証済→/stores）。
// unregistered も /login へ送る（ログイン画面が利用資格なしの案内を表示する）。
// 状態確定前（loading）は遷移せず待ち、誤リダイレクトでちらつかせない。
export default function Home() {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'ready') {
      router.replace('/stores');
    } else if (status === 'signedOut' || status === 'unregistered') {
      router.replace('/login');
    }
  }, [status, router]);

  return (
    <main>
      <p>読み込み中…</p>
    </main>
  );
}
