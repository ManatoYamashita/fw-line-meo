// タイポグラフィトークンの単一定義箇所（Requirement 1.1）。
// フォントは基盤段階ではシステム JP スタック（ネットワークコストゼロ・LCP 影響なし）。
// ブランドフォント（LINE Seed JP 等）の導入判断は Issue #44 で行い、fontSans の差し替えのみで追従する。

/** タイポグラフィトークン（フォントファミリとサイズ階層）。 */
export interface TypographyTokens {
  /** サンセリフ基本フォントスタック（日本語システムフォント）。 */
  readonly fontSans: string;
  /**
   * フォントサイズ階層（rem）。`display` はプロダクト全体で 1 箇所だけの巨大表示（店舗詳細の順位数値）の段。
   * `3xl` 以上の名前にしないのは、Tailwind 既定の同名の段を上書きすると既定クラスの意味が静かに変わるため。
   */
  readonly scale: Readonly<Record<'xs' | 'sm' | 'base' | 'lg' | 'xl' | '2xl' | 'display', string>>;
}

export const typography: TypographyTokens = {
  fontSans:
    'system-ui, -apple-system, "Segoe UI", Roboto, "Hiragino Kaku Gothic ProN", "Hiragino Sans", Meiryo, sans-serif',
  scale: {
    xs: '0.75rem',
    sm: '0.875rem',
    base: '1rem',
    lg: '1.125rem',
    xl: '1.25rem',
    '2xl': '1.5rem',
    display: '4rem',
  },
};
