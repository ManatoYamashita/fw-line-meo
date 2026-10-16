"use client"

import * as React from "react"
import { CircleCheckIcon } from "lucide-react"

import { cn } from "../lib/utils"

// 成功の表示に添える印。成功色はアクション色と色相がほぼ同じで、色だけでは押しボタンやリンクと
// 見分けられない（design-tokens の ColorTokens.success）。成功であることは、この印と文言で示す。
//
// 印は文言と同じことを言う装飾なので読み上げない。色は指定せず、親の文字色を受け継ぐ。
function SuccessIcon({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <CircleCheckIcon
      data-slot="success-icon"
      aria-hidden
      className={cn("shrink-0", className)}
      {...props}
    />
  )
}

export { SuccessIcon }
