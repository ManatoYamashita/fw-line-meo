"use client"

// ページ外枠の共通部品（Requirements 5.1 / design.md D6・tasks 6.2）。
//
// 各面のページはこれまで外枠の指定を持たず、ブラウザ既定の描画のまま端まで広がっていた。
// 面ごとに幅と余白を書くと必ず食い違うため、ここで 2 段だけに固定する。
//
// **幅を 2 段に限る理由**: 出典の版面は本文系が約 576px、一覧系が約 1280px の 2 つしか無い。
// 段を増やすと「どれを選ぶか」の判断が面ごとに発生し、部品化の目的（意匠のドリフト防止）が
// そのまま失われる。
//
// **描画する要素の既定を main にしている理由**: 各面のページのルートはいずれも主要領域であり、
// 本部品はその位置を置き換える。ただし主要領域は 1 ページに 1 つでなければならないので、
// 既に main を持つ構造の内側で使う場合は as で div / section へ切り替えること。
// （検証面の E2E は main を 1 つに解決する前提で書かれており、2 つになると複数の検証が同時に壊れる）

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../lib/utils"

const pageShellVariants = cva("mx-auto w-full px-4 py-8", {
  variants: {
    width: {
      /** 本文系（回答画面・店舗詳細）。 */
      sm: "max-w-xl",
      /** 一覧系（ダッシュボード）。 */
      lg: "max-w-7xl",
    },
  },
  defaultVariants: {
    width: "sm",
  },
})

/** 描画できる要素。主要領域の重複を避けるための逃げ道として div / section を許す。 */
type PageShellElement = "main" | "div" | "section"

type PageShellProps = React.ComponentProps<"div"> &
  VariantProps<typeof pageShellVariants> & {
    /** 描画する要素（既定は main）。 */
    as?: PageShellElement
  }

function PageShell({ as = "main", width, className, ...props }: PageShellProps) {
  // 描画先を変数にすると、要素ごとに異なる ref の型が合流できず型検査が通らない
  // （div の ref を main へ渡す形になる）。受け口の型は 3 つに共通する div の形で表し、
  // 描画先はここで一段緩めて解決する。許す要素は PageShellElement の 3 つに限られており、
  // いずれも div と同じ属性しか受け取らないため、緩める範囲は描画先の名前だけに閉じている。
  const Tag = as as React.ElementType

  return (
    <Tag
      data-slot="page-shell"
      data-width={width ?? "sm"}
      className={cn(pageShellVariants({ width }), className)}
      {...props}
    />
  )
}

export { PageShell, pageShellVariants }
export type { PageShellElement, PageShellProps }
