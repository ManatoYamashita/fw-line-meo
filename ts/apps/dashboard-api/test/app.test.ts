import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('dashboard-api app', () => {
  it('GET /healthz は 200 で status ok を返す', async () => {
    const app = createApp();
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
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
