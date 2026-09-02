// 角丸トークンの単一定義箇所（Requirement 1.1）。
// full は完全な丸み（ピル形状）を表す慣例値のため px リテラルを用いる。
//
// 値は Tailwind の既定スケールと恒等対応する（ui-token-collision Requirements 3.3 / 5.4）。
// 一部の段だけを独自値へ上書きすると、上書きしなかった隣の段と同値になり視覚階層が潰れるため、
// スケールの定義そのものは Tailwind 側に委ね、本ファイルはその写しを CSS 以外の消費先へ提供する。
// theme.css と生成 CSS との一致は @fwlm/ui の test/token-scales.test.ts が役割ごとに機械照合する。
//
// キー集合は共通部品が実際に使う段をすべて含む必要がある
// （使われている段に対応が無いと要件 3.3 を満たせない）。
// 2xl は Card と表の容器、4xl は Badge、lg は Button と一行入力・選択が使用する。
// sm と xl はいずれの部品も未使用だが、既定スケールとの恒等対応を示す写しとして維持する
// （xl は Card が 2xl へ移るまで唯一の消費先だった）。

/** 角丸トークン（sm/md/lg/xl/2xl/4xl/full）。 */
export const radius: Readonly<
  Record<'sm' | 'md' | 'lg' | 'xl' | '2xl' | '4xl' | 'full', string>
> = {
  sm: '0.25rem',
  md: '0.375rem',
  lg: '0.5rem',
  xl: '0.75rem',
  '2xl': '1rem',
  '4xl': '2rem',
  full: '9999px',
};
