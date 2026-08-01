"use client"

import * as React from "react"
import { Loader2Icon } from "lucide-react"

import { cn } from "../lib/utils"

// 処理中の伝達を「動き」だけに賭けない（Issue #52 / ui-a11y-gaps Requirements 2.1）。
//
// theme.css の抑制により、動き低減設定下では回転が止まる。止めただけだと利用者は
// 「処理中」なのか「画面が固まった」のかを判別できなくなるため、動きに依存しない
// 手掛かりとして文言を可視化する。点滅など別の動きへの置換は行わない（光過敏への配慮）。
//
// 可視化する文言と読み上げ名は同一の値から作る。二重管理にすると、片方だけ差し替えた
// ときに「読み上げは『下書きを生成中』、画面表示は『読み込み中』」という食い違いが生まれる。
//
// className はラッパではなく **アイコン** へ渡す。呼び出し側は `<Spinner className="size-8" />`
// を「アイコンの大きさ」の意図で書いており、ラッパへ適用するとアイコンの寸法が変わらないまま
// 無言で意図が失われる（画面は壊れないので誰も気づけない）。ラッパ自身は寸法を持たない。
// test/components.test.tsx が「className が動きを持つ要素へ届くこと」を機械固定する。
function Spinner({
  className,
  "aria-label": ariaLabel = "読み込み中",
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="spinner"
      role="status"
      // 本プロダクトの UI 言語は日本語（各画面は lang="ja"）。読み上げ名も日本語で提供する。
      // 用途に応じた文言（「下書きを生成中」等）は呼び出し側が aria-label で上書きできる。
      aria-label={ariaLabel}
      className="inline-flex items-center gap-1.5"
      {...props}
    >
      <Loader2Icon
        data-slot="spinner-icon"
        // 図形は装飾であり、読み上げ名はラッパが担う（二重に読み上げさせない）。
        aria-hidden
        className={cn("size-4 animate-spin", className)}
      />
      {/* 通常は読み上げ専用。動き低減設定下でのみ可視化する。
       * sr-only と not-sr-only はどちらも @layer utilities に生成されるため、どちらが勝つかは
       * 生成順で決まる。クラスが付いていることと見えていることは別問題なので、実際に描画
       * されるかどうかは survey-web の E2E が実測で確かめる。 */}
      <span data-slot="spinner-label" className="sr-only motion-reduce:not-sr-only">
        {ariaLabel}
      </span>
    </span>
  )
}

export { Spinner }
