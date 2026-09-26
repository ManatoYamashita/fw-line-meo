import type { Metadata } from 'next';
import Image from 'next/image';
import { PageShell } from '@fwlm/ui/components/page-shell';

const description =
  'Firstweb 集客AIアシスタントは、飲食店の口コミづくりと日々の状況確認をサポート。お客様はQRコードからアンケートに答え、AIが整えた下書きを確認して、ご自身でGoogleに投稿できます。';

export const metadata: Metadata = {
  metadataBase: new URL('https://review.firstweb-works.com/'),
  description,
  alternates: { canonical: 'https://review.firstweb-works.com/' },
  openGraph: {
    type: 'website',
    locale: 'ja_JP',
    siteName: 'Firstweb 集客AIアシスタント',
    title: 'Firstweb 集客AIアシスタント QR口コミ支援',
    description,
    url: 'https://review.firstweb-works.com/',
    images: [
      { url: '/ogp.jpg', width: 1200, height: 630, type: 'image/jpeg', alt: 'Firstweb 集客AIアシスタント QR口コミ支援' },
      { url: '/ogp.webp', width: 1200, height: 630, type: 'image/webp', alt: 'Firstweb 集客AIアシスタント QR口コミ支援' },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Firstweb 集客AIアシスタント QR口コミ支援',
    description,
    images: ['/ogp.jpg'],
  },
};

const steps = [
  {
    number: '01',
    title: 'QRコードから、感想を回答',
    body: '店頭のQRコードを読み取り、星評価や良かった点・気になった点を選びます。LINEログインは不要です。',
  },
  {
    number: '02',
    title: 'AIが、口コミの下書きを作成',
    body: '回答した内容をもとに文章を整えます。下書きは自由に編集できるので、ご自身の言葉に直せます。',
  },
  {
    number: '03',
    title: '内容を確認して、ご自身で投稿',
    body: '投稿したい場合は、文章をコピーしてGoogleの投稿画面へ。投稿するかどうかは、お客様が決められます。',
  },
];

// 公開の紹介ページ。店舗別の回答・認証・データ取得はここへ持ち込まない。
export default function Home() {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-10 focus:rounded-lg focus:bg-background focus:p-4 focus:underline"
      >
        本文へスキップ
      </a>

      <header className="border-b border-border">
        <PageShell as="div" width="lg" className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4 py-6">
          <span className="flex min-w-0 items-center gap-3">
            <Image src="/icon.png" alt="" width={40} height={40} unoptimized loading="eager" className="size-10 shrink-0" />
            <span className="flex min-w-0 flex-col gap-1 leading-tight">
              <span className="text-xs text-muted-foreground">Firstweb 集客AI<wbr />アシスタント</span>
              <span className="text-xl font-bold text-brand">QR口コミ支援</span>
            </span>
          </span>
          <nav aria-label="ページ内の案内" className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <a href="#how-it-works" className="inline-flex min-h-11 items-center underline decoration-border underline-offset-4 hover:decoration-current">使い方</a>
            <a href="#for-owners" className="inline-flex min-h-11 items-center underline decoration-border underline-offset-4 hover:decoration-current">店舗オーナーの方へ</a>
          </nav>
        </PageShell>
      </header>

      <PageShell id="main" tabIndex={-1} width="lg" className="py-0">
        <section className="grid items-center gap-8 py-12 md:grid-cols-2 md:gap-12 md:py-16">
          <div className="min-w-0 space-y-6">
            <p className="text-sm font-medium text-muted-foreground">飲食店のための、口コミ・集客サポート</p>
            <h1 className="text-balance leading-relaxed">
              お客様の声を、<br />お店の次の一歩に。
            </h1>
            <p className="max-w-xl text-pretty text-text-body">
              来店の感想を、もっと伝えやすく。<br />
              Firstweb 集客AIアシスタントは、アンケートからの口コミづくりと、LINEでのお店の状況確認をサポートします。
            </p>
            <a href="#how-it-works" className="inline-flex min-h-11 items-center gap-3 font-semibold underline underline-offset-8">
              使い方を見る<span aria-hidden="true">↓</span>
            </a>
          </div>

          <div className="min-w-0 rounded-2xl bg-muted p-6 sm:p-8">
            <p className="mb-6 text-sm font-medium text-muted-foreground">お客様の感想が、お店に届くしくみ</p>
            <div className="space-y-4">
              <div className="rounded-lg bg-background p-6">
                <p className="mb-2 text-sm text-muted-foreground">お客様は、スマートフォンで</p>
                <p className="text-lg font-semibold">感想を選んで、言葉にする。</p>
                <p className="mt-3 text-sm text-text-body">アンケート → AIの下書き → ご自身で投稿</p>
              </div>
              <p aria-hidden="true" className="text-center text-xl">↓</p>
              <div className="rounded-lg bg-background p-6">
                <p className="mb-2 text-sm text-muted-foreground">お店は、いつものLINEで</p>
                <p className="text-lg font-semibold">日々の変化を、確かめる。</p>
                <p className="mt-3 text-sm text-text-body">自店の評価・口コミ件数・近隣店との比較</p>
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-border p-6 sm:p-8">
          <h2 className="text-balance">アンケートに回答したいお客様へ</h2>
          <p className="mt-3 max-w-xl text-text-body">
            ご来店先の店頭にあるQRコードを読み取ってください。お店専用のアンケートが開きます。QRコードが見つからない場合は、お店のスタッフにお声がけください。
          </p>
          <p className="mt-3 text-sm text-muted-foreground">アンケートへの回答に、会員登録やLINEログインは必要ありません。</p>
        </section>

        <section id="how-it-works" className="scroll-mt-8 py-12 md:py-16">
          <p className="mb-3 text-sm text-muted-foreground">お客様の使い方</p>
          <h2 className="text-balance">感想を伝える、3つのステップ。</h2>
          <ol role="list" className="mt-8 grid gap-8 md:grid-cols-3">
            {steps.map((step) => (
              <li key={step.number} className="min-w-0 space-y-4">
                <span aria-hidden="true" className="inline-flex size-12 items-center justify-center rounded-full bg-secondary text-sm font-semibold tabular-nums">{step.number}</span>
                <h3 className="text-balance leading-relaxed">{step.title}</h3>
                <p className="text-pretty text-text-body">{step.body}</p>
              </li>
            ))}
          </ol>
          <div className="mt-8 space-y-2 border-t border-border pt-6 text-sm text-muted-foreground">
            <p>良かった点も、気になった点も、そのままお聞かせください。評価にかかわらず、同じ手順で投稿へ進めます。</p>
            <p>Googleへの投稿にはGoogleアカウントが必要です。口コミが自動で投稿されることはありません。</p>
          </div>
        </section>

        <section id="for-owners" className="mb-12 grid scroll-mt-8 gap-8 rounded-2xl bg-muted p-6 sm:p-8 md:mb-16 md:grid-cols-2 md:gap-12">
          <div className="min-w-0">
            <p className="mb-3 text-sm text-muted-foreground">店舗オーナーの方へ</p>
            <h2 className="text-balance leading-relaxed">口コミのきっかけづくりから、<br />日々の状況確認まで。</h2>
            <p className="mt-4 text-pretty text-text-body">店頭のQRコードでお客様の声を集め、LINEに届くサマリーで自店と近隣店の状況を確認。日々の営業の中で、集客に取り組めます。</p>
          </div>
          <div className="flex min-w-0 flex-col justify-center gap-4">
            <p className="text-text-body">サービスの導入やご利用については、Firstwebへご相談ください。</p>
            <a href="https://firstweb-works.com/contact/" className="inline-flex min-h-11 items-center gap-3 self-start font-semibold underline underline-offset-8">
              導入について相談する<span aria-hidden="true">↗</span>
            </a>
            <p className="text-sm text-muted-foreground">Firstwebの公式サイトへ移動します。</p>
          </div>
        </section>
      </PageShell>

      <footer className="border-t border-border">
        <PageShell as="div" width="lg" className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4 text-sm text-muted-foreground">
          <p>運営：Firstweb</p>
          <nav aria-label="運営情報" className="flex flex-wrap gap-x-6 gap-y-2">
            <a href="https://firstweb-works.com/" className="inline-flex min-h-11 items-center underline underline-offset-4">運営サイト</a>
            <a href="https://firstweb-works.com/privacy/" className="inline-flex min-h-11 items-center underline underline-offset-4">プライバシーポリシー</a>
            <a href="https://firstweb-works.com/terms/" className="inline-flex min-h-11 items-center underline underline-offset-4">利用規約</a>
          </nav>
        </PageShell>
      </footer>
    </>
  );
}
