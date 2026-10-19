// 巨大表示の段（text-display）をプロダクト全体で 1 箇所だけに使うことの照合。
//
// 正典 docs/design/design-language.md §7.3 は、巨大表示を店舗詳細の順位数値ただ 1 箇所に限る。
// 段の値はトークンのガードに掛かるが、使う場所の数はどのガードにも掛からないので、2 箇所目を
// 足しても CI は緑のまま「唯一の大声」が崩れる。面と共有部品のソースから使用箇所を数えて塞ぐ。
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { appAndSharedSourceRoots, fromTsRoot, listSources } from './support/app-sources';

/** ユーティリティとしての使用。`--text-display` のテーマ変数の宣言は数えない。 */
const DISPLAY_UTILITY = /(?<![-\w])text-display(?![-\w])/g;

/** 正典 §7.3 が巨大表示を置く唯一の場所。 */
const DISPLAY_OWNER = 'apps/store-detail/app/store/page.tsx';

/** コメントは数えない。説明文に段の名前を書いただけで「2 箇所目」と誤検出しないため。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function countUses(text: string): number {
  return stripComments(text).match(DISPLAY_UTILITY)?.length ?? 0;
}

describe('巨大表示の段はプロダクト全体で 1 箇所', () => {
  it('抽出の自己検証: ユーティリティの使用を数え、テーマ変数の宣言と似た名前は数えない', () => {
    expect(countUses('className="text-display leading-none font-bold"')).toBe(1);
    expect(countUses('className="sm:text-display"')).toBe(1);
    expect(countUses('  --text-display: 4rem;')).toBe(0);
    expect(countUses('className="text-display-sm"')).toBe(0);
    expect(countUses('className="text-2xl"')).toBe(0);
    expect(countUses('// 巨大表示は text-display を使う')).toBe(0);
    expect(countUses('/* text-display の説明 */ const a = 1;')).toBe(0);
    expect(countUses('{/* 説明 */}<span className="text-display">')).toBe(1);
    expect(countUses('const url = "https://example.com"; const c = "text-display";')).toBe(1);
  });

  it('src を持たない面（store-detail の app と lib）も走査している', () => {
    const roots = appAndSharedSourceRoots().map(fromTsRoot);
    expect(roots).toEqual(expect.arrayContaining(['apps/store-detail/app', 'apps/store-detail/lib']));
  });

  it('面と共有部品のソースで text-display を使うのは店舗詳細の順位数値の 1 箇所だけである', () => {
    const uses = appAndSharedSourceRoots()
      .flatMap(listSources)
      .flatMap((path) => {
        const count = countUses(readFileSync(path, 'utf8'));
        return count > 0 ? [`${fromTsRoot(path)} × ${count}`] : [];
      });
    expect(
      uses,
      '巨大表示（text-display）は正典 §7.3 により店舗詳細の順位数値ただ 1 箇所に限ります',
    ).toEqual([`${DISPLAY_OWNER} × 1`]);
  });
});
