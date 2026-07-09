import { describe, it, expect } from 'vitest';
import { createSessionTokenService } from '../src/lib/session-token';
import type { DraftMaterial } from '../src/lib/domain';

const KEY = 'test-signing-key-0123456789';
const STORE = '44444444-4444-4444-4444-444444444444';
const MATERIAL: DraftMaterial = {
  storeName: 'テスト店',
  star: 5,
  aspectLabels: ['味', '接客'],
  comment: 'おいしかった',
};

describe('createSessionTokenService', () => {
  it('鍵が空なら生成を拒否する', () => {
    expect(() => createSessionTokenService('')).toThrow();
  });

  describe('pageToken', () => {
    it('sign→verify 往復（正しい storeId）', () => {
      const svc = createSessionTokenService(KEY);
      const token = svc.signPage(STORE);
      const res = svc.verifyPage(token, STORE);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.storeId).toBe(STORE);
    });

    it('別 storeId での検証は INVALID', () => {
      const svc = createSessionTokenService(KEY);
      const token = svc.signPage(STORE);
      const res = svc.verifyPage(token, '00000000-0000-0000-0000-000000000000');
      expect(res).toEqual({ ok: false, error: 'INVALID' });
    });

    it('5 分経過で EXPIRED', () => {
      let clock = 1_000_000;
      const svc = createSessionTokenService(KEY, () => clock);
      const token = svc.signPage(STORE);
      clock += 5 * 60 * 1000 + 1;
      expect(svc.verifyPage(token, STORE)).toEqual({ ok: false, error: 'EXPIRED' });
    });
  });

  describe('sessionToken', () => {
    it('sign→verify 往復で material と attempt を保持', () => {
      const svc = createSessionTokenService(KEY);
      const token = svc.sign({ storeId: STORE, material: MATERIAL, attempt: 2 });
      const res = svc.verify(token);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.attempt).toBe(2);
        expect(res.value.material).toEqual(MATERIAL);
        expect(res.value.storeId).toBe(STORE);
      }
    });

    it('30 分経過で EXPIRED', () => {
      let clock = 1_000_000;
      const svc = createSessionTokenService(KEY, () => clock);
      const token = svc.sign({ storeId: STORE, material: MATERIAL, attempt: 0 });
      clock += 30 * 60 * 1000 + 1;
      expect(svc.verify(token)).toEqual({ ok: false, error: 'EXPIRED' });
    });
  });

  describe('改ざん・鍵不一致・不正形式', () => {
    it('本体改ざんは INVALID', () => {
      const svc = createSessionTokenService(KEY);
      const token = svc.sign({ storeId: STORE, material: MATERIAL, attempt: 0 });
      const [body, mac] = token.split('.');
      const tampered = `${body}x.${mac}`;
      expect(svc.verify(tampered)).toEqual({ ok: false, error: 'INVALID' });
    });

    it('別の鍵で署名されたトークンは INVALID', () => {
      const signer = createSessionTokenService('other-key-9999');
      const verifier = createSessionTokenService(KEY);
      const token = signer.sign({ storeId: STORE, material: MATERIAL, attempt: 0 });
      expect(verifier.verify(token)).toEqual({ ok: false, error: 'INVALID' });
    });

    it('ドット無しの不正形式は INVALID', () => {
      const svc = createSessionTokenService(KEY);
      expect(svc.verify('not-a-token')).toEqual({ ok: false, error: 'INVALID' });
    });
  });

  describe('kind 相互流用の拒否', () => {
    it('pageToken を verify（session）に渡すと INVALID', () => {
      const svc = createSessionTokenService(KEY);
      const pageToken = svc.signPage(STORE);
      expect(svc.verify(pageToken)).toEqual({ ok: false, error: 'INVALID' });
    });

    it('sessionToken を verifyPage に渡すと INVALID', () => {
      const svc = createSessionTokenService(KEY);
      const sessionToken = svc.sign({ storeId: STORE, material: MATERIAL, attempt: 0 });
      expect(svc.verifyPage(sessionToken, STORE)).toEqual({ ok: false, error: 'INVALID' });
    });
  });
});
