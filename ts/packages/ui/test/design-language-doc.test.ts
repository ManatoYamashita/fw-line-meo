// docs/design/design-language.md ↔ 実装 の両方向照合（Issue #175）。
//
// 写像版デザイン言語文書に書かれた値が、実装の値と一致していることを機械で固定する。
// Issue #175 の完了条件「記述された全数値が実装値と一致している」を、目視ではなく検証で満たす。
//
// なぜ shell ガード（scripts/check-*.sh）ではなく vitest なのか:
//   コントラスト比の照合には contrastRatio / compositeOver が要る。Tier A のシェルガードは
//   pnpm install より前に走るため dist/ が存在せず、node から再利用する道が構造的に無い。
//   残る道は awk での再実装だけだが、それは design-tokens の contrast.ts が
//   「2 パッケージで別実装を持つと、まさに本プロジェクトのガードが防ごうとしている
//   実装ドリフトを自分で作ることになる」として明文で禁じている経路である。
//
// なぜ @fwlm/design-tokens 側ではなく @fwlm/ui 側なのか:
//   見出し階層の照合に heading.tsx の DEFAULT_SIZE_BY_LEVEL が要り、部品一覧の照合に
//   src/components/ の走査が要る。design-tokens は「依存ゼロ」を不変条件とするため
//   どちらも持ち込めない。ui は devDependencies に design-tokens を持つので両方に届く。
//
// 抽出器の設計原則: **抽出に失敗したら例外にする。**
//   「表が見つからなければ空配列」を返す設計にすると、列名を 1 語変えただけで全 assert が
//   「対象 0 件」で緑になる。theme-sync.test.ts の extractThemeInlineBlock が
//   「無いこと」を要求する側で踏んだ穴と同型であり、こちらは全表が同時に消える分だけ悪い。
//
// 既知の穴（Issue #175 の範囲外・別 Issue へ送る）:
//   ui の test スクリプトは `vitest run --passWithNoTests` なので、本ファイル自体を
//   改名・移動すると検証が丸ごと消えても緑になる。ただしこれは本ファイルが新設する穴ではなく、
//   既存の 5 本すべてが同じ状態にある。塞ぐべきは「TS テストファイルの実在強制」という
//   横断課題であり、1 ファイルだけ特別扱いすると「守っているつもり」の非対称が生まれる。
//   なお文書側の消失は fail-closed である（module スコープの readFileSync が throw する）。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { describe, it, expect } from 'vitest';
import {
  colors,
  compositeOver,
  contrastRatio,
  radius,
  shadow,
  spacing,
  typography,
} from '@fwlm/design-tokens';

import { DEFAULT_SIZE_BY_LEVEL } from '../src/components/heading';
import { collectUsedRadiusUtilities } from './support/token-scales';

// --- パス導出 -----------------------------------------------------------------
//
// 深度を 1 つ間違えると readFileSync が ENOENT を投げるだけで、原因が「文書が無い」なのか
// 「パス計算がずれた」なのか区別できない。実在が確実で移動しない 2 点を別に固定する。
const testDir = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(testDir, '..');
/** ts/packages/ui → ts/packages → ts → リポジトリルート。 */
const repoRoot = resolve(uiRoot, '..', '..', '..');
const componentsDir = join(uiRoot, 'src', 'components');
const themeCssPath = join(uiRoot, 'src', 'theme.css');
const docPath = join(repoRoot, 'docs', 'design', 'design-language.md');

const AA_TEXT_RATIO = 4.5;
const AA_NON_TEXT_RATIO = 3;

// --- Markdown 抽出器 -----------------------------------------------------------

interface DocTable {
  /** 直前の見出し（失敗メッセージ用。照合キーではない）。 */
  readonly heading: string;
  /** ヘッダ行のセル。列構成が照合キーである。 */
  readonly headers: readonly string[];
  /** 本文行。 */
  readonly rows: readonly (readonly string[])[];
  /** ヘッダ行の 1 始まり行番号。 */
  readonly startLine: number;
  /** 表の最終行の 1 始まり行番号。 */
  readonly endLine: number;
}

const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*)$/;
const SEPARATOR_RE = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/;

interface MaskedMarkdown {
  /** フェンスの中身を空行へ潰した本文（行数は元文書と一致する）。 */
  readonly body: string;
  /** 取り出したフェンスの中身。 */
  readonly fences: readonly string[];
}

/**
 * コードフェンスの中身を空行へ潰す（行数は保つ）。
 *
 * 潰さないと、フェンスで引用した CSS 断片や Markdown の例が表・散文として解析される。
 * 行数を保つのは失敗メッセージの行番号を元文書と揃えるためである
 * （theme-sync.test.ts の stripCssComments が改行だけ残すのと同じ理由）。
 *
 * 開閉規則は check-markdown-emphasis.sh と揃える（同じ記号・開始以上の長さ・info string なし）。
 * 単純なトグルにすると ```` で開いたフェンスを内側の ``` が閉じ、以降が本文として解析される。
 */
function maskFences(markdown: string): MaskedMarkdown {
  const lines = markdown.split('\n');
  const body: string[] = [];
  const fences: string[] = [];
  let opener: string | null = null;
  let buffer: string[] = [];

  for (const line of lines) {
    const matched = FENCE_RE.exec(line);
    if (opener === null) {
      if (matched !== null) {
        opener = matched[1] ?? '';
        buffer = [];
        body.push('');
        continue;
      }
      body.push(line);
      continue;
    }
    const fence = matched?.[1] ?? '';
    const closes =
      matched !== null && fence[0] === opener[0] && fence.length >= opener.length && (matched[2] ?? '').trim() === '';
    if (closes) {
      fences.push(buffer.join('\n'));
      opener = null;
      body.push('');
      continue;
    }
    buffer.push(line);
    body.push('');
  }
  if (opener !== null) {
    throw new Error('design-language.md のコードフェンスが閉じていません（以降が解析対象から落ちます）');
  }
  return { body: body.join('\n'), fences };
}

/** `| a | b |` を ['a','b'] へ。両端の `|` だけを落とし、各セルを trim する。 */
function splitCells(line: string): readonly string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** フェンスを潰した本文から GFM の表をすべて取り出す。 */
function parseTables(body: string): readonly DocTable[] {
  const lines = body.split('\n');
  const tables: DocTable[] = [];
  let heading = '';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch !== null) {
      heading = (headingMatch[1] ?? '').trim();
      continue;
    }
    if (!line.trim().startsWith('|')) continue;
    const separator = lines[index + 1];
    if (separator === undefined || !SEPARATOR_RE.test(separator)) continue;

    const headers = splitCells(line);
    const rows: (readonly string[])[] = [];
    let cursor = index + 2;
    for (; cursor < lines.length; cursor += 1) {
      const row = lines[cursor] ?? '';
      if (!row.trim().startsWith('|')) break;
      rows.push(splitCells(row));
    }
    tables.push({ heading, headers, rows, startLine: index + 1, endLine: cursor });
    index = cursor - 1;
  }
  return tables;
}

/**
 * 列構成で表を一意に引く。0 件でも 2 件以上でも例外にする。
 *
 * 見出し文言ではなく列構成をキーにするのは、見出しの言い回しが変わっても照合が続くようにするため。
 * 0 件を例外にするのは、列名を 1 語変えた瞬間に全 assert が静かに緑へ落ちる経路を塞ぐため。
 */
function tableBySignature(tables: readonly DocTable[], signature: readonly string[]): DocTable {
  const key = signature.join(' | ');
  const matched = tables.filter((table) => table.headers.join(' | ') === key);
  if (matched.length === 0) {
    const available = tables
      .map((table) => `  ${table.startLine} 行目 [${table.heading}] ${table.headers.join(' | ')}`)
      .join('\n');
    throw new Error(
      `docs/design/design-language.md に列構成「${key}」の表がありません。` +
        `列名を変えると照合対象が丸ごと消えるため、ここで打ち切ります。\n` +
        `抽出できた表は ${tables.length} 件です:\n${available}`,
    );
  }
  if (matched.length > 1) {
    throw new Error(
      `docs/design/design-language.md に列構成「${key}」の表が ${matched.length} 件あります` +
        `（${matched.map((table) => `${table.startLine} 行目`).join(' / ')}）。照合対象を一意にできません。`,
    );
  }
  return matched[0] as DocTable;
}

/** 表の 1 セルを生のまま取り出す（範囲外は例外）。 */
function cell(table: DocTable, rowIndex: number, columnIndex: number): string {
  const value = table.rows[rowIndex]?.[columnIndex];
  if (value === undefined) {
    throw new Error(
      `${table.headers.join(' | ')} 表の ${rowIndex + 1} 行 ${columnIndex + 1} 列がありません` +
        `（列数が揃っていない可能性があります）`,
    );
  }
  return value;
}

/** バッククォート囲みのセルから中身を取り出す（囲みが無ければ例外）。 */
function codeCell(table: DocTable, rowIndex: number, columnIndex: number): string {
  const raw = cell(table, rowIndex, columnIndex);
  const matched = /^`([^`]+)`$/.exec(raw);
  if (matched === null) {
    throw new Error(
      `${table.startLine + 2 + rowIndex} 行目の ${columnIndex + 1} 列はバッククォート囲みで書いてください: ${raw}`,
    );
  }
  return matched[1] as string;
}

/** 部品ソースから値 export の名前を集める（`export type` は部品ではないので除く）。 */
function namedExportsOf(source: string): readonly string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/(?:^|\n)export\s+(type\s+)?\{([\s\S]*?)\}/g)) {
    if (match[1] !== undefined) continue;
    for (const raw of (match[2] ?? '').split(',')) {
      const name = raw.trim().replace(/^\w+\s+as\s+/, '');
      if (name.length > 0) names.add(name);
    }
  }
  for (const match of source.matchAll(/(?:^|\n)export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/g)) {
    names.add(match[1] as string);
  }
  return [...names].sort();
}

/** テストソースから describe / it / test のタイトル文字列を集める（散文コメントは拾わない）。 */
function testTitlesIn(source: string): readonly string[] {
  return [...source.matchAll(/\b(?:describe|it|test)\(\s*(['"`])([\s\S]*?)\1/g)].map((match) => match[2] as string);
}

/** theme.css の `@layer base` が h1〜h6 へ与える宣言を構文木から取り出す。 */
function baseHeadingRules(themeCss: string): ReadonlyMap<string, Readonly<Record<string, string>>> {
  const found = new Map<string, Record<string, string>>();
  postcss.parse(themeCss).walkAtRules('layer', (atRule) => {
    if (atRule.params.trim() !== 'base') return;
    atRule.walkRules((rule) => {
      if (!/^h[1-6]$/.test(rule.selector.trim())) return;
      const declarations: Record<string, string> = {};
      rule.walkDecls((decl) => {
        declarations[decl.prop] = decl.value.trim();
      });
      found.set(rule.selector.trim(), declarations);
    });
  });
  return found;
}

// --- 文書の読み込み -------------------------------------------------------------

const docSource = readFileSync(docPath, 'utf8');
const masked = maskFences(docSource);
const docTables = parseTables(masked.body);

/**
 * 表の行とコードフェンスを落とした「散文」。
 *
 * 表だけを照合すると散文に書いた数値が野放しになる。表と散文で値がずれた状態は、
 * 読み手にとっては表よりも散文のほうが目に入るぶん悪い。
 */
const prose = (() => {
  const lines = masked.body.split('\n');
  const isTableLine = new Set<number>();
  for (const table of docTables) {
    for (let line = table.startLine; line <= table.endLine + 1; line += 1) isTableLine.add(line);
  }
  return lines.filter((_line, index) => !isTableLine.has(index + 1)).join('\n');
})();

// --- 表の列構成（照合キー） -------------------------------------------------------

const COLOR_ROLE_SIGNATURE = ['役割', '値', '対白', '出典の色', '用途と制約'] as const;
const REJECTED_SIGNATURE = ['原典の色', '値', '測定条件', '実測', '閾値', '不採用の理由'] as const;
const SPACING_SIGNATURE = ['出典の段', '値', '倍率', 'クラス例', 'px'] as const;
const RADIUS_SIGNATURE = ['段', '値', 'クラス', '使用部品', '出典の段'] as const;
const SHADOW_SIGNATURE = ['段', '値', '用途'] as const;
const TYPOGRAPHY_SIGNATURE = ['段', '値', 'クラス', 'px'] as const;
const HEADING_SIGNATURE = ['タグ', 'サイズ段', '実寸', '太さ', '行間', 'Heading の既定'] as const;
const COMPOSITE_SIGNATURE = [
  '前景',
  '前景 α',
  '面',
  '面 α',
  '面の下',
  '面の実効色',
  '前景の実効色',
  '比',
  '判定',
  '出典',
] as const;
const COMPONENT_SIGNATURE = ['ファイル', 'export', '役割'] as const;
const POINTER_SIGNATURE = ['守る対象', 'ガード', 'アンカー'] as const;
const CONTRACT_SIGNATURE = ['契約', '出典（テストファイル）'] as const;

// --- 汎用の両方向照合 -------------------------------------------------------------

/**
 * 実装のキー集合と文書の第 1 列を両方向で突き合わせる。
 *
 * 片方向（文書 → 実装）だけだと役割の削除が素通りし、逆だけだと幽霊行が残る。
 * **件数の assert を先に置く**のは、抽出が壊れて 0 行になったときに「差分なし」で
 * 緑になる経路を塞ぐためである。
 */
function expectKeySetsMatch(
  table: DocTable,
  documentedKeys: readonly string[],
  implementationKeys: readonly string[],
  label: string,
): void {
  expect(table.rows.length, `${label}: 文書の表に本文行が 1 件もありません（抽出が空振りしています）`).toBeGreaterThan(
    0,
  );
  expect(implementationKeys.length, `${label}: 実装側のキーが 0 件です（import か走査が壊れています）`).toBeGreaterThan(
    0,
  );

  const missing = implementationKeys.filter((key) => !documentedKeys.includes(key));
  expect(
    missing,
    `${label}: 実装にあるのに文書に無い項目があります: ${missing.join(', ')}\n` +
      `  → docs/design/design-language.md の表へ行を足してください（実装が正典です）。`,
  ).toEqual([]);

  const phantom = documentedKeys.filter((key) => !implementationKeys.includes(key));
  expect(
    phantom,
    `${label}: 文書にあるのに実装に無い項目があります: ${phantom.join(', ')}\n` +
      `  → 実装から消えた項目が文書に残っています。行を削除してください。`,
  ).toEqual([]);

  const duplicated = documentedKeys.filter((key, index) => documentedKeys.indexOf(key) !== index);
  expect(duplicated, `${label}: 文書の表に重複した行があります: ${duplicated.join(', ')}`).toEqual([]);
}

/** 閉じた語彙であることと、死んだ語彙が無いことを両方向で固定する。 */
function expectClosedVocabulary(values: readonly string[], vocabulary: readonly string[], label: string): void {
  const unknown = values.filter((value) => !vocabulary.includes(value));
  expect(unknown, `${label}: 語彙にない値が使われています: ${[...new Set(unknown)].join(', ')}`).toEqual([]);
  const unused = vocabulary.filter((word) => !values.includes(word));
  expect(
    unused,
    `${label}: 一度も使われていない語彙があります: ${unused.join(', ')}\n` +
      `  → 使わない語彙を残すと、次に足す人が「その値も許される」と読みます。`,
  ).toEqual([]);
}

// --- 自己検証 -------------------------------------------------------------------

describe('抽出器の自己検証（Issue #60 の規律）', () => {
  describe('パス導出', () => {
    it('リポジトリルートの導出が正しい（相対深度の自己検証）', () => {
      expect(existsSync(join(repoRoot, 'Makefile')), `repoRoot の導出が誤っています: ${repoRoot}`).toBe(true);
      expect(existsSync(join(repoRoot, 'ts', 'pnpm-workspace.yaml'))).toBe(true);
      expect(existsSync(componentsDir), `componentsDir の導出が誤っています: ${componentsDir}`).toBe(true);
    });
  });

  describe('maskFences', () => {
    it('フェンス内の表を本文から落とす（誤検出）', () => {
      const markdown = '```\n| 段 | 値 |\n|---|---|\n| `sm` | `1rem` |\n```\n';
      expect(parseTables(maskFences(markdown).body)).toEqual([]);
    });

    it('同じ内容もフェンスを外せば表として拾える（fixture 自身の変異で確かめる）', () => {
      // この対照が無いと、上のケースは「フェンスが効いている」ではなく
      // 「fixture がそもそも表として成立していない」でも緑になる。
      const markdown = '| 段 | 値 |\n|---|---|\n| `sm` | `1rem` |\n';
      expect(parseTables(maskFences(markdown).body)).toHaveLength(1);
    });

    it('``` で開いたフェンスを ~~~ が閉じない（記号違いの開閉）', () => {
      expect(() => maskFences('```\ntext\n~~~\n')).toThrow(/閉じていません/);
    });

    it('```` で開いたフェンスを ``` が閉じない（長さの開閉）', () => {
      expect(() => maskFences('````\n```\ntext\n```\n')).toThrow(/閉じていません/);
    });

    it('フェンスの中身を取り出せる（取りこぼし）', () => {
      expect(maskFences('```\nsystem-ui, Meiryo\n```\n').fences).toEqual(['system-ui, Meiryo']);
    });

    it('行数を保つ（失敗メッセージの行番号を元文書と揃える）', () => {
      expect(maskFences('a\n```\nx\n```\nb\n').body.split('\n')).toHaveLength(6);
    });
  });

  describe('parseTables', () => {
    it('文書の先頭と末尾の表を漏らさない（位置依存の取りこぼし）', () => {
      const markdown = '| a |\n|---|\n| 1 |\n\n本文\n\n| b |\n|---|\n| 2 |';
      expect(parseTables(markdown).map((table) => table.headers[0])).toEqual(['a', 'b']);
    });

    it('区切り行が無ければ表として拾わない（誤検出）', () => {
      expect(parseTables('| a | b |\n| 1 | 2 |')).toEqual([]);
    });

    it('直前の見出しを記録する（失敗メッセージの手掛かり）', () => {
      expect(parseTables('## 色\n\n| a |\n|---|\n| 1 |')[0]?.heading).toBe('色');
    });

    it('空行で区切られた 2 表を 1 表へ融合しない', () => {
      expect(parseTables('| a |\n|---|\n| 1 |\n\n| a |\n|---|\n| 2 |')).toHaveLength(2);
    });

    it('行番号は 1 始まりで、ヘッダ行を指す', () => {
      expect(parseTables('前置き\n\n| a |\n|---|\n| 1 |')[0]?.startLine).toBe(3);
    });
  });

  describe('tableBySignature', () => {
    it('0 件は例外にする（列名の変更が静かに全 assert を消す経路の封じ）', () => {
      expect(() => tableBySignature(parseTables('| a |\n|---|\n| 1 |'), ['b'])).toThrow(/表がありません/);
    });

    it('2 件は例外にする（先頭一致で片方だけ見る経路の封じ）', () => {
      const tables = parseTables('| a |\n|---|\n| 1 |\n\n| a |\n|---|\n| 2 |');
      expect(() => tableBySignature(tables, ['a'])).toThrow(/2 件あります/);
    });

    it('1 件なら返す（取りこぼしの対照）', () => {
      expect(tableBySignature(parseTables('| a |\n|---|\n| 1 |'), ['a']).rows).toEqual([['1']]);
    });
  });

  describe('codeCell', () => {
    it('バッククォート囲みの中身を返す', () => {
      expect(codeCell(tableBySignature(parseTables('| a |\n|---|\n| `x` |'), ['a']), 0, 0)).toBe('x');
    });

    it('囲みが無ければ例外にする（生の値を黙って通さない）', () => {
      expect(() => codeCell(tableBySignature(parseTables('| a |\n|---|\n| x |'), ['a']), 0, 0)).toThrow(
        /バッククォート囲み/,
      );
    });
  });

  describe('namedExportsOf', () => {
    it('複数行の export ブロックを拾う（card.tsx の形）', () => {
      expect(namedExportsOf('\nexport {\n  Card,\n  CardHeader,\n}\n')).toEqual(['Card', 'CardHeader']);
    });

    it('export type は拾わない（heading.tsx の形）', () => {
      expect(namedExportsOf('\nexport { Heading }\nexport type { HeadingProps }\n')).toEqual(['Heading']);
    });

    it('関数宣言の export も拾う（取りこぼし）', () => {
      expect(namedExportsOf('\nexport function Probe() {}\n')).toEqual(['Probe']);
    });

    it('import の名前を export と取り違えない（誤検出）', () => {
      expect(namedExportsOf('import { cva } from "class-variance-authority"\n')).toEqual([]);
    });
  });

  describe('testTitlesIn', () => {
    it('describe と it を単一・二重・バッククォートのいずれでも拾う', () => {
      expect(testTitlesIn("describe('A', () => {}); it(\"B\", () => {}); it(`C`, () => {})")).toEqual(['A', 'B', 'C']);
    });

    it('describe.each のタイトルは拾わない（既知の制約の固定）', () => {
      // 拾えないこと自体は欠陥ではないが、「拾えているつもり」が最悪である。
      // ポインタ側は囲みの describe を指す運用にする。
      expect(testTitlesIn("describe.each(APPS)('$name のスケール', () => {})")).toEqual([]);
    });

    it('コメント中の describe という語を拾わない（誤検出）', () => {
      expect(testTitlesIn('// describe は使わない\n')).toEqual([]);
    });
  });

  describe('baseHeadingRules', () => {
    it('@layer base の h1 を拾う（取りこぼし）', () => {
      const rules = baseHeadingRules('@layer base {\n  h1 { font-size: var(--text-2xl); line-height: 1.25; }\n}');
      expect(rules.get('h1')?.['line-height']).toBe('1.25');
    });

    it('@layer base の外側にある h1 は拾わない（誤検出）', () => {
      expect(baseHeadingRules('h1 { line-height: 9 }').size).toBe(0);
    });

    it('別のレイヤの h1 は拾わない（誤検出）', () => {
      expect(baseHeadingRules('@layer utilities {\n  h1 { line-height: 9 }\n}').size).toBe(0);
    });
  });
});

// --- 2. 色 ---------------------------------------------------------------------

describe('色役割表 ↔ colors（両方向）', () => {
  const table = tableBySignature(docTables, COLOR_ROLE_SIGNATURE);
  const documentedRoles = table.rows.map((_row, index) => codeCell(table, index, 0));
  const implementationRoles = Object.keys(colors);

  it('役割の集合が実装と一致する（両方向・件数を先に固定）', () => {
    expectKeySetsMatch(table, documentedRoles, implementationRoles, '色役割表');
  });

  for (const [index, role] of documentedRoles.entries()) {
    it(`${role} の値と対白比が実装と一致する`, () => {
      const key = role as keyof typeof colors;
      expect(colors[key], `色役割表 ${index + 1} 行目の \`${role}\` は colors のキーではありません`).toBeDefined();

      const documentedHex = codeCell(table, index, 1);
      expect(
        documentedHex.toUpperCase(),
        `色役割表の \`${role}\` の値が実装と一致しません` +
          `（文書: ${documentedHex} / colors.${role}: ${colors[key]}）。実装が正典です。`,
      ).toBe(colors[key].toUpperCase());

      // 背景も colors から引く。'#FFFFFF' を literal で書くと、背景を変えたときに
      // 15 行の対白比が全部嘘になるのに緑のまま通る。
      const expected = contrastRatio(colors[key], colors.background).toFixed(3);
      expect(
        cell(table, index, 2),
        `色役割表の \`${role}\` の対白比が実測と一致しません` +
          `（文書: ${cell(table, index, 2)} / 実測: ${expected}・小数 3 桁で書くこと）。`,
      ).toBe(expected);
    });
  }

  it('出典と用途の欄が空でない（説明の空洞化を防ぐ）', () => {
    for (const [index, role] of documentedRoles.entries()) {
      expect(cell(table, index, 3).length, `\`${role}\` の出典欄が空です`).toBeGreaterThan(0);
      expect(cell(table, index, 4).length, `\`${role}\` の用途欄が短すぎます`).toBeGreaterThan(8);
    }
  });
});

describe('不採用色表（文書が正典・比は再計算で固定）', () => {
  const table = tableBySignature(docTables, REJECTED_SIGNATURE);
  const MEASUREMENT_VOCABULARY = ['素', '`/20` 面上'] as const;
  const rejectedHexes = table.rows.map((_row, index) => codeCell(table, index, 1).toUpperCase());
  const tokenHexes = Object.values(colors).map((hex) => hex.toUpperCase());

  it('測定条件が閉じた語彙で、死んだ語彙が無い', () => {
    expect(table.rows.length, '不採用色表に本文行がありません').toBeGreaterThan(0);
    expectClosedVocabulary(
      table.rows.map((_row, index) => cell(table, index, 2)),
      [...MEASUREMENT_VOCABULARY],
      '不採用色表の測定条件',
    );
  });

  it('採らなかったと書いてある色が実装で採用されていない', () => {
    // **否定の直前に非空アンカーを置く。** 「同値のものが 0 件」は抽出が空振りしても成立する。
    expect(rejectedHexes.length, '不採用色を 1 件も抽出できていません（表の抽出が空振りしています）').toBeGreaterThan(4);
    expect(tokenHexes.length, 'colors から値を 1 件も取れていません（import が壊れています）').toBeGreaterThan(10);
    expect(rejectedHexes, '既知の不採用色 #C13515 を拾えていません（抽出が生きている証拠）').toContain('#C13515');

    const adopted = rejectedHexes.filter((hex) => tokenHexes.includes(hex));
    expect(
      adopted,
      `「採らなかった」と書いてある色が実装で採用されています: ${adopted.join(', ')}\n` +
        `  → 実装を戻すか、その色を不採用色表から外して色役割表へ移してください。`,
    ).toEqual([]);
  });

  for (const [index] of table.rows.entries()) {
    const name = cell(table, index, 0);
    it(`${name} の実測と閾値が整合する`, () => {
      const hex = codeCell(table, index, 1).toUpperCase();
      const condition = cell(table, index, 2);
      const surface = condition === '素' ? colors.background : compositeOver(hex, colors.background, 0.2);
      const expected = contrastRatio(hex, surface).toFixed(3);
      expect(
        cell(table, index, 3),
        `${name} の実測が再計算と一致しません（文書: ${cell(table, index, 3)} / 実測: ${expected}）。`,
      ).toBe(expected);

      const threshold = Number(cell(table, index, 4));
      expect([AA_TEXT_RATIO, AA_NON_TEXT_RATIO], `${name} の閾値は 4.5 か 3 のいずれかです`).toContain(threshold);
      expect(
        Number(expected),
        `${name} は閾値 ${threshold} を満たしています。閾値で落とせない色は不採用色表ではなく散文で説明してください` +
          `（数値の理由が無い行を表に置くと、次に足す人が数値を根拠だと誤読します）。`,
      ).toBeLessThan(threshold);
      expect(cell(table, index, 5).length, `${name} の不採用理由が短すぎます`).toBeGreaterThan(10);
    });
  }
});

describe('実効コントラスト表 ↔ compositeOver / contrastRatio', () => {
  const table = tableBySignature(docTables, COMPOSITE_SIGNATURE);
  const VERDICT_VOCABULARY = ['AA', '非テキスト', '既知の限界'] as const;
  const ALPHA_CELL = /^(?:1|0(?:\.\d{1,2})?)$/;
  const RATIO_CELL = /^\d{1,2}\.\d{3}$/;

  function roleHex(raw: string, where: string): string {
    const role = /^`([A-Za-z]+)`$/.exec(raw)?.[1];
    if (role === undefined || !(role in colors)) {
      throw new Error(
        `${where}: 「${raw}」は ColorTokens の役割名ではありません。\n` +
          `  → 実効コントラスト表は design-tokens の役割名だけを使います（意味論名 card / muted は使えません）。\n` +
          `    意味論名の解決は contrast-usage.test.ts が担っており、ここに第 2 実装を置くと\n` +
          `    contrast.ts が禁じた実装ドリフトを自作することになります。`,
      );
    }
    return colors[role as keyof typeof colors];
  }

  it('行があり、判定が閉じた語彙で、死んだ語彙が無い', () => {
    expect(table.rows.length, '実効コントラスト表に本文行がありません').toBeGreaterThan(0);
    expectClosedVocabulary(
      table.rows.map((_row, index) => cell(table, index, 8)),
      [...VERDICT_VOCABULARY],
      '実効コントラスト表の判定',
    );
  });

  for (const [index] of table.rows.entries()) {
    const line = table.startLine + 2 + index;
    it(`${line} 行目（${cell(table, index, 0)} on ${cell(table, index, 2)}）の実効色と比が実測と一致する`, () => {
      expect(cell(table, index, 1), `${line} 行目の前景 α`).toMatch(ALPHA_CELL);
      expect(cell(table, index, 3), `${line} 行目の面 α`).toMatch(ALPHA_CELL);

      const foregroundBase = roleHex(cell(table, index, 0), `${line} 行目 前景`);
      const surfaceBase = roleHex(cell(table, index, 2), `${line} 行目 面`);
      const backdrop = roleHex(cell(table, index, 4), `${line} 行目 面の下`);
      const foregroundAlpha = Number(cell(table, index, 1));
      const surfaceAlpha = Number(cell(table, index, 3));

      // 合成の順序は contrast-usage.test.ts と同じ。面を先に合成し、その上へ前景を合成する。
      const surfaceHex = surfaceAlpha === 1 ? surfaceBase : compositeOver(surfaceBase, backdrop, surfaceAlpha);
      const foregroundHex =
        foregroundAlpha === 1 ? foregroundBase : compositeOver(foregroundBase, surfaceHex, foregroundAlpha);

      const documentedSurface = codeCell(table, index, 5);
      expect(
        documentedSurface.toUpperCase(),
        `${line} 行目の面の実効色が実測と一致しません（文書: ${documentedSurface} / 実測: ${surfaceHex}）。`,
      ).toBe(surfaceHex);

      const documentedForeground = codeCell(table, index, 6);
      expect(
        documentedForeground.toUpperCase(),
        `${line} 行目の前景の実効色が実測と一致しません（文書: ${documentedForeground} / 実測: ${foregroundHex}）。`,
      ).toBe(foregroundHex);

      const expected = contrastRatio(foregroundHex, surfaceHex).toFixed(3);
      expect(cell(table, index, 7), `${line} 行目の比は小数 3 桁で書いてください`).toMatch(RATIO_CELL);
      expect(
        cell(table, index, 7),
        `${line} 行目の比が実測と一致しません（文書: ${cell(table, index, 7)} / 実測: ${expected}）。\n` +
          `  ${foregroundHex} on ${surfaceHex}。実装が正典です。`,
      ).toBe(expected);

      const verdict = cell(table, index, 8);
      const ratio = Number(expected);
      if (verdict === 'AA') {
        expect(ratio, `${line} 行目は AA と書かれていますが ${AA_TEXT_RATIO}:1 を満たしていません`).toBeGreaterThanOrEqual(
          AA_TEXT_RATIO,
        );
      } else if (verdict === '非テキスト') {
        expect(
          ratio,
          `${line} 行目は非テキストと書かれていますが ${AA_NON_TEXT_RATIO}:1 を満たしていません`,
        ).toBeGreaterThanOrEqual(AA_NON_TEXT_RATIO);
      } else {
        expect(
          ratio,
          `${line} 行目は「既知の限界」と書かれていますが ${AA_TEXT_RATIO}:1 を満たしています。` +
            `満たしているなら AA と書いてください。`,
        ).toBeLessThan(AA_TEXT_RATIO);
      }
      expect(cell(table, index, 9).length, `${line} 行目の出典欄が短すぎます`).toBeGreaterThan(5);
    });
  }
});

// --- 3〜6. スケール ---------------------------------------------------------------

describe('余白表 ↔ spacing（両方向）', () => {
  const table = tableBySignature(docTables, SPACING_SIGNATURE);
  const documentedSteps = table.rows.map((_row, index) => codeCell(table, index, 0));

  it('段の集合が実装と一致する', () => {
    expectKeySetsMatch(table, documentedSteps, Object.keys(spacing), '余白表');
  });

  for (const [index, step] of documentedSteps.entries()) {
    it(`${step} の値・倍率・クラス・px が実装から導出した値と一致する`, () => {
      const value = spacing[step as keyof typeof spacing];
      expect(value, `余白表の \`${step}\` は spacing のキーではありません`).toBeDefined();

      // 倍率・クラス・px は対応表を書き写さず、すべて spacing の値から導く。
      const rem = Number.parseFloat(value);
      const multiplier = rem / 0.25;
      expect(codeCell(table, index, 1), `余白表 \`${step}\` の値`).toBe(value);
      expect(cell(table, index, 2), `余白表 \`${step}\` の倍率（実測: ×${multiplier}）`).toBe(`×${multiplier}`);
      expect(codeCell(table, index, 3), `余白表 \`${step}\` のクラス例（実測: p-${multiplier}）`).toBe(
        `p-${multiplier}`,
      );
      expect(cell(table, index, 4), `余白表 \`${step}\` の px（実測: ${rem * 16}）`).toBe(String(rem * 16));
    });
  }
});

describe('角丸表 ↔ radius（両方向）', () => {
  const table = tableBySignature(docTables, RADIUS_SIGNATURE);
  const documentedSteps = table.rows.map((_row, index) => codeCell(table, index, 0));
  const componentFiles = readdirSync(componentsDir)
    .filter((name) => name.endsWith('.tsx'))
    .sort();

  it('段の集合が実装と一致する', () => {
    expectKeySetsMatch(table, documentedSteps, Object.keys(radius), '角丸表');
  });

  for (const [index, step] of documentedSteps.entries()) {
    it(`${step} の値・クラス・使用部品が実装と一致する`, () => {
      const value = radius[step as keyof typeof radius];
      expect(value, `角丸表の \`${step}\` は radius のキーではありません`).toBeDefined();
      expect(codeCell(table, index, 1), `角丸表 \`${step}\` の値`).toBe(value);
      // クラス名は literal で書かず段から導く（Tailwind はソースをプレーンテキスト走査するため）。
      expect(codeCell(table, index, 2), `角丸表 \`${step}\` のクラス`).toBe(`rounded-${step}`);

      const users = componentFiles
        .filter((file) =>
          collectUsedRadiusUtilities([readFileSync(join(componentsDir, file), 'utf8')]).includes(step),
        )
        .sort();
      const expected = users.length === 0 ? '（なし）' : users.map((file) => `\`${file}\``).join(', ');
      expect(
        cell(table, index, 3),
        `角丸 \`${step}\` の使用部品が実装と一致しません。\n` +
          `  文書: ${cell(table, index, 3)}\n` +
          `  実装: ${expected}\n` +
          `  → 次の 1 行で置き換えてください:\n` +
          `    | \`${step}\` | \`${value}\` | \`rounded-${step}\` | ${expected} | ${cell(table, index, 4)} |`,
      ).toBe(expected);
      expect(cell(table, index, 4).length, `角丸表 \`${step}\` の出典欄が空です`).toBeGreaterThan(0);
    });
  }
});

describe('影表 ↔ shadow（両方向）', () => {
  const table = tableBySignature(docTables, SHADOW_SIGNATURE);
  const documentedSteps = table.rows.map((_row, index) => codeCell(table, index, 0));

  it('段の集合が実装と一致する', () => {
    expectKeySetsMatch(table, documentedSteps, Object.keys(shadow), '影表');
  });

  for (const [index, step] of documentedSteps.entries()) {
    it(`${step} の値が実装と一致する`, () => {
      const value = shadow[step as keyof typeof shadow];
      expect(value, `影表の \`${step}\` は shadow のキーではありません`).toBeDefined();
      expect(codeCell(table, index, 1), `影表 \`${step}\` の値`).toBe(value);
      expect(cell(table, index, 2).length, `影表 \`${step}\` の用途欄が短すぎます`).toBeGreaterThan(8);
    });
  }
});

describe('タイポ表 ↔ typography（両方向）', () => {
  const table = tableBySignature(docTables, TYPOGRAPHY_SIGNATURE);
  const documentedSteps = table.rows.map((_row, index) => codeCell(table, index, 0));

  it('段の集合が実装と一致する', () => {
    expectKeySetsMatch(table, documentedSteps, Object.keys(typography.scale), 'タイポ表');
  });

  for (const [index, step] of documentedSteps.entries()) {
    it(`${step} の値・クラス・px が実装と一致する`, () => {
      const value = typography.scale[step as keyof typeof typography.scale];
      expect(value, `タイポ表の \`${step}\` は typography.scale のキーではありません`).toBeDefined();
      expect(codeCell(table, index, 1), `タイポ表 \`${step}\` の値`).toBe(value);
      expect(codeCell(table, index, 2), `タイポ表 \`${step}\` のクラス`).toBe(`text-${step}`);
      expect(cell(table, index, 3), `タイポ表 \`${step}\` の px`).toBe(String(Number.parseFloat(value) * 16));
    });
  }

  it('フォントスタックがコードフェンスで完全一致で書かれている', () => {
    // 表に入れると引用符付きの書体名がセルを汚すため、フェンスで置いて完全一致を要求する。
    expect(masked.fences.length, 'コードフェンスを 1 つも抽出できていません').toBeGreaterThan(0);
    expect(
      masked.fences.map((fence) => fence.trim()),
      `フォントスタックが実装と一致しません。次の 1 行をフェンスに入れてください:\n  ${typography.fontSans}`,
    ).toContain(typography.fontSans);
  });
});

describe('見出し階層表 ↔ theme.css / typography / heading.tsx', () => {
  const table = tableBySignature(docTables, HEADING_SIGNATURE);
  const rules = baseHeadingRules(readFileSync(themeCssPath, 'utf8'));
  const documentedTags = table.rows.map((_row, index) => codeCell(table, index, 0));

  it('タグの集合が theme.css の @layer base と一致する', () => {
    expectKeySetsMatch(table, documentedTags, [...rules.keys()].sort(), '見出し階層表');
  });

  for (const [index, tag] of documentedTags.entries()) {
    it(`${tag} の寸法・太さ・行間と Heading の既定が一致する`, () => {
      const declarations = rules.get(tag);
      expect(declarations, `見出し階層表の \`${tag}\` が theme.css の @layer base にありません`).toBeDefined();
      const step = codeCell(table, index, 1);

      // font-size は var(--text-<段>) の形で書かれている。段名を取り出して照合する。
      const declaredStep = /^var\(--text-([a-z0-9]+)\)$/.exec(declarations?.['font-size'] ?? '')?.[1];
      expect(
        step,
        `\`${tag}\` のサイズ段が theme.css と一致しません（文書: ${step} / theme.css: ${declaredStep ?? '不明'}）`,
      ).toBe(declaredStep);

      const scaleValue = typography.scale[step as keyof typeof typography.scale];
      expect(codeCell(table, index, 2), `\`${tag}\` の実寸`).toBe(scaleValue);
      expect(cell(table, index, 3), `\`${tag}\` の太さ`).toBe(declarations?.['font-weight']);
      expect(cell(table, index, 4), `\`${tag}\` の行間`).toBe(declarations?.['line-height']);

      // D7 の不変条件: 素のタグと共通部品 Heading の既定が同じ段を指す。
      const level = Number(tag.slice(1)) as keyof typeof DEFAULT_SIZE_BY_LEVEL;
      expect(
        codeCell(table, index, 5),
        `\`${tag}\` の「Heading の既定」が heading.tsx と一致しません`,
      ).toBe(DEFAULT_SIZE_BY_LEVEL[level]);
      expect(
        codeCell(table, index, 5),
        `\`${tag}\` は素のタグと Heading の既定が別の段を指しています（D7 の不変条件が壊れています）`,
      ).toBe(step);
    });
  }
});

// --- 部品・ポインタ・構造契約 --------------------------------------------------------

describe('部品表 ↔ src/components（両方向）', () => {
  const table = tableBySignature(docTables, COMPONENT_SIGNATURE);
  const componentFiles = readdirSync(componentsDir)
    .filter((name) => name.endsWith('.tsx'))
    .sort();
  const documentedFiles = table.rows.map((_row, index) => codeCell(table, index, 0));

  it('部品ファイルの集合が一致する（両方向・件数を先に固定）', () => {
    expect(componentFiles.length, '部品ファイルを 1 件も読めていません').toBeGreaterThan(0);
    expectKeySetsMatch(table, documentedFiles, componentFiles, '部品表');
  });

  for (const [index, file] of documentedFiles.entries()) {
    it(`${file} の export 一覧が実装と一致する`, () => {
      const actual = namedExportsOf(readFileSync(join(componentsDir, file), 'utf8'));
      const documented = cell(table, index, 1)
        .split(',')
        .map((raw) => raw.trim().replace(/^`|`$/g, ''))
        .filter((name) => name.length > 0)
        .sort();
      expect(
        documented,
        `${file} の export 一覧が実装と一致しません。\n` +
          `  文書: ${documented.join(', ')}\n` +
          `  実装: ${actual.join(', ')}\n` +
          `  → 実装が正典です。次のセルで置き換えてください:\n` +
          `    ${actual.map((name) => `\`${name}\``).join(', ')}`,
      ).toEqual(actual);
      expect(cell(table, index, 2).length, `${file} の役割欄が短すぎます`).toBeGreaterThan(3);
    });
  }
});

describe('ガードポインタ表（パスとアンカーの実在）', () => {
  const table = tableBySignature(docTables, POINTER_SIGNATURE);
  const SHELL_ANCHOR = '（シェルガード）';

  it('行が 1 件以上ある（空振り緑の防止）', () => {
    expect(table.rows.length, 'ガードポインタ表に本文行がありません').toBeGreaterThan(0);
  });

  for (const [index] of table.rows.entries()) {
    const line = table.startLine + 2 + index;
    const subject = cell(table, index, 0);
    it(`${line} 行目「${subject}」のガードが実在する`, () => {
      const guardPath = codeCell(table, index, 1);
      const absolute = join(repoRoot, guardPath);
      expect(
        existsSync(absolute),
        `${line} 行目のガード '${guardPath}' がリポジトリに存在しません。\n` +
          `  → ファイルを移したなら文書も追随させてください。`,
      ).toBe(true);

      const anchor = cell(table, index, 2);
      if (anchor === SHELL_ANCHOR) return;
      expect(anchor.length, `${line} 行目のアンカーが短すぎます（偶然一致します）: ${anchor}`).toBeGreaterThanOrEqual(6);

      const titles = testTitlesIn(readFileSync(absolute, 'utf8'));
      // **否定の前に非空アンカーを置く。** タイトル抽出が壊れて 0 件になると、
      // 下の判定は全ポインタで同時に赤くなり、原因が「改名」なのか「抽出の破綻」なのか読めない。
      expect(titles.length, `${guardPath} から describe / it のタイトルを 1 件も抽出できません`).toBeGreaterThan(0);
      expect(
        titles.some((title) => title.includes(anchor)),
        `${line} 行目のアンカー「${anchor}」が ${guardPath} の describe / it のタイトルに現れません。\n` +
          `  → その検査は改名されたか消えています。守っているつもりのポインタが残るのを防ぎます。\n` +
          `  抽出できたタイトル ${titles.length} 件の先頭 3 件: ${titles.slice(0, 3).join(' / ')}`,
      ).toBe(true);
    });
  }
});

describe('構造契約表（出典テストの実在）', () => {
  const table = tableBySignature(docTables, CONTRACT_SIGNATURE);

  it('行が 1 件以上ある（空振り緑の防止）', () => {
    expect(table.rows.length, '構造契約表に本文行がありません').toBeGreaterThan(0);
  });

  for (const [index] of table.rows.entries()) {
    const line = table.startLine + 2 + index;
    it(`${line} 行目の出典テストがすべて実在する`, () => {
      // パスは `/` を含むため、複数指定の区切りはカンマにする。
      const paths = cell(table, index, 1)
        .split(',')
        .map((raw) => raw.trim().replace(/^`|`$/g, ''))
        .filter((value) => value.length > 0);
      expect(paths.length, `${line} 行目に出典パスがありません`).toBeGreaterThan(0);
      for (const path of paths) {
        expect(
          existsSync(join(repoRoot, path)),
          `${line} 行目の出典 '${path}' がリポジトリに存在しません。\n` +
            `  → 構造契約の正典はテストそのものです。テストが消えたなら契約も消えています。`,
        ).toBe(true);
      }
      expect(cell(table, index, 0).length, `${line} 行目の契約の記述が短すぎます`).toBeGreaterThan(10);
    });
  }
});

// --- 散文 -----------------------------------------------------------------------

describe('散文の数値が照合済みの値だけを使う', () => {
  const ratioColumns: string[] = [];
  const remValues: string[] = [];
  const hexValues = new Set<string>();

  for (const hex of Object.values(colors)) hexValues.add(hex.toUpperCase());
  for (const value of Object.values(shadow)) {
    for (const hex of value.match(/#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?/g) ?? []) hexValues.add(hex.toUpperCase());
  }
  for (const value of Object.values(spacing)) remValues.push(value);
  for (const value of Object.values(radius)) remValues.push(value);
  for (const value of Object.values(typography.scale)) remValues.push(value);

  {
    const colorTable = tableBySignature(docTables, COLOR_ROLE_SIGNATURE);
    for (const [index] of colorTable.rows.entries()) ratioColumns.push(cell(colorTable, index, 2));
    const rejected = tableBySignature(docTables, REJECTED_SIGNATURE);
    for (const [index] of rejected.rows.entries()) {
      ratioColumns.push(cell(rejected, index, 3));
      hexValues.add(codeCell(rejected, index, 1).toUpperCase());
    }
    const composite = tableBySignature(docTables, COMPOSITE_SIGNATURE);
    for (const [index] of composite.rows.entries()) {
      ratioColumns.push(cell(composite, index, 7));
      hexValues.add(codeCell(composite, index, 5).toUpperCase());
      hexValues.add(codeCell(composite, index, 6).toUpperCase());
    }
  }

  /** WCAG の閾値。散文では「4.5:1」「3:1」と書くのが自然なので許す。 */
  const THRESHOLDS = ['4.5', '3'];

  it('散文を抽出できている（空振り緑の防止）', () => {
    expect(prose.length, '散文が空です（表の除去が行き過ぎています）').toBeGreaterThan(500);
    expect(prose, '散文に WCAG への言及がありません（抽出範囲がずれています）').toContain('WCAG');
  });

  it('散文の比が閾値か照合済みの値である', () => {
    const allowed = new Set([...THRESHOLDS, ...ratioColumns]);
    const found = [...prose.matchAll(/(\d+(?:\.\d+)?)\s*:\s*1/g)].map((match) => match[1] as string);
    const unknown = found.filter((value) => !allowed.has(value));
    expect(
      [...new Set(unknown)],
      `散文に、どの表にも無い比が書かれています: ${[...new Set(unknown)].join(', ')}\n` +
        `  → 表の値を引くか、表へ行を足してください。散文の数値は誰も検証していません。`,
    ).toEqual([]);
  });

  it('散文の rem が照合済みの値である', () => {
    const allowed = new Set(remValues);
    const found = [...prose.matchAll(/(\d+(?:\.\d+)?rem)/g)].map((match) => match[1] as string);
    const unknown = found.filter((value) => !allowed.has(value));
    expect(
      [...new Set(unknown)],
      `散文に、どのスケールにも無い rem が書かれています: ${[...new Set(unknown)].join(', ')}`,
    ).toEqual([]);
  });

  it('散文の hex が照合済みの値である', () => {
    // 6 桁または 8 桁だけを対象にするので、Issue 番号（#175）とは原理的に一致しない。
    const found = [...prose.matchAll(/#([0-9A-Fa-f]{8}|[0-9A-Fa-f]{6})(?![0-9A-Fa-f])/g)].map(
      (match) => `#${(match[1] as string).toUpperCase()}`,
    );
    const unknown = found.filter((hex) => !hexValues.has(hex));
    expect(
      [...new Set(unknown)],
      `散文に、実装にも不採用色表にも無い hex が書かれています: ${[...new Set(unknown)].join(', ')}`,
    ).toEqual([]);
  });

  it('段や部品の件数を散文に書いていない（追随箇所を表 1 箇所へ集約する）', () => {
    const counts = [...prose.matchAll(/(?:角丸|余白|部品|色役割|タイポ|意味役割)[^。\n]{0,10}?\d+\s*(?:段|点|件|役割)/g)];
    expect(
      counts.map((match) => match[0]),
      '件数を散文に書かないでください。段や部品が増えたときに追随箇所が 2 箇所になり、\n' +
        '  片方だけ直した状態を機械が検出できません。件数は表の行数として表してください。',
    ).toEqual([]);
  });
});
