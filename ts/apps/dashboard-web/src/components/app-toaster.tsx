'use client';

import { Toaster } from 'sonner';
import { useSyncExternalStore, type CSSProperties } from 'react';

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

// 帯が 1 段になる広い画面（lg 以上・docs/design/design-language.md の 7.8 節）の問い合わせ。
// 帯の段組みの境目と同じ値を使う。
export const WIDE_SCREEN_QUERY = '(min-width: 1024px)';

function subscribeWideScreen(onChange: () => void): () => void {
  const media = window.matchMedia(WIDE_SCREEN_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

/**
 * Toast の置き場。**狭い画面では下に出す。**
 *
 * 狭い画面の帯は 3 段で、上部中央に出した Toast がロール・ログアウト・案内リンクに重なり、表示中は
 * それらを押せなかった（2026-09-26 に E2E の R2 で実測）。広い画面の帯は 1 段で高さも固定なので、
 * 上部中央のままでよい。サーバー側の描画は狭い側（下）で出し、広い画面ではマウント後に上へ移る。
 */
export function useToasterPosition(): 'top-center' | 'bottom-center' {
  const wide = useSyncExternalStore(
    subscribeWideScreen,
    () => window.matchMedia(WIDE_SCREEN_QUERY).matches,
    () => false,
  );
  return wide ? 'top-center' : 'bottom-center';
}

// 操作結果の通知は管理ダッシュボード全体で 1 箇所だけ描く。
// closeButton を常設し、自動で消える前にも利用者自身で閉じられるようにする。
export function AppToaster() {
  const position = useToasterPosition();
  return (
    <Toaster
      className="app-toaster"
      theme="light"
      position={position}
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
