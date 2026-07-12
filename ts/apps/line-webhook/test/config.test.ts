import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const validEnv = {
  LINE_CHANNEL_ID: 'channel-id',
  LINE_CHANNEL_SECRET: 'channel-secret',
  PLACES_API_KEY: 'places-key',
  LINE_RICHMENU_COMPLETED_ID: 'richmenu-completed',
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

  it('全 env 欠落は最初に検証した必須項目のエラーを投げる', () => {
    expect(() => loadConfig({})).toThrow(/LINE_CHANNEL_ID/);
  });
});
