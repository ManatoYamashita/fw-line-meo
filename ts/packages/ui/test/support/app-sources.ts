// 面のソースを走査するテストの共通部分。走査範囲を 1 箇所に持ち、テストごとに範囲がずれないようにする。
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const tsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** 面のソースを置くディレクトリ。store-detail は src を持たず app と lib に置くので、src だけでは漏れる。 */
export const APP_SOURCE_DIRS = ['src', 'app', 'lib'] as const;

/** 面のソース（.ts / .tsx / .css）を再帰的に列挙する。 */
export function listSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listSources(path);
    return /\.(?:tsx?|css)$/.test(name) ? [path] : [];
  });
}

/** 全アプリの面のソースの根。 */
export function appSourceRoots(): string[] {
  const appsDir = join(tsRoot, 'apps');
  return readdirSync(appsDir)
    .flatMap((app) => APP_SOURCE_DIRS.map((dir) => join(appsDir, app, dir)))
    .filter((root) => existsSync(root));
}

/** 全アプリの面と共有部品のソースの根。 */
export function appAndSharedSourceRoots(): string[] {
  return [...appSourceRoots(), join(tsRoot, 'packages', 'ui', 'src')];
}

/** tsRoot からの相対パス（区切りは `/`）。 */
export function fromTsRoot(path: string): string {
  return relative(tsRoot, path).split('\\').join('/');
}
