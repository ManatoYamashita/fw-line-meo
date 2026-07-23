// 色トークンの単一定義箇所（Requirements 1.1, 1.3 / design.md「@fwlm/design-tokens」）。
// - brand は LINE ブランド緑 #1DB446（白文字と約 2.2:1 で WCAG AA 非準拠）。装飾・アイコン・
//   大テキスト専用とし、アクション色には使用しない。
// - primary はアクション用の暗色化緑。primaryForeground と 4.5:1 以上のコントラストを持つ値を
//   採用する（網羅的な機械検証はタスク 1.2 の colors.test.ts が担い、最終値もそこで確定する）。
// - lineColors は Flex Message（非 Web コンテンツ）用のため AA 検証対象外。値は現行
//   messages.ts の直書き色と同一に保ち、置換時に見た目が変わらないことを保証する。

/** Web 面（survey-web / store-detail / dashboard-web）の意味役割カラートークン。 */
export interface ColorTokens {
  /** ブランド基調色（装飾・アイコン・大テキスト専用・AA 非保証）。 */
  readonly brand: string;
  /** ブランドの淡緑背景（成功系の面塗り等）。 */
  readonly brandSubtle: string;
  /** アクション色（ボタン背景等。primaryForeground と 4.5:1 以上）。 */
  readonly primary: string;
  /** primary 上の前景色。 */
  readonly primaryForeground: string;
  /** 本文色（background と 4.5:1 以上）。 */
  readonly text: string;
  /** 補足・ミュート文字色（background と 4.5:1 以上）。 */
  readonly textMuted: string;
  /** 基本背景色。 */
  readonly background: string;
  /** 破壊的操作・エラー色（destructiveForeground と 4.5:1 以上）。 */
  readonly destructive: string;
  /** destructive 上の前景色。 */
  readonly destructiveForeground: string;
  /** 境界線色（非テキスト用途）。 */
  readonly border: string;
}

/** LINE Flex Message 用カラートークン（現行 5 色の意味役割化・値は現行と同一）。 */
export interface LineColorTokens {
  /** 見出し（現 #1DB446）。 */
  readonly headline: string;
  /** 本文（現 #333333）。 */
  readonly body: string;
  /** 説明文（現 #666666）。 */
  readonly description: string;
  /** キャプション・補足（現 #888888）。 */
  readonly caption: string;
  /** 成功系の背景（現 #F0FBF4）。 */
  readonly successBackground: string;
  /** アクション・リンク（現 #1DB446）。 */
  readonly action: string;
}

export const colors: ColorTokens = {
  brand: '#1DB446',
  brandSubtle: '#F0FBF4',
  // 仮確定値: #1DB446 系の暗色化緑（白文字と約 5.0:1）。タスク 1.2 の AA 機械検証で最終確定する。
  primary: '#15803D',
  primaryForeground: '#FFFFFF',
  text: '#333333',
  textMuted: '#666666',
  background: '#FFFFFF',
  destructive: '#DC2626',
  destructiveForeground: '#FFFFFF',
  border: '#DDDDDD',
};

export const lineColors: LineColorTokens = {
  headline: '#1DB446',
  body: '#333333',
  description: '#666666',
  caption: '#888888',
  successBackground: '#F0FBF4',
  action: '#1DB446',
};
