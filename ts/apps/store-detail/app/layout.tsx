import type { ReactNode } from 'react';

export const metadata = {
  title: '店舗詳細',
  description: '競合ポジション詳細閲覧',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
