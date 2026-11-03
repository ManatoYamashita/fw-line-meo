// 本文中の文字のリンクの見た目（Issue #503・docs/design/design-language.md §7.21）。
//
// Tailwind の Preflight はリンクの下線を消し、色も周りの文から継がせる。何も指定しない文字のリンクは
// 周りの文と同じ見た目になり、押せることが分からない（Issue #503 で 5 か所がこの状態だった）。
// リンクごとにクラスを書くと、書き忘れたリンクだけが素の文に戻るので、見た目はここ 1 か所で決める。
//
// **手がかりは下線だけで付け、色は持たせない。** 色を持たせた文字はワードマークの面の役割に限る
// （§7.4）。下線は状態を色だけに委ねない手がかりでもある。色は周りの文から継ぐので、補足の色の
// 案内（EmptyState など）の中では補足の色の下線になる。
//
// 要素は持たない。Next.js の Link・素の <a> のどちらにも className として渡す（buttonVariants と同じ形）。
// 押しボタンの見た目のリンクには付けない。押しボタンの形そのものが手がかりになる。

import { cva } from "class-variance-authority"

const textLinkVariants = cva("underline underline-offset-4")

export { textLinkVariants }
