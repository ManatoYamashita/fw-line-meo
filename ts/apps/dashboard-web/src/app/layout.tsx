import type { ReactNode } from 'react';

export const metadata = {
  title: 'ダッシュボード',
  description: '運営・代理店向け管理ダッシュボード',
};

// 最小のルートレイアウト。ログイン状態を配る AuthProvider は Task 4.2 で追加する。
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
