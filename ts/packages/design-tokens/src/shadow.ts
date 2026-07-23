// 影トークンの単一定義箇所（Requirement 1.1）。
// 影色は 8 桁 hex（末尾 2 桁がアルファ）で表現し、rgba() 関数値を避けて hex リテラル方針を保つ。
// #0000000D = 黒 5% / #0000001A = 黒 10%。

/** 影トークン（sm/md/lg の box-shadow 値）。 */
export const shadow: Readonly<Record<'sm' | 'md' | 'lg', string>> = {
  sm: '0 1px 2px 0 #0000000D',
  md: '0 4px 6px -1px #0000001A, 0 2px 4px -2px #0000001A',
  lg: '0 10px 15px -3px #0000001A, 0 4px 6px -4px #0000001A',
};
