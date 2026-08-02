// トークンスケールの解析（ui-token-collision タスク 1.2）。
//
// design.md「test/support/token-scales.ts」/ Requirements 2.2, 3.2, 3.3, 5.1, 5.3, 5.4, 5.5, 5.6。
//
// 本モジュールは **副作用を持たない**。入力は CSS 文字列とトークン定義だけで、ファイル読み書きも
// コンパイルも行わない。この分離により、タスク 2.4 の注入対照が「是正前の宣言を注入して
// コンパイルした結果」を渡して**同じ判定関数**を呼べる（ガードが生きていることの恒久的な証拠）。
//
// 判定はすべて「違反の一覧」を返す。例外は投げない。呼び出し側が件数と内容を assert できる形に
// することで、失敗メッセージに実際の値を載せられる。
import postcss, { type Declaration } from 'postcss';

/** Tailwind が内部的に用いる変数の接頭辞。テーマ変数ではないため解決先の判定から除外する。 */
const INTERNAL_VAR_PREFIX = '--tw-';

/** ユーティリティが読む値の種別。 */
export type Resolution =
  | { readonly kind: 'themeVar'; readonly variable: string }
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'absent' };

export interface ShadowingViolation {
  readonly utility: string;
  /** 素の Tailwind が読むテーマ変数。 */
  readonly baselineVariable: string;
  /** 現行が読むテーマ変数（= 覆っている宣言）。 */
  readonly currentVariable: string;
}

export interface ScaleMismatch {
  readonly scale: 'spacing' | 'radius';
  readonly key: string;
  readonly tokenValue: string;
  /** 生成 CSS から得た実寸。解決できない場合は null（**違反として扱う**）。 */
  readonly resolvedValue: string | null;
}

export interface DuplicateRadiusStep {
  /** 同値へ解決された 2 段以上のキー。 */
  readonly keys: readonly string[];
  readonly value: string;
}

/** 値の表記ゆれ（連続空白）を吸収する。 */
function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** 生成 CSS から、セレクタが `.{utility}` に完全一致する規則の宣言を順に集める。 */
function declarationsOfUtility(css: string, utility: string): readonly Declaration[] {
  const selector = `.${utility}`;
  const declarations: Declaration[] = [];
  postcss.parse(css).walkRules((rule) => {
    if (normalize(rule.selector) !== selector) return;
    rule.each((node) => {
      if (node.type === 'decl') declarations.push(node);
    });
  });
  return declarations;
}

/**
 * 生成 CSS から、指定クラスが読む値を判定する。
 *
 * `--tw-*` は Tailwind の内部変数であり「どのテーマスケールを読むか」を表さないため除外する。
 * テーマ変数を 1 つも読まない場合（`rounded-full` の `calc(infinity * 1px)` 等）は literal とする。
 */
export function resolveUtility(css: string, utility: string): Resolution {
  const declarations = declarationsOfUtility(css, utility);
  if (declarations.length === 0) return { kind: 'absent' };

  for (const declaration of declarations) {
    for (const match of declaration.value.matchAll(/var\((--[a-zA-Z0-9-]+)/g)) {
      const variable = match[1];
      if (variable !== undefined && !variable.startsWith(INTERNAL_VAR_PREFIX)) {
        return { kind: 'themeVar', variable };
      }
    }
  }
  return {
    kind: 'literal',
    value: normalize(declarations.map((declaration) => declaration.value).join(' ')),
  };
}

/**
 * 越境衝突を列挙する。
 *
 * 違反は「基準線でテーマ変数 A・現行でテーマ変数 B・A ≠ B」のときに限る。
 * - 片方が absent（トークン追加で新たに生えたユーティリティ）は違反ではない
 * - 片方が literal（同一ユーティリティの値上書き）は越境ではないため違反ではない
 * - 同名上書き（変数名が変わらない）は意図した運用であり違反ではない
 *
 * この規則により**許可リストを持たずに**誤検出ゼロを達成する（research.md Research Log 2 で実測）。
 * 許可リストは「意図した例外」の名目で実害を隠す構造を生むため持たない。
 */
export function findShadowing(
  baselineCss: string,
  currentCss: string,
  probes: readonly string[],
): readonly ShadowingViolation[] {
  const violations: ShadowingViolation[] = [];
  for (const utility of probes) {
    const baseline = resolveUtility(baselineCss, utility);
    const current = resolveUtility(currentCss, utility);
    if (baseline.kind !== 'themeVar' || current.kind !== 'themeVar') continue;
    if (baseline.variable === current.variable) continue;
    violations.push({
      utility,
      baselineVariable: baseline.variable,
      currentVariable: current.variable,
    });
  }
  return violations;
}

/** 生成 CSS が宣言するカスタムプロパティの値を返す（未宣言なら null）。 */
function customPropertyValue(css: string, property: string): string | null {
  let found: string | null = null;
  postcss.parse(css).walkDecls((declaration) => {
    if (declaration.prop === property) found = normalize(declaration.value);
  });
  return found;
}

/**
 * 生成 CSS が出力している `--radius-*` のキーを列挙する（照合の網羅方向: 生成側）。
 * `--radius`（shadcn 規約の別変数）は接尾辞を持たないため対象外。
 */
export function collectRadiusVariables(css: string): readonly string[] {
  const keys = new Set<string>();
  postcss.parse(css).walkDecls((declaration) => {
    const match = /^--radius-([a-z0-9]+)$/.exec(declaration.prop);
    if (match?.[1] !== undefined) keys.add(match[1]);
  });
  return [...keys].sort();
}

/**
 * 角丸トークンと生成 CSS の `--radius-{key}` を役割ごとに突き合わせる。
 *
 * **解決できなかった段は違反として扱う**（`resolvedValue: null`）。Tailwind は参照されない
 * テーマ変数を出力しないため、照合はプローブで出力を強制した CSS に対して行うこと。
 * 欠測を「検証対象外」として握り潰すとガードが空洞になる。
 */
export function findRadiusMismatches(
  css: string,
  tokens: Readonly<Record<string, string>>,
): readonly ScaleMismatch[] {
  const mismatches: ScaleMismatch[] = [];
  for (const [key, tokenValue] of Object.entries(tokens)) {
    const resolvedValue = customPropertyValue(css, `--radius-${key}`);
    if (resolvedValue === null || resolvedValue !== normalize(tokenValue)) {
      mismatches.push({ scale: 'radius', key, tokenValue, resolvedValue });
    }
  }
  return mismatches;
}

/** 角丸スケールで同値へ解決された段を列挙する（解決できない段は比較対象外）。 */
export function findDuplicateRadiusSteps(
  css: string,
  keys: readonly string[],
): readonly DuplicateRadiusStep[] {
  const byValue = new Map<string, string[]>();
  for (const key of keys) {
    const value = customPropertyValue(css, `--radius-${key}`);
    if (value === null) continue;
    const bucket = byValue.get(value);
    if (bucket === undefined) byValue.set(value, [key]);
    else bucket.push(key);
  }
  const duplicates: DuplicateRadiusStep[] = [];
  for (const [value, group] of byValue) {
    if (group.length > 1) duplicates.push({ keys: group, value });
  }
  return duplicates;
}

/** `0.25rem` のような長さ値を数値と単位へ分解する（解釈できない場合は null）。 */
function parseLength(value: string): { readonly amount: number; readonly unit: string } | null {
  const match = /^(-?\d*\.?\d+)([a-z%]*)$/.exec(normalize(value));
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const amount = Number(match[1]);
  return Number.isFinite(amount) ? { amount, unit: match[2] } : null;
}

/** 浮動小数の丸め誤差を吸収して長さ値を整形する。 */
function formatLength(amount: number, unit: string): string {
  return `${Number(amount.toFixed(6))}${unit}`;
}

/**
 * 余白トークンと数値スケールの実寸を役割ごとに突き合わせる。
 *
 * 生成 CSS の余白基数（`--spacing`）に対応表の倍率を掛けた値がトークン値と一致することを見る。
 * 基数の倍数で表現できない値へトークンが変更された場合は `resolvedValue` が一致しないため
 * 違反になる（Requirements 5.5）。
 */
export function findSpacingMismatches(
  css: string,
  tokens: Readonly<Record<string, string>>,
  steps: Readonly<Record<string, number>>,
): readonly ScaleMismatch[] {
  const base = customPropertyValue(css, '--spacing');
  const parsedBase = base === null ? null : parseLength(base);
  const mismatches: ScaleMismatch[] = [];

  for (const [key, tokenValue] of Object.entries(tokens)) {
    const step = steps[key];
    if (parsedBase === null || step === undefined) {
      // 基数が読めない、または対応表にキーが無い＝照合が成立しない。握り潰さず違反とする。
      mismatches.push({ scale: 'spacing', key, tokenValue, resolvedValue: null });
      continue;
    }
    const resolvedValue = formatLength(parsedBase.amount * step, parsedBase.unit);
    if (resolvedValue !== normalize(tokenValue)) {
      mismatches.push({ scale: 'spacing', key, tokenValue, resolvedValue });
    }
  }
  return mismatches;
}

/**
 * 部品ソースが使用している角丸の段を列挙する（照合の網羅方向: 使用側）。
 *
 * 実在する書き方に耐える必要がある:
 * - 方向付き（`rounded-t-xl`）
 * - variant 前置（`in-data-[slot=button-group]:rounded-lg`）
 * - 任意値（`rounded-[min(var(--radius-md),10px)]`）— 名前付きの段ではないので段としては拾わないが、
 *   参照している `--radius-md` は段として拾う（プローブ集合がその段を要求するため）
 */
export function collectUsedRadiusUtilities(componentSources: readonly string[]): readonly string[] {
  const keys = new Set<string>();
  const named = /rounded-(?:(?:tl|tr|bl|br|ss|se|ee|es|t|b|l|r|s|e)-)?([a-z0-9]+)(?![a-z0-9-])/g;
  const referenced = /var\(\s*--radius-([a-z0-9]+)\s*\)/g;

  for (const source of componentSources) {
    for (const match of source.matchAll(named)) {
      if (match[1] !== undefined) keys.add(match[1]);
    }
    for (const match of source.matchAll(referenced)) {
      if (match[1] !== undefined) keys.add(match[1]);
    }
  }
  return [...keys].sort();
}

/**
 * theme.css の `@theme` 直下が宣言するカスタムプロパティ名を構文木から取り出す。
 *
 * **祖先の at-rule を辿って所属を判定する。** 行番号や位置で判定すると `@layer base` の宣言や
 * `:root` の意味論変数まで拾って静かに壊れる（[[ui-design-foundation-facts]] の同型の失敗）。
 * `@theme` と `@theme inline` の双方を対象にする。
 */
export function declaredThemeKeys(themeCss: string): readonly string[] {
  const keys = new Set<string>();
  postcss.parse(themeCss).walkAtRules('theme', (atRule) => {
    atRule.each((node) => {
      if (node.type === 'decl' && node.prop.startsWith('--')) keys.add(node.prop);
    });
  });
  return [...keys].sort();
}

/** カスタムプロパティ名から名前空間（`--radius-lg` → `--radius`）を取り出す。 */
export function namespaceOf(property: string): string {
  const match = /^(--[a-z]+)(?:-|$)/.exec(property);
  return match?.[1] ?? property;
}
