// トークンスケールの恒久検証（ui-token-collision）。
//
// design.md「test/token-scales.test.ts」/ Requirements 1.1–1.3, 2.1, 2.2, 3.2, 3.3, 5.1–5.9。
//
// 構成:
//   1. 解析の純関数の単体検証（タスク 1.2）— 誤検出しないことの証拠を含む
//   2. 基準線コンパイルの自己確認（タスク 1.1）
// タスク 2.1〜2.4 で越境衝突・角丸の段差・トークン対応・注入対照へ拡張される。
import { describe, it, expect, beforeAll } from 'vitest';
import { APPS, compileStockBaseline } from './support/compile-app-css';
import {
  collectRadiusVariables,
  collectUsedRadiusUtilities,
  declaredThemeKeys,
  findDuplicateRadiusSteps,
  findRadiusMismatches,
  findShadowing,
  findSpacingMismatches,
  namespaceOf,
  resolveUtility,
} from './support/token-scales';

// --- 1. 解析の純関数の単体検証（Requirements 5.1, 5.3, 5.4, 5.5, 5.6, 5.7） ---

describe('resolveUtility は解決先の種別を判別する', () => {
  it('テーマ変数を読む場合は themeVar を返す', () => {
    const css = '.max-w-md { max-width: var(--container-md); }';
    expect(resolveUtility(css, 'max-w-md')).toEqual({
      kind: 'themeVar',
      variable: '--container-md',
    });
  });

  it('calc の内側のテーマ変数も読み取る', () => {
    const css = '.p-4 { padding: calc(var(--spacing) * 4); }';
    expect(resolveUtility(css, 'p-4')).toEqual({ kind: 'themeVar', variable: '--spacing' });
  });

  it('テーマ変数を読まない場合は literal を返す', () => {
    const css = '.rounded-full { border-radius: calc(infinity * 1px); }';
    expect(resolveUtility(css, 'rounded-full')).toEqual({
      kind: 'literal',
      value: 'calc(infinity * 1px)',
    });
  });

  it('Tailwind 内部変数（--tw-*）はテーマ変数として扱わない', () => {
    // 内部変数は「どのテーマスケールを読むか」を表さない。これを themeVar として扱うと
    // 影や境界のユーティリティが越境衝突の判定に紛れ込む。
    const css = '.shadow-md { box-shadow: var(--tw-shadow-color); }';
    expect(resolveUtility(css, 'shadow-md')).toEqual({
      kind: 'literal',
      value: 'var(--tw-shadow-color)',
    });
  });

  it('規則が存在しない場合は absent を返す', () => {
    expect(resolveUtility('.p-4 { padding: 1rem; }', 'p-md')).toEqual({ kind: 'absent' });
  });
});

describe('findShadowing は越境衝突だけを報告する（誤検出しないことの証拠）', () => {
  it('双方がテーマ変数で名前が異なるとき違反として報告する', () => {
    const baseline = '.max-w-md { max-width: var(--container-md); }';
    const current = '.max-w-md { max-width: var(--spacing-md); }';
    expect(findShadowing(baseline, current, ['max-w-md'])).toEqual([
      {
        utility: 'max-w-md',
        baselineVariable: '--container-md',
        currentVariable: '--spacing-md',
      },
    ]);
  });

  it('同名上書きは違反にしない（意図した運用）', () => {
    // theme.css が --text-xs を上書きしても、text-xs が読む変数名は変わらない。
    const baseline = '.text-xs { font-size: var(--text-xs); }';
    const current = '.text-xs { font-size: var(--text-xs); }';
    expect(findShadowing(baseline, current, ['text-xs'])).toEqual([]);
  });

  it('基準線に存在しないユーティリティは違反にしない（トークン追加で生えたもの）', () => {
    // p-md や bg-primary は素の Tailwind には存在しない。新規ユーティリティであって越境ではない。
    const baseline = '.p-4 { padding: calc(var(--spacing) * 4); }';
    const current = '.p-md { padding: var(--spacing-md); }';
    expect(findShadowing(baseline, current, ['p-md'])).toEqual([]);
  });

  it('基準線がリテラルの場合は違反にしない（同一ユーティリティの値上書き）', () => {
    // rounded-full は素の Tailwind ではテーマ変数を読まない。--radius-full の宣言により
    // 変数を読むようになるが、これは越境ではない。
    const baseline = '.rounded-full { border-radius: calc(infinity * 1px); }';
    const current = '.rounded-full { border-radius: var(--radius-full); }';
    expect(findShadowing(baseline, current, ['rounded-full'])).toEqual([]);
  });

  it('現行に存在しないユーティリティは違反にしない', () => {
    const baseline = '.max-w-md { max-width: var(--container-md); }';
    expect(findShadowing(baseline, '', ['max-w-md'])).toEqual([]);
  });
});

describe('findRadiusMismatches は役割ごとに突き合わせる', () => {
  const css = ':root { --radius-sm: 0.25rem; --radius-lg: 0.5rem; }';

  it('値が一致していれば違反を返さない', () => {
    expect(findRadiusMismatches(css, { sm: '0.25rem', lg: '0.5rem' })).toEqual([]);
  });

  it('値が食い違う段を報告する', () => {
    expect(findRadiusMismatches(css, { lg: '0.75rem' })).toEqual([
      { scale: 'radius', key: 'lg', tokenValue: '0.75rem', resolvedValue: '0.5rem' },
    ]);
  });

  it('生成 CSS に出力されていない段は違反として扱う（欠測を握り潰さない）', () => {
    // Tailwind は参照されないテーマ変数を出力しない。これを「対象外」にするとガードが空洞になる。
    expect(findRadiusMismatches(css, { xl: '0.75rem' })).toEqual([
      { scale: 'radius', key: 'xl', tokenValue: '0.75rem', resolvedValue: null },
    ]);
  });

  it('値の集合が重なっているだけでは緑にならない（役割の取り違えを検出する）', () => {
    // sm と lg の値を入れ替えると、値の集合は同一のまま役割だけが壊れる。
    const swapped = findRadiusMismatches(css, { sm: '0.5rem', lg: '0.25rem' });
    expect(swapped.map((mismatch) => mismatch.key).sort()).toEqual(['lg', 'sm']);
  });
});

describe('findDuplicateRadiusSteps は同値の段を束ねる', () => {
  it('同値の 2 段を報告する', () => {
    const css = ':root { --radius-lg: 0.75rem; --radius-xl: 0.75rem; }';
    expect(findDuplicateRadiusSteps(css, ['lg', 'xl'])).toEqual([
      { keys: ['lg', 'xl'], value: '0.75rem' },
    ]);
  });

  it('3 段以上が同値でも 1 件にまとめる', () => {
    const css = ':root { --radius-sm: 1px; --radius-md: 1px; --radius-lg: 1px; }';
    expect(findDuplicateRadiusSteps(css, ['sm', 'md', 'lg'])).toEqual([
      { keys: ['sm', 'md', 'lg'], value: '1px' },
    ]);
  });

  it('すべて異なれば違反を返さない', () => {
    const css = ':root { --radius-sm: 0.25rem; --radius-md: 0.375rem; --radius-lg: 0.5rem; }';
    expect(findDuplicateRadiusSteps(css, ['sm', 'md', 'lg'])).toEqual([]);
  });
});

describe('findSpacingMismatches は数値スケールの実寸と突き合わせる', () => {
  const css = ':root { --spacing: 0.25rem; }';
  const steps = { xs: 1, sm: 2, md: 4, lg: 6, xl: 8 } as const;

  it('基数の倍数と一致していれば違反を返さない', () => {
    const tokens = { xs: '0.25rem', sm: '0.5rem', md: '1rem', lg: '1.5rem', xl: '2rem' };
    expect(findSpacingMismatches(css, tokens, steps)).toEqual([]);
  });

  it('基数の倍数で表現できない値を違反として報告する（Requirements 5.5）', () => {
    expect(findSpacingMismatches(css, { md: '0.3rem' }, steps)).toEqual([
      { scale: 'spacing', key: 'md', tokenValue: '0.3rem', resolvedValue: '1rem' },
    ]);
  });

  it('対応表に無いキーは違反として報告する（網羅漏れの検出）', () => {
    expect(findSpacingMismatches(css, { xxl: '4rem' }, steps)).toEqual([
      { scale: 'spacing', key: 'xxl', tokenValue: '4rem', resolvedValue: null },
    ]);
  });

  it('基数が読めない場合は違反として報告する', () => {
    expect(findSpacingMismatches('', { md: '1rem' }, steps)).toEqual([
      { scale: 'spacing', key: 'md', tokenValue: '1rem', resolvedValue: null },
    ]);
  });
});

describe('collectRadiusVariables は生成 CSS が出力した段を列挙する', () => {
  it('接尾辞を持つ --radius-* のみを拾う', () => {
    const css = ':root { --radius: var(--radius-md); --radius-md: 0.375rem; --radius-xl: 0.75rem; }';
    expect(collectRadiusVariables(css)).toEqual(['md', 'xl']);
  });
});

describe('collectUsedRadiusUtilities は部品ソースの実態に耐える', () => {
  it('素の指定・方向付き・variant 前置・任意値の変数参照をすべて拾う', () => {
    const sources = [
      'className="rounded-lg border"',
      '"*:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl"',
      '"in-data-[slot=button-group]:rounded-lg"',
      '"rounded-[min(var(--radius-md),10px)]"',
      '"rounded-full bg-primary"',
    ];
    expect(collectUsedRadiusUtilities(sources)).toEqual(['full', 'lg', 'md', 'xl']);
  });

  it('任意値そのものを段として拾わない', () => {
    expect(collectUsedRadiusUtilities(['"rounded-[3px]"'])).toEqual([]);
  });
});

describe('declaredThemeKeys は @theme 直下だけを拾う', () => {
  const themeCss = [
    '@theme {',
    '  --color-primary: #15803D;',
    '  --radius-full: 9999px;',
    '}',
    '@theme inline {',
    '  --color-card: var(--card);',
    '}',
    ':root {',
    '  --radius: var(--radius-md);',
    '}',
    '@layer base {',
    '  h1 { font-size: var(--text-2xl); }',
    '  :focus-visible { outline: 2px solid var(--ring); }',
    '}',
  ].join('\n');

  it('@theme と @theme inline の宣言を拾う', () => {
    expect(declaredThemeKeys(themeCss)).toEqual(['--color-card', '--color-primary', '--radius-full']);
  });

  it(':root や @layer base の宣言は拾わない（位置ではなく所属で判定している証拠）', () => {
    expect(declaredThemeKeys(themeCss)).not.toContain('--radius');
  });
});

describe('namespaceOf はカスタムプロパティの名前空間を返す', () => {
  it.each([
    ['--radius-lg', '--radius'],
    ['--color-primary-hover', '--color'],
    ['--text-2xl', '--text'],
    ['--spacing', '--spacing'],
  ])('%s → %s', (property, expected) => {
    expect(namespaceOf(property)).toBe(expected);
  });
});

// --- 2. 基準線コンパイルの自己確認（Requirements 1.3, 5.7） ---

/**
 * 基準線の自己確認に用いる最小のプローブ。
 * Tailwind は参照されないテーマ変数を出力しないため、既定値の存在を確かめるには
 * その値を読むユーティリティを 1 つ以上生成させる必要がある。
 */
const BASELINE_SELF_CHECK_PROBES = ['max-w-md'] as const;

describe.each(APPS)(
  '$packageName の基準線コンパイルは素の Tailwind である（Requirements 1.3, 5.7）',
  (app) => {
    let baseline: string;

    beforeAll(async () => {
      baseline = await compileStockBaseline(app, BASELINE_SELF_CHECK_PROBES);
    });

    it('既定のコンテナ寸法スケールを出力する', () => {
      // 基準線が実際に Tailwind を読み込めていることの確認。空文字やエラー握り潰しで
      // 「差分ゼロ＝違反なし」という空振りの緑が出ることを防ぐ。
      expect(
        baseline,
        '基準線に既定のコンテナ寸法が現れません。素の Tailwind がコンパイルできていない可能性があります',
      ).toContain('--container-md: 28rem');
    });

    it('プロジェクト独自のトークンを含まない', () => {
      // theme.css を読み込んでいないことの確認。読み込んでしまうと基準線が現行と同一になり、
      // 越境衝突の差分が永久に 0 件になる（検出できないのに緑）。
      //
      // 照合先に `--color-primary` を選ぶ理由: Tailwind は **参照されないテーマ変数を出力しない**。
      // `--color-brand` は theme.css が宣言しているが `bg-brand` を使う部品が無いため現行の生成 CSS
      // にも現れず、これを照合先にすると「theme.css を読み込んでいても緑」という空振りになる
      // （実装時に実測で確認）。`--color-primary` は Button の `bg-primary` により現行では必ず
      // 出力されるため、差が出る照合先として成立する。
      expect(
        baseline,
        '基準線にプロジェクト独自の色トークンが現れました。theme.css を読み込んでいます',
      ).not.toContain('--color-primary');
    });

    it('プローブで指定したユーティリティを実際に出力する', () => {
      // `@source inline(...)` が効いていることの確認。効いていなければ以降の解決先検査は
      // 「対象が存在しない」ことを「違反なし」と取り違える。
      expect(
        baseline,
        'プローブで指定したユーティリティが生成されていません。@source inline が効いていません',
      ).toMatch(/\.max-w-md\s*\{/);
    });
  },
);
