import { describe, it, expect } from 'vitest';
import { createRateLimiter } from '../src/lib/rate-limit';

describe('createRateLimiter', () => {
  it('ウィンドウ内は limit 回まで許可し、超過を抑止する', () => {
    const rl = createRateLimiter({ limit: 3, windowMs: 1000, now: () => 0 });
    expect(rl.check('ip1')).toBe(true);
    expect(rl.check('ip1')).toBe(true);
    expect(rl.check('ip1')).toBe(true);
    expect(rl.check('ip1')).toBe(false); // 4 回目は抑止
  });

  it('ウィンドウ経過で解放される', () => {
    let clock = 0;
    const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => clock });
    expect(rl.check('ip1')).toBe(true);
    expect(rl.check('ip1')).toBe(false);
    clock += 1000; // ウィンドウ経過
    expect(rl.check('ip1')).toBe(true);
  });

  it('key ごとに独立してカウントする', () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
    expect(rl.check('ip1')).toBe(true);
    expect(rl.check('ip2')).toBe(true); // 別 key は影響しない
    expect(rl.check('ip1')).toBe(false);
  });
});
