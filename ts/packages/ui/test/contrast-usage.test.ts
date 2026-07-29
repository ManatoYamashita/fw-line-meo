// 部品が実際に使う「アルファ合成後の実効色」の WCAG コントラスト検証（Issue #50 / Requirements 5.2）。
//
// なぜこのテストが要るか:
// design-tokens/test/colors.test.ts は「トークン素の値のペア」しか検証しない。しかし
// `text-success/90` や `bg-destructive/10` のような不透明度付きユーティリティは、ブラウザ上では
// 「その色を下地に合成した色」として描画されるため、コントラスト比は合成後の実効色で決まる。
// 実際に PR #46/#47 では 5 箇所が AA を割ったまま CI 全緑で main に入った。
// theme.css:87-91 が「ブランド緑は 2.74:1 だから文字色に使わない」と明記しているにもかかわらず、
// `/90` や `/80` の合成が同じ失敗を再導入していた、という構図である。
//
// 本テストは 2 層で構成する:
//   1. 数値検証 — USAGE_PAIRS の各エントリについて合成後の実効色を求め、しきい値以上を assert
//   2. 網羅ガード — 部品ソースを走査して不透明度付きクラスを全抽出し、USAGE_PAIRS ∪ EXEMPT_UTILITIES
//      と双方向で突き合わせる。#48 で潰した「集合包含だけでは不十分」と同じ穴を空けないため、
//      「部品に新しい /NN を足したのに検証表へ追記し忘れた」を必ず赤化させる。
//
// 意味論名 → 実 hex の解決は theme.css の宣言から導出する（手書きの対応表を持たない）。
// 対応表を手写しすると、それ自体が新たな同期漏れの発生源になるため。
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { compositeOver, contrastRatio } from '@fwlm/design-tokens';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const componentsDir = join(srcDir, 'components');
const themeCss = readFileSync(join(srcDir, 'theme.css'), 'utf8');

/** 通常文字の WCAG 2.1 AA 基準（Requirements 5.2）。 */
const AA_NORMAL_TEXT_RATIO = 4.5;
/** 非テキスト（UI 部品の境界・状態表示）の WCAG 2.1 SC 1.4.11 基準。 */
const AA_NON_TEXT_RATIO = 3;

// --- 意味論名の解決 -----------------------------------------------------------------

/**
 * theme.css の全 `--name: <値>;` 宣言を集める（@theme / :root / @theme inline を区別しない）。
 * 同名が複数回宣言されることは設計上無い（theme.css:99-102 が循環参照防止のため再定義を禁じている）。
 */
function collectDeclarations(css: string): ReadonlyMap<string, string> {
  const declarations = new Map<string, string>();
  for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const name = match[1]!;
    if (!declarations.has(name)) {
      declarations.set(name, match[2]!.trim());
    }
  }
  return declarations;
}

const declarations = collectDeclarations(themeCss);

/**
 * Tailwind の色ユーティリティ名（`primary` / `muted-foreground` 等）を実 hex へ解決する。
 * `--color-<name>` を起点に `var(--other)` の参照鎖をたどる。
 */
function resolveSemanticColor(name: string, seen: readonly string[] = []): string {
  const variable = seen.length === 0 ? `--color-${name}` : name;
  if (seen.includes(variable)) {
    throw new Error(`CSS 変数の参照が循環しています: ${[...seen, variable].join(' -> ')}`);
  }
  const value = declarations.get(variable);
  if (value === undefined) {
    throw new Error(`theme.css に ${variable} の宣言がありません（意味論名: ${name}）`);
  }
  if (/^#[0-9a-fA-F]{6}$/.test(value)) {
    return value.toUpperCase();
  }
  const reference = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  if (reference === null) {
    throw new Error(`${variable} の値を hex へ解決できません: ${value}`);
  }
  return resolveSemanticColor(reference[1]!, [...seen, variable]);
}

describe('意味論名の hex 解決（theme.css からの導出・自己検証）', () => {
  it('@theme に直接ある色をそのまま返す', () => {
    expect(resolveSemanticColor('primary')).toBe('#15803D');
  });

  it('@theme inline → :root → @theme の参照鎖をたどる', () => {
    // --color-card -> var(--card) -> var(--color-background) -> #FFFFFF
    expect(resolveSemanticColor('card')).toBe('#FFFFFF');
    // --color-success -> var(--success) -> var(--color-primary) -> #15803D
    expect(resolveSemanticColor('success')).toBe('#15803D');
    // --color-muted-foreground -> var(--muted-foreground) -> var(--color-text-muted) -> #666666
    expect(resolveSemanticColor('muted-foreground')).toBe('#666666');
  });

  it('未定義の意味論名は例外にする（静かな空振りを防ぐ）', () => {
    expect(() => resolveSemanticColor('no-such-color')).toThrow();
  });
});

// --- 検証表 -------------------------------------------------------------------------

interface UsagePair {
  /** 部品ソースに現れる不透明度付きクラス（網羅ガードの突き合わせキー）。 */
  readonly utility: string;
  /** 出典（どの部品のどの状態か）。 */
  readonly source: string;
  /** 前景の意味論名。 */
  readonly foreground: string;
  /** 前景の不透明度（既定 1）。 */
  readonly foregroundAlpha?: number;
  /** 下地の意味論名。 */
  readonly surface: string;
  /** 下地の不透明度（既定 1）。 */
  readonly surfaceAlpha?: number;
  /** 下地のさらに下にある不透明色（既定 background）。 */
  readonly backdrop?: string;
  /** テキストか非テキスト（しきい値が変わる）。 */
  readonly kind: 'text' | 'non-text';
}

/**
 * 部品が使う不透明度付きクラスと、その実効コントラストの検証対象ペア。
 *
 * 下地が指定されていない部品（Button ghost / link 等）は親の背景に載るため、
 * 既定の backdrop である `background`（#FFFFFF）を仮定する。
 */
const USAGE_PAIRS: readonly UsagePair[] = [
  {
    utility: 'bg-destructive/10',
    source: 'button.tsx / badge.tsx variant=destructive（base）',
    foreground: 'destructive',
    surface: 'destructive',
    surfaceAlpha: 0.1,
    kind: 'text',
  },
  {
    utility: 'bg-destructive/20',
    source: 'button.tsx / badge.tsx variant=destructive（hover）',
    foreground: 'destructive',
    surface: 'destructive',
    surfaceAlpha: 0.2,
    kind: 'text',
  },
  {
    utility: 'bg-secondary/80',
    source: 'badge.tsx variant=secondary（<a> 描画時の hover）',
    foreground: 'secondary-foreground',
    surface: 'secondary',
    surfaceAlpha: 0.8,
    kind: 'text',
  },
  {
    utility: 'bg-muted/50',
    source: 'card.tsx CardFooter（面塗り。文字は継承）',
    foreground: 'foreground',
    surface: 'muted',
    surfaceAlpha: 0.5,
    kind: 'text',
  },
  {
    utility: 'bg-primary/5',
    source: 'field.tsx FieldLabel（has-data-checked の面塗り。文字は継承）',
    foreground: 'foreground',
    surface: 'primary',
    surfaceAlpha: 0.05,
    kind: 'text',
  },
];

/**
 * 検証表に載せない不透明度付きクラスと、その理由。
 *
 * 「合格しているから除外」ではなく「WCAG の対象外であるか、別Issueで扱う」ものだけを載せる。
 * 理由なしの除外を許すと、このガードは #48 で潰した空振りガードと同じものになる。
 */
const EXEMPT_UTILITIES: ReadonlyArray<{ readonly utility: string; readonly reason: string }> = [
  {
    utility: 'ring-destructive/20',
    reason:
      'aria-invalid のリングは装飾。エラーであることの伝達は同時に付く ' +
      'aria-invalid:border-destructive（対白 6.47:1）と role="alert" の文言が担う。',
  },
  {
    utility: 'ring-foreground/10',
    reason: 'card.tsx の外枠。情報を持たない純装飾のため SC 1.4.11 の対象外。',
  },
  {
    utility: 'border-primary/30',
    reason:
      'field.tsx FieldLabel の選択状態表示（1.96:1）。非テキスト 3:1 未達だが、' +
      'border-input #DDDDDD(1.35:1) と同種の「トークン素の値が薄すぎる」問題であり、' +
      '枠線の意匠全体に関わるため別Issueで一括して扱う（#49/#50 のスコープ外）。',
  },
  {
    utility: 'bg-input/50',
    reason:
      'input / textarea の disabled 時の面塗り。WCAG 1.4.3 は無効化された部品を' +
      'コントラスト要件の対象外としている。',
  },
];

// --- 数値検証 -----------------------------------------------------------------------

/** 前景・下地それぞれのアルファ合成を解いて実効コントラスト比を求める。 */
function effectiveRatio(pair: UsagePair): {
  readonly ratio: number;
  readonly foregroundHex: string;
  readonly surfaceHex: string;
} {
  const backdrop = resolveSemanticColor(pair.backdrop ?? 'background');
  const surfaceBase = resolveSemanticColor(pair.surface);
  const surfaceHex =
    pair.surfaceAlpha === undefined
      ? surfaceBase
      : compositeOver(surfaceBase, backdrop, pair.surfaceAlpha);
  const foregroundBase = resolveSemanticColor(pair.foreground);
  const foregroundHex =
    pair.foregroundAlpha === undefined
      ? foregroundBase
      : compositeOver(foregroundBase, surfaceHex, pair.foregroundAlpha);
  return { ratio: contrastRatio(foregroundHex, surfaceHex), foregroundHex, surfaceHex };
}

describe('アルファ合成後の実効コントラスト（Issue #50 / Requirements 5.2）', () => {
  it('検証表が空でない（空振り緑の防止）', () => {
    expect(USAGE_PAIRS.length).toBeGreaterThan(0);
  });

  for (const pair of USAGE_PAIRS) {
    const threshold = pair.kind === 'text' ? AA_NORMAL_TEXT_RATIO : AA_NON_TEXT_RATIO;
    it(`${pair.utility}（${pair.source}）は ${threshold}:1 以上`, () => {
      const { ratio, foregroundHex, surfaceHex } = effectiveRatio(pair);
      expect(
        ratio,
        `${pair.utility}: ${pair.foreground}(${foregroundHex}) on ${surfaceHex} → ` +
          `${ratio.toFixed(3)}:1（要求 ${threshold}:1・${pair.source}）`,
      ).toBeGreaterThanOrEqual(threshold);
    });
  }
});

// --- 網羅ガード ---------------------------------------------------------------------

/** 部品ソース（src/components/*.tsx）を全て読む。 */
function readComponentSources(): ReadonlyArray<{ readonly file: string; readonly source: string }> {
  return readdirSync(componentsDir)
    .filter((name) => name.endsWith('.tsx'))
    .map((file) => ({ file, source: readFileSync(join(componentsDir, file), 'utf8') }));
}

/** 不透明度付きの色ユーティリティ（`bg-primary/80` 等）。 */
const ALPHA_UTILITY_PATTERN = /^(?:bg|text|border|ring|outline|fill|stroke)-[a-z0-9-]+\/\d{1,3}$/;

/**
 * ソースから不透明度付き色ユーティリティを抽出する。
 *
 * `dark:` を含むクラスは theme.css:65 の `@custom-variant dark (&:is(.dark *))` により
 * `.dark` 祖先が無い限り一切適用されない（ダークパレット未整備のため意図的に無効化されている）。
 * 現状 `.dark` を付与する箇所はリポジトリ内に存在しないため、検証対象から除外する。
 * ダークモード着手時にはこの除外を外し、ダーク下地での実効コントラストを検証すること。
 */
function extractAlphaUtilities(source: string): readonly string[] {
  const found: string[] = [];
  for (const rawToken of source.split(/[\s"'`]+/)) {
    if (rawToken.includes('dark:')) continue;
    // 先頭の variant 連鎖（`[a]:hover:` `*:data-[slot=x]:` `focus-visible:` 等）を落として
    // ユーティリティ本体だけを見る。variant 部分に `/` は現れない。
    const utility = rawToken.slice(rawToken.lastIndexOf(':') + 1);
    if (ALPHA_UTILITY_PATTERN.test(utility)) {
      found.push(utility);
    }
  }
  return found;
}

describe('網羅ガード: 部品の不透明度付きクラスが全て分類されている（Issue #50）', () => {
  const sources = readComponentSources();
  const foundUtilities = [
    ...new Set(sources.flatMap(({ source }) => extractAlphaUtilities(source))),
  ].sort();
  const classified = [
    ...new Set([
      ...USAGE_PAIRS.map((pair) => pair.utility),
      ...EXEMPT_UTILITIES.map((entry) => entry.utility),
    ]),
  ].sort();

  it('部品ソースを読めており、抽出が機能している（空振り緑の防止）', () => {
    expect(sources.length).toBeGreaterThan(0);
    expect(foundUtilities.length).toBeGreaterThan(0);
  });

  it('部品が使う不透明度付きクラスは全て検証表か除外理由付きリストにある', () => {
    // 新しい /NN クラスを部品へ足したら、必ず USAGE_PAIRS で検証させるか
    // EXEMPT_UTILITIES で理由を書かせるための網羅ガード
    // （theme-sync.test.ts の「役割対応表に無い色変数の混入防止」と同じ流儀）。
    const unclassified = foundUtilities.filter((utility) => !classified.includes(utility));
    expect(
      unclassified,
      `検証表にも除外リストにも無い不透明度付きクラスが部品にあります: ${unclassified.join(', ')}`,
    ).toEqual([]);
  });

  it('検証表・除外リストに部品で使われていないクラスが残っていない', () => {
    // 部品から消したクラスが表に残り続けると「守っているつもり」の空振りになる。
    const stale = classified.filter((utility) => !foundUtilities.includes(utility));
    expect(
      stale,
      `部品で使われていないクラスが検証表／除外リストに残っています: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('除外はすべて理由が書かれている', () => {
    for (const entry of EXEMPT_UTILITIES) {
      expect(entry.reason.length, `${entry.utility} の除外理由が空です`).toBeGreaterThan(20);
    }
  });
});

// --- color-mix ガード ---------------------------------------------------------------

/**
 * `color-mix()` は不透明度付きクラスの正規表現をすり抜けるため、別途検出して
 * 実測値付きの許可リストへの登録を必須にする（ホールを塞ぐ）。
 */
const COLOR_MIX_ALLOWLIST: ReadonlyArray<{
  readonly file: string;
  readonly reason: string;
}> = [
  {
    file: 'button.tsx',
    reason:
      'variant=secondary の hover。--secondary(#F0FBF4) に --foreground(#333333) を 5% 混色し、' +
      '文字は --secondary-foreground(#333333) のまま。合成方向が「暗くする」ため元の 11.92:1 から' +
      '悪化せず、実測でも約 10.9:1 と AA を大きく上回る。',
  },
];

describe('color-mix ガード: 静的検証できない色指定を野放しにしない（Issue #50）', () => {
  const sources = readComponentSources();
  const filesUsingColorMix = sources
    .filter(({ source }) => source.includes('color-mix('))
    .map(({ file }) => file)
    .sort();
  const allowed = [...new Set(COLOR_MIX_ALLOWLIST.map((entry) => entry.file))].sort();

  it('color-mix を使う部品は全て許可リストに理由付きで登録されている', () => {
    // color-mix は oklch 等の色空間で合成されるため、hex ベースの静的検証ができない。
    // 使うこと自体は禁じないが、なぜ安全かを人間が書き残すことを強制する。
    const undocumented = filesUsingColorMix.filter((file) => !allowed.includes(file));
    expect(
      undocumented,
      `color-mix を使っているが許可リストに無い部品: ${undocumented.join(', ')}`,
    ).toEqual([]);
  });

  it('許可リストに color-mix を使っていない部品が残っていない', () => {
    const stale = allowed.filter((file) => !filesUsingColorMix.includes(file));
    expect(
      stale,
      `color-mix を使っていない部品が許可リストに残っています: ${stale.join(', ')}`,
    ).toEqual([]);
  });
});
