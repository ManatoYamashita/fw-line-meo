"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../lib/utils"

const alertVariants = cva(
  "group/alert relative grid w-full gap-0.5 rounded-lg border px-2.5 py-2 text-left text-sm has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        // 成功通知。文字色は成功専用のトークン（--color-success・白背景で約 5.02:1）を
        // text-success 経由で参照する。**アクション色は参照しない。** 参照していると、
        // アクション色を暖色系へ差し替えた瞬間に成功通知が危険通知と同系色になる
        // （色相の変化は輝度を変えないためコントラスト比を見るガードには掛からない）。
        // ブランド色をそのまま文字色にすると白背景で約 3.52:1 となり WCAG AA を割るため使わない。
        //
        // 説明文への指定が必要な理由: AlertDescription は自身に text-muted-foreground を持つ。
        // したがって親に状態色を置くだけでは説明文へ届かず、子孫指定で明示的に渡さない限り
        // 説明文は変種によらず灰色で描画される。
        //
        // ただし不透明度は掛けない。かつてはタイトルより弱く見せるため説明文に 90% を掛けていたが、
        // 白背景での実効値が AA（4.5:1）を割っていた（Issue #50）。「ブランド色は AA を割るから
        // 使わない」と判断しておきながら、アルファ合成で同じ失敗を再導入していたことになる。
        // 強弱はタイトル側の font-medium と文字サイズで表現し、説明文はトークン素の色
        // （success 5.02:1 / destructive 6.60:1）をそのまま使う。
        success:
          "bg-card text-success *:data-[slot=alert-description]:text-success *:[svg]:text-current",
        destructive:
          "bg-card text-destructive *:data-[slot=alert-description]:text-destructive *:[svg]:text-current",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

// 変種に応じた既定の読み上げ強度（Issue #52 / ui-a11y-gaps Requirements 3.1, 3.2, 3.4）。
//
// role="alert" は assertive なライブリージョンであり、進行中の読み上げを **中断させる**。
// 全変種を alert で提示すると、単なる案内文でもスクリーンリーダー利用者の作業が毎回遮られる。
// エラーだけは確実に気づける必要があるため、destructive のみ alert とし、他は status
// （polite = 区切りのよい時点で読み上げる）にする。
//
// role="status" / role="alert" はそれぞれ暗黙に aria-live を持つため、明示は不要。
// **どの変種にも必ずライブリージョンの役割を与える**こと（Requirements 3.4）。役割の無い
// 変種を作ると、その通知は支援技術へ一切伝わらなくなる。
// 視覚表現（alertVariants）には一切手を触れない（Requirements 3.3）。
const alertRoleByVariant = {
  default: "status",
  success: "status",
  destructive: "alert",
} as const satisfies Record<
  NonNullable<VariantProps<typeof alertVariants>["variant"]>,
  string
>

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      // {...props} より前に置くことで、呼び出し側が role を明示した場合はそちらを優先する
      // （spinner.tsx の aria-label と同じ作法。API の追加は不要）。
      role={alertRoleByVariant[variant ?? "default"]}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-sm text-balance text-muted-foreground md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
        className
      )}
      {...props}
    />
  )
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn("absolute top-2 right-2", className)}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, AlertAction }
