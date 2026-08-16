// WCAG 2.1 コントラスト演算の単一実装（Requirements 5.2）。
//
// 元は test/colors.test.ts のファイルローカル関数だったが、@fwlm/ui 側でも
// 「部品が使うアルファ合成後の実効色」を検証する必要が生じたため src へ移して export する
// （Issue #50）。2 パッケージで別実装を持つと、まさに本プロジェクトのガードが防ごうとしている
// 実装ドリフトを自分で作ることになるため、演算はここ 1 箇所に集約する。
//
// design-tokens は依存ゼロが不変条件であり、ここに置く演算はすべて純粋な算術のみで完結する。

/** '#RRGGBB'（6桁大文字 hex）を 0..255 の RGB 3成分へ変換する。 */
export function hexToRgb(hex: string): [number, number, number] {
  if (!/^#[0-9A-F]{6}$/.test(hex)) {
    throw new Error(`6桁 hex リテラルではありません: ${hex}`);
  }
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * WCAG 2.1 定義の相対輝度。
 * sRGB 各成分を 0..1 化し、しきい値 0.03928 以下は /12.92、超は ((c+0.055)/1.055)^2.4 で
 * 線形化したうえで 0.2126R + 0.7152G + 0.0722B の加重和を取る。
 * 参照: https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG 2.1 定義のコントラスト比 (L1 + 0.05) / (L2 + 0.05)（L1 は明るい方の輝度）。
 * 参照: https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
 */
export function contrastRatio(colorA: string, colorB: string): number {
  const luminanceA = relativeLuminance(colorA);
  const luminanceB = relativeLuminance(colorB);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * 半透明の前景色を不透明な背景色の上に重ねた結果の実効色を返す。
 *
 * Tailwind の `text-primary/90` や `bg-destructive/10` のような不透明度付きユーティリティは、
 * ブラウザ上では「その色を下地に合成した色」として描画される。コントラスト比は合成後の
 * 実効色で決まるため、トークン素の値だけを検証しても AA 準拠は保証できない
 * （Issue #50 の根本原因。実際に 5 箇所が素通りしていた）。
 *
 * 合成は sRGB 空間での単純なアルファブレンド c = a * fg + (1 - a) * bg。
 * ブラウザの実際の合成もこの式に従う（`background-color` のアルファ合成は sRGB で行われる）。
 *
 * @param foreground 重ねる色（'#RRGGBB'）
 * @param background 下地の色（'#RRGGBB'・不透明であること）
 * @param alpha 0..1 の不透明度（Tailwind の `/90` は 0.9）
 * @returns 合成後の実効色（'#RRGGBB'・6桁大文字。hexToRgb にそのまま渡せる形式）
 */
export function compositeOver(
  foreground: string,
  background: string,
  alpha: number,
): string {
  if (!(alpha >= 0 && alpha <= 1)) {
    throw new Error(`alpha は 0..1 の範囲で指定してください: ${alpha}`);
  }
  const fg = hexToRgb(foreground);
  const bg = hexToRgb(background);
  const channels = fg.map((channel, index) =>
    Math.round(channel * alpha + bg[index]! * (1 - alpha)),
  );
  return `#${channels
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase();
}
