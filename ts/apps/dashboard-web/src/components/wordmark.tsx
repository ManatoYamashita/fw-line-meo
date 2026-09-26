import Image from 'next/image';
import { cn } from '@fwlm/ui/lib/utils';

// この画面の役割。表示名「Firstweb 集客AIアシスタント」は下の JSX に書く（折れる位置を指定するため文字列定数に
// しない）。3 アプリとも「Firstweb 集客AIアシスタント」＋画面の役割で揃える（2026-09-26 決定）。
// OAuth 同意画面のアプリ名は「集客AIアシスタント」のまま（名前を変えるとブランドの再検証になる）。
export const SURFACE_NAME = '管理用ダッシュボード';

// ワードマーク（帯とログインの 2 箇所で共有する）。
//
// 装飾専用色の使い所をここへ限る判断は docs/design/design-language.md の 7.4 節、大きい文字としてのみ
// 用いる根拠は 2.2 節と 10 節にある。ブランド色を載せるのはアプリ名だけで、面の役割は補足の色で添える。
// リンクにも見出しにもしない（リンクと押しボタンの個数を固定した構造契約・Req 3.3）。
//
// 狭い画面では面の役割が次の行へ回る。アプリ名は「Firstweb」の後と「集客AI」の後でだけ折れる
// （語の途中で割らない）。アイコンは名前と同じことを言う装飾なので読み上げない。
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
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 leading-tight">
        <span className="text-xl font-bold break-keep text-brand lg:text-2xl">
          Firstweb 集客AI
          <wbr />
          アシスタント
        </span>{' '}
        <span className="text-sm text-muted-foreground">{SURFACE_NAME}</span>
      </span>
    </span>
  );
}
