'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { PageShell } from '@fwlm/ui/components/page-shell';
import { Spinner } from '@fwlm/ui/components/spinner';
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
    // 子はそれぞれ自前の版面（主要領域）を持つ。ここで版面を足すと主要領域が二重になる。
    return <>{children}</>;
  }
  if (status === 'unregistered') {
    return (
      <PageShell>
        {/* 危険を伝える変種は読み上げ役割 alert を自ら持つ。文言の側へ role を重ねない。 */}
        <Alert variant="destructive">
          <AlertDescription>
            このアカウントには利用資格がありません。運営までお問い合わせください。
          </AlertDescription>
        </Alert>
      </PageShell>
    );
  }
  // loading / signedOut は遷移するまでの一時表示。管理データは出さない。
  return (
    <PageShell>
      {/* Spinner 自身も role="status" を持つため、読み上げはこの行に一本化する。
       * 図形は装飾として扱い aria-hidden で支援技術から外す。文言は可視のテキストのまま残す
       * （Spinner の aria-label へ移すと sr-only の子要素へ落ちる・Req 4.5）。 */}
      <p role="status" className="flex items-center gap-2">
        <Spinner aria-hidden />
        読み込み中...
      </p>
    </PageShell>
  );
}
