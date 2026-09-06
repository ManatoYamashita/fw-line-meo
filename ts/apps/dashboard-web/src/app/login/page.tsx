'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { Button } from '@fwlm/ui/components/button';
import { Heading } from '@fwlm/ui/components/heading';
import { PageShell } from '@fwlm/ui/components/page-shell';
import { useAuth } from '../../lib/auth-context';

// Google ログイン画面（signInWithPopup）。未登録/無効時は利用資格がない旨を案内する。
// 認証済み（ready）になったら店舗一覧へ遷移する。管理データは一切描画しない（Req 1.1, 1.3, 7.3）。
//
// 版面（本文系の狭い側）と主操作を全幅にする判断は docs/design/design-language.md の 7.9 節が、
// ワードマークの色は 7.4 節と 2.2 節が正典であり、ここでは結論も数値も転記せず参照する。
// 版面の部品は既定で main を描くため、素の main を **置換** する（入れ子にしない）。
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
      <PageShell width="sm" className="flex flex-col gap-6">
        <Wordmark />
        <Heading level={1}>ログイン</Heading>
        {/* 危険を伝える変種は読み上げ役割 alert を自ら持つ。文言の側へ role を重ねると
            領域が二重になるため、文言は説明の受け口へ置くだけにする。 */}
        <Alert variant="destructive">
          <AlertDescription>
            このアカウントにはダッシュボードの利用資格がありません。
            ご利用をご希望の場合は、運営までお問い合わせください。
          </AlertDescription>
        </Alert>
      </PageShell>
    );
  }

  return (
    <PageShell width="sm" className="flex flex-col gap-6">
      <Wordmark />
      <Heading level={1}>ログイン</Heading>
      {/* 通常の案内は緊急ではないため、読み上げを中断しない既定の変種（role="status"）を使う。 */}
      <Alert>
        <AlertDescription>
          運営・代理店向けダッシュボードです。Google アカウントでログインしてください。
        </AlertDescription>
      </Alert>
      {/* 状態確定前は押せない。焦点の到達を止めてよい操作なので、通知手段はブラウザ標準の
          無効属性である（Req 3.5）。 */}
      <Button
        type="button"
        className="w-full"
        onClick={() => void signIn()}
        disabled={status === 'loading'}
      >
        Google でログイン
      </Button>
    </PageShell>
  );
}

// ワードマーク。文字列は帯（top-nav）と同一で、装飾専用色の使い所を帯とログインの 2 箇所に
// 限る判断は 7.4 節、大きい文字としてのみ用いる根拠は 2.2 節と 10 節にある。
// リンクにも見出しにもしない（リンクと押しボタンの個数を固定した構造契約・Req 3.3）。
function Wordmark() {
  return <span className="text-2xl font-bold text-brand">LINE MEO</span>;
}
