import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// structured survey の休眠状態と、接続するときの順序の不変条件（Issue #436・#441 の PR1）。
//
// PR1 は契約と検証だけを足し、客向けの画面・回答受付へは接続しない。接続は Issue #438（PR4）で行う。
//   - 「休眠」の 2 件は PR1 の時点の事実を固定する。Issue #438 で接続するときは、この 2 件を意図して
//     書き換える（黙って消えるのではなく、接続の PR の差分に現れるようにする）。
//   - 「不変条件」の 2 件は接続の後も残す。structured の pageToken を発行するなら回答受付が版を照合する
//     こと、structured の集計を呼ぶなら legacy の集計と同じ回答で併用しないこと。

const here = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(here, '../src/app');
const RESPONSES_HANDLER = resolve(APP_DIR, 'api/responses/handler.ts');

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

describe('structured survey の休眠状態（PR1・Issue #438 で接続するときに書き換える）', () => {
  it('走査対象のソースがある（空振りしない）', () => {
    expect(sourceFiles(APP_DIR).length).toBeGreaterThan(0);
    expect(readFileSync(RESPONSES_HANDLER, 'utf8')).toContain('verifyPage');
  });

  it('画面・API は structured の pageToken を発行しない', () => {
    expect(filesReferencing('signStructuredPage')).toEqual([]);
  });

  it('画面・API は structured の検証・集計・定義の読み取りを呼ばない', () => {
    for (const name of [
      'validateStructuredAnswer',
      'resolveStructuredAnswer',
      'incrementStructuredTallies',
      'readStoreSurveyDefinition',
    ]) {
      expect(filesReferencing(name), name).toEqual([]);
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
    for (const file of filesReferencing('incrementStructuredTallies')) {
      const src = readFileSync(file, 'utf8');
      if (src.includes('incrementTallies(')) expect(src, file).toContain('checkSurveyRevision');
    }
  });
});
