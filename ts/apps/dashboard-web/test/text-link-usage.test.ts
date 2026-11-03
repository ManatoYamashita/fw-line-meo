import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// 本文中の文字のリンクは下線で示す（Issue #503・正典 docs/design/design-language.md §7.21）。
//
// 画面のリンクは、押しボタンの見た目（buttonVariants）か、文字のリンクの見た目（textLinkVariants）の
// どちらかを必ず持つ。Tailwind の Preflight はリンクの下線を消すので、どちらも付けない素のリンクは
// 周りの文と見分けが付かない。#503 の時点で 5 か所がこの状態だった。
// 下線のクラスを直書きしたリンクも通さない。見た目を 1 か所で決める意味が無くなるためである。

const SRC_DIR = resolve(process.cwd(), 'src');

/**
 * 上の 2 つのどちらも使わないリンク。値は、そのリンクの開始タグが含むべき識別子である。
 * 識別子が消えたら（= リンクの見た目の決め方が変わったら）除外の根拠も消えるので、赤にする。
 */
const EXEMPT: Readonly<Record<string, string>> = {
  // 帯の案内リンク。現在地を下線の罫で示すので、文字の下線を重ねない（正典 §7.8）。
  'components/top-nav.tsx': 'NAV_LINK_CLASS',
};

/** 見た目の種類ごとのリンクの数。実測へ合わせて宣言を書き換える改変を素通りさせないため literal で持つ。 */
const EXPECTED = { textLink: 6, button: 3, exempt: 1 } as const;
const EXPECTED_TOTAL = 10;

type LinkTag = { file: string; line: number; tag: string };

/** コメントを空白へ置き換える。改行は残すので、行番号はずれない。 */
function stripComments(source: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^[ \t]*\/\/.*$/gm, blank);
}

/** `<Link` と `<a` の開始タグを、属性の式の中の `>` で途切れないよう波括弧と引用符を数えて抜き出す。 */
function linkTags(file: string, source: string): LinkTag[] {
  const code = stripComments(source);
  const tags: LinkTag[] = [];
  const opener = /<(Link|a)(?=[\s>])/g;
  for (let match = opener.exec(code); match !== null; match = opener.exec(code)) {
    let depth = 0;
    let quote: string | null = null;
    let end = match.index + 1;
    for (; end < code.length; end += 1) {
      const char = code[end];
      if (quote !== null) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'" || char === '`') {
        quote = char;
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
      } else if (char === '>' && depth === 0) {
        break;
      }
    }
    tags.push({
      file,
      line: code.slice(0, match.index).split('\n').length,
      tag: code.slice(match.index, end + 1),
    });
  }
  return tags;
}

function linkKind(file: string, tag: string): 'textLink' | 'button' | 'exempt' | null {
  if (tag.includes('textLinkVariants(')) return 'textLink';
  if (tag.includes('buttonVariants(')) return 'button';
  const exemptBy = EXEMPT[file];
  if (exemptBy !== undefined && tag.includes(exemptBy)) return 'exempt';
  return null;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.tsx') ? [path] : [];
  });
}

describe('抽出器の自己検証', () => {
  it('複数行の開始タグを、属性の式の中の > で途切れずに抜き出す', () => {
    const source = [
      '<Link',
      '  href="/a"',
      '  onClick={() => (count > 0 ? go() : stop())}',
      '  className={cn(textLinkVariants(), "self-start")}',
      '>',
      '  戻る',
      '</Link>',
    ].join('\n');
    const [tag] = linkTags('x.tsx', source);
    expect(tag?.tag.endsWith('"self-start")}\n>')).toBe(true);
    expect(linkKind('x.tsx', tag!.tag)).toBe('textLink');
  });

  it('コメントの中の <a> と、a で始まる別の要素を拾わない', () => {
    const source = [
      '// 素の <a> のまま保つ',
      '{/* <Link href="/x">古い導線</Link> */}',
      '/* <a href="/y"> */',
      '<abbr title="x">x</abbr>',
      '<aside>x</aside>',
    ].join('\n');
    expect(linkTags('x.tsx', source)).toEqual([]);
  });

  it('見た目の指定が無いリンクと、下線を直書きしたリンクを拾う', () => {
    const bare = linkTags('x.tsx', '<Link href="/a">一覧</Link>');
    const literal = linkTags('x.tsx', '<a href="/b" className="underline underline-offset-4">b</a>');
    expect(bare.map((link) => linkKind('x.tsx', link.tag))).toEqual([null]);
    expect(literal.map((link) => linkKind('x.tsx', link.tag))).toEqual([null]);
  });

  it('除外は、宣言したファイルの、宣言した識別子を含むリンクにだけ効く', () => {
    const navTag = '<Link href="/a" className={NAV_LINK_CLASS}>';
    expect(linkKind('components/top-nav.tsx', navTag)).toBe('exempt');
    expect(linkKind('components/other.tsx', navTag)).toBeNull();
    expect(linkKind('components/top-nav.tsx', '<Link href="/a">')).toBeNull();
  });
});

describe('文字のリンクの見た目（Issue #503・正典 §7.21）', () => {
  const links = sourceFiles(SRC_DIR).flatMap((path) =>
    linkTags(relative(SRC_DIR, path), readFileSync(path, 'utf8')),
  );

  it('画面のリンクは、文字のリンクか押しボタンの見た目を必ず持つ', () => {
    const missing = links
      .filter((link) => linkKind(link.file, link.tag) === null)
      .map((link) => `${link.file}:${link.line}`);
    expect(missing, '見た目の指定が無いリンク（textLinkVariants を付ける）').toEqual([]);
  });

  it('見た目の種類ごとの数が宣言と一致する', () => {
    const counts = { textLink: 0, button: 0, exempt: 0 };
    for (const link of links) {
      const kind = linkKind(link.file, link.tag);
      if (kind !== null) counts[kind] += 1;
    }
    expect(counts).toEqual(EXPECTED);
    expect(links).toHaveLength(EXPECTED_TOTAL);
  });

  it('除外は、実在するリンクに効いている', () => {
    for (const [file, identifier] of Object.entries(EXEMPT)) {
      const hits = links.filter((link) => link.file === file && link.tag.includes(identifier));
      expect(hits.length, file).toBeGreaterThan(0);
    }
  });
});
