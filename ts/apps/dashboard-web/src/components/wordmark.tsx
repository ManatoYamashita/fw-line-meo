import Image from 'next/image';
import { cn } from '@fwlm/ui/lib/utils';

// この画面の役割。表示名「Firstweb 集客AIアシスタント」は下の JSX に書く（折れる位置を指定するため文字列定数に
// しない）。3 アプリとも「Firstweb 集客AIアシスタント」＋画面の役割で揃える（2026-09-26 決定）。
// OAuth 同意画面のアプリ名は「集客AIアシスタント」のまま（名前を変えるとブランドの再検証になる）。
export const SURFACE_NAME = '管理用ダッシュボード';

// ワードマーク（帯とログインの 2 箇所で共有する）。
//
// 装飾専用色の使い所をここへ限る判断は docs/design/design-language.md の 7.4 節、大きい文字としてのみ
// 用いる根拠は 2.2 節と 10 節にある。
// リンクにも見出しにもしない（リンクと押しボタンの個数を固定した構造契約・Req 3.3）。
//
// 2 段に組む。上の段はアプリ名を補足の色の小さい文字で、下の段は面の役割を装飾専用色の大きい文字で置く。
// アプリ名は 3 アプリで共通なので、この画面で目に入れたいのは面の役割のほうである。アプリ名を大きく
// すると帯の横幅を取りすぎ、案内リンクと近づいた。装飾専用色は大きい文字にしか使えないため、
// 小さくしたアプリ名には載せない。アプリ名は「集客AI」の後でだけ折れる（語の途中で割らない）。
// アイコンは名前と同じことを言う装飾なので読み上げない。
export function Wordmark({ className }: { className?: string }) {
  return (
    <span data-slot="wordmark" className={cn('flex min-w-0 items-center gap-2', className)}>
      <Image
        src="/brand-icon.png"
        alt=""
        width={32}
        height={32}
        unoptimized
        // 画面の最上部に最初から見える要素なので遅延させない（既定の lazy では、狭い画面で
        // 描画の時点にまだ読み込まれていないことがあった）。
        loading="eager"
        className="size-8 shrink-0"
      />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="text-xs break-keep text-muted-foreground">
          Firstweb 集客AI
          <wbr />
          アシスタント
        </span>
        <span className="text-xl font-bold text-brand">{SURFACE_NAME}</span>
      </span>
    </span>
  );
}
