import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';

describe('line-webhook app', () => {
  it('GET /healthz は 200 で status ok を返す', async () => {
    const res = await createApp().request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
