import { describe, it, expect } from 'vitest';
import { createApp, clampSize, type AppDeps } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { QrDeps } from '../src/qr.js';

// 最小の QR deps（healthz とルート配線の確認用。RBAC 詳細は qr.test / 6.2 が担う）。
function fakeQrDeps(): QrDeps {
  return {
    auth: {
      verifier: { verifyIdToken: (t) => Promise.resolve({ uid: t }) },
      findUser: () => Promise.resolve(null),
    },
    findStore: () => Promise.resolve(null),
    renderQr: () => Promise.resolve(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    surveyBaseUrl: 'https://survey.example',
  };
}

function app(): ReturnType<typeof createApp> {
  const deps: AppDeps = { qr: fakeQrDeps() };
  return createApp(deps);
}

describe('dashboard-api app', () => {
  it('GET /healthz は 200 で status ok を返す', async () => {
    const res = await app().request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('QR ルートが配線され認証なしは 401 を返す', async () => {
    const res = await app().request('/stores/44444444-4444-4444-4444-444444444444/qr.png');
    expect(res.status).toBe(401);
  });
});

describe('clampSize', () => {
  it('既定は 512', () => {
    expect(clampSize(undefined)).toBe(512);
  });
  it('128 未満は 128、1024 超は 1024 に clamp', () => {
    expect(clampSize('10')).toBe(128);
    expect(clampSize('5000')).toBe(1024);
    expect(clampSize('256')).toBe(256);
  });
  it('不正値は既定 512', () => {
    expect(clampSize('abc')).toBe(512);
  });
});

describe('loadConfig', () => {
  it('SURVEY_BASE_URL があれば設定を返す', () => {
    const config = loadConfig({ SURVEY_BASE_URL: 'https://survey.example', PORT: '9090' });
    expect(config.surveyBaseUrl).toBe('https://survey.example');
    expect(config.port).toBe(9090);
  });

  it('SURVEY_BASE_URL 欠落は明示エラー', () => {
    expect(() => loadConfig({})).toThrow(/SURVEY_BASE_URL/);
  });
});
