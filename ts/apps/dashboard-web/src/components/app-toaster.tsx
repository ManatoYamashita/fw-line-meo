'use client';

import { Toaster } from 'sonner';
import type { CSSProperties } from 'react';

// Sonner 既定の淡色エラーは小さい文字で AA をわずかに下回るため、プロジェクトの
// コントラスト検証済み意味色へ接続する。案内・警告も未定義の色を増やさず本文色で示す。
const TOASTER_COLORS = {
  '--success-bg': 'var(--card)',
  '--success-border': 'var(--success)',
  '--success-text': 'var(--success)',
  '--info-bg': 'var(--card)',
  '--info-border': 'var(--input)',
  '--info-text': 'var(--foreground)',
  '--warning-bg': 'var(--card)',
  '--warning-border': 'var(--input)',
  '--warning-text': 'var(--foreground)',
  '--error-bg': 'var(--card)',
  '--error-border': 'var(--destructive)',
  '--error-text': 'var(--destructive)',
} as CSSProperties;

// 操作結果の通知は管理ダッシュボード全体で 1 箇所だけ描く。
// closeButton を常設し、自動で消える前にも利用者自身で閉じられるようにする。
export function AppToaster() {
  return (
    <Toaster
      className="app-toaster"
      theme="light"
      position="top-center"
      richColors
      closeButton
      expand
      visibleToasts={4}
      duration={6000}
      containerAriaLabel="操作結果の通知"
      toastOptions={{ closeButtonAriaLabel: '通知を閉じる' }}
      style={TOASTER_COLORS}
    />
  );
}
