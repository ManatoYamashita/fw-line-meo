// 色トークンの単一定義箇所（Requirements 1.1, 1.3 / design.md「@fwlm/design-tokens」）。
//
// 意匠の出典は docs/design/upstream/airbnb-DESIGN.md（VoltAgent/awesome-design-md・MIT）。
// 採否の判断と実測コントラスト比は .kiro/specs/ui-airbnb-foundation/design.md D1 が正典で、
// 網羅的な機械検証は test/colors.test.ts が担う。
//
// 出典の色をそのまま持ち込んでいない点が本ファイルの要である:
//  - brand は出典のブランド色そのもの。白文字と 3.52:1 で WCAG AA（4.5:1）に届かないため
//    **装飾・アイコン・大テキスト専用**とし、アクション色にも文字色にも使わない。
//  - primary は出典の「押下時の色」。白文字と 4.89:1 で AA を満たす下限であり、
//    これより明るい色をアクション面に置くことはできない。
//  - success は出典に対応色が無い唯一の役割。以前アクション色だった緑を横滑りさせている。
//    アクション色と共有してはならない理由は下の宣言に書いた。
//  - lineColors は Flex Message（非 Web コンテンツ）用のため AA 検証対象外。値は現行
//    messages.ts / flex.ts と同一に保ち、Web 側の意匠差し替えで LINE の見た目が動かないことを
//    保証する（LINE アプリ自身の配色の中で成立させるための決定）。

/** Web 面（survey-web / store-detail / dashboard-web）の意味役割カラートークン。 */
export interface ColorTokens {
  /** ブランド基調色（装飾・アイコン・大テキスト専用・AA 非保証）。 */
  readonly brand: string;
  /** アクション色（ボタン背景等。primaryForeground と 4.5:1 以上）。 */
  readonly primary: string;
  /** primary の hover 時の面色（primary より暗く、primaryForeground と 4.5:1 以上）。 */
  readonly primaryHover: string;
  /** primary 上の前景色。 */
  readonly primaryForeground: string;
  /** 本文色（background と 4.5:1 以上）。 */
  readonly text: string;
  /** 長文の本文色（見出しより弱く、background と 4.5:1 以上）。 */
  readonly textBody: string;
  /** 補足・ミュート文字色（background と 4.5:1 以上）。 */
  readonly textMuted: string;
  /** 基本背景色。 */
  readonly background: string;
  /** 最も淡い面（無効な入力・副次的な帯・ミュート面）。 */
  readonly surfaceSoft: string;
  /** やや濃い面（副次ボタン・円形アイコンボタンの面）。 */
  readonly surfaceStrong: string;
  /**
   * 成功を表す色（background と 4.5:1 以上）。
   *
   * **アクション色と共有してはならない。** 共有していると、アクション色を暖色系へ変えた瞬間に
   * 成功通知が危険通知と同系色になる。この事故は色相の変化であって輝度の変化ではないため、
   * コントラスト比を見るどのガードにも掛からず CI 全緑で通る（test/colors.test.ts の
   * 「成功と危険の識別」がこの経路を塞ぐ）。
   */
  readonly success: string;
  /** 破壊的操作・エラー色（destructiveForeground と 4.5:1 以上）。 */
  readonly destructive: string;
  /** destructive 上の前景色。 */
  readonly destructiveForeground: string;
  /** 区切り線・カード罫線・情報コンテナ外枠の色（純装飾・SC 1.4.11 対象外）。 */
  readonly border: string;
  /**
   * フォーム入力部品と対話的部品の輪郭の色（識別用・SC 1.4.11 の 3:1 対象）。
   * 隣接背景に対する 3:1 の検証は使用箇所側のガードが担う（トークン単体は「何に隣接するか」を
   * 知らないため。design.md D7）。border（装飾用）と同値になってはならない
   * （test/colors.test.ts の不変条件が固定する）。
   */
  readonly borderInteractive: string;
}

/** LINE Flex Message 用カラートークン（現行 7 色の意味役割化・値は現行と同一）。 */
export interface LineColorTokens {
  /** 見出し。 */
  readonly headline: string;
  /** 本文。 */
  readonly body: string;
  /** 説明文。 */
  readonly description: string;
  /** キャプション・補足。 */
  readonly caption: string;
  /** 成功系の背景。 */
  readonly successBackground: string;
  /** アクション・リンク。 */
  readonly action: string;
  /** 補助的な数値・ラベル（日次サマリーの前日比・競合星差など）。 */
  readonly muted: string;
}

export const colors: ColorTokens = {
  // 出典のブランド色。白文字と約 3.52:1 で AA 非準拠のため装飾専用。
  brand: '#FF385C',
  // 出典の押下時の色。白文字と約 4.89:1。AA の下限に最も近い役割であり、
  // これ以上明るい値をアクション面に採ることはできない。
  primary: '#E00B41',
  // hover は primary を「暗くする」方向で表現する。アルファ合成（bg-primary/80 等）は
  // 白背景では合成後が明るくなり、ホバー時にだけ AA を割る（Issue #50）。
  // 各成分を 0.8 倍した確定値（白文字と約 6.99:1）。
  primaryHover: '#B30934',
  primaryForeground: '#FFFFFF',
  // 出典の ink。純黒を使わないのは出典の方針をそのまま採ったもの（対白 約 15.9:1）。
  text: '#222222',
  // 出典の body。長文でインクが重すぎる場面用（対白 約 10.5:1）。
  textBody: '#3F3F3F',
  // 出典の muted（対白 約 5.41:1・surfaceSoft 上でも約 5.05:1）。
  textMuted: '#6A6A6A',
  background: '#FFFFFF',
  surfaceSoft: '#F7F7F7',
  surfaceStrong: '#F2F2F2',
  // 出典に対応色が無い唯一の役割。意匠差し替え前にアクション色だった緑をそのまま横滑りさせる
  // （対白 約 5.02:1）。アクション色と共有しない理由は ColorTokens の宣言に書いた。
  success: '#15803D',
  // 淡い面（bg-destructive/10・/20）の上に同色の文字を載せる shadcn の destructive 表現では、
  // 判定すべきは単体の対白比ではなく合成後の実効色に対する比である。出典のエラー色は
  // /20 の面上で約 4.08:1 と AA を割るため、出典のエラー族の暗い方を採る
  // （白背景の文字 約 6.60:1 ／ /10 面上 約 5.58:1 ／ /20 面上 約 4.68:1）。
  destructive: '#B32505',
  destructiveForeground: '#FFFFFF',
  // 出典の hairline。意匠差し替え前と同値であり、罫線の見え方は変わらない。
  border: '#DDDDDD',
  // 対白 約 4.54:1。SC 1.4.11 の要求は 3:1 だが、1px の細線は subpixel アンチエイリアスで
  // 実効コントラストが落ちるため、3:1 ちょうどの灰では余裕が無い。出典の border-strong は
  // 対白 1.80:1 で 3:1 に届かないため採らない。
  borderInteractive: '#767676',
};

export const lineColors: LineColorTokens = {
  headline: '#1DB446',
  body: '#333333',
  description: '#666666',
  caption: '#888888',
  successBackground: '#F0FBF4',
  action: '#1DB446',
  muted: '#AAAAAA',
};
