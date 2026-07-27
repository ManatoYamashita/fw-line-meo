// 余白トークンの単一定義箇所（Requirement 1.1）。値は rem リテラル。

/** 余白トークン（xs〜xl の 5 段階）。 */
export const spacing: Readonly<Record<'xs' | 'sm' | 'md' | 'lg' | 'xl', string>> = {
  xs: '0.25rem',
  sm: '0.5rem',
  md: '1rem',
  lg: '1.5rem',
  xl: '2rem',
};
