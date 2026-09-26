import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Next.js の standalone 出力は public/ を含まない。実行段で明示的にコピーしないと、public/ の
// ファイルは開発サーバーでは見えるのに本番だけ 404 になる（dashboard-web の Issue #146 でログインの G ロゴが実際にそうなった。OGP 画像も同じ経路で配る）。

const appRoot = path.join(import.meta.dirname, '..');
const dockerfile = readFileSync(path.join(appRoot, 'Dockerfile'), 'utf8');

/** 最後の FROM 以降（実行段）だけを取り出す。build 段の COPY で満たされたと誤読しないため。 */
function runtimeStage(text: string): string {
  const lines = text.split('\n');
  const last = lines.map((l) => /^FROM\s/i.test(l)).lastIndexOf(true);
  return lines.slice(last).join('\n');
}

describe('Dockerfile は public/ を実行段へコピーする', () => {
  it('public/ に配信するファイルがある（前提）', () => {
    const dir = path.join(appRoot, 'public');
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir).length).toBeGreaterThan(0);
  });

  it('実行段に public/ の COPY がある', () => {
    const copies = runtimeStage(dockerfile)
      .split('\n')
      .filter((l) => /^COPY\s/i.test(l.trim()));
    expect(
      copies.some((l) => /\/apps\/store-detail\/public\s+\.\/apps\/store-detail\/public\s*$/.test(l.trim())),
      copies.join('\n'),
    ).toBe(true);
  });
});
