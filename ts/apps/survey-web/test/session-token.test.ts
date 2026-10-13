import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  createSessionTokenService,
  checkSurveyRevision,
  type PagePayload,
} from '../src/lib/session-token';
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

  describe('structured の pageToken（Issue #436・Issue #438）', () => {
    // 有効な定義の指紋の形（SHA-256 の base64url・43 文字）。
    const FP = 'A'.repeat(43);
    const FP2 = 'B'.repeat(43);

    // 署名鍵を知る者だけが作れる任意の body の token（版の印の扱いを検証する）。
    function forge(payload: object): string {
      const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
      return `${body}.${createHmac('sha256', KEY).update(body).digest('base64url')}`;
    }

    it('sign→verify 往復で surveyRevision と定義の指紋を保持する', () => {
      const svc = createSessionTokenService(KEY, () => 1_000);
      const res = svc.verifyPage(svc.signStructuredPage(STORE, 7, FP), STORE);
      expect(res).toEqual({
        ok: true,
        value: {
          kind: 'page',
          v: 2,
          storeId: STORE,
          surveyRevision: 7,
          definitionFingerprint: FP,
          exp: 1_000 + 5 * 60 * 1000,
        },
      });
    });

    it('legacy の pageToken は従来どおりの形で検証できる（版の印を足さない）', () => {
      const svc = createSessionTokenService(KEY, () => 1_000);
      const token = svc.signPage(STORE);
      const body = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'));
      expect(body).toEqual({ kind: 'page', storeId: STORE, exp: 1_000 + 5 * 60 * 1000 });
      expect(svc.verifyPage(token, STORE)).toEqual({
        ok: true,
        value: { kind: 'page', storeId: STORE, exp: 1_000 + 5 * 60 * 1000 },
      });
    });

    it('別 storeId・期限切れは legacy と同じく拒否する', () => {
      let clock = 1_000_000;
      const svc = createSessionTokenService(KEY, () => clock);
      const token = svc.signStructuredPage(STORE, 2, FP);
      expect(svc.verifyPage(token, '00000000-0000-0000-0000-000000000000')).toEqual({
        ok: false,
        error: 'INVALID',
      });
      clock += 5 * 60 * 1000 + 1;
      expect(svc.verifyPage(token, STORE)).toEqual({ ok: false, error: 'EXPIRED' });
    });

    it('未知の版・不正な surveyRevision・指紋の欠落や形の誤りは署名が正しくても拒否する', () => {
      const svc = createSessionTokenService(KEY, () => 1_000);
      const exp = 10_000;
      const definitionFingerprint = FP;
      for (const payload of [
        { kind: 'page', v: 3, storeId: STORE, surveyRevision: 1, definitionFingerprint, exp },
        { kind: 'page', v: 2, storeId: STORE, definitionFingerprint, exp },
        { kind: 'page', v: 2, storeId: STORE, surveyRevision: 0, definitionFingerprint, exp },
        { kind: 'page', v: 2, storeId: STORE, surveyRevision: 1.5, definitionFingerprint, exp },
        { kind: 'page', v: 2, storeId: STORE, surveyRevision: '1', definitionFingerprint, exp },
        // PR1 の形（指紋なし）は受け付けない。
        { kind: 'page', v: 2, storeId: STORE, surveyRevision: 1, exp },
        { kind: 'page', v: 2, storeId: STORE, surveyRevision: 1, definitionFingerprint: 'short', exp },
        { kind: 'page', v: 2, storeId: STORE, surveyRevision: 1, definitionFingerprint: 42, exp },
      ]) {
        expect(svc.verifyPage(forge(payload), STORE)).toEqual({ ok: false, error: 'INVALID' });
      }
    });

    it('surveyRevision が正の整数でなければ署名しない', () => {
      const svc = createSessionTokenService(KEY);
      for (const bad of [0, -1, 1.5, Number.NaN]) {
        expect(() => svc.signStructuredPage(STORE, bad, FP)).toThrow();
      }
      expect(() => svc.signStructuredPage(STORE, 1, 'not-a-fingerprint')).toThrow();
    });

    it('structured の pageToken は sessionToken として通らない（相互流用の拒否）', () => {
      const svc = createSessionTokenService(KEY);
      expect(svc.verify(svc.signStructuredPage(STORE, 1, FP))).toEqual({ ok: false, error: 'INVALID' });
    });

    it('別の指紋を署名した token は別物として検証される（指紋も署名に含まれる）', () => {
      const svc = createSessionTokenService(KEY, () => 1_000);
      const a = svc.verifyPage(svc.signStructuredPage(STORE, 1, FP), STORE);
      const b = svc.verifyPage(svc.signStructuredPage(STORE, 1, FP2), STORE);
      expect(a.ok && 'v' in a.value ? a.value.definitionFingerprint : null).toBe(FP);
      expect(b.ok && 'v' in b.value ? b.value.definitionFingerprint : null).toBe(FP2);
    });
  });

  describe('checkSurveyRevision（Issue #436・Issue #438）', () => {
    const FP = 'A'.repeat(43);
    const legacyPage: PagePayload = { kind: 'page', storeId: STORE, exp: 1 };
    const structuredPage = (surveyRevision: number, definitionFingerprint = FP): PagePayload => ({
      kind: 'page',
      v: 2,
      storeId: STORE,
      surveyRevision,
      definitionFingerprint,
      exp: 1,
    });
    const structured = (revision: number, definitionFingerprint = FP) =>
      ({ mode: 'structured', revision, definitionFingerprint }) as const;

    it('legacy の画面 × legacy の店舗は legacy として受け付ける（従来どおり）', () => {
      expect(checkSurveyRevision(legacyPage, { mode: 'legacy' })).toEqual({ ok: true, value: 'legacy' });
    });

    it('structured の画面 × 同じ版は structured として受け付ける', () => {
      expect(checkSurveyRevision(structuredPage(4), structured(4))).toEqual({
        ok: true,
        value: 'structured',
      });
    });

    it('表示の後に設定が変わった（版が違う）回答は古い画面として拒否する', () => {
      expect(checkSurveyRevision(structuredPage(4), structured(5))).toEqual({
        ok: false,
        error: 'STALE_SURVEY',
      });
    });

    it('版が同じでも、定義の指紋が違う（全店舗共通の taxonomy が変わった）回答は拒否する', () => {
      expect(checkSurveyRevision(structuredPage(4), structured(4, 'B'.repeat(43)))).toEqual({
        ok: false,
        error: 'STALE_SURVEY',
      });
    });

    it('表示の後に店舗が structured を有効 / 無効にした回答は拒否する', () => {
      expect(checkSurveyRevision(legacyPage, structured(1))).toEqual({
        ok: false,
        error: 'STALE_SURVEY',
      });
      expect(checkSurveyRevision(structuredPage(1), { mode: 'legacy' })).toEqual({
        ok: false,
        error: 'STALE_SURVEY',
      });
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
