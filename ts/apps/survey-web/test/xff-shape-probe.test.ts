import { describe, expect, it } from 'vitest';

import {
  XFF_PROBE_MARKER,
  XFF_SHAPE_HEADER,
  withXffShape,
  xffShape,
} from '../src/app/api/review-link-opened/xff-shape-probe';

// 一時的な計測（Issue #344）の契約。来店客の要求には何も付けないこと、IP そのものを返さないことを固定する。

function req(xff?: string): Request {
  const headers = new Headers();
  if (xff !== undefined) headers.set('x-forwarded-for', xff);
  return new Request('https://example.test/api/review-link-opened', { method: 'POST', headers });
}

describe('xffShape', () => {
  it('目印を含まない要求では何も返さない（来店客の要求）', () => {
    expect(xffShape(req())).toBeNull();
    expect(xffShape(req('198.51.100.7'))).toBeNull();
    expect(xffShape(req('198.51.100.7, 192.0.2.1'))).toBeNull();
  });

  it('目印を含む要求では並びを返し、目印以外は 8 桁のハッシュにする', () => {
    const shape = xffShape(req(`${XFF_PROBE_MARKER}, 198.51.100.7, 192.0.2.1`));
    expect(shape).not.toBeNull();
    const parts = (shape as string).split(',');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('probe');
    expect(parts[1]).toMatch(/^[0-9a-f]{8}$/);
    expect(parts[2]).toMatch(/^[0-9a-f]{8}$/);
    expect(parts[1]).not.toBe(parts[2]);
    expect(shape).not.toContain('198.51.100.7');
    expect(shape).not.toContain('192.0.2.1');
  });
});

describe('withXffShape', () => {
  it('目印が無ければ応答をそのまま返す', () => {
    const res = new Response(null, { status: 400 });
    expect(withXffShape(req('198.51.100.7'), res)).toBe(res);
  });

  it('目印があれば状態コードを保ったまま応答ヘッダへ載せる', () => {
    const out = withXffShape(req(XFF_PROBE_MARKER), new Response(null, { status: 429 }));
    expect(out.status).toBe(429);
    expect(out.headers.get(XFF_SHAPE_HEADER)).toBe('probe');
  });
});
