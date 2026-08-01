"use client"

import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../lib/utils"

// フォーカス指標は theme.css の `@layer base` にあるグローバル `:focus-visible` の outline に
// 一本化しており、部品側では一切宣言しない（Issue #49）。
//
// ベンダリング元は base class で outline を打ち消すユーティリティを指定していたが、それは
// `@layer utilities` に生成されるため、生成 CSS 冒頭の
// `@layer theme, base, components, utilities` により **詳細度に関係なく base の :focus-visible
// 既定に勝ち**、フォーカスの outline を無効化していた。代替のリング（リング色トークンの 50%）は
// 白背景で 2.08:1 と SC 1.4.11 の 3:1 に届かず、default variant ではリング用の枠線色が
// 自身の塗り（primary）と同色になって完全に不可視だった。
// `aria-invalid:*` はフォーカスではなくエラー状態の表現なので残す
// （outline = フォーカス / ring = エラー、という役割分担）。
//
// 注意: Tailwind v4 はソースをプレーンテキストとして走査するため、コメント内にクラス名を
// そのまま書くとそのユーティリティが実際に生成される。撤去したクラス名は literal で書かないこと。
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all select-none active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // hover は暗くする方向（primaryHover トークン）。以前は primary を 80% で敷いており、
        // 白背景では合成後が明るくなるため白文字とのコントラストが 5.02:1 → 3.49:1 と
        // hover 時に AA を割っていた（Issue #50）。
        default: "bg-primary text-primary-foreground hover:bg-primary-hover",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        // hover の混色空間は oklab を使う。oklch で混ぜると、無彩色である --foreground の色相が
        // powerless となり合成結果の hue が none（= 描画時は 0 = 赤）になるため、実描画が
        // 「わずかに暗い緑」ではなく赤寄りになっていた。oklab には色相成分が無くこれが起きない。
        // 合成後の実効色の実測値は test/color-mix-allowlist.json を正典とし、
        // survey-web の E2E が実ブラウザで一致を検証する。
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklab,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        // focus-visible の上書き（border-destructive/40 = 1.93:1）は base の指標より弱く、
        // この variant だけフォーカスが実質不可視になっていたため撤去した（Issue #49）。
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30",
        link: "text-primary underline-offset-4 hover:underline",
      },
      // 操作領域の拡張（Issue #52 / ui-a11y-gaps Requirements 4.1, 4.3, 4.4）。
      //
      // 本プロダクトの主動線は QR → モバイル → LIFF であり、利用者は IT に不慣れであることが
      // 前提（steering product.md）。押し損ねは離脱に直結する。視覚的な寸法は各面デザイン
      // （#43 / #44）と衝突するため変えず、**部品の外側へはみ出す不可視の面**で操作領域だけを
      // 広げる（Checkbox / RadioGroupItem が既に採っている作法）。疑似要素はレイアウトフローから
      // 外れるので、周囲の要素の位置も余白も動かない。
      //
      // inset の値は視覚寸法から素直に引き算できない。`::after` の含有ブロックは本体の
      // **padding box** であり、border（1px）の分だけ内側から始まるため、外側への実効的な
      // はみ出しは inset − 1px になる。h-8（32px）を 44px 以上にするには片側 6px 以上が要り、
      // inset は 8px（-inset-2）＝実効 7px → 46px。h-9（36px）は inset 6px（-inset-1.5）
      // ＝実効 5px → 46px。実測は survey-web の E2E が行う。
      //
      // 縮小寸法（xs / sm / icon-xs / icon-sm）には拡張を掛けない。24〜28px の部品を密集配置
      // （ボタングループ）で 44px へ広げると領域が隣の視覚領域を覆い、見えている部品を指したのに
      // 別の部品が反応する（Requirements 4.5）。これらは SC 2.5.8 の 24px を満たしている。
      size: {
        default:
          "relative h-8 gap-1.5 px-2.5 after:absolute after:-inset-2 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "relative h-9 gap-1.5 px-2.5 after:absolute after:-inset-1.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "relative size-8 after:absolute after:-inset-2",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "relative size-9 after:absolute after:-inset-1.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      // 寸法区分を描画結果から読めるようにする（card.tsx と同じ作法）。
      // タッチ操作領域の要求値は区分ごとに異なる（既定 44px / 縮小 24px）ため、実測する側が
      // 「この要素はどの区分か」を高さから推測せずに済む必要がある。推測に頼ると、区分が
      // 増えたときに検証が静かに誤った要求値を当てはめる。
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
