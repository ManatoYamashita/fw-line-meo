import { describe, it, expect } from 'vitest';

import { qrFileName } from '../src/lib/qr-filename';

// 保存ファイル名の決定規則（Requirements 2.4, 2.5, 2.6）。
// DOM・ネットワークに依存しない純粋関数なので node 環境で検証する。

const ID_A = '11111111-2222-3333-4444-555555555555';
const ID_B = '99999999-8888-7777-6666-555555555555';

// 制御文字はソースへ直接書かず符号位置から組み立てる（NUL / BEL / ESC / DEL）。
const CONTROL_CHARS = [0, 7, 27, 127].map((code) => String.fromCharCode(code));

describe('qrFileName', () => {
  it('店名を含み .png で終わる（2.4）', () => {
    const name = qrFileName('炭火焼肉 やました', ID_A);
    expect(name).toContain('炭火焼肉 やました');
    expect(name.endsWith('.png')).toBe(true);
  });

  it('同一店名でも店舗 ID が異なれば別のファイル名になる（2.6）', () => {
    expect(qrFileName('同じ名前の店', ID_A)).not.toBe(qrFileName('同じ名前の店', ID_B));
  });

  it('同一の店名・店舗 ID に対して常に同一の値を返す（2.6）', () => {
    expect(qrFileName('同じ名前の店', ID_A)).toBe(qrFileName('同じ名前の店', ID_A));
  });

  it('一覧の内容に依存せず店舗 ID の断片を常に含む（2.6）', () => {
    expect(qrFileName('店A', ID_A)).toContain(ID_A.slice(0, 8));
  });

  it('パス区切り・予約文字を残さない（2.5）', () => {
    const name = qrFileName('a/b\\c:d*e?f"g<h>i|j klm', ID_A);
    for (const forbidden of ['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
      expect(name).not.toContain(forbidden);
    }
    expect(name.endsWith('.png')).toBe(true);
  });

  it('制御文字を残さない（2.5）', () => {
    const name = qrFileName(`焼${CONTROL_CHARS.join('')}鳥`, ID_A);
    for (const forbidden of CONTROL_CHARS) {
      expect(name).not.toContain(forbidden);
    }
    expect(name).toContain('焼');
    expect(name).toContain('鳥');
  });

  it('前後の空白と点を落とし、連続空白を 1 つへ畳む（2.5）', () => {
    const name = qrFileName('  ..海鮮   丼   ..  ', ID_A);
    expect(name).toContain('海鮮 丼');
    expect(name).not.toContain('海鮮   丼');
  });

  it('正規化後に空になる店名でも非空で .png を返す（2.5）', () => {
    const name = qrFileName('///...   ', ID_A);
    expect(name.endsWith('.png')).toBe(true);
    expect(name.replace(/\.png$/, '').length).toBeGreaterThan(0);
    expect(name).toContain(ID_A.slice(0, 8));
  });

  it('店名が空文字でも非空で .png を返す（2.5）', () => {
    const name = qrFileName('', ID_A);
    expect(name.endsWith('.png')).toBe(true);
    expect(name).toContain(ID_A.slice(0, 8));
  });

  it('極端に長い店名でもファイル名全体が保存先の制約に収まる長さになる（2.5）', () => {
    const name = qrFileName('あ'.repeat(500), ID_A);
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name.endsWith('.png')).toBe(true);
    expect(name).toContain('あ');
  });
});
