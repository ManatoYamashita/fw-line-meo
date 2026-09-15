// Flex Message とクイックリプライの局所的な型（design.md「File Structure Plan」の line/flex-types.ts）。
// 案内文の組立（line/messages.ts）とレポートの組立（report/builders/*）が共有する。
//
// LineMessage['contents'] は unknown のため、組立の内部ではこれらの狭い型で構築し、
// 呼び出し側（テスト等）が安全にキャストできるよう export しておく（no-explicit-any 対応）。
//
// 形の一次情報は .claude/skills/messaging-api/references（flex-message.md・action-objects.md・
// message-objects.md）と、@line/bot-sdk の生成型（messaging-api/model）である。生成型をそのまま
// 使わないのは、生成型がほぼすべての項目を省略可能にしており（postback の data、クイックリプライの
// label と action など）、LINE が必須とする項目の欠落を型検査で落とせないためである。ここでは組立が
// 使う項目だけを、必須のものは必須として書く。各型の鍵が生成型に実在することは
// test/line/flex-types.test.ts が型検査で確かめる。
//
// 文字数と件数の上限（クイックリプライは 13 件まで、そのラベルは 20 文字まで、など）は型では
// 表せない。組立側の定数と試験が持つ。

// --- action（references/action-objects.md） ---

export interface FlexPostbackAction {
  readonly type: 'postback';
  readonly label: string;
  readonly data: string;
  readonly displayText: string;
}

// 外部リンク（LIFF 等）へ遷移する action。postback と異なり data を持たず uri を持つ。
export interface FlexUriAction {
  readonly type: 'uri';
  readonly label: string;
  readonly uri: string;
}

export type FlexAction = FlexPostbackAction | FlexUriAction;

// --- Flex の部品（references/flex-message.md「Components」） ---

export interface FlexTextComponent {
  readonly type: 'text';
  readonly text: string;
  readonly weight?: 'regular' | 'bold';
  readonly size?: string;
  readonly color?: string;
  readonly wrap?: boolean;
  /** wrap が true のときの最大行数（新着口コミの本文を 4 行で打ち切る）。 */
  readonly maxLines?: number;
  readonly align?: 'start' | 'center' | 'end';
  readonly margin?: string;
  /** 横に並べる box の中での幅の比（推移の表の列、投稿者の画像の横の名前）。 */
  readonly flex?: number;
  /**
   * 容器の幅を超える文字を自動で縮める。折り返さない文字は幅を超えると省略記号で切られるため、
   * 大きな段を使う表示にはこれを対で添える（docs/design/design-language.md §7.13）。
   */
  readonly adjustMode?: 'shrink-to-fit';
  /** 文字を押したときの遷移（投稿者名から投稿者のプロフィールへ）。 */
  readonly action?: FlexUriAction;
}

export interface FlexButtonComponent {
  readonly type: 'button';
  readonly style: 'primary' | 'secondary';
  readonly color?: string;
  readonly height?: 'sm' | 'md';
  readonly action: FlexAction;
}

/**
 * 画像（投稿者の画像）。url は HTTPS の JPEG か PNG でなければならず、1 つでも不適合があると
 * LINE はメッセージ全体を拒否する。url の検証は組立側が行う。
 */
export interface FlexImageComponent {
  readonly type: 'image';
  readonly url: string;
  readonly size?: string;
  /** `{幅}:{高さ}` の比。投稿者の画像は 1:1 にする。 */
  readonly aspectRatio?: string;
  /** 画像の比が aspectRatio と異なるときの収め方。cover は切り抜いて埋める。 */
  readonly aspectMode?: 'cover' | 'fit';
  readonly flex?: number;
}

export type FlexBoxContent = FlexTextComponent | FlexButtonComponent | FlexImageComponent | FlexBoxComponent;

export interface FlexBoxComponent {
  readonly type: 'box';
  readonly layout: 'horizontal' | 'vertical';
  readonly spacing?: string;
  readonly margin?: string;
  readonly paddingAll?: string;
  readonly contents: readonly FlexBoxContent[];
}

// --- Flex のコンテナ（references/flex-message.md「Containers」「Bubble Styles」） ---

// Bubble の各ブロックの装飾（背景色・区切り線）。
export interface FlexBlockStyle {
  readonly backgroundColor?: string;
  readonly separator?: boolean;
}

export interface FlexBubbleStyles {
  readonly body?: FlexBlockStyle;
  readonly footer?: FlexBlockStyle;
}

export interface FlexBubbleContents {
  readonly type: 'bubble';
  readonly size?: string;
  readonly styles?: FlexBubbleStyles;
  readonly header?: FlexBoxComponent;
  readonly body: FlexBoxComponent;
  readonly footer: FlexBoxComponent;
}

export interface FlexCarouselContents {
  readonly type: 'carousel';
  readonly contents: readonly FlexBubbleContents[];
}

// --- クイックリプライ（references/message-objects.md「Quick Reply」） ---
//
// 店舗の選択肢（line-on-demand-report の Requirement 3.2）が使う postback だけを持つ。
// postback の action は Flex のボタンと同じ形であり（action オブジェクトは文脈をまたいで共有される）、
// displayText は、選んだ店舗名を省略せずにトークへ残すため必須にしている（Requirement 3.9）。
// 複数のメッセージを送ると、クイックリプライが表示されるのは最後のメッセージのものだけである。

export type QuickReplyAction = FlexPostbackAction;

export interface QuickReplyItem {
  readonly type: 'action';
  readonly action: QuickReplyAction;
}

export interface QuickReply {
  readonly items: readonly QuickReplyItem[];
}
