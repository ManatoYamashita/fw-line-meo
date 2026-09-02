"use client"

// 選択の共通部品（Requirements 5.1, 5.3, 5.4, 5.7 / design.md D6・tasks 6.3）。
//
// **ブラウザ標準の選択要素のラッパである。** 描画を伴う選択部品（一覧を自前で描く実装）へ
// 置き換えていない。理由は 2 つあり、どちらも単独で決定的である:
//
//  1. 既存の面のテストが、プログラムによる値の変更で選択を操作している。標準要素でなくなると
//     その操作が届かなくなる。さらに 1 箇所は必須属性の有無を要素から直接読んでいる
//  2. 標準要素のままなら、開いた一覧の描画・焦点の閉じ込め・重ね順の管理がすべて不要になる。
//     外部依存も増えない（Requirements 5.7）
//
// 枠・高さ・角丸は一行入力と揃える。**輪郭を打ち消すユーティリティは書かない**
// （フォーカス指標は theme.css の base 層に一本化されており、部品側の打ち消しは
// カスケードレイヤの順序により必ず勝ってしまう。Issue #49）。
//
// 暗色時の指定を持たないのは、暗色パレット自体が未定義であるため。
// 一行入力は取り込み元の記述をそのまま保持しているが、本部品は検証できない指定を
// 先回りで持たない（値が決まった時点で両者をまとめて設計する）。

import * as React from "react"
import { ChevronDownIcon } from "lucide-react"

import { cn } from "../lib/utils"

/**
 * 標準の選択要素。
 *
 * 包む要素を 1 枚挟むのは、開閉の記号を重ねるためだけである。`id` や必須属性を含む
 * すべての属性は選択要素そのものへ渡すので、ラベルとの関連付け（`htmlFor`）も
 * アクセシブル名の解決も標準要素のまま変わらない。
 *
 * **外から与える `className` は包む要素へ載せる**（PR #180 レビュー指摘）。開閉の記号は
 * 包む要素を基準に絶対配置されるため、選択要素の側だけを狭めると、記号は箱の右端に
 * 取り残されて選択要素から離れて描かれる。呼び出し側が「この部品」と見なして幅や余白を
 * 指定する箱は包む要素であり、寸法系の指定はそちらへ効くのが正しい。
 *
 * 選択要素自身の枠・高さ・角丸は一行入力と揃える約束なので、**面ごとに上書きする口は
 * 用意しない**（意匠のドリフト防止が本部品の存在理由である）。そのため選択要素側の
 * クラスは合成せず、この 1 箇所に固定する。
 */
function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <div data-slot="select-wrapper" className={cn("relative w-full", className)}>
      <select
        data-slot="select"
        className="h-8 w-full min-w-0 appearance-none rounded-lg border border-input bg-transparent py-1 pr-8 pl-2.5 text-base transition-colors disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm"
        {...props}
      >
        {children}
      </select>
      {/* 開閉の記号は装飾である。支援技術には選択要素自身の役割だけが伝わればよい。 */}
      <ChevronDownIcon
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  )
}

export { Select }
