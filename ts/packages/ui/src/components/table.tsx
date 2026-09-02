"use client"

// 表の共通部品（Requirements 5.1, 5.2 / design.md D6・tasks 6.1）。
//
// 意匠の出典（docs/design/upstream/airbnb-DESIGN.md）は表そのものの規定を持たない。
// そのため本部品は「出典が持つ他の面の作法を表へ写像した結果」を、ここで方針として固定する。
// 個々の面が独自に判断すると、同じ一覧が面ごとに違う余白と罫線で描かれるためである。
//
// 写像した 5 点:
//  1. 容器がカード化を担う。面の分離は 1px の輪郭で表し、影は使わない
//     （出典の影は 1 段しか無く、本部品はその段を消費しない。Requirements 3.3）
//  2. セル余白は 16px。見出し行だけ縦をやや詰める
//  3. 行の区切りは 1px の罫線のみ。**交互の背景色は使わない**（出典は一切用いない）
//  4. 行の重畳時に面を塗らない。行そのものは押せないため、塗ると誤った可動感を与える
//  5. 数値の列だけ右寄せ＋等幅数字にする（出典の価格表示の写像）。既定では適用しない
//
// **支援技術上の役割を保つことが最優先である**（Requirements 5.2）。カードの並びへ置き換えない。
// 呼び出し側のテストが行とセルの役割、および行の隣接関係（ある行の直後に詳細行を挿す構成）に
// 依存しているため、次の 3 点は構造契約として扱う:
//
//  - TableRow は tr を 1 段だけ描く（間に要素を挟まない）
//  - TableBody は子をそのまま tbody へ流す
//  - 横溢れの捲りは table の **外側**（TableContainer）が持つ。tbody の内側には置けない
//  - その容器はキーボードで焦点を得られる（捲りを担う領域が到達不能だと隠れた列が失われる）

import * as React from "react"

import { cn } from "../lib/utils"

type TableContainerProps = React.ComponentProps<"div"> & {
  /**
   * スクロール領域としてのアクセシブル名（任意）。
   *
   * 名前を持たない `region` を支援技術へランドマークとして公開しない実装があるため、
   * 名前が与えられたときだけ役割を宣言する。**焦点可能であること自体は名前に依存しない**
   * （到達性は名前の有無で変わってはならない）。
   */
  label?: string
}

/**
 * 表を包む容器。カード化（面・角丸・輪郭）と横溢れの捲りを担う。
 *
 * 捲りを table の外側に置くのは、tbody の内側に要素を挟めないためだけではなく、
 * 挟むと行の隣接関係が壊れて呼び出し側の詳細行の挿入が成立しなくなるためでもある。
 *
 * **捲りを担う以上、容器そのものがキーボードで焦点を得られなければならない**（WCAG 2.1.1）。
 * スクロール領域を自動で焦点可能にしないブラウザでは、溢れて隠れた列へ到達する手段が
 * 他に無い。セルの中に焦点可能な要素があるとは限らず（数値や日時だけの列が普通にある）、
 * 「行のどれかを辿れば横にも動く」は成り立たない。
 *
 * 溢れていない表でも巡回の停止が 1 つ増えるが、溢れの有無は描画してからでないと決まらず、
 * 判定を持ち込むと部品が状態と副作用を持つことになる。常に焦点可能とし、費用は一定に保つ。
 */
function TableContainer({ className, label, ...props }: TableContainerProps) {
  return (
    <div
      data-slot="table-container"
      tabIndex={0}
      role={label === undefined ? undefined : "region"}
      aria-label={label}
      className={cn(
        "w-full overflow-x-auto rounded-2xl bg-card ring-1 ring-foreground/10",
        className
      )}
      {...props}
    />
  )
}

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <table
      data-slot="table"
      className={cn("w-full text-sm text-card-foreground", className)}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-head" className={cn(className)} {...props} />
}

/**
 * 本体。最終行の罫線だけを落とす。
 *
 * 落とすのを TableRow 側の「最後の子」条件にしないのは、見出し行が thead の唯一の行であり、
 * その条件では**見出しの下の罫線まで消える**ため。消える側の見た目は自然なので、
 * 目視でも気づきにくい。
 */
function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&>tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn("border-b border-border", className)}
      {...props}
    />
  )
}

/**
 * 見出しセル。`scope` を既定で与える。
 *
 * 既定値を持たせるのは、既存の一覧のうち片方だけが scope を持っており、部品化で
 * **持っている側へ揃える**ためである（支援技術に対する後退を作らない）。
 */
function TableHeaderCell({
  className,
  scope = "col",
  ...props
}: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-header-cell"
      scope={scope}
      className={cn(
        "px-4 py-3 text-left text-xs font-semibold text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

/**
 * データセル。
 *
 * `numeric` は**明示的に選ぶ**。既定で右寄せにすると、日時や状態のような
 * 数字を含むだけの列まで巻き込まれる（実際の一覧では数値列を持つのは 1 つだけである）。
 */
function TableCell({
  className,
  numeric = false,
  ...props
}: React.ComponentProps<"td"> & { numeric?: boolean }) {
  return (
    <td
      data-slot="table-cell"
      data-numeric={numeric ? "true" : undefined}
      className={cn(
        "px-4 py-4 align-top",
        numeric && "text-right tabular-nums",
        className
      )}
      {...props}
    />
  )
}

export type { TableContainerProps }
export {
  Table,
  TableContainer,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
}
