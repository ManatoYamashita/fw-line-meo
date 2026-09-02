"use client"

// 空状態の共通部品（Requirements 5.1 / design.md D6・tasks 6.2）。
//
// 「担当店舗はまだありません」のような一覧が空のときの案内は、現在いずれの面でも
// 素の段落で書かれており、余白も文字色も面ごとに異なりうる。ここで 1 つに固定する。
//
// **押しボタンを内包しない。** 店舗詳細の面は「書込操作の要素を 1 つも含まない」ことを
// 構造契約として固定しており、本部品が押しボタンを持つと、その面で使った瞬間に契約が破れる。
// 導線が要る場合は呼び出し側が children として渡す（渡すか否かの判断を面の側に残す）。
//
// 読み上げの強度（role）は呼び出し側が決める。一覧が空であることは通常は通知に当たらないが、
// 検索の結果が 0 件だった等、操作の結果として現れる場合は通知として扱う必要がある。
// 既定を持たせるとその判断が消えるため、素の属性として通す。

import * as React from "react"

import { cn } from "../lib/utils"

function EmptyState({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

export { EmptyState }
