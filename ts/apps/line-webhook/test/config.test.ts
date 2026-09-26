import { describe, it, expect } from 'vitest';
import { GBP_ENV_KEYS, loadConfig } from '../src/config.js';

// GBP を使わない本番の env（Issue #323 の既定 OFF。GBP API の利用承認まではこの形で動く）。
const baseEnv = {
  LINE_CHANNEL_ID: 'channel-id',
  LINE_CHANNEL_SECRET: 'channel-secret',
  PLACES_API_KEY: 'places-key',
  LINE_RICHMENU_COMPLETED_ID: 'richmenu-completed',
  LIFF_STORE_DETAIL_URL: 'https://liff.line.me/test-liff-id',
};

// GBP を有効にする env 一式。
const gbpEnv = {
  GBP_OAUTH_CLIENT_ID: 'gbp-client-id',
  GBP_OAUTH_CLIENT_SECRET: 'gbp-client-secret',
  GBP_OAUTH_REDIRECT_URL: 'https://api.firstweb-works.com/gbp/oauth/callback',
  GBP_TOKEN_CIPHER_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  GEMINI_API_KEY: 'gemini-key',
};

function without(env: Record<string, string>, key: string): Record<string, string> {
  const next: Record<string, string> = { ...env };
  delete next[key];
  return next;
}

describe('loadConfig', () => {
  it('必須 env が揃っていれば設定を返し、PORT 未指定は既定 8080。GBP の env が無ければ GBP は OFF（null）', () => {
    const config = loadConfig(baseEnv);
    expect(config).toEqual({
      lineChannelId: 'channel-id',
      lineChannelSecret: 'channel-secret',
      placesApiKey: 'places-key',
      lineRichMenuCompletedId: 'richmenu-completed',
      liffStoreDetailUrl: 'https://liff.line.me/test-liff-id',
      gbp: null,
      port: 8080,
    });
  });

  it('PORT を指定すればその値を使用する', () => {
    const config = loadConfig({ ...baseEnv, PORT: '9090' });
    expect(config.port).toBe(9090);
  });

  it.each(Object.keys(baseEnv))('%s 欠落は明示エラー', (key) => {
    expect(() => loadConfig(without(baseEnv, key))).toThrow(new RegExp(key));
  });

  it('全 env 欠落は最初に検証した必須項目のエラーを投げる', () => {
    expect(() => loadConfig({})).toThrow(/LINE_CHANNEL_ID/);
  });

  it('GEMINI_API_KEY だけがあっても GBP は OFF のまま（survey-web と共有の secret で、GBP の有効化の合図ではない）', () => {
    expect(loadConfig({ ...baseEnv, GEMINI_API_KEY: 'gemini-key' }).gbp).toBeNull();
  });
});

describe('GBP の設定（既定 OFF・Issue #323）', () => {
  it('GBP の env が全部あれば GBP を ON にする', () => {
    expect(loadConfig({ ...baseEnv, ...gbpEnv }).gbp).toEqual({
      oauthClientId: 'gbp-client-id',
      oauthClientSecret: 'gbp-client-secret',
      oauthRedirectUrl: 'https://api.firstweb-works.com/gbp/oauth/callback',
      tokenCipherKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      geminiApiKey: 'gemini-key',
    });
  });

  // 入れ忘れを黙って OFF にしない。1 つでも欠けていれば、欠けている名前を出して起動時に落とす。
  it.each(GBP_ENV_KEYS)('GBP の env のうち %s だけが欠けていれば、その名前を出して起動時に落とす', (key) => {
    expect(() => loadConfig(without({ ...baseEnv, ...gbpEnv }, key))).toThrow(
      new RegExp(`一部だけ設定されています（不足: ${key}）`),
    );
  });

  it.each(GBP_ENV_KEYS)('GBP の env が %s の 1 つだけでも、残りの不足を出して起動時に落とす', (key) => {
    expect(() => loadConfig({ ...baseEnv, [key]: 'x' })).toThrow(/一部だけ設定されています/);
  });

  it('GBP を ON にするなら GEMINI_API_KEY も要る', () => {
    expect(() => loadConfig(without({ ...baseEnv, ...gbpEnv }, 'GEMINI_API_KEY'))).toThrow(/GEMINI_API_KEY/);
  });
});
