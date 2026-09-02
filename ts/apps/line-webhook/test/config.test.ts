import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const validEnv = {
  LINE_CHANNEL_ID: 'channel-id',
  LINE_CHANNEL_SECRET: 'channel-secret',
  PLACES_API_KEY: 'places-key',
  LINE_RICHMENU_COMPLETED_ID: 'richmenu-completed',
  LIFF_STORE_DETAIL_URL: 'https://liff.line.me/test-liff-id',
  GBP_OAUTH_CLIENT_ID: 'gbp-client-id',
  GBP_OAUTH_CLIENT_SECRET: 'gbp-client-secret',
  GBP_OAUTH_REDIRECT_URL: 'https://line-webhook.example.com/gbp/oauth/callback',
  GBP_TOKEN_CIPHER_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  GEMINI_API_KEY: 'gemini-key',
};

function withoutKey(key: keyof typeof validEnv): Record<string, string> {
  const env: Record<string, string> = { ...validEnv };
  delete env[key];
  return env;
}

describe('loadConfig', () => {
  it('必須 env が揃っていれば設定を返し、PORT 未指定は既定 8080', () => {
    const config = loadConfig(validEnv);
    expect(config).toEqual({
      lineChannelId: 'channel-id',
      lineChannelSecret: 'channel-secret',
      placesApiKey: 'places-key',
      lineRichMenuCompletedId: 'richmenu-completed',
      liffStoreDetailUrl: 'https://liff.line.me/test-liff-id',
      gbpOauthClientId: 'gbp-client-id',
      gbpOauthClientSecret: 'gbp-client-secret',
      gbpOauthRedirectUrl: 'https://line-webhook.example.com/gbp/oauth/callback',
      gbpTokenCipherKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      geminiApiKey: 'gemini-key',
      port: 8080,
    });
  });

  it('PORT を指定すればその値を使用する', () => {
    const config = loadConfig({ ...validEnv, PORT: '9090' });
    expect(config.port).toBe(9090);
  });

  it('LINE_CHANNEL_ID 欠落は明示エラー', () => {
    expect(() => loadConfig(withoutKey('LINE_CHANNEL_ID'))).toThrow(/LINE_CHANNEL_ID/);
  });

  it('LINE_CHANNEL_SECRET 欠落は明示エラー', () => {
    expect(() => loadConfig(withoutKey('LINE_CHANNEL_SECRET'))).toThrow(/LINE_CHANNEL_SECRET/);
  });

  it('PLACES_API_KEY 欠落は明示エラー', () => {
    expect(() => loadConfig(withoutKey('PLACES_API_KEY'))).toThrow(/PLACES_API_KEY/);
  });

  it('LINE_RICHMENU_COMPLETED_ID 欠落は明示エラー', () => {
    expect(() => loadConfig(withoutKey('LINE_RICHMENU_COMPLETED_ID'))).toThrow(
      /LINE_RICHMENU_COMPLETED_ID/,
    );
  });

  it('LIFF_STORE_DETAIL_URL 欠落は明示エラー', () => {
    expect(() => loadConfig(withoutKey('LIFF_STORE_DETAIL_URL'))).toThrow(/LIFF_STORE_DETAIL_URL/);
  });

  it('GBP_OAUTH_CLIENT_ID 欠落は明示エラー', () => {
    expect(() => loadConfig(withoutKey('GBP_OAUTH_CLIENT_ID'))).toThrow(/GBP_OAUTH_CLIENT_ID/);
  });

  it('GBP_OAUTH_CLIENT_SECRET 欠落は明示エラー', () => {
    expect(() => loadConfig(withoutKey('GBP_OAUTH_CLIENT_SECRET'))).toThrow(
      /GBP_OAUTH_CLIENT_SECRET/,
    );
  });

  it('GBP_OAUTH_REDIRECT_URL 欠落は明示エラー', () => {
    expect(() => loadConfig(withoutKey('GBP_OAUTH_REDIRECT_URL'))).toThrow(
      /GBP_OAUTH_REDIRECT_URL/,
    );
  });

  it('GBP_TOKEN_CIPHER_KEY 欠落は明示エラー', () => {
    expect(() => loadConfig(withoutKey('GBP_TOKEN_CIPHER_KEY'))).toThrow(/GBP_TOKEN_CIPHER_KEY/);
  });

  it('GEMINI_API_KEY 欠落は明示エラー', () => {
    expect(() => loadConfig(withoutKey('GEMINI_API_KEY'))).toThrow(/GEMINI_API_KEY/);
  });

  it('全 env 欠落は最初に検証した必須項目のエラーを投げる', () => {
    expect(() => loadConfig({})).toThrow(/LINE_CHANNEL_ID/);
  });
});
