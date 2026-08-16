'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../lib/auth-context';

// Google ログイン画面（signInWithPopup）。未登録/無効時は利用資格がない旨を案内する。
// 認証済み（ready）になったら店舗一覧へ遷移する。管理データは一切描画しない（Req 1.1, 1.3, 7.3）。
export default function LoginPage() {
  const { status, signIn } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'ready') {
      router.replace('/stores');
    }
  }, [status, router]);

  if (status === 'unregistered') {
    return (
      <main>
        <h1>ログイン</h1>
        <p role="alert">
          このアカウントにはダッシュボードの利用資格がありません。
          ご利用をご希望の場合は、運営までお問い合わせください。
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>ログイン</h1>
      <p>運営・代理店向けダッシュボードです。Google アカウントでログインしてください。</p>
      <button type="button" onClick={() => void signIn()} disabled={status === 'loading'}>
        Google でログイン
      </button>
    </main>
  );
}
