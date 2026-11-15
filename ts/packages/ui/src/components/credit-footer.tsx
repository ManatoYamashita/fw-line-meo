// 全画面の末尾に出すクレジット表記（Issue #523・docs/design/design-language.md §7.22）。
//
// 管理ダッシュボード・店舗詳細・QR 口コミ支援の 3 つのアプリが、それぞれの root layout から
// この部品を 1 つだけ描画する。画面ごとに書くと、書き忘れた画面（ログイン・エラー・新設の画面）
// だけ表記が欠けるので、文言の正典はここ 1 か所に置く。
//
// **要素は footer にする。** 本文の main の外に置かれるので contentinfo の目印になる。
// 1 ページに contentinfo は 1 つに限るため、同じページの main の外に別の footer を置かないこと。
//
// **本文より弱く見せる。** 店舗詳細には Google の帰属表示（text-sm・ポリシーが許す色だけ）が
// 本文の末尾にあり、こちらはそれより小さい text-xs と補足の色で、帰属表示を目立たなくしない。
//
// 年は固定で書く。描画時に年を求めると、サーバーとブラウザの年がまたぐ瞬間に描画が食い違い、
// 著作権表示としても初出の年を書けば足りる。

import * as React from "react"

import { cn } from "../lib/utils"
import { textLinkVariants } from "./text-link"

/** 著作権者の表記。 */
const CREDIT_COPYRIGHT = "© 2026 Firstweb / 新卒グルメ" as const

/** 開発者の表記と、そのリンク先。表記は利用者が読むドメイン名、リンク先は転送後の正規の URL。 */
const CREDIT_DEVELOPER = {
  label: "yamashitamana.to",
  href: "https://www.yamashitamana.to/",
} as const

function CreditFooter({ className, ...props }: React.ComponentProps<"footer">) {
  return (
    <footer
      data-slot="credit-footer"
      className={cn("mx-auto w-full max-w-7xl px-4 py-6 text-center text-xs text-muted-foreground", className)}
      {...props}
    >
      {/* 狭い画面では区切りの位置で折り返す。著作権者と開発者の表記の途中では切らない。 */}
      <p>
        <span className="inline-block">{CREDIT_COPYRIGHT}</span>
        {" ・ "}
        <span className="inline-block">
          開発{" "}
          <a href={CREDIT_DEVELOPER.href} className={textLinkVariants()}>
            {CREDIT_DEVELOPER.label}
          </a>
        </span>
      </p>
    </footer>
  )
}

export { CREDIT_COPYRIGHT, CREDIT_DEVELOPER, CreditFooter }
