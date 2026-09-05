// @fwlm/design-tokens 公開 API（design.md「@fwlm/design-tokens」Service Interface）。
// 全トークン値の単一情報源。フレームワーク非依存・依存ゼロを不変条件とする。
export type { ColorTokens, LineColorTokens } from './colors.js';
export { colors, lineColors } from './colors.js';
export type { LineLayoutTokens } from './line-layout.js';
export { lineLayout } from './line-layout.js';
export type { TypographyTokens } from './typography.js';
export { typography } from './typography.js';
export { spacing } from './spacing.js';
export { radius } from './radius.js';
export { shadow } from './shadow.js';
// WCAG コントラスト演算（@fwlm/ui 側のアルファ合成色ガードからも参照する・Issue #50）。
export {
  hexToRgb,
  relativeLuminance,
  contrastRatio,
  compositeOver,
} from './contrast.js';
