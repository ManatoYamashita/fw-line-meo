// 巨大表示の段（text-display）をプロダクト全体で 1 箇所だけに使うことの照合。
//
// 正典 docs/design/design-language.md §7.3 は、巨大表示を店舗詳細の順位数値ただ 1 箇所に限る。
// 段の値はトークンのガードに掛かるが、使う場所の数はどのガードにも掛からないので、2 箇所目を
// 足しても CI は緑のまま「唯一の大声」が崩れる。面と共有部品のソースから使用箇所を数えて塞ぐ。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const tsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** ユーティリティとしての使用。`--text-display` のテーマ変数の宣言は数えない。 */
const DISPLAY_UTILITY = /(?<![-\w])text-display(?![-\w])/g;

/** 正典 §7.3 が巨大表示を置く唯一の場所。 */
const DISPLAY_OWNER = 'apps/store-detail/app/store/page.tsx';

function listSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listSources(path);
    return /\.(?:tsx?|css)$/.test(name) ? [path] : [];
  });
}

/** 面のソースを置くディレクトリ。store-detail は src を持たず app と lib に置くので、src だけでは漏れる。 */
const APP_SOURCE_DIRS = ['src', 'app', 'lib'] as const;

function scannedRoots(): string[] {
  const apps = join(tsRoot, 'apps');
  return [
    ...readdirSync(apps)
      .flatMap((app) => APP_SOURCE_DIRS.map((dir) => join(apps, app, dir)))
      .filter((root) => existsSync(root)),
    join(tsRoot, 'packages', 'ui', 'src'),
  ];
}

function countUses(text: string): number {
  return text.match(DISPLAY_UTILITY)?.length ?? 0;
}

describe('巨大表示の段はプロダクト全体で 1 箇所', () => {
  it('抽出の自己検証: ユーティリティの使用を数え、テーマ変数の宣言と似た名前は数えない', () => {
    expect(countUses('className="text-display leading-none font-bold"')).toBe(1);
    expect(countUses('className="sm:text-display"')).toBe(1);
    expect(countUses('  --text-display: 4rem;')).toBe(0);
    expect(countUses('className="text-display-sm"')).toBe(0);
    expect(countUses('className="text-2xl"')).toBe(0);
  });

  it('src を持たない面（store-detail の app と lib）も走査している', () => {
    const roots = scannedRoots().map((root) => relative(tsRoot, root).split('\\').join('/'));
    expect(roots).toEqual(expect.arrayContaining(['apps/store-detail/app', 'apps/store-detail/lib']));
  });

  it('面と共有部品のソースで text-display を使うのは店舗詳細の順位数値の 1 箇所だけである', () => {
    const uses = scannedRoots()
      .flatMap(listSources)
      .flatMap((path) => {
        const count = countUses(readFileSync(path, 'utf8'));
        return count > 0 ? [`${relative(tsRoot, path).split('\\').join('/')} × ${count}`] : [];
      });
    expect(
      uses,
      '巨大表示（text-display）は正典 §7.3 により店舗詳細の順位数値ただ 1 箇所に限ります',
    ).toEqual([`${DISPLAY_OWNER} × 1`]);
  });
});
