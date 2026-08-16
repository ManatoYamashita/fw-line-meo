"use client"

import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "../lib/utils"

// フォーカス指標は theme.css の `@layer base` の `:focus-visible` outline に一本化しており、
// 部品側では宣言しない（Issue #49）。outline を打ち消すユーティリティは `@layer utilities` に
// 生成されるためレイヤ順で base の既定に勝ってしまい、この入力欄のフォーカスを不可視にしていた。
//
// 注意: Tailwind v4 はソースをプレーンテキストとして走査するため、コメント内にクラス名を
// そのまま書くとそのユーティリティが実際に生成される。撤去したクラス名は literal で書かないこと。
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
