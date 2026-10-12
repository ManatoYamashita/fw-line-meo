import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// API クライアントをモジュールごと差し替える検査は、取得の結果を deferResolution で
// 遅らせること（Issue #298）。付け忘れた検査ファイルでは、取得の前の画面に触る race が
// 手元では通り、負荷の高い CI でだけ落ちる状態へ戻る。

const TEST_DIR = resolve(process.cwd(), 'test');
// 連結で組むのは、この検査ファイル自身が照合に一致しないようにするため（除外表を広げない）。
const API_MOCK = 'vi.mock(' + "'../src/lib/api',";

/**
 * 差し替えるが包まない検査ファイル。取得は props（右の名前）で注入していて、モジュールの
 * 差し替えは api.ts が取り込む './firebase' の実 SDK を発火させないためだけにある。
 * 注入の props が消えたら（= 取得がモジュール経由に戻ったら）除外の根拠も消えるので、赤にする。
 */
const EXEMPT: Readonly<Record<string, string>> = {
  'store-qr-panel.test.tsx': 'fetchQr={',
  'store-review-funnel.test.tsx': 'fetchFunnel={',
};

/** 包んでいる検査ファイルの数。実測へ合わせて宣言を書き換える改変を素通りさせないため literal で持つ。 */
const EXPECTED_DEFERRED = 8;

function apiMockStatements(source: string): string[] {
  const statements: string[] = [];
  let from = source.indexOf(API_MOCK);
  while (from !== -1) {
    // vi.mock の呼び出しは `);` を行末に持つ行で閉じる（factory が複数行でも同じ）。
    const end = source.indexOf(');\n', from);
    statements.push(source.slice(from, end === -1 ? undefined : end + 2));
    from = source.indexOf(API_MOCK, from + API_MOCK.length);
  }
  return statements;
}

describe('取得のモックの遅延（Issue #298）', () => {
  const files = readdirSync(TEST_DIR).filter((name) => /\.test\.tsx?$/.test(name));
  const mocking = files.filter((name) =>
    readFileSync(resolve(TEST_DIR, name), 'utf8').includes(API_MOCK),
  );

  it('API クライアントを差し替える検査は、除外を除いてすべて deferResolution を通す', () => {
    const missing: string[] = [];
    let deferred = 0;
    for (const name of mocking) {
      if (name in EXEMPT) continue;
      const statements = apiMockStatements(readFileSync(resolve(TEST_DIR, name), 'utf8'));
      expect(statements.length, name).toBeGreaterThan(0);
      if (statements.every((statement) => statement.includes('deferResolution('))) deferred += 1;
      else missing.push(name);
    }
    expect(missing, '包んでいない差し替え').toEqual([]);
    expect(deferred).toBe(EXPECTED_DEFERRED);
  });

  it('除外は、実際に差し替えていて、取得を props で注入している検査に限る', () => {
    let checked = 0;
    for (const [name, injection] of Object.entries(EXEMPT)) {
      expect(mocking, `${name} は差し替えていない（除外が不要）`).toContain(name);
      const source = readFileSync(resolve(TEST_DIR, name), 'utf8');
      expect(source.includes(injection), `${name} が ${injection} で取得を注入していない`).toBe(true);
      expect(source.includes('deferResolution('), `${name} は包んでいる（除外が不要）`).toBe(false);
      checked += 1;
    }
    expect(checked).toBe(2);
  });
});
