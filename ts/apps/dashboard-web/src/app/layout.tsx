import type { ReactNode } from 'react';
import { AuthProvider } from '../lib/auth-context';

export const metadata = {
  title: 'ダッシュボード',
  description: '運営・代理店向け管理ダッシュボード',
};

// ルートレイアウト。ログイン状態を全画面へ配る AuthProvider（クライアント境界）で子を包む。
// サーバーコンポーネントからクライアントコンポーネントを描画する構成（AuthProvider が 'use client'）。
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
