import { describe, it, expect } from 'vitest';
import { resolvePoolMode } from '../src/pool.js';

describe('resolvePoolMode', () => {
  it('DATABASE_URL があれば database-url モード', () => {
    expect(resolvePoolMode({ DATABASE_URL: 'postgres://x@/db' })).toBe('database-url');
  });

  it('DATABASE_URL が無ければ cloud-sql-iam モード', () => {
    expect(resolvePoolMode({})).toBe('cloud-sql-iam');
  });

  it('空文字の DATABASE_URL は未設定とみなす', () => {
    expect(resolvePoolMode({ DATABASE_URL: '' })).toBe('cloud-sql-iam');
  });
});
