// ブランド色を文字色に使わないことの照合。
//
// ブランド色（LINE Green #06C755）は白背景に対して 2.26:1 しかなく、通常の文字の 4.5:1 どころか
// 大きい文字の 3:1 にも届かない（design-tokens の test/colors.test.ts が値を固定する）。トークンの値は
// コントラストのガードに掛かるが、`text-brand` のような使い方は掛からないので、値を差し替えると使う側だけが
// 黙って基準を割る。面のソースから文字色としての使用を拾って塞ぐ。
//
// 装飾（アイコンの塗りなど）としての使用は妨げない。文字を載せる面としての使用は静的には
// 見分けられないので、docs/design/design-language.md §2.4 の規律に委ねる。
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { appAndSharedSourceRoots, fromTsRoot, listSources } from './support/app-sources';

/** 文字色としてのブランド色の使用（Tailwind のユーティリティと CSS の color 宣言）。 */
const BRAND_AS_TEXT: readonly RegExp[] = [/\btext-brand\b/, /(?<![-\w])color:\s*var\(--color-brand\)/];

describe('ブランド色を文字色に使わない', () => {
  it('抽出の自己検証: 文字色の指定を拾い、装飾の指定と似た名前は拾わない', () => {
    const hits = (text: string) => BRAND_AS_TEXT.some((pattern) => pattern.test(text));
    expect(hits('className="text-xl font-bold text-brand"')).toBe(true);
    expect(hits('  color: var(--color-brand);')).toBe(true);
    expect(hits('className="fill-brand"')).toBe(false);
    expect(hits('  background-color: var(--color-brand);')).toBe(false);
    expect(hits('/brand-icon.png')).toBe(false);
  });

  it('src を持たない面（store-detail の app と lib）も走査している', () => {
    const roots = appAndSharedSourceRoots().map(fromTsRoot);
    expect(roots).toEqual(expect.arrayContaining(['apps/store-detail/app', 'apps/store-detail/lib']));
  });

  it('面と共有部品のソースに、ブランド色を文字色とする指定が無い', () => {
    const offenders = appAndSharedSourceRoots()
      .flatMap(listSources)
      .filter((path) => {
        const source = readFileSync(path, 'utf8');
        return BRAND_AS_TEXT.some((pattern) => pattern.test(source));
      })
      .map(fromTsRoot);
    expect(
      offenders,
      'ブランド色は白背景で 2.26:1 しかなく、大きい文字にも使えません。文字にはアクション色か本文色を使うこと',
    ).toEqual([]);
  });
});
