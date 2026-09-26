'use client';

import { useEffect } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { Button } from '@fwlm/ui/components/button';
import { PageHeader } from '@fwlm/ui/components/page-header';
import { PageShell } from '@fwlm/ui/components/page-shell';
import { Spinner } from '@fwlm/ui/components/spinner';
import { useAuth } from '../../lib/auth-context';
import { Wordmark } from '../../components/wordmark';

// Google ログイン画面（signInWithPopup）。未登録/無効時は利用資格がない旨を案内する。
// 認証済み（ready）になったら店舗一覧へ遷移する。管理データは一切描画しない（Req 1.1, 1.3, 7.3）。
//
// 版面（本文系の狭い側）と主操作を全幅にする判断は docs/design/design-language.md の 7.9 節が、
// ワードマークの色は 7.4 節と 2.2 節が正典であり、ここでは結論も数値も転記せず参照する。
// 版面の部品は既定で main を描くため、素の main を **置換** する（入れ子にしない）。
// 主見出しと案内文は見出し周りの部品（PageHeader）が描く。案内文は状態の変化を知らせる通知ではなく
// 画面の説明なので、通知の部品にも読み上げ領域にも載せない（9 節の部品表）。
export default function LoginPage() {
  const { status, isSigningIn, signIn } = useAuth();
  const router = useRouter();
  // 認証ポップアップから /me 確定、遷移開始までを 1 つの処理中状態として示す。
  const busy = status === 'loading' || status === 'ready' || isSigningIn;

  useEffect(() => {
    if (status === 'ready') {
      router.replace('/stores');
    }
  }, [status, router]);

  if (status === 'unregistered') {
    return (
      <PageShell width="sm" className="flex flex-col gap-6">
        <Wordmark />
        <PageHeader title="ログイン" />
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
      <PageHeader
        title="ログイン"
        description="運営・代理店向けダッシュボードです。Google アカウントでログインしてください。"
      />
      {/* 処理中も焦点を保ったまま重複押下を止める。ポップアップから戻った直後に焦点が文書先頭へ
          落ちると、操作が受け付けられたか判別しにくいためである。 */}
      {/* 見た目は Sign in with Google の規定（Light）に従う（docs/design/design-language.md の 7.9 節と
          2.1 節）。G ロゴは規定外の背景に置けないため、アクション色では塗らない。ロゴは装飾なので
          読み上げない（読み上げ名は文言だけ）。 */}
      <Button
        type="button"
        className={`${GOOGLE_SIGN_IN_CLASS} data-[disabled]:opacity-50`}
        onClick={() => void signIn()}
        disabled={busy}
        focusableWhenDisabled
        aria-busy={busy}
      >
        {busy ? (
          <>
            <Spinner aria-hidden />
            Google でログイン
          </>
        ) : (
          <>
            <Image src={GOOGLE_LOGO_SRC} alt="" width={20} height={20} unoptimized />
            Google でログイン
          </>
        )}
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
