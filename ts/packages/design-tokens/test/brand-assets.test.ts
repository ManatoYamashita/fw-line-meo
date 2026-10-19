// リポジトリ直下の assets/ が、ブランド系の画像を漏れなく指していることの照合（Issue #463）。
//
// assets/ には本物の画像を置かず、各アプリの画像へのシンボリックリンクだけを置く。本物は元の場所から
// 動かせない。アイコンは Next.js のファイル規約で各アプリの app/ に要り、本番のイメージは ts/ だけを
// ビルドの範囲にして作るためである。リンクは、実体が動くと黙って切れる。新しい画像を足してもリンクを
// 張り忘れれば、assets/ から見えないまま残る。その両方をここで塞ぐ。
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const assetsDir = join(repoRoot, 'assets');
const appsDir = join(repoRoot, 'ts', 'apps');

/** ブランド系の画像とみなす置き場所（ts/apps からの相対パス）。 */
const BRAND_IMAGE: readonly RegExp[] = [
  // Next.js のファイル規約のアイコン（src を持つ面と持たない面の両方）
  /^[^/]+\/(?:src\/)?app\/(?:icon|apple-icon)\.png$/,
  /^[^/]+\/public\/ogp\.(?:jpg|webp)$/,
  /^[^/]+\/public\/brand-icon\.png$/,
  /^[^/]+\/public\/screenshots\/[^/]+\.png$/,
  /^[^/]+\/assets\/richmenu-[^/]+\.png$/,
];

/** いまの件数。画像を足したら、リンクを張ってこの数も増やす。 */
const EXPECTED_COUNT = 18;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === '.next' || name === 'dist') return [];
    // リンクはたどらずに 1 件として数える（assets/ の中身はリンクそのものを見る）。
    if (lstatSync(path).isDirectory()) return walk(path);
    return [path];
  });
}

const toPosix = (path: string) => path.split('\\').join('/');

function brandImages(): string[] {
  return walk(appsDir)
    .map((path) => toPosix(relative(appsDir, path)))
    .filter((path) => BRAND_IMAGE.some((pattern) => pattern.test(path)))
    .sort();
}

function links(): string[] {
  return existsSync(assetsDir) ? walk(assetsDir).filter((path) => !path.endsWith('.md')) : [];
}

describe('assets/ のリンク', () => {
  it('抽出の自己検証: 置き場所の規則がブランド系の画像を拾い、ほかの画像は拾わない', () => {
    const hits = (path: string) => BRAND_IMAGE.some((pattern) => pattern.test(path));
    expect(hits('survey-web/src/app/icon.png')).toBe(true);
    expect(hits('store-detail/app/apple-icon.png')).toBe(true);
    expect(hits('dashboard-web/public/ogp.webp')).toBe(true);
    expect(hits('survey-web/public/screenshots/draft.png')).toBe(true);
    expect(hits('line-webhook/assets/richmenu-completed.png')).toBe(true);
    // Google の規定どおりの素材は対象外。
    expect(hits('dashboard-web/public/google-g-logo.png')).toBe(false);
    expect(hits('survey-web/test/fixtures/icon.png')).toBe(false);
  });

  it(`ブランド系の画像は ${EXPECTED_COUNT} 件ある（両方が空のまま一致して素通りしない）`, () => {
    expect(brandImages()).toHaveLength(EXPECTED_COUNT);
    expect(links()).toHaveLength(EXPECTED_COUNT);
  });

  it('assets/ の中身はすべて相対パスのシンボリックリンクで、切れていない', () => {
    for (const link of links()) {
      const name = toPosix(relative(repoRoot, link));
      expect(lstatSync(link).isSymbolicLink(), `${name} がリンクではなく実体です。実体は各アプリに置く`).toBe(
        true,
      );
      const target = readlinkSync(link);
      expect(isAbsolute(target), `${name} が絶対パスを指しています（他の環境で切れる）`).toBe(false);
      const resolved = resolve(dirname(link), target);
      expect(existsSync(resolved) && statSync(resolved).isFile(), `${name} のリンクが切れています`).toBe(true);
    }
  });

  it('ブランド系の画像とリンクの指す先が一致する（両方向）', () => {
    // 作業コピーの置き場所自体がリンクの下にあっても比べられるよう、基準も実体のパスへ解決する。
    const appsReal = realpathSync(appsDir);
    const targets = links()
      .map((link) => toPosix(relative(appsReal, realpathSync(link))))
      .sort();
    expect(
      targets,
      'ブランド系の画像を足したら assets/ にリンクを張り、assets/README.md の一覧にも載せること',
    ).toEqual(brandImages());
  });
});
