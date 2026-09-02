"use client"

// ページ見出しの共通部品（Requirements 5.1 / design.md D6・tasks 6.2）。
//
// 各面のページ見出しは現在すべて素のタグで書かれており、説明文の有無・余白・下罫線が
// 面ごとにばらつく余地がある。見出しそのものは Heading が既に階層を担っているので、
// 本部品はその周囲（説明文・右側の操作・下罫線）だけを引き受ける。
//
// **見出しの階層は 1 に固定する。** 本部品はページの主見出しを描くためのものであり、
// 階層を選べるようにすると「見出しの階層をページの都合で下げる」使い方を招く。
// 節の見出しが要る場面では Heading を直接使うこと。
//
// **押しボタンを内包しない。** actions は受け口だけを用意し、中身は呼び出し側が渡す。
// 店舗詳細の面が「書込操作の要素を 1 つも含まない」ことを構造契約として固定しているため、
// 部品側が押しボタンを持つとその面で使えなくなる。

import * as React from "react"

import { cn } from "../lib/utils"
import { Heading } from "./heading"

type PageHeaderProps = Omit<React.ComponentProps<"div">, "title"> & {
  /**
   * ページの主見出し。
   *
   * div が元から持つ title 属性（補助的な吹き出し）と名前が衝突するため、そちらは除外している。
   * 吹き出しは見出しの代わりにならないうえ、支援技術での扱いが環境ごとに異なるため、
   * 本部品では受け付けない。
   */
  title: React.ReactNode
  /** 見出しの下に置く説明文（任意）。 */
  description?: React.ReactNode
  /** 見出しの右側に置く操作（任意）。 */
  actions?: React.ReactNode
}

function PageHeader({
  title,
  description,
  actions,
  className,
  ...props
}: PageHeaderProps) {
  return (
    <div
      data-slot="page-header"
      className={cn(
        "flex flex-col gap-2 border-b border-border pb-4",
        className
      )}
      {...props}
    >
      <div className="flex items-start justify-between gap-4">
        <Heading level={1}>{title}</Heading>
        {actions === undefined ? null : (
          <div data-slot="page-header-actions" className="shrink-0">
            {actions}
          </div>
        )}
      </div>
      {description === undefined ? null : (
        <p
          data-slot="page-header-description"
          className="text-sm text-muted-foreground"
        >
          {description}
        </p>
      )}
    </div>
  )
}

export { PageHeader }
export type { PageHeaderProps }
