import type { ReactNode } from 'react';
import './globals.css';
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
      {/* トークンベースの基本描画（背景・文字色・フォント・字間）。
          DOM 構造・情報設計・認証境界（AuthProvider）は変更しない（本格整備は #45 の責務）。 */}
      <body className="bg-background text-foreground font-sans text-base leading-relaxed antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
