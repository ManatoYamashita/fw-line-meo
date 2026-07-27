import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: '店舗詳細',
  description: '競合ポジション詳細閲覧',
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
