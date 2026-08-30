// 余白トークンの単一定義箇所（Requirement 1.1）。値は rem リテラル。
//
// 意匠の出典は docs/design/upstream/airbnb-DESIGN.md の spacing 9 段
// （2 / 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 px）。出典の 9 段はいずれも Tailwind の数値スケール
// （基数 0.25rem）で余りなく表現できる。これが「@theme に余白の名前付きキーを宣言しない」
// 規約（Issue #54）を守ったまま出典の余白律を採れる根拠である。
//
// **CSS へは出さない。** 名前付きキーを @theme に宣言すると、サイズ系ユーティリティ
// （最大幅・最小幅・幅・フレックス基準幅）の解決先が既定のコンテナ寸法スケールから
// 余白スケールへ覆われ、画面が壊れたままビルドが通る。CSS では p-4 のような数値スケールで
// 指定し、本ファイルは LINE Flex Message など CSS 以外の消費先へ値を提供する。
// 対応（余白基数 0.25rem に対する倍率）は @fwlm/ui の test/token-scales.test.ts が機械照合する。
//
// 注意: 意匠差し替えに伴い **md の意味が 1rem から 0.75rem へ移り、1rem は新キー base になった**。
// 変更時点の spacing の消費者は token-scales.test.ts だけであり（LINE 層は lineColors のみを
// import する）、意味の移動を無痛で行える最後の機会だったため、出典の段名にそのまま揃えた。

/** 余白トークン（出典の 9 段）。 */
export const spacing: Readonly<
  Record<'xxs' | 'xs' | 'sm' | 'md' | 'base' | 'lg' | 'xl' | 'xxl' | 'section', string>
> = {
  xxs: '0.125rem',
  xs: '0.25rem',
  sm: '0.5rem',
  md: '0.75rem',
  base: '1rem',
  lg: '1.5rem',
  xl: '2rem',
  xxl: '3rem',
  section: '4rem',
};
