'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { PageShell } from '@fwlm/ui/components/page-shell';
import { Spinner } from '@fwlm/ui/components/spinner';
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
    <PageShell>
      {/* Spinner 自身も role="status" を持つため、読み上げはこの行に一本化する。
       * 図形は装飾として扱い aria-hidden で支援技術から外す（components/store-qr-panel.tsx と同じ作法）。
       * 文言は可視のテキストのまま残す。Spinner の aria-label へ移すと sr-only の子要素へ落ち、
       * 動き低減設定でない実ブラウザでは進行状態の手掛かりが回転だけになる（Req 4.5）。 */}
      <p role="status" className="flex items-center gap-2">
        <Spinner aria-hidden />
        読み込み中…
      </p>
    </PageShell>
  );
}
