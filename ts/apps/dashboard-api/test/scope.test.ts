import { describe, it, expect } from 'vitest';
import { resolveAgencyScope, requireOperator } from '../src/scope.js';
import type { DashboardUserIdentity } from '@fwlm/db';

// 純粋ユニット（DB 不要）。ロールと要求 agencyId から有効スコープを一意に解決する（2.1–2.3, 5.4, 6.5）。
const OP: DashboardUserIdentity = { id: 'u1', role: 'operator', operatorId: 'op1', agencyId: null };
const AG: DashboardUserIdentity = { id: 'u2', role: 'agency', operatorId: 'op1', agencyId: 'ag1' };

describe('resolveAgencyScope', () => {
  it('operator + 未指定 → all（全代理店）', () => {
    expect(resolveAgencyScope(OP, undefined)).toEqual({ ok: true, scope: { kind: 'all' } });
  });

  it('operator + 指定 → single(指定 agencyId)', () => {
    expect(resolveAgencyScope(OP, 'agX')).toEqual({ ok: true, scope: { kind: 'single', agencyId: 'agX' } });
  });

  it('agency + 未指定 → single(自代理店)', () => {
    expect(resolveAgencyScope(AG, undefined)).toEqual({ ok: true, scope: { kind: 'single', agencyId: 'ag1' } });
  });

  it('agency + 自代理店指定 → single(自代理店)', () => {
    expect(resolveAgencyScope(AG, 'ag1')).toEqual({ ok: true, scope: { kind: 'single', agencyId: 'ag1' } });
  });

  it('agency + 他代理店指定 → 403（サーバー側拒否）', () => {
    expect(resolveAgencyScope(AG, 'ag2')).toEqual({ ok: false, status: 403 });
  });

  it('agency で agencyId が null（構造上あり得ないが防御的に）→ 403', () => {
    const bad: DashboardUserIdentity = { id: 'u3', role: 'agency', operatorId: 'op1', agencyId: null };
    expect(resolveAgencyScope(bad, undefined)).toEqual({ ok: false, status: 403 });
  });
});

describe('requireOperator', () => {
  it('operator は true', () => {
    expect(requireOperator(OP)).toBe(true);
  });

  it('agency は false', () => {
    expect(requireOperator(AG)).toBe(false);
  });
});
