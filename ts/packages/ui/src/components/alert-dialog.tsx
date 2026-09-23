"use client"

// 確認ダイアログの共通部品（store-suspension tasks 5.1 / Requirements 1.6 /
// design.md「AlertDialog（`@fwlm/ui`）」）。
//
// Base UI の AlertDialog を design tokens で包む。開閉・焦点の閉じ込め・閉じたときに起点へ
// 焦点を戻すこと・背景を操作不能にすることは、すべて Base UI の既定に任せ、部品側では書き直さない。
// 自前で実装し直すと、閉じ込めの抜け（Shift+Tab・背景のスクロール）を同じだけ試験し直す必要が出る。
//
// 応答を求めるダイアログなので、背景を押しても閉じない（Base UI の AlertDialog の既定）。
// 外を押しただけで「キャンセルと答えた」ことにすると、利用者が意図しない選択をしたことになる。
// 閉じ方は、キャンセル・確定・Esc の 3 つだけである。
//
// **既定の焦点はキャンセルに置く。** Base UI は開いたときに最初の操作可能な要素へ焦点を移すため、
// フッターではキャンセルを確定より先に並べる。取り消せない操作の確認で、開いた直後の Enter の
// 一押しが確定にならないようにするためである。
//
// 開閉の動きは付けない。確認は頻度の低い操作だが、押した直後に答えを求める場面で遷移を待たせる
// 理由が無く、動きの分類表（components.test.tsx）へ新しい区分を増やすだけになるためである。
//
// フォーカス指標は theme.css の base 層に一本化しているので、部品側では宣言しない（Issue #49）。

import * as React from "react"
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog"
import type { VariantProps } from "class-variance-authority"

import { cn } from "../lib/utils"
import { buttonVariants } from "./button"

type ButtonStyleProps = VariantProps<typeof buttonVariants>

/** 開閉の状態を持つ根。`open` / `onOpenChange` で外から制御することもできる。 */
function AlertDialog(props: AlertDialogPrimitive.Root.Props) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />
}

/**
 * ダイアログを開く押しボタン。見た目は Button と同じ区分（variant / size）を受ける。
 *
 * 閉じたときに焦点が戻る先はこの要素である（Base UI の既定）。Button 部品を中に入れ子にすると
 * 押しボタンが二重になるため、同じ見た目をこの要素自身へ直接載せる。
 */
function AlertDialogTrigger({
  className,
  variant = "default",
  size = "default",
  ...props
}: AlertDialogPrimitive.Trigger.Props & ButtonStyleProps) {
  return (
    <AlertDialogPrimitive.Trigger
      data-slot="alert-dialog-trigger"
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

/**
 * 背景の減光とダイアログの面。文書の末尾へ描くので、呼び出し側の重なりや overflow に左右されない。
 *
 * 幅は狭い画面でも左右に 16px の余白を残す（`max-w-[calc(100%-2rem)]`）。内容が画面の高さを
 * 超えたときは面の内側だけを捲る。
 */
function AlertDialogContent({
  className,
  children,
  ...props
}: AlertDialogPrimitive.Popup.Props) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Backdrop
        data-slot="alert-dialog-backdrop"
        className="fixed inset-0 z-50 bg-foreground/40"
      />
      <AlertDialogPrimitive.Popup
        data-slot="alert-dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-6 overflow-y-auto rounded-2xl bg-background p-6 text-sm text-foreground shadow-raised sm:max-w-md",
          className
        )}
        {...props}
      >
        {children}
      </AlertDialogPrimitive.Popup>
    </AlertDialogPrimitive.Portal>
  )
}

/** 題名と説明をまとめる枠。 */
function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

/**
 * 操作を並べる枠。狭い画面では縦に積み、広い画面では右端へ横に並べる。
 * どちらでも DOM の順（キャンセル → 確定）を入れ替えない。見た目の順と焦点の順が
 * 食い違わず、既定の焦点がキャンセルに置かれる前提も崩れない。
 */
function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        "flex flex-col gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  )
}

/** ダイアログの題名。alertdialog のアクセシブル名になる。 */
function AlertDialogTitle({ className, ...props }: AlertDialogPrimitive.Title.Props) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn("text-base leading-snug font-semibold text-pretty", className)}
      {...props}
    />
  )
}

/** ダイアログの説明。alertdialog の説明（aria-describedby）になる。 */
function AlertDialogDescription({
  className,
  ...props
}: AlertDialogPrimitive.Description.Props) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn("text-sm text-muted-foreground text-pretty", className)}
      {...props}
    />
  )
}

/** 何もせずに閉じる押しボタン。見た目の既定は outline。 */
function AlertDialogCancel({
  className,
  variant = "outline",
  size = "default",
  ...props
}: AlertDialogPrimitive.Close.Props & ButtonStyleProps) {
  return (
    <AlertDialogPrimitive.Close
      data-slot="alert-dialog-cancel"
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

/**
 * 確定の押しボタン。`onClick` で処理を受け、押すとダイアログを閉じる。
 *
 * 処理の成否はダイアログの外（呼び出し側）で示す。閉じた後も結果を読み上げられるよう、
 * 失敗や成功の文言はダイアログの中ではなく起点の近くに置くこと。
 */
function AlertDialogAction({
  className,
  variant = "default",
  size = "default",
  ...props
}: AlertDialogPrimitive.Close.Props & ButtonStyleProps) {
  return (
    <AlertDialogPrimitive.Close
      data-slot="alert-dialog-action"
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
}
