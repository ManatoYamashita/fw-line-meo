"use client"

import * as React from "react"
import { Loader2Icon } from "lucide-react"

import { cn } from "../lib/utils"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      data-slot="spinner"
      role="status"
      // 本プロダクトの UI 言語は日本語（各画面は lang="ja"）。読み上げ名も日本語で提供する。
      // 用途に応じた文言（「下書きを生成中」等）は呼び出し側が aria-label で上書きできる。
      aria-label="読み込み中"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
