// 色トークンの単一定義箇所（Requirements 1.1, 1.3 / design.md「@fwlm/design-tokens」）。
//
// 意匠の出典は docs/design/upstream/airbnb-DESIGN.md（VoltAgent/awesome-design-md・MIT）。以下で「出典」と
// 書くのはこの文書を指す。ただしブランド色・アクション色・hover の 3 役割だけは出典の赤系ではなく
// LINE の緑系から採っている。
// 実測コントラスト比の読み物は docs/design/design-language.md §2、網羅的な機械検証は test/colors.test.ts が担う。
//
// 緑をそのまま持ち込んでいない点が本ファイルの要である:
//  - brand は LINE Green（LINE ログインボタンのガイドラインが基本色として指定する値）。白文字と 2.26:1 で
//    大きい文字の 3:1 にも届かないため**装飾・アイコン専用**とし、文字色にも、文字を載せる面にも使わない。
//  - primary は brand の各成分を 0.6 倍した暗い緑。白文字と 5.69:1、副次面（surfaceStrong）の上でも
//    5.08:1 で AA を満たす。0.65 倍では副次面の上で AA を割るため、この濃さを採る。
//  - success は出典に対応色が無い役割で、アクション色とは独立した値を持つ。色相がアクション色とほぼ
//    同じであることは受け入れており、成功の表示は色以外の手がかり（アイコンと文言）で識別させる。
//  - lineColors は Flex Message（非 Web コンテンツ）用のため AA 検証対象外。値は現行の LINE 面の
//    実装（messages.ts・delivery-job の notification.ts・line-webhook の report/builders）と
//    同一に保ち、Web 側の配色の差し替えで LINE の見た目が動かないことを保証する
//    （LINE アプリ自身の配色の中で成立させるための決定）。ただし attribution
//    （Google Maps の帰属表示）だけは現行色から採らず、Places API ポリシーが許す色から選んでいる。

/** Web 面（survey-web / store-detail / dashboard-web）の意味役割カラートークン。 */
export interface ColorTokens {
  /** ブランド基調色（装飾・アイコン専用。大きい文字の 3:1 にも届かないため文字には使わない）。 */
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
   *
   * 値を分けていても、いまのアクション色とは色だけでは見分けられない（色相の差 1 度未満・
   * 相互比 1.13:1）。成功の表示は必ずアイコンと文言を伴わせる（Alert の success 変種は部品が
   * アイコンを描く・@fwlm/ui の test/success-cue.test.tsx が成功の表示の全箇所を照合する）。
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
  /**
   * Google Maps の帰属表示の文字色（Web 面・Places API ポリシー・Issue #287）。
   *
   * ポリシーが許すのは白・#1F1F1F・#5E5E5E の 3 色だけで、本文色（text）はそのどれでもない。
   * 役割を分けずに本文色を継承させると、ポリシーの外の色で帰属表示が描かれる。白い面の上に置くので
   * 白は採れず、黒は本文より強く見えるため、灰（#5E5E5E）を採る。LINE 側の lineColors.attribution と
   * 同値だが、Web は LINE のトークンを参照しない（面ごとに解決先が違うため）。
   */
  readonly attribution: string;
  /**
   * 「Google でログイン」ボタンの塗り・枠・文字（dashboard-web のログイン画面・Issue #146）。
   *
   * 値の決め手は意匠ではなく Google の Sign in with Google branding guidelines にある。許される配色は
   * Light（塗り #FFFFFF・枠 #747775・文字 #1F1F1F）・Dark・Neutral の 3 つだけで、G ロゴを規定外の
   * 背景へ置くことは禁じられている。アクション色（primary）の塗りにロゴを載せると違反になるため、
   * 役割を分けて Light を採る。塗りは background と同値だが、background を変えたときにボタンまで
   * 動かないよう別の役割にした（3 値が規定どおりであることは test/tokens.test.ts が固定する）。
   */
  readonly googleSignInFill: string;
  readonly googleSignInBorder: string;
  readonly googleSignInForeground: string;
}

/** LINE Flex Message 用カラートークン（現行 7 色の意味役割化と、帰属表示の色）。 */
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
  /**
   * Google Maps の帰属表示（「データ提供: Google Maps」）の文字色。
   *
   * Places API ポリシーはテキストの帰属表示の色を白・黒・灰の 3 つの値に限る。caption と muted は
   * どちらもその外にあり、ポリシーの色へ寄せると帰属以外の補足まで見た目が動くため、役割を分けた
   * （3 つのどれかであることは test/tokens.test.ts が固定する）。
   */
  readonly attribution: string;
}

export const colors: ColorTokens = {
  // LINE Green。白文字と約 2.26:1 で、大きい文字の 3:1 にも届かないため装飾・アイコン専用。
  brand: '#06C755',
  // brand の各成分を 0.6 倍した値。白文字と約 5.69:1・surfaceStrong の上で約 5.08:1。
  primary: '#047733',
  // hover は primary を「暗くする」方向で表現する。アルファ合成（bg-primary/80 等）は
  // 白背景では合成後が明るくなり、ホバー時にだけ AA を割る（Issue #50）。
  // 各成分を 0.8 倍した確定値（白文字と約 7.86:1）。
  primaryHover: '#035F29',
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
  // 出典に対応色が無い役割（対白 約 5.02:1）。アクション色と共有しない理由と、
  // 色だけでは見分けられないことの扱いは ColorTokens の宣言に書いた。
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
  // ポリシーが許す灰（対白 約 6.48:1）。ポリシー自身も 4.5:1 の確保を求めている。
  attribution: '#5E5E5E',
  // Sign in with Google branding guidelines の Light テーマ（2026-09-23 確認）。
  googleSignInFill: '#FFFFFF',
  googleSignInBorder: '#747775',
  googleSignInForeground: '#1F1F1F',
};

export const lineColors: LineColorTokens = {
  headline: '#1DB446',
  body: '#333333',
  description: '#666666',
  caption: '#888888',
  successBackground: '#F0FBF4',
  action: '#1DB446',
  muted: '#AAAAAA',
  // ポリシーが許す灰。白いバブルの上に置くので白は採れず、黒は本文より強く見えるため採らない。
  attribution: '#5E5E5E',
};
