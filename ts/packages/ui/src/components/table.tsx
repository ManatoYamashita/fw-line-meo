"use client"

// 表の共通部品（Requirements 5.1, 5.2 / design.md D6・tasks 6.1）。
//
// 意匠の出典（docs/design/upstream/airbnb-DESIGN.md）は表そのものの規定を持たない。
// そのため本部品は「出典が持つ他の面の作法を表へ写像した結果」を、ここで方針として固定する。
// 個々の面が独自に判断すると、同じ一覧が面ごとに違う余白と罫線で描かれるためである。
//
// 写像した 5 点:
//  1. 容器がカード化を担う。面の分離は 1px の輪郭で表し、面を浮かせる影は使わない
//     （出典の影は 1 段しか無く、本部品はその段を消費しない。Requirements 3.3）。
//     **捲れる側の端に出る手がかりの濃淡はこれとは別である**（docs/design/design-language.md 7.18）
//  2. セル余白は 16px。見出し行だけ縦をやや詰める
//  3. 行の区切りは 1px の罫線のみ。**交互の背景色は使わない**（出典は一切用いない）
//  4. 行の重畳時に面を塗らない。行そのものは押せないため、塗ると誤った可動感を与える
//  5. 数値の列だけ右寄せ＋等幅数字にする（出典の価格表示の写像）。既定では適用しない
//  6. 折り返しの規則は列の中身の種類で選ぶ。語彙と実値はこの部品が持ち、面の側は選ぶだけである
//     （7.18 節。日本語はどの文字の間でも折り返せるので、規則を持たない列は 1 文字まで細る）
//  7. 表が見える幅に収まらないときは、容器の端に手がかりを描く。行の直下に挿すパネルは
//     容器の見えている幅に留める（7.18 節。どちらも状態を持たない CSS だけで解く）
//
// **支援技術上の役割を保つことが最優先である**（Requirements 5.2）。カードの並びへ置き換えない。
// 呼び出し側のテストが行とセルの役割、および行の隣接関係（ある行の直後に詳細行を挿す構成）に
// 依存しているため、次の点は構造契約として扱う:
//
//  - TableRow は tr を 1 段だけ描く（間に要素を挟まない）
//  - TableBody は子をそのまま tbody へ流す
//  - 横溢れの捲りは table の **外側**（TableContainer）が持つ。tbody の内側には置けない
//  - その容器はキーボードで焦点を得られる（捲りを担う領域が到達不能だと隠れた列が失われる）
//  - TableDetailRow は tr を 1 段・td を 1 つだけ描き、全列にまたがる

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
 *
 * **捲れる手がかり（`scroll-shadow-x`）も幅の問い合わせ先（`@container`）もここが持つ。**
 * 手がかりは覆いと濃淡の重ね方だけで描かれ、溢れの有無の判定を持たない（theme.css に定義がある）。
 * 幅の問い合わせ先を面の側に任せると付け忘れが起きるうえ、携帯端末の幅では版面の余白が偶然
 * 同じ幅を与えるため、付け忘れたまま緑になる。**幅が中身で決まる文脈（inline-block・grid の
 * auto 列）へ置かないこと。** 内側の寸法を封じ込めるため、容器が潰れる。
 */
function TableContainer({ className, label, ...props }: TableContainerProps) {
  return (
    <div
      data-slot="table-container"
      tabIndex={0}
      role={label === undefined ? undefined : "region"}
      aria-label={label}
      className={cn(
        "@container w-full overflow-x-auto rounded-2xl bg-card ring-1 ring-foreground/10 scroll-shadow-x",
        className
      )}
      {...props}
    />
  )
}

type TableDensity = "default" | "responsive"

/**
 * `responsive` は、容器が狭いときだけセルの横余白を詰める。列や文字を削らずに収め、
 * それでも収まらない文字拡大時には TableContainer の横捲りへ退避する。
 */
function Table({
  className,
  density = "default",
  ...props
}: React.ComponentProps<"table"> & { density?: TableDensity }) {
  return (
    <table
      data-slot="table"
      data-density={density}
      className={cn(
        "w-full text-sm text-card-foreground",
        density === "responsive" &&
          "@max-sm:[&_td]:px-2 @max-sm:[&_th]:px-2 @sm:min-w-sm",
        className
      )}
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
 *
 * **列見出しは折り返さない**（7.18 節）。列見出しは常に短いラベルであり、日本語では
 * どの文字の間でも折り返せるため、表が容器より広いと 1 文字ずつ縦に並ぶ。面ごとに指定
 * させると必ず書き忘れる列が出るので、既定で持つ。長い見出しが要る面は className で戻す。
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
        "px-4 py-3 text-left text-xs font-semibold whitespace-nowrap text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

/**
 * セルの折り返しの規則（7.18 節）。**列の中身の種類で選ぶ**。
 *
 * - `none`: 語として分けて読むと意味が崩れる短い値（ロール・状態のようなラベル、コード、日時）。
 * - `prose`: 自由記述（店名・代理店名・表示名）。語の区切りで折り返し、1 行に数語が並ぶ幅を保つ。
 * - `anywhere`: 区切りを持たない長い語（メールアドレス）。どこでも折り返してよいが、
 *   最小の幅は `prose` と同じに保つ（そうしないと 1 文字まで細る）。
 *
 * 排他の列挙にしているのは、真偽値を 2 つ持つと「折り返さない」と「どこでも折り返す」を
 * 同時に指定できてしまうためである。
 */
type TableCellWrap = "none" | "prose" | "anywhere"

/**
 * 折り返しの規則ごとのクラス。**実値はここ 1 箇所だけが持つ**（面の側は語彙を選ぶだけ）。
 *
 * `min-w-36`（9rem）は余白の数値スケールの段である。セルの寸法は枠の内側までを数えるので、
 * 左右の余白（`px-4`）を引いた内容の幅は 7rem ＝ 本文（`text-sm`）の全角 8 文字にあたる。
 * （このファイルのコメントに書く語は色ユーティリティの網羅ガードが走査する。寸法の語を
 * 不用意に書くと、色として解決できない語の集合が変わって赤くなる。）
 */
const CELL_WRAP_CLASS: Record<TableCellWrap, string> = {
  none: "whitespace-nowrap",
  prose: "min-w-36",
  anywhere: "min-w-36 wrap-anywhere",
}

/**
 * データセル。
 *
 * `numeric` と `wrap` は**明示的に選ぶ**。既定で右寄せにすると、日時や状態のような
 * 数字を含むだけの列まで巻き込まれる（実際の一覧では数値列を持つのは 1 つだけである）。
 * 折り返しの規則を既定で与えないのも同じ理由で、押しボタンだけを置くセルや、行の直下に
 * 挿すパネルのセルには当てはまらない。`white-space` は継承されるため、既定で与えると
 * パネルの中の文章まで折り返さなくなる。
 */
function TableCell({
  className,
  numeric = false,
  wrap,
  ...props
}: React.ComponentProps<"td"> & { numeric?: boolean; wrap?: TableCellWrap }) {
  return (
    <td
      data-slot="table-cell"
      data-numeric={numeric ? "true" : undefined}
      data-wrap={wrap}
      className={cn(
        "px-4 py-4 align-top",
        numeric && "text-right tabular-nums",
        wrap !== undefined && CELL_WRAP_CLASS[wrap],
        className
      )}
      {...props}
    />
  )
}

/**
 * 行の直下に挿す詳細行（QR の発行パネル・利用者の編集パネル）。
 *
 * **包みの位置と幅は、セルの左右の余白（`px-4`）と結び付いている。** 表が容器より広いとき、
 * 全列にまたがるセルは容器の見えている幅を超える。そのままパネルを置くと、捲り位置しだいで
 * 操作が画面の外へ出る（WCAG 2.4.7・1.4.10。実測では保存が画面の左外にあり、Tab で焦点を
 * 載せても見えるのは 3px だった・Issue #259）。そこで容器の左端に留まる位置と、容器の
 * 見えている幅から左右の余白を引いた幅で包む。`100cqi` の問い合わせ先は `TableContainer` で、
 * この 3 つが同じファイルにあることが、ずれを防ぐ唯一の仕掛けである。
 *
 * 区切りを持たない長い語（メールアドレスの見出し）はカードの縁を越えるので、包みの側で
 * どこでも折り返せるようにする。
 *
 * **印刷では包みを外す。** 掲示面の印刷は祖先の display と余白だけを戻す規則で成り立っており、
 * 位置と幅には触れない。外さないと、紙の上で掲示面が右へずれ、幅も狭くなる。
 */
function TableDetailRow({
  colSpan,
  id,
  className,
  children,
  ...props
}: React.ComponentProps<"td"> & { colSpan: number; id: string }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} id={id} className={className} {...props}>
        <div
          data-slot="table-detail"
          className="sticky left-4 w-[calc(100cqi-2rem)] wrap-anywhere print:static print:w-auto"
        >
          {children}
        </div>
      </TableCell>
    </TableRow>
  )
}

export type { TableCellWrap, TableContainerProps, TableDensity }
export {
  Table,
  TableContainer,
  TableDetailRow,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
}
