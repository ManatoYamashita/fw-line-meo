// theme.css ↔ @fwlm/design-tokens の同値検証（theme-sync）。
// design.md「@fwlm/ui — theme.css」Responsibilities & Constraints /
// Testing Strategy Unit 2「theme-sync.test.ts」/ Requirements 1.1, 1.2, 5.3。
//
// 設計方針: theme.css と design-tokens の同期は codegen を作らず「手動同期 ＋ 機械検証」で固める。
// 本テストは theme.css に現れる全 hex 値が @fwlm/design-tokens の値集合に含まれること
// （theme.css の hex ⊆ design-tokens の hex）を assert する。design-tokens に定義の無い色を
// theme.css へ足すと即座に赤になる（RED を保証）。
//
// 注: 影トークンは rgba を避け 8 桁アルファ hex（#0000000D 等）で表現されるため、hex 抽出の
// 正規表現は 3〜8 桁を対象にする。
//
// 注意（集合包含だけでは不十分な理由）: hex の集合包含は「役割の取り違え」も「同期漏れ」も
// 検出できない。例えば `--color-text` へ `--color-text-muted` の値を誤って割り当てても、
// design-tokens 側で `colors.text` を変えて theme.css を同期し忘れても、同じ hex が別の役割の
// 値として集合に残っている限り緑のままになる。よって下段の「役割対応表による厳密一致」検証を
// 併せて持つ（集合包含は shadow のアルファ hex 等、対応表の対象外を拾う網として残す）。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { colors, lineColors, shadow, type ColorTokens } from '@fwlm/design-tokens';

/** 3〜8 桁の hex カラーリテラル（影の 8 桁アルファ hex を含む）を大文字化して抽出する。 */
const HEX_PATTERN = /#[0-9a-fA-F]{3,8}/g;

function extractHexes(source: string): readonly string[] {
  return (source.match(HEX_PATTERN) ?? []).map((hex) => hex.toUpperCase());
}

/** design-tokens 側の全 hex 値集合（colors / lineColors / shadow の値から抽出）。 */
function buildTokenHexSet(): ReadonlySet<string> {
  const tokenValues: readonly string[] = [
    ...Object.values(colors),
    ...Object.values(lineColors),
    ...Object.values(shadow),
  ];
  const set = new Set<string>();
  for (const value of tokenValues) {
    for (const hex of extractHexes(value)) {
      set.add(hex);
    }
  }
  return set;
}

const themeCssPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'theme.css');
const themeCss = readFileSync(themeCssPath, 'utf8');
const themeHexes = extractHexes(themeCss);
const tokenHexSet = buildTokenHexSet();

describe('theme-sync: theme.css の全 hex ⊆ design-tokens 値集合（Requirements 1.1, 1.2）', () => {
  it('design-tokens 値集合が hex を含む（照合基盤の自己検証）', () => {
    expect(tokenHexSet.size).toBeGreaterThan(0);
  });

  it('theme.css は hex カラーを 1 つ以上含む（空ファイルでの空振り緑を防ぐ）', () => {
    expect(themeHexes.length).toBeGreaterThan(0);
  });

  it('theme.css の全 hex が design-tokens の値集合に含まれる', () => {
    const undefinedHexes = [...new Set(themeHexes)].filter((hex) => !tokenHexSet.has(hex));
    expect(
      undefinedHexes,
      `design-tokens に定義の無い色が theme.css に混入しています: ${undefinedHexes.join(', ')}`,
    ).toEqual([]);
  });
});

/**
 * CSS のブロックコメントを空白へ潰す（改行は残す）。
 *
 * 抽出器はブロックの開始を文字列一致で探すため、**コメントに書かれた CSS 断片**を
 * 本体と取り違える。theme.css は `h1,h2,h3,h4,h5,h6 { font-size: inherit }` のような
 * 波括弧付きの断片をコメントで引用する書き方を既に持っており、誘発は現実的である。
 *
 * 取り違えの怖さは向きで決まる。`extractThemeBlock` の利用側は「在ること」と厳密一致を
 * 要求するので誤抽出は赤くなるが、`extractThemeInlineBlock` の利用側は「無いこと」を
 * 要求するため、空ブロックを掴むと **「正しく不在」と読まれて静かに緑になる**。
 * 実測: `--color-success` を `@theme` と `@theme inline` の両方へ宣言すると 1 件赤くなるが、
 * `@theme inline { }` を含むコメントを 1 行足すと同じ二重定義のまま 384 件すべて緑になった。
 *
 * 改行を残すのは、失敗時に出るブロック本文の行構造を元 CSS と揃えるためである。
 */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

/**
 * `@theme { … }`（`@theme inline` ではない方）のブロック本文を取り出す。
 * ブロック内に入れ子の波括弧は無いが、将来の変化に耐えるよう深さを数えて対応括弧を探す。
 */
function extractThemeBlock(source: string): string {
  const css = stripCssComments(source);
  // `@theme inline {` に一致しないよう、`@theme` の直後は空白＋`{` のみを許す。
  const header = /@theme[ \t]*\{/.exec(css);
  if (header === null) {
    throw new Error('theme.css に @theme ブロックが見つかりません');
  }
  const start = css.indexOf('{', header.index);
  let depth = 0;
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start + 1, i);
    }
  }
  throw new Error('theme.css の @theme ブロックが閉じられていません');
}

/**
 * `@theme inline { … }` のブロック本文を取り出す。
 *
 * `@theme` と `@theme inline` は役割が異なる。前者は実値の宣言、後者は既存の意味論変数を
 * Tailwind の色名前空間へ**公開するだけ**の層である。同じ名前を両方に置くと循環参照になるため、
 * 「どちらに居るか」を区別できる抽出器が要る（`extractThemeBlock` は inline を意図的に除外する）。
 *
 * 利用側が「無いこと」を要求する唯一の抽出器なので、誤抽出は赤ではなく緑へ倒れる。
 * コメント除去（`stripCssComments`）はその向きを守るための前提であり、外すと空振りする。
 */
function extractThemeInlineBlock(source: string): string {
  const css = stripCssComments(source);
  const header = /@theme[ \t]+inline[ \t]*\{/.exec(css);
  if (header === null) {
    throw new Error('theme.css に @theme inline ブロックが見つかりません');
  }
  const start = css.indexOf('{', header.index);
  let depth = 0;
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start + 1, i);
    }
  }
  throw new Error('theme.css の @theme inline ブロックが閉じられていません');
}

/** ブロック本文から `--name: <値>;` の値部分を取り出す（最初の宣言のみ）。 */
function declarationIn(block: string, cssVariable: string): string | undefined {
  // 変数名の直後に `:` を要求するため、`--color-text` が `--color-text-muted` に誤一致しない。
  const pattern = new RegExp(`(?:^|[;{\\s])${cssVariable}\\s*:\\s*([^;]+);`);
  return pattern.exec(block)?.[1]?.trim();
}

/**
 * 抽出器の自己検証（Issue #60）。
 *
 * 「空振り防止」（`themeHexes.length > 0` のような非空 assert）は **対象ゼロで緑にならないこと**しか
 * 保証せず、**拾ったものが正しいか**は一切見ない。位置依存の取りこぼしと、宣言でないものの誤検出は
 * 素通りする。PR #59 では実際に、抑制ブロックの**先頭**に置いた宣言だけが判定から漏れていた
 * （非空 assert は 3 件返るので緑のままだった）。
 *
 * 固定する性質は 2 方向ある。片方だけでは足りない。
 *   - 拾ってはならないものを拾わない（誤検出）
 *   - 拾うべきものを漏らさない（取りこぼし。とくに**先頭・末尾・入れ子**の位置）
 */
describe('抽出器の自己検証（Issue #60）', () => {
  describe('extractHexes', () => {
    it('3 桁・6 桁・8 桁を拾い、先頭と末尾の位置でも漏らさない', () => {
      // 先頭と末尾に置くのが要点。`match` の逐次走査が位置に依存しないことを固定する。
      expect(extractHexes('#abc mid #112233 tail #aabbcc80')).toEqual([
        '#ABC',
        '#112233',
        '#AABBCC80',
      ]);
    });

    it('大文字へ揃える（照合は大文字同士で行うため）', () => {
      expect(extractHexes('#aAbBcC')).toEqual(['#AABBCC']);
    });

    it('hex に見えない語は拾わない', () => {
      // `#` に続く 3 文字以上が hex でなければ色ではない（`url(#gradient)` の類）。
      expect(extractHexes('url(#gradient) and #zz calc(100% - 2px)')).toEqual([]);
    });
  });

  describe('extractThemeBlock', () => {
    it('@theme inline を拾わず、@theme の本文だけを返す', () => {
      // **`@theme inline` が先に現れる並び**にするのが要点。先頭一致で拾う実装だと、
      // ここで inline 側の本文を返してしまう。
      const css = '@theme inline {\n  --a: 1;\n}\n@theme {\n  --b: 2;\n}\n';
      expect(extractThemeBlock(css)).toContain('--b: 2;');
      expect(extractThemeBlock(css)).not.toContain('--a: 1;');
    });

    it('入れ子の波括弧を跨いで対応する閉じ括弧まで取り出す', () => {
      const css = '@theme {\n  --a: 1;\n  @media (min-width: 1px) { --b: 2; }\n  --c: 3;\n}\ntail {}';
      const block = extractThemeBlock(css);
      expect(block).toContain('--b: 2;');
      expect(block).toContain('--c: 3;');
      expect(block).not.toContain('tail');
    });

    it('@theme が無ければ例外にする（静かに空文字を返さない）', () => {
      expect(() => extractThemeBlock(':root { --a: 1; }')).toThrow(/@theme ブロックが見つかりません/);
    });

    it('閉じられていなければ例外にする', () => {
      expect(() => extractThemeBlock('@theme {\n  --a: 1;\n')).toThrow(/閉じられていません/);
    });

    it('コメント内の @theme { … } を本体と取り違えない', () => {
      // コメントが**先に**現れる並びにするのが要点。先頭一致で拾う実装はここでコメント側を掴む。
      const css = '/* 旧構成は @theme { --a: 1; } だった */\n@theme {\n  --b: 2;\n}\n';
      expect(extractThemeBlock(css)).toContain('--b: 2;');
      expect(extractThemeBlock(css)).not.toContain('--a: 1;');
    });
  });

  describe('extractThemeInlineBlock', () => {
    // **この抽出器だけは利用側が「無いこと」を要求する。** したがって誤抽出は赤ではなく緑へ倒れ、
    // 「拾うべきものを拾えている」ことを別に固定しないと、検査そのものが静かに消える。
    it('@theme より後ろにあっても inline の本文だけを返す', () => {
      const css = '@theme {\n  --a: 1;\n}\n@theme inline {\n  --b: 2;\n}\n';
      expect(extractThemeInlineBlock(css)).toContain('--b: 2;');
      expect(extractThemeInlineBlock(css)).not.toContain('--a: 1;');
    });

    it('コメント内の @theme inline { } を本体と取り違えない（空ブロックを掴まない）', () => {
      // **本 finding が名指しした性質。** 空の波括弧を含むコメントを 1 行置くだけで、
      // 抽出結果が空になり `declarationIn(...) === undefined` が「正しく不在」と読まれていた。
      const css = '/* 旧構成では @theme inline { } の側で公開していた */\n@theme inline {\n  --b: 2;\n}\n';
      const block = extractThemeInlineBlock(css);
      expect(block, 'コメント側の空ブロックを掴んでいます').toContain('--b: 2;');
    });

    it('@theme inline が無ければ例外にする（静かに空文字を返さない）', () => {
      expect(() => extractThemeInlineBlock('@theme {\n  --a: 1;\n}\n')).toThrow(
        /@theme inline ブロックが見つかりません/,
      );
    });

    it('閉じられていなければ例外にする', () => {
      expect(() => extractThemeInlineBlock('@theme inline {\n  --a: 1;\n')).toThrow(
        /閉じられていません/,
      );
    });
  });

  describe('stripCssComments', () => {
    it('ブロックコメントの中身を宣言として残さない', () => {
      expect(stripCssComments('/* --a: 1; */\n--b: 2;')).not.toContain('--a: 1;');
      expect(stripCssComments('/* --a: 1; */\n--b: 2;')).toContain('--b: 2;');
    });

    it('コメント外の宣言を巻き込んで消さない（除去が広がりすぎていないことの対照）', () => {
      expect(stripCssComments('--a: 1; /* 注 */ --b: 2;')).toContain('--a: 1;');
      expect(stripCssComments('--a: 1; /* 注 */ --b: 2;')).toContain('--b: 2;');
    });

    it('改行を保つ（失敗時の行構造を元 CSS と揃える）', () => {
      expect(stripCssComments('/* 1\n2\n3 */').split('\n')).toHaveLength(3);
    });
  });

  describe('declarationIn', () => {
    it('接頭辞が一致する別変数へ誤一致しない（--color-text vs --color-text-muted）', () => {
      // **本 Issue が名指しした性質。** 実装コメントは「変数名の直後に `:` を要求するため誤一致しない」と
      // 主張していたが、その主張を固定する fixture が無かった。宣言の順序を入れ替えた 2 通りで見る。
      const muted_first = '  --color-text-muted: #111;\n  --color-text: #222;\n';
      const text_first = '  --color-text: #222;\n  --color-text-muted: #111;\n';
      expect(declarationIn(muted_first, '--color-text')).toBe('#222');
      expect(declarationIn(text_first, '--color-text')).toBe('#222');
      expect(declarationIn(muted_first, '--color-text-muted')).toBe('#111');
      expect(declarationIn(text_first, '--color-text-muted')).toBe('#111');
    });

    it('別変数の接尾辞として一致しない（--brand--color-a に対する --color-a）', () => {
      // 前方の `(?:^|[;{\\s])` が守っている性質。接頭辞の衝突（上）と対になる。
      // **`--brand-color-a` ではなく `--brand--color-a` にすること。** 前者はハイフンが 1 本なので
      // `--color-a` を部分文字列として含まず、前方境界を外す変異でも赤にならない
      // （最初にそう書いて変異で見逃し、fixture の側が的を外していることに気づいた）。
      expect(declarationIn('  --brand--color-a: #999;\\n', '--color-a')).toBeUndefined();
      expect(declarationIn('  --brand--color-a: #999;\\n  --color-a: #123;\\n', '--color-a')).toBe(
        '#123',
      );
    });

    it('ブロック先頭の宣言も拾う（位置依存で漏らさない）', () => {
      expect(declarationIn('--color-a: #123;', '--color-a')).toBe('#123');
    });

    it('値の前後の空白を落とす', () => {
      expect(declarationIn('  --color-a:   #123  ;\n', '--color-a')).toBe('#123');
    });

    it('無ければ undefined を返す（空文字と取り違えない）', () => {
      expect(declarationIn('  --color-b: #123;\n', '--color-a')).toBeUndefined();
    });
  });
});

/**
 * 意味役割 ↔ `@theme` の CSS 変数の対応表（Requirements 1.1, 1.3）。
 *
 * ここが本テストの中核。集合包含では「役割の取り違え」を検出できないため、
 * ColorTokens の全キーについて「どの CSS 変数と同値であるべきか」を明示的に固定し、
 * 宣言値と厳密一致（大文字化して比較）することを assert する。
 * 新しい色役割を design-tokens へ追加したら、必ずこの表にも追記させる
 * （下段の網羅ガードが未追記を検出する）。
 */
const COLOR_ROLE_TO_CSS_VARIABLE: Readonly<Record<keyof ColorTokens, string>> = {
  brand: '--color-brand',
  primary: '--color-primary',
  primaryHover: '--color-primary-hover',
  primaryForeground: '--color-primary-foreground',
  text: '--color-text',
  textBody: '--color-text-body',
  textMuted: '--color-text-muted',
  background: '--color-background',
  surfaceSoft: '--color-surface-soft',
  surfaceStrong: '--color-surface-strong',
  // 成功色。:root の --success はこの変数だけを参照し、アクション色を参照してはならない
  // （下の「success 意味論変数」の検証が向きを固定する）。
  success: '--color-success',
  destructive: '--color-destructive',
  destructiveForeground: '--color-destructive-foreground',
  border: '--color-border',
  // 識別用の枠色。装飾用（--color-border）とは別変数として宣言し、:root の意味論変数が
  // それぞれ別の役割を指せるようにする。この 2 つが同じ変数へ潰れると、識別用だけを濃くする
  // ことが構造的に不可能になる（design.md「意味論変数割当」State Management）。
  borderInteractive: '--color-border-interactive',
};

describe('theme-sync: 意味役割 ↔ @theme 変数の厳密一致（Requirements 1.1, 1.3）', () => {
  const themeBlock = extractThemeBlock(themeCss);

  it('ColorTokens の全キーが役割対応表に存在する（新規役割の取りこぼし防止）', () => {
    // 色役割を追加したら必ず theme.css への対応付けを宣言させるための網羅ガード
    // （design-tokens/test/colors.test.ts の分類ガードと同じ流儀）。
    expect(Object.keys(COLOR_ROLE_TO_CSS_VARIABLE).sort()).toEqual(Object.keys(colors).sort());
  });

  for (const [role, cssVariable] of Object.entries(COLOR_ROLE_TO_CSS_VARIABLE) as [
    keyof ColorTokens,
    string,
  ][]) {
    it(`${cssVariable} は colors.${role}（${colors[role]}）と同値`, () => {
      const declared = declarationIn(themeBlock, cssVariable);
      expect(
        declared,
        `${cssVariable} が theme.css の @theme ブロックに定義されていません`,
      ).toBeDefined();
      expect(
        declared?.toUpperCase(),
        `${cssVariable} の値が colors.${role} と一致しません` +
          `（theme.css: ${declared} / design-tokens: ${colors[role]}）`,
      ).toBe(colors[role].toUpperCase());
    });
  }

  it('@theme の全 --color-* 変数が役割対応表で説明されている（役割外の色の混入防止）', () => {
    // 対応表に無い `--color-*` を theme.css へ足すと、design-tokens に同じ hex が
    // 別役割で存在する限り集合包含テストは緑のまま通ってしまう。ここで塞ぐ。
    const declaredColorVariables = [...themeBlock.matchAll(/(--color-[a-z0-9-]+)\s*:/g)].map(
      (match) => match[1],
    );
    const mapped = new Set(Object.values(COLOR_ROLE_TO_CSS_VARIABLE));
    const unmapped = declaredColorVariables.filter((name) => !mapped.has(name ?? ''));
    expect(
      unmapped,
      `役割対応表に無い色変数が @theme に定義されています: ${unmapped.join(', ')}`,
    ).toEqual([]);
  });
});

// 成功通知（Alert の success 変種）用の意味論変数の契約（Requirements 2.1, 5.2）。
// 成功色は **アクション色から独立した実値**（--color-success・白背景で約 5.02:1）を持ち、
// --success はそれだけを参照する。アクション色を参照していると、アクション色を暖色系へ
// 差し替えた瞬間に成功通知が危険通知と同系色になるが、**色相の変化は輝度を変えないため
// コントラスト比を見るどのガードにも掛からず CI 全緑で通る**。
// ブランド色（#FF385C・対白 3.52:1）は AA に届かないため成功の文字色にも使えない。
describe('success 意味論変数の AA 準拠参照（Requirements 2.1, 5.2）', () => {
  /** `--name: <値>;` の値部分を取り出す（最初の宣言のみ）。 */
  function declarationValue(name: string): string | undefined {
    const match = new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(themeCss);
    return match?.[1]?.trim();
  }

  it('--success は専用の成功色だけを参照する（アクション色・ブランド色・危険色は参照しない）', () => {
    // かつて --success は --color-primary を参照していた。その状態でアクション色を暖色系へ
    // 差し替えると、成功通知が危険通知と同系色になる。**色相の変化は輝度を変えないため、
    // コントラスト比を見るどのガードにも掛からず CI 全緑で通る。**
    // 参照先そのものを固定してこの経路を塞ぐ（Requirements 2.1）。
    const value = declarationValue('success');
    expect(value, '--success が theme.css に定義されていません').toBeDefined();
    expect(value).toContain('var(--color-success)');
    for (const forbidden of ['var(--color-primary)', 'var(--color-brand)', 'var(--color-destructive)']) {
      expect(
        value,
        `--success が ${forbidden} を参照しています。参照元の色を差し替えると成功通知が巻き込まれます。`,
      ).not.toContain(forbidden);
    }
  });

  it('--color-success は @theme の実値として宣言される（@theme inline では公開しない）', () => {
    // 成功色は意味役割として独立した実値を持つため、他の色役割と同じく @theme 側に置く。
    // @theme と @theme inline の両方に同名を置くと循環参照になるため、inline からは外す。
    const themeBlockValue = declarationIn(extractThemeBlock(themeCss), '--color-success');
    expect(
      themeBlockValue,
      '--color-success が theme.css の @theme ブロックに定義されていません',
    ).toBeDefined();
    expect(themeBlockValue?.toUpperCase()).toBe(colors.success.toUpperCase());

    // 下の assert は「無いこと」を要求する向きなので、**抽出に失敗した状態と区別がつかない**。
    // 実在する宣言を 1 つ要求して、掴んでいるブロックが本物であることを先に固定する
    // （--color-ring は @theme inline の最後の宣言であり、末尾まで読めていることの証拠にもなる）。
    const inlineBlock = extractThemeInlineBlock(themeCss);
    expect(
      declarationIn(inlineBlock, '--color-ring'),
      '@theme inline から既知の宣言を取り出せません（抽出が空振りしており、下の検査は成立しません）',
    ).toBeDefined();
    expect(
      declarationIn(inlineBlock, '--color-success'),
      '--color-success が @theme inline にも宣言されています（@theme と二重定義になり循環参照になります）',
    ).toBeUndefined();
  });
});
