// Tailwind CSS v4 の PostCSS 統合（next build が本設定を読む）。
// v4 はプラグイン1つのみ・autoprefixer 不要（design.md「Technology Stack」）。
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
