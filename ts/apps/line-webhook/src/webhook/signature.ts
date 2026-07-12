import { validateSignature } from '@line/bot-sdk';

// LINE Webhook の送信元検証（Requirement 7.1）。
// design.md「SignatureVerifier」契約: raw body（パース前の生文字列）と
// x-line-signature ヘッダを HMAC-SHA256（key=Channel Secret）で照合する。
// 不一致・ヘッダ欠落は例外を投げず false を返す（呼び出し側が 401 を返す）。
export interface SignatureVerifier {
  verify(rawBody: string, signatureHeader: string | undefined): boolean;
}

// @line/bot-sdk の validateSignature はヘッダ欠落（undefined）を渡すと
// 内部の Buffer.from(signature, 'base64') が例外を投げる実装のため、
// この契約（false を返す）に合わせるためにここで先にガードする。
export function createSignatureVerifier(channelSecret: string): SignatureVerifier {
  return {
    verify(rawBody: string, signatureHeader: string | undefined): boolean {
      if (!signatureHeader) {
        return false;
      }
      return validateSignature(rawBody, channelSecret, signatureHeader);
    },
  };
}
