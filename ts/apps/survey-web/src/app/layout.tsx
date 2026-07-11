import type { ReactNode } from 'react';

export const metadata = {
  title: 'アンケート',
  description: '来店アンケート',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
