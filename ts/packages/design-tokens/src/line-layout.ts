// LINE Flex Message 用の寸法トークンの単一定義箇所（Issue #42）。
//
// 値は LINE 独自のキーワード（xxs〜xxl・kilo 等）であり、CSS の rem 体系とは別物である。
// LINE が各キーワードの実 px を公開していないため spacing.ts の rem 値へ写像できない。
// したがって本セットが共有するのは「値」ではなく「役割」であり、買えるのは
// **同じ役割には同じキーワードを使う**の強制だけである。値の単一情報源という利得は無い
// （値の所有者は LINE である）。
//
// このためトークンを置くだけでは「守っているつもりの層」が 1 枚増えるだけになる。実効化するのは
// 消費側の不変条件テスト（delivery-job/test/flex.test.ts・line-webhook/test/line/messages.test.ts）が
// 「組み立てた Flex の値が本セットの値と一致する」を assert することであり、両者は対で入れる。
// スナップショットは -u 一発で意匠を元に戻す変更も静かに受理するため、この役目を負えない。
//
// 各キーワードの妥当性の裏は .claude/skills/messaging-api/references/flex-message.md:
// - box の内部余白は paddingAll（none/xs/sm/md/lg/xl/xxl・ピクセル・パーセント）
// - text の size は xxs/xs/sm/md/lg/xl/xxl/3xl/4xl/5xl またはピクセル
// - bubble の size は nano/micro/deca/hecto/kilo/mega/giga
// - margin は親の spacing を、その子についてだけ上書きする

/** LINE Flex Message 用の寸法トークン（意味役割 → LINE のキーワード）。 */
export interface LineLayoutTokens {
  /** バブルの幅の段。日次サマリーは既定（mega）を使うため、本トークンの消費先はオンボーディングの 4 バブル。 */
  readonly bubbleSize: string;
  /** header / body / footer の内部余白。バブルの大きさに依らず同じ段を使う。 */
  readonly blockPadding: string;
  /** header 下端だけを詰める段（見出しを直下の本文へ近づける）。 */
  readonly headerPaddingBottom: string;
  /** ブロック内のセクションどうしの間隔。itemGap より大きい段であること。 */
  readonly sectionGap: string;
  /** セクション内の行どうしの間隔。これが無いとセクションの内と外が同じ間隔になり、群として読めない。 */
  readonly itemGap: string;
  /** 節を閉じる区切り線の前の余白。sectionGap より大きい段であること（margin は親の spacing を上書きする）。 */
  readonly dividerMargin: string;
  /** 唯一の大声。日次サマリーの順位数値ただ 1 箇所に使う。 */
  readonly displaySize: string;
  /** 祝祭の面の主見出し。オンボーディング完了バブルただ 1 箇所に使う。 */
  readonly titleSize: string;
  /** 基準段。見出しか本文かは weight が区別するので、段は分けない。 */
  readonly bodySize: string;
  /** 説明文・補足。 */
  readonly descriptionSize: string;
  /** 説明文よりさらに退く注記。 */
  readonly noteSize: string;
  /** 帰属表記などの最小段。 */
  readonly captionSize: string;
  /**
   * 主要操作の高さ。LINE の button が受け取る値は 2 つだけなので、消費側の型
   * （FlexButton.height）が要求する union をトークン側でも保つ。他のフィールドは
   * ピクセル指定も許容されるため string のままにする。
   */
  readonly actionHeight: 'sm' | 'md';
}

export const lineLayout: LineLayoutTokens = {
  bubbleSize: 'kilo',
  blockPadding: 'lg',
  headerPaddingBottom: 'md',
  sectionGap: 'md',
  itemGap: 'sm',
  dividerMargin: 'lg',
  displaySize: 'xxl',
  titleSize: 'lg',
  bodySize: 'md',
  descriptionSize: 'sm',
  noteSize: 'xs',
  captionSize: 'xxs',
  actionHeight: 'md',
};
