// 角丸トークンの単一定義箇所（Requirement 1.1）。
// full は完全な丸み（ピル形状）を表す慣例値のため px リテラルを用いる。

/** 角丸トークン（sm/md/lg/full）。 */
export const radius: Readonly<Record<'sm' | 'md' | 'lg' | 'full', string>> = {
  sm: '0.25rem',
  md: '0.5rem',
  lg: '0.75rem',
  full: '9999px',
};
