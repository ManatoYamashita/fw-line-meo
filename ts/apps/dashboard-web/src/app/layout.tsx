import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { AppToaster } from '../components/app-toaster';
import { AuthProvider } from '../lib/auth-context';

// OGP の画像 URL を絶対 URL にする基準。未設定だと Next.js は localhost を基準にし、
// クローラが画像を取得できない。管理画面の入口は独自ドメインで、dashboard-api の CORS も
// この送信元だけを許可している。
const PUBLIC_ORIGIN = 'https://dashboard.firstweb-works.com';

const TITLE = 'Firstweb 集客AIアシスタント 管理用ダッシュボード';
const DESCRIPTION = '運営・代理店向け管理ダッシュボード';

// og:image は JPEG を先に置く。LINE のリンクのプレビューが WebP を表示するかを一次情報で
// 確かめられていないため、対応が確実な JPEG をクローラが先に拾うようにする。
// 寸法は同梱した画像の実寸と test/ogp-metadata.test.ts が突き合わせる。
// 画像の店舗一覧は店名を伏せてある（実在の店舗名を公開の画像に載せない）。
const OGP_ALT =
  'Firstweb 集客AIアシスタント 管理用ダッシュボードの案内画像。店舗特定と競合設定の状況を並べた店舗一覧';

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

// ルートレイアウト。ログイン状態を全画面へ配る AuthProvider（クライアント境界）で子を包む。
// サーバーコンポーネントからクライアントコンポーネントを描画する構成（AuthProvider が 'use client'）。
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      {/* トークンベースの基本描画（背景・文字色・フォント・字間）。
          DOM 構造・情報設計・認証境界（AuthProvider）は変更しない（本格整備は #45 の責務）。 */}
      <body className="bg-background text-foreground font-sans text-base leading-relaxed antialiased">
        <AuthProvider>
          {children}
          <AppToaster />
        </AuthProvider>
      </body>
    </html>
  );
}
