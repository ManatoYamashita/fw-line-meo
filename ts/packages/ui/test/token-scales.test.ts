// トークンスケールの恒久検証（ui-token-collision）。
//
// design.md「test/token-scales.test.ts」/ Requirements 1.1–1.3, 2.1, 2.2, 3.2, 3.3, 5.1–5.9。
//
// 構成:
//   1. 解析の純関数の単体検証（タスク 1.2）— 誤検出しないことの証拠を含む
//   2. 基準線コンパイルの自己確認（タスク 1.1）
// タスク 2.1〜2.4 で越境衝突・角丸の段差・トークン対応・注入対照へ拡張される。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { radius, spacing } from '@fwlm/design-tokens';
import {
  APPS,
  compileStockBaseline,
  compileWithAppToolchain,
  compileWithProbes,
  componentsDir,
  inlineSourceDeclaration,
  readGlobalsCss,
  uiSrcDir,
} from './support/compile-app-css';
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

// --- 2. 越境衝突ガード（Requirements 1.1, 1.2, 1.3, 2.1, 5.1, 5.2, 5.7, 5.8） ---

/** 名前付きスケールで寸法を指定するユーティリティ。既定のコンテナ寸法へ解決されなければならない。 */
const SIZE_PROBES = [
  'max-w-sm',
  'max-w-md',
  'max-w-lg',
  'max-w-xl',
  'min-w-md',
  'w-md',
  'basis-md',
] as const;

/** 数値スケールの余白。余白基数を読む。 */
const NUMERIC_SPACING_PROBES = ['p-4', 'gap-6'] as const;

/**
 * 名前付き余白ユーティリティ。**生成されてはならない**（Requirements 2.1）。
 * サイズ系と綴りが重ならないもの（`p-` / `gap-` / `m-`）だけを選ぶ。
 */
const NAMED_SPACING_PROBES = ['p-md', 'gap-lg', 'm-xs'] as const;

/** 角丸の全段。Tailwind は参照されない段を出力しないため、照合には出力の強制が要る。 */
const RADIUS_PROBES = [
  'rounded-sm',
  'rounded-md',
  'rounded-lg',
  'rounded-xl',
  'rounded-4xl',
  'rounded-full',
] as const;

/**
 * 同名上書きの対照。theme.css がこれらの名前空間を意図的に上書きしているが、
 * ユーティリティが読む**変数名は変わらない**ため越境衝突にはならない。
 * 誤検出が起きればここが真っ先に落ちる。
 */
const SAME_NAME_OVERRIDE_PROBES = ['text-xs', 'text-2xl', 'font-sans', 'shadow-md', 'bg-primary'] as const;

const PROBES: readonly string[] = [
  ...SIZE_PROBES,
  ...NUMERIC_SPACING_PROBES,
  ...NAMED_SPACING_PROBES,
  ...RADIUS_PROBES,
  ...SAME_NAME_OVERRIDE_PROBES,
];

/** 角丸の段のキー（プローブと対応）。 */
const RADIUS_KEYS: readonly string[] = RADIUS_PROBES.map((probe) =>
  probe.replace(/^rounded-/, ''),
);

/**
 * `@theme` が宣言しうる名前空間と、その解決先を見張るプローブの対応表（宣言側からの網羅）。
 *
 * 新しい名前空間を `@theme` へ足したとき、それを読むユーティリティがプローブ集合に無ければ
 * 越境衝突が起きても検出できない。本表に無い名前空間が現れたら失敗させ、追随を強制する。
 */
const PROBED_NAMESPACES: Readonly<Record<string, readonly string[]>> = {
  '--color': ['bg-primary'],
  '--font': ['font-sans'],
  '--radius': [...RADIUS_PROBES],
  '--shadow': ['shadow-md'],
  '--spacing': [...NUMERIC_SPACING_PROBES, ...NAMED_SPACING_PROBES, ...SIZE_PROBES],
  '--text': ['text-xs', 'text-2xl'],
};

/**
 * 余白トークンと Tailwind の数値スケールの対応表（正典）。
 * 余白基数 0.25rem に対し xs=×1 / sm=×2 / md=×4 / lg=×6 / xl=×8。
 */
const SPACING_STEPS: Readonly<Record<string, number>> = { xs: 1, sm: 2, md: 4, lg: 6, xl: 8 };

/** ベンダリングした部品のソース（角丸の使用側の網羅に用いる）。 */
function readComponentSources(): readonly string[] {
  return readdirSync(componentsDir)
    .filter((file) => file.endsWith('.tsx'))
    .map((file) => readFileSync(join(componentsDir, file), 'utf8'));
}

/**
 * 是正前の宣言を注入したうえでコンパイルする（注入対照・Requirements 5.9）。
 *
 * theme.css そのものは書き換えない。`@theme` は加算的に合成されるため、後置の宣言だけで
 * 是正前の状態を再現できる。ファイルを書き換える方式は他テストと競合し、失敗時に汚染が残る。
 */
async function compileWithInjectedTheme(
  app: (typeof APPS)[number],
  injectedDeclarations: string,
): Promise<string> {
  return compileWithAppToolchain(
    app,
    `${readGlobalsCss(app)}\n@theme {\n${injectedDeclarations}\n}\n${inlineSourceDeclaration(PROBES)}`,
  );
}

describe.each(APPS)('$packageName のトークンスケール', (app) => {
  let baseline: string;
  let current: string;

  beforeAll(async () => {
    [baseline, current] = await Promise.all([
      compileStockBaseline(app, PROBES),
      compileWithProbes(app, PROBES),
    ]);
  });

  describe('越境衝突（Requirements 1.1, 1.2, 5.1, 5.2）', () => {
    it('抽出が空振りしていない（自己検証・Requirements 5.8）', () => {
      // プローブが 1 つも解決できていない状態では、違反 0 件は「衝突が無い」ではなく
      // 「何も見ていない」を意味する。先にそれを排除する。
      const resolved = PROBES.filter((probe) => resolveUtility(current, probe).kind !== 'absent');
      expect(
        resolved.length,
        `現行の生成 CSS からプローブを 1 つも解決できません（対象 ${PROBES.length} 件）。` +
          'コンパイルまたは @source inline が機能していません',
      ).toBeGreaterThan(PROBES.length / 2);
    });

    it('あるスケールの宣言が別のスケールの解決先を覆っていない', () => {
      const violations = findShadowing(baseline, current, PROBES);
      const detail = violations
        .map(
          (violation) =>
            `  ${violation.utility}: 既定は ${violation.baselineVariable} を読むが ` +
            `${violation.currentVariable} に覆われている`,
        )
        .join('\n');
      expect(
        violations,
        `${app.packageName}: テーマ宣言が別スケールの解決先を覆っています。\n${detail}`,
      ).toEqual([]);
    });

    it('名前付き余白ユーティリティを提供しない（Requirements 2.1）', () => {
      const generated = NAMED_SPACING_PROBES.filter(
        (probe) => resolveUtility(current, probe).kind !== 'absent',
      );
      expect(
        generated,
        `${app.packageName}: 名前付き余白ユーティリティが生成されています（${generated.join(', ')}）。` +
          '余白は数値スケール（p-4 等）で指定してください',
      ).toEqual([]);
    });
  });

  describe('角丸の段差とトークン対応（Requirements 3.2, 3.3, 5.3, 5.4, 5.6）', () => {
    it('角丸の各段が相異なる値へ解決される', () => {
      const duplicates = findDuplicateRadiusSteps(current, RADIUS_KEYS);
      const detail = duplicates
        .map((duplicate) => `  ${duplicate.keys.join(' と ')} がいずれも ${duplicate.value}`)
        .join('\n');
      expect(
        duplicates,
        `${app.packageName}: 角丸スケールの段が重複しています。小さなコントロールと容器の` +
          `視覚階層が失われます。\n${detail}`,
      ).toEqual([]);
    });

    it('デザイントークンと生成 CSS が役割ごとに一致する', () => {
      // 値の集合が重なっていることでは代替しない。役割キーごとの厳密一致で見る。
      const mismatches = findRadiusMismatches(current, radius);
      const detail = mismatches
        .map(
          (mismatch) =>
            `  ${mismatch.key}: トークンは ${mismatch.tokenValue} だが生成 CSS は ` +
            `${mismatch.resolvedValue ?? '未出力'}`,
        )
        .join('\n');
      expect(
        mismatches,
        `${app.packageName}: 角丸トークンと生成 CSS が食い違っています。\n${detail}`,
      ).toEqual([]);
    });

    it('部品が使う段はすべてトークンに定義されている（網羅方向: 使用側）', () => {
      const used = collectUsedRadiusUtilities(readComponentSources());
      const defined = new Set(Object.keys(radius));
      const missing = used.filter((key) => !defined.has(key));
      expect(
        missing,
        `ベンダリング部品が使う角丸の段がトークンに存在しません（${missing.join(', ')}）。` +
          '部品ソースは書き換えられないため、トークン側に段を足してください',
      ).toEqual([]);
    });

    it('生成 CSS に出た段はすべてトークンに定義されている（網羅方向: 生成側）', () => {
      const emitted = collectRadiusVariables(current).filter((key) => RADIUS_KEYS.includes(key));
      const defined = new Set(Object.keys(radius));
      const missing = emitted.filter((key) => !defined.has(key));
      expect(
        missing,
        `${app.packageName}: 生成 CSS が出力した角丸の段がトークンに存在しません（${missing.join(', ')}）`,
      ).toEqual([]);
    });
  });

  describe('余白トークンと数値スケールの対応（Requirements 2.2, 2.3, 5.4, 5.5）', () => {
    it('数値スケールの実寸がトークン値と一致する', () => {
      const mismatches = findSpacingMismatches(current, spacing, SPACING_STEPS);
      const detail = mismatches
        .map(
          (mismatch) =>
            `  ${mismatch.key}: トークンは ${mismatch.tokenValue} だが数値スケールの実寸は ` +
            `${mismatch.resolvedValue ?? '算出不能'}`,
        )
        .join('\n');
      expect(
        mismatches,
        `${app.packageName}: 余白トークンと数値スケールが食い違っています。\n${detail}`,
      ).toEqual([]);
    });
  });

  describe('注入対照（Requirements 5.9）', () => {
    it('余白の名前付きキーを注入するとサイズ系の越境衝突を報告する', async () => {
      // 是正前の状態そのものを再現する。ここが緑を返したらガードは死んでいる。
      const poisoned = await compileWithInjectedTheme(app, '  --spacing-md: 1rem;');
      const violations = findShadowing(baseline, poisoned, PROBES);
      expect(
        violations.map((violation) => violation.utility),
        '是正前の宣言を注入しても越境衝突を検出できません。ガードが空振りしています',
      ).toContain('max-w-md');
    });

    it('角丸の段を容器の段と同値にすると重複を報告する', async () => {
      const poisoned = await compileWithInjectedTheme(app, '  --radius-lg: 0.75rem;');
      const duplicates = findDuplicateRadiusSteps(poisoned, RADIUS_KEYS);
      const duplicatedKeys = duplicates.flatMap((duplicate) => duplicate.keys);
      expect(
        duplicatedKeys,
        '段を同値にしても重複を検出できません。ガードが空振りしています',
      ).toEqual(expect.arrayContaining(['lg', 'xl']));
    });

    it('余白トークンを基数の倍数で表現できない値にすると乖離を報告する', () => {
      const mismatches = findSpacingMismatches(current, { md: '0.3rem' }, SPACING_STEPS);
      expect(
        mismatches.map((mismatch) => mismatch.key),
        '基数の倍数で表現できない値を検出できません。ガードが空振りしています',
      ).toEqual(['md']);
    });
  });
});

describe('余白トークンと対応表は両方向で一致する（Requirements 5.6）', () => {
  it('トークンのキー集合と対応表のキー集合が一致する', () => {
    expect(Object.keys(spacing).sort()).toEqual(Object.keys(SPACING_STEPS).sort());
  });
});

describe('プローブ集合は @theme が宣言する名前空間を網羅する（Requirements 5.6）', () => {
  const themeCss = readFileSync(join(uiSrcDir, 'theme.css'), 'utf8');

  it('抽出が空振りしていない（自己検証・Requirements 5.8）', () => {
    expect(
      declaredThemeKeys(themeCss).length,
      'theme.css の @theme から宣言キーを 1 つも抽出できません',
    ).toBeGreaterThan(0);
  });

  it('宣言されている名前空間はすべてプローブで見張られている', () => {
    const declared = [...new Set(declaredThemeKeys(themeCss).map(namespaceOf))].sort();
    const unwatched = declared.filter((namespace) => PROBED_NAMESPACES[namespace] === undefined);
    expect(
      unwatched,
      `@theme が宣言する名前空間にプローブがありません（${unwatched.join(', ')}）。` +
        'その名前空間の解決先を読むユーティリティをプローブ集合へ追加してください',
    ).toEqual([]);
  });

  it('対応表が挙げるプローブはすべてプローブ集合に含まれる（表と集合の同期）', () => {
    const listed = [...new Set(Object.values(PROBED_NAMESPACES).flat())];
    const orphans = listed.filter((probe) => !PROBES.includes(probe));
    expect(
      orphans,
      `名前空間の対応表がプローブ集合に無いクラスを挙げています（${orphans.join(', ')}）`,
    ).toEqual([]);
  });
});

// --- 3. 基準線コンパイルの自己確認（Requirements 1.3, 5.7） ---

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
