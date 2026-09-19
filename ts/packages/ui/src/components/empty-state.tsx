"use client"

// 空状態の共通部品（Requirements 5.1 / design.md D6・tasks 6.2）。
//
// 「担当店舗はまだありません」のような一覧が空のときの案内は、現在いずれの面でも
// 素の段落で書かれており、余白も文字色も面ごとに異なりうる。ここで 1 つに固定する。
//
// **押しボタンを内包しない。** 店舗詳細の面は「書込の手段となる要素（押しボタン・フォーム・複数行入力・
// 選択欄）を 1 つも含まない」ことを構造契約として固定しており（Issue #265 の改定後も、入力は検索欄と
// 選択肢に限られる）、本部品が押しボタンを持つと、その面で使った瞬間に契約が破れる。
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
        // 行の長さをそろえて分ける（Issue #286 項目 3）。中央寄せの 1 文が最終行だけ極端に短く割れると、
        // 文の重心が消える（320px で 40 字の案内が 252 / 252 / 55px に割れていた）。
        // 最終行の孤立語だけを避ける指定ではなく全行をそろえる指定を採るのは、ここが中央寄せの短い
        // 案内だからである（複数段落を持ちうる長文の受け口は alert.tsx が幅で使い分けている）。
        "flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-balance text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

export { EmptyState }
