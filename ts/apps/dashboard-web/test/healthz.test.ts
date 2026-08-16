import { describe, it, expect } from 'vitest';
import { GET } from '../src/app/healthz/route';

describe('healthz GET', () => {
  it('200 と { status: "ok" } を返す', async () => {
    const res = GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'ok' });
  });
});
