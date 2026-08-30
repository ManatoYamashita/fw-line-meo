"use client"

// ページ見出しの共通部品（Requirements 2.1「基本部品…見出し…を共通コンポーネントとして提供する」）。
//
// 既存の CardTitle / AlertTitle は <div>、FieldLegend は <legend> であり、いずれもカード・通知・
// フォームの「内部部品」でページ見出しには使えない。本部品は見出しレベル（<h1>〜<h6>）という
// 意味論そのものを扱う唯一の部品として、支援技術に通知される見出しレベルと視覚的なサイズ階層を
// 単一の宣言（level）から導く。
//
// 設計上の 2 点:
//  - level は必須。既定値を持たせると「何も考えずに置いた見出し」が同一レベルで量産され、
//    本部品が解決しようとしている見出し階層の崩壊をむしろ助長するため。
//  - size は level と独立に上書きできる。文書構造（level）を正しく保ったまま視覚的な強弱だけを
//    調整したい場面（例: 第3階層だがページの主役）に、level を歪めさせないための逃げ道。

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../lib/utils"

const headingVariants = cva("text-balance", {
  variants: {
    // サイズは typography トークン（theme.css の --text-*）由来のユーティリティのみを使う。
    // 色は指定しない（周囲の文脈から継承させる。Alert 内の見出し等で文脈色を壊さないため）。
    size: {
      // 太さが最も強いのは 2xl（= 既定のレベル 1）だけにしてある。意匠の出典は display の
      // ウェイトを控えめに保ち、階層はサイズと余白で表す。theme.css の @layer base と
      // 一致していることは test/app-integration.test.ts が実コンパイル結果で機械検証する。
      "2xl": "text-2xl leading-tight font-bold",
      xl: "text-xl leading-tight font-semibold",
      lg: "text-lg leading-snug font-semibold",
      base: "text-base leading-snug font-semibold",
      sm: "text-sm leading-normal font-semibold",
      xs: "text-xs leading-normal font-semibold",
    },
  },
})

/** 見出しの階層（1 = ページ見出し 〜 6）。描画される要素と支援技術の見出しレベルに一致する。 */
type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

/**
 * 各レベルの既定サイズ。theme.css の `@layer base` が生 <h1>〜<h6> に与える階層と対応する。
 *
 * この対応は長らくコメントで主張されていただけで、検証するものが何も無かった（結果として
 * 実際に食い違っていた）。test/app-integration.test.ts が実コンパイル結果を使って
 * レベルごとの寸法・太さ・行間の一致を要求するため、本表は export する。
 */
const DEFAULT_SIZE_BY_LEVEL = {
  1: "2xl",
  2: "xl",
  3: "lg",
  4: "base",
  5: "sm",
  6: "xs",
} as const satisfies Record<
  HeadingLevel,
  NonNullable<VariantProps<typeof headingVariants>["size"]>
>

type HeadingProps = React.ComponentProps<"h2"> &
  VariantProps<typeof headingVariants> & {
    /** 見出しの階層。<h1>〜<h6> のどれを描画するかを決める（必須・既定値なし）。 */
    level: HeadingLevel
  }

function Heading({ level, size, className, ...props }: HeadingProps) {
  const Tag = `h${level}` as const

  return (
    <Tag
      data-slot="heading"
      data-level={level}
      className={cn(
        headingVariants({ size: size ?? DEFAULT_SIZE_BY_LEVEL[level] }),
        className
      )}
      {...props}
    />
  )
}

export { Heading, headingVariants, DEFAULT_SIZE_BY_LEVEL }
export type { HeadingLevel, HeadingProps }
