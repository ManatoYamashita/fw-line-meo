'use client';

import { Toaster } from 'sonner';
import { useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';

// 面は状態を問わず白・枠は中立の罫線・文字は本文色にそろえる（design-language 7.5）。
// 状態は右上のにじみとアイコンの意味色（globals.css）と文言で示す。文字を意味色で塗らないのは、
// にじみの上に文字が重なっても対比が変わらないようにするためである。
const TOASTER_COLORS = Object.fromEntries(
  (['success', 'info', 'warning', 'error'] as const).flatMap((type) => [
    [`--${type}-bg`, 'var(--card)'],
    [`--${type}-border`, 'var(--border)'],
    [`--${type}-text`, 'var(--foreground)'],
  ]),
) as CSSProperties;

// 成功・失敗の Toast の右上の角に置くにじみ（globals.css の [data-slot='toast-accent']）。
// **疑似要素ではなく本物の要素で描く。** axe は、文字の祖先が疑似要素に塗りを持つと対比の判定を
// 「判定不能（pseudoContent）」へ降ろし、違反 0 件のまま Toast の文字の監査が消える。本物の要素は、
// 文字の位置に重なっていなければ背景の判定に加わらない。Toast は右側ににじみの幅の余白を取るので、
// 文字とにじみは重ならない。にじみは装飾なので読み上げない。
function withAccent(icon: ReactNode): ReactNode {
  return (
    <>
      {icon}
      <span data-slot="toast-accent" aria-hidden="true" />
    </>
  );
}

// アイコンを差し替えるとライブラリ既定のアイコンは描かれないため、同じ形（Sonner の既定・MIT）を描く。
const SUCCESS_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" height="20" width="20" aria-hidden="true">
    <path
      fillRule="evenodd"
      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
      clipRule="evenodd"
    />
  </svg>
);

const ERROR_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" height="20" width="20" aria-hidden="true">
    <path
      fillRule="evenodd"
      d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z"
      clipRule="evenodd"
    />
  </svg>
);

const TOAST_ICONS = { success: withAccent(SUCCESS_ICON), error: withAccent(ERROR_ICON) };

// 帯が 1 段になる広い画面（lg 以上・docs/design/design-language.md の 7.8 節）の問い合わせ。
// 帯の段組みの境目と同じ値を使う。
export const WIDE_SCREEN_QUERY = '(min-width: 1024px)';

function subscribeWideScreen(onChange: () => void): () => void {
  const media = window.matchMedia(WIDE_SCREEN_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

/**
 * Toast の置き場。**右側に置き、狭い画面では下に出す**（design-language 7.5）。
 *
 * 狭い画面の帯は 3 段で、上に出した Toast がロール・ログアウト・案内リンクに重なり、表示中は
 * それらを押せなかった（2026-09-26 に E2E の R2 で実測）。広い画面の帯は 1 段で高さも固定なので、
 * 右上に置く。サーバー側の描画は狭い側（右下）で出し、広い画面ではマウント後に右上へ移る。
 * 600px 以下では Sonner が Toast を表示幅いっぱいに広げる（左右の位置は見た目に現れない）。
 */
export function useToasterPosition(): 'top-right' | 'bottom-right' {
  const wide = useSyncExternalStore(
    subscribeWideScreen,
    () => window.matchMedia(WIDE_SCREEN_QUERY).matches,
    () => false,
  );
  return wide ? 'top-right' : 'bottom-right';
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
      icons={TOAST_ICONS}
      toastOptions={{ closeButtonAriaLabel: '通知を閉じる' }}
      style={TOASTER_COLORS}
    />
  );
}
