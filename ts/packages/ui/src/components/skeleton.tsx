import * as React from "react"

import { cn } from "../lib/utils"

// 取得中に、これから描かれる中身の形だけを先に示す面。
//
// 形そのものが中身の代わりであり、読み上げる内容を持たないため aria-hidden を既定で持つ。
// 「読み込み中」であることの伝達は呼び出し側が role="status" の文言で担う（形だけでは
// 支援技術に何も伝わらない）。
//
// 明滅（animate-pulse）は動き低減設定下では theme.css の抑制で止まる。止まった形だけでは
// 「読み込み中」と「中身が空」を見分けにくいので、呼び出し側は可視の文言を併置すること。
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn("animate-pulse rounded-md bg-foreground/10", className)}
      {...props}
    />
  )
}

type TableSkeletonProps = React.ComponentProps<"div"> & {
  /** 列の数。見出し行の帯の数と、各行の帯の数になる。 */
  columns: number
  /** 本体の行の数。実データの件数とは無関係な固定値でよい。 */
  rows?: number
}

/**
 * 一覧表の取得中の形。外観（面・角丸・輪郭・行の罫線）を TableContainer / TableRow に揃え、
 * 取得の前後で版面が跳ばないようにする。
 *
 * **表の要素（table）も捲れる容器も使わない。** 取得前から置くと、面ごとの「捲れる領域の件数」の
 * 宣言や表の行数の照合が、中身の無い形を数えてしまう。焦点も得ない（aria-hidden の内側に
 * 焦点可能な要素を置かない）。
 *
 * 末尾の列は行の操作の押しボタン（size="sm"）の位置と寸法に合わせる。
 */
function TableSkeleton({ columns, rows = 3, className, ...props }: TableSkeletonProps) {
  const cells = Array.from({ length: columns }, (_, index) => index)
  return (
    <div
      data-slot="table-skeleton"
      aria-hidden
      className={cn(
        "w-full overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/10",
        className
      )}
      {...props}
    >
      <div className="flex gap-6 border-b border-border px-4 py-3">
        {cells.map((index) => (
          <Skeleton key={index} className="h-3 w-12" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div
          key={row}
          className="flex items-center gap-6 border-b border-border px-4 py-4 last:border-0"
        >
          <Skeleton className="h-4 w-32" />
          {cells.slice(1, -1).map((index) => (
            <Skeleton key={index} className="h-4 w-16" />
          ))}
          <Skeleton className="ml-auto h-7 w-20" />
        </div>
      ))}
    </div>
  )
}

export { Skeleton, TableSkeleton }
