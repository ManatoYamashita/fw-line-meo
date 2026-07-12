import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { createSignatureVerifier } from '../../src/webhook/signature.js';

const channelSecret = 'test-channel-secret';

// テスト自身が実際に HMAC-SHA256 で署名を計算する（固定文字列の比較ではなく、
// validateSignature の暗号学的な検証ロジックを本当に通していることを証明する）。
function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

describe('createSignatureVerifier', () => {
  it('正しい署名は true を返す', () => {
    const verifier = createSignatureVerifier(channelSecret);
    const rawBody = '{"destination":"Uxxxxxxxx","events":[]}';
    const signature = sign(rawBody, channelSecret);

    expect(verifier.verify(rawBody, signature)).toBe(true);
  });

  it('改竄された body は false を返す', () => {
    const verifier = createSignatureVerifier(channelSecret);
    const rawBody = '{"destination":"Uxxxxxxxx","events":[]}';
    const signature = sign(rawBody, channelSecret);
    const tamperedBody = '{"destination":"Uyyyyyyyy","events":[]}';

    expect(verifier.verify(tamperedBody, signature)).toBe(false);
  });

  it('異なるチャネルシークレットで計算された署名は false を返す', () => {
    const verifier = createSignatureVerifier(channelSecret);
    const rawBody = '{"destination":"Uxxxxxxxx","events":[]}';
    const signature = sign(rawBody, 'wrong-channel-secret');

    expect(verifier.verify(rawBody, signature)).toBe(false);
  });

  it('署名ヘッダが undefined の場合は例外を投げず false を返す', () => {
    const verifier = createSignatureVerifier(channelSecret);
    const rawBody = '{"destination":"Uxxxxxxxx","events":[]}';

    expect(verifier.verify(rawBody, undefined)).toBe(false);
  });

  it('署名ヘッダが空文字の場合は false を返す', () => {
    const verifier = createSignatureVerifier(channelSecret);
    const rawBody = '{"destination":"Uxxxxxxxx","events":[]}';

    expect(verifier.verify(rawBody, '')).toBe(false);
  });
});
