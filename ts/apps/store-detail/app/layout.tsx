import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

// OGP の画像 URL を絶対 URL にする基準。未設定だと Next.js は localhost を基準にし、
// クローラが画像を取得できない。Cloud Run の URL はプロジェクトごとに決まった値で、
// 独自ドメインへ移った後もこの URL は同じサービスを返し続ける。
const PUBLIC_ORIGIN = 'https://store-detail-vdqjgfvkma-an.a.run.app';

const TITLE = 'Firstweb 集客AIアシスタント 店舗詳細';
const DESCRIPTION = '競合ポジション詳細閲覧';

// og:image は JPEG を先に置く。LINE のリンクのプレビューが WebP を表示するかを一次情報で
// 確かめられていないため、対応が確実な JPEG をクローラが先に拾うようにする。
// 寸法は同梱した画像の実寸と test/ogp-metadata.test.ts が突き合わせる。
const OGP_ALT = 'Firstweb 集客AIアシスタント 店舗詳細の案内画像。LINE に届く近隣店舗との比較レポートと推移のグラフ';

export const metadata: Metadata = {
  metadataBase: new URL(PUBLIC_ORIGIN),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    type: 'website',
    locale: 'ja_JP',
    siteName: 'Firstweb 集客AIアシスタント',
    title: TITLE,
    description: DESCRIPTION,
    images: [
      { url: '/ogp.jpg', width: 1200, height: 630, type: 'image/jpeg', alt: OGP_ALT },
      { url: '/ogp.webp', width: 1200, height: 630, type: 'image/webp', alt: OGP_ALT },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: ['/ogp.jpg'],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      {/* トークンベースの基本描画（背景・文字色・フォント・字間）。
          DOM 構造・情報設計・LIFF ロジックは変更しない（本格整備は #43 の責務）。 */}
      <body className="bg-background text-foreground font-sans text-base leading-relaxed antialiased">
        {children}
      </body>
    </html>
  );
}
