import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// structured survey を画面・回答受付へ接続した後の不変条件（Issue #438）。
//
// PR1（Issue #436）の時点では「休眠（どこからも呼ばない）」をここで固定していた。Issue #438 で接続したので、
// 休眠の 2 件は「接続の形」の 2 件へ置き換えた（黙って消えたのではなく、この差分として残る）。不変条件は残す:
//   - structured の pageToken を発行するなら、回答受付は種類・版・指紋を照合する（verifyPage だけで受理しない）
//   - structured の集計と legacy の集計を同じファイルで呼ぶなら、照合の結果でどちらか一方へ振り分ける
// 制御フロー（照合 → 分岐・定義の読み取り 1 回・集計の排他）は test/api-responses-structured.test.ts が
// 実際の token を通して確かめる。ここはソースの形だけを見る（接続の経路が増えたときの網）。

const here = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(here, '../src/app');
const RESPONSES_HANDLER = resolve(APP_DIR, 'api/responses/handler.ts');
const PAGE_DATA = resolve(APP_DIR, 's/[storeId]/page-data.ts');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function filesReferencing(name: string): string[] {
  return sourceFiles(APP_DIR).filter((f) => readFileSync(f, 'utf8').includes(name));
}

describe('structured survey の接続の形（Issue #438）', () => {
  it('走査対象のソースがある（空振りしない）', () => {
    expect(sourceFiles(APP_DIR).length).toBeGreaterThan(0);
    expect(readFileSync(RESPONSES_HANDLER, 'utf8')).toContain('verifyPage');
  });

  it('structured の pageToken を発行するのは、画面のデータの読み込み（page-data / page）だけ', () => {
    const issuers = filesReferencing('signStructuredPage').map((f) => relative(APP_DIR, f).split(sep).join('/'));
    // page.tsx が署名鍵で実際に署名し、page-data.ts はそれを依存として受け取って呼ぶ。
    expect(issuers.sort()).toEqual(['s/[storeId]/page-data.ts', 's/[storeId]/page.tsx']);
    // 署名する指紋は、表示に使ったのと同じ読み取りの結果から計算する。
    expect(readFileSync(PAGE_DATA, 'utf8')).toContain('surveyDefinitionFingerprint');
  });

  it('回答受付は定義を読み、指紋を計算し、structured の検証・解決・集計を呼ぶ', () => {
    const src = readFileSync(RESPONSES_HANDLER, 'utf8');
    for (const name of [
      'readDefinition',
      'surveyDefinitionFingerprint',
      'checkSurveyRevision',
      'validateStructuredAnswer',
      'resolveStructuredAnswer',
      'incrementStructuredTallies',
    ]) {
      expect(src, name).toContain(name);
    }
  });
});

describe('structured survey を接続するときの不変条件', () => {
  it('structured の pageToken を発行するなら、回答受付は版を照合する（verifyPage だけで受理しない）', () => {
    if (filesReferencing('signStructuredPage').length === 0) return;
    expect(readFileSync(RESPONSES_HANDLER, 'utf8')).toContain('checkSurveyRevision');
  });

  it('structured の集計と legacy の集計を同じファイルで呼ぶなら、どちらか一方へ振り分ける', () => {
    // incrementStructuredTallies は星も加算するので、同じ回答に incrementTallies を併せて呼ぶと
    // 星が二重に数えられる。静的に排他を証明はできないので、両方を参照するファイルには版の照合
    // （checkSurveyRevision の戻り値で legacy / structured を振り分ける）が在ることを要求する。
    // route.ts は 2 つの集計を依存として配線するだけで、振り分けるのは同じディレクトリの handler.ts である。
    // その場合は handler.ts に照合が在ることを要求する。
    for (const file of filesReferencing('incrementStructuredTallies')) {
      const src = readFileSync(file, 'utf8');
      if (!src.includes('incrementTallies(')) continue;
      const router = file.endsWith(`${sep}route.ts`) ? join(dirname(file), 'handler.ts') : file;
      expect(readFileSync(router, 'utf8'), router).toContain('checkSurveyRevision');
    }
  });
});
