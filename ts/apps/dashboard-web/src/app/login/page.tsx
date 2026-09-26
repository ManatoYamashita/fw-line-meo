'use client';

import { useEffect } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { Button } from '@fwlm/ui/components/button';
import { Heading } from '@fwlm/ui/components/heading';
import { PageShell } from '@fwlm/ui/components/page-shell';
import { useAuth } from '../../lib/auth-context';
import { Wordmark } from '../../components/wordmark';

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
      {/* 見た目は Sign in with Google の規定（Light）に従う（docs/design/design-language.md の 7.9 節と
          2.1 節）。G ロゴは規定外の背景に置けないため、アクション色では塗らない。ロゴは装飾なので
          読み上げない（読み上げ名は文言だけ）。 */}
      <Button
        type="button"
        className={GOOGLE_SIGN_IN_CLASS}
        onClick={() => void signIn()}
        disabled={status === 'loading'}
      >
        <Image src={GOOGLE_LOGO_SRC} alt="" width={20} height={20} unoptimized />
        Google でログイン
      </Button>
    </PageShell>
  );
}

// 公式素材（signin-assets.zip の Web・Light・文字なし）から、ボタンの枠の内側だけを切り出した G ロゴ。
const GOOGLE_LOGO_SRC = '/google-g-logo.png';

// 塗り・枠・文字は Google の規定値のトークンで描き、hover でも塗りを変えない（規定に hover の色が無いため）。
// 既定の変種の色（アクション色）は、このクラスが上書きして消す。outline 変種は使わない — 開閉状態や
// 暗色用の色クラスが残り、条件が揃うと G ロゴが規定外の色の上に載る。ロゴと文字の間は規定の 10px。
const GOOGLE_SIGN_IN_CLASS =
  'w-full gap-2.5 border-google-sign-in-border bg-google-sign-in-fill text-google-sign-in-foreground hover:bg-google-sign-in-fill hover:text-google-sign-in-foreground';
