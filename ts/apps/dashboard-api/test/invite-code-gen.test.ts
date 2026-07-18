import { describe, it, expect, vi } from 'vitest';
import {
  INVITE_CODE_ALPHABET,
  INVITE_CODE_LENGTH,
  generateInviteCode,
  createUniqueInviteCode,
  isUniqueViolation,
} from '../src/invite-code-gen.js';

// pg の unique_violation（23505）を模したエラー。pg は Error 派生に code プロパティを持つ。
function uniqueViolation(): Error & { code: string } {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
  });
}

describe('generateInviteCode', () => {
  it('アルファベットは 31 字（0/O/1/I/L 除外）・長さ定数は 8', () => {
    expect(INVITE_CODE_ALPHABET).toBe('23456789ABCDEFGHJKMNPQRSTUVWXYZ');
    expect(INVITE_CODE_ALPHABET).toHaveLength(31);
    expect(INVITE_CODE_LENGTH).toBe(8);
    for (const ambiguous of ['0', 'O', '1', 'I', 'L']) {
      expect(INVITE_CODE_ALPHABET).not.toContain(ambiguous);
    }
  });

  it('実 crypto.randomInt で多数生成しても常に 8 文字・全文字が 31 字集合内（紛らわしい文字なし）', () => {
    const allowed = new Set(INVITE_CODE_ALPHABET.split(''));
    for (let i = 0; i < 300; i++) {
      const code = generateInviteCode();
      expect(code).toHaveLength(8);
      for (const ch of code) {
        expect(allowed.has(ch)).toBe(true);
      }
      expect(code).not.toMatch(/[0O1IL]/);
    }
  });

  it('注入 random が常に 0 を返すと先頭文字のみ（"22222222"）', () => {
    const random = vi.fn(() => 0);
    expect(generateInviteCode(random)).toBe('22222222');
    // 1 文字につき 1 回、上限は必ずアルファベット長（31）で呼ばれる。
    expect(random).toHaveBeenCalledTimes(8);
    for (const call of random.mock.calls) {
      expect(call[0]).toBe(31);
    }
  });

  it('注入 random が常に最終インデックス（30）を返すと末尾文字のみ（"ZZZZZZZZ"）', () => {
    expect(generateInviteCode(() => 30)).toBe('ZZZZZZZZ');
  });

  it('注入 random のインデックス列がそのままアルファベット位置に写像される', () => {
    // 0..7 → '23456789'（先頭 8 文字）。
    let i = 0;
    expect(generateInviteCode(() => i++)).toBe('23456789');
  });
});

describe('isUniqueViolation', () => {
  it('pg の code=23505 エラーを true と判定する', () => {
    expect(isUniqueViolation(uniqueViolation())).toBe(true);
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });

  it('23505 以外・code 無し・非オブジェクトは false', () => {
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });
});

describe('createUniqueInviteCode', () => {
  it('初回成功なら 1 回の create で結果を返す（既定 generate は 8 文字コードを渡す）', async () => {
    const create = vi.fn((code: string) => Promise.resolve({ code }));
    const result = await createUniqueInviteCode({ create });
    expect(create).toHaveBeenCalledTimes(1);
    const issued = create.mock.calls[0]?.[0];
    expect(issued).toHaveLength(8);
    expect(result).toEqual({ code: issued });
  });

  it('23505 衝突が 2 回続いた後に成功する（3 回の create が全て異なるコード）', async () => {
    const codes = ['AAAA2222', 'BBBB3333', 'CCCC4444'];
    let g = 0;
    const generate = vi.fn(() => codes[g++] ?? 'ZZZZ9999');
    const create = vi
      .fn<(code: string) => Promise<{ code: string }>>()
      .mockRejectedValueOnce(uniqueViolation())
      .mockRejectedValueOnce(uniqueViolation())
      .mockImplementationOnce((code: string) => Promise.resolve({ code }));

    const result = await createUniqueInviteCode({ create, generate });

    expect(create).toHaveBeenCalledTimes(3);
    const attempted = create.mock.calls.map((c) => c[0]);
    expect(attempted).toEqual(codes); // 毎試行 NEW コード（同一コードの再送ではない）
    expect(new Set(attempted).size).toBe(3);
    expect(result).toEqual({ code: 'CCCC4444' });
  });

  it('3 回とも 23505 なら投げる（最大 3 試行で打ち切り・4 回目は呼ばない）', async () => {
    const create = vi.fn(() => Promise.reject(uniqueViolation()));
    await expect(createUniqueInviteCode({ create })).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('23505 以外のエラーは即時 rethrow（リトライしない・create は 1 回のみ）', async () => {
    const dbDown = new Error('connection refused');
    const create = vi.fn(() => Promise.reject(dbDown));
    await expect(createUniqueInviteCode({ create })).rejects.toBe(dbDown);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
