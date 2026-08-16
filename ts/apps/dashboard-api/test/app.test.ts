import { describe, it, expect } from 'vitest';
import { createApp, clampSize, type AppDeps } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { QrDeps } from '../src/qr.js';

// 最小の QR deps（healthz とルート配線の確認用。RBAC 詳細は qr.test / 6.2 が担う）。
function fakeQrDeps(): QrDeps {
  return {
    auth: {
      verifier: {
        verifyIdToken: (t) =>
          Promise.resolve({ uid: t, email: null, emailVerified: false, signInProvider: null }),
      },
      findUser: () => Promise.resolve(null),
      linkByEmail: () => Promise.resolve(null),
    },
    findStore: () => Promise.resolve(null),
    renderQr: () => Promise.resolve(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    surveyBaseUrl: 'https://survey.example',
  };
}

// createApp は全業務ルート用の deps を要求する。healthz と CORS 非適用の確認には
// qr 以外はハンドラを呼ばない（未認証で早期 401）ため、認証面のみ最小スタブで満たす。
function stubAuth() {
  return {
    verifier: {
      verifyIdToken: (t: string) =>
        Promise.resolve({ uid: t, email: null, emailVerified: false, signInProvider: null }),
    },
    findUser: () => Promise.resolve(null),
    linkByEmail: () => Promise.resolve(null),
  };
}

function fakeAppDeps(): AppDeps {
  const auth = stubAuth();
  const notCalled = () => {
    throw new Error('not wired in this test');
  };
  return {
    corsOrigin: 'https://dash.example',
    qr: fakeQrDeps(),
    me: { auth, findAgencyName: notCalled, findDisplayName: notCalled },
    stores: { auth, listStores: notCalled },
    owners: { auth, listOwners: notCalled },
    categories: { auth, listCategories: notCalled },
    storeRegistration: {
      search: { auth, searchCandidates: notCalled },
      register: {
        auth,
        findOwner: notCalled,
        isValidCategory: notCalled,
        registerStore: notCalled,
      },
    },
    inviteCodes: {
      list: { auth, listInviteCodes: notCalled },
      issue: { auth, issueCode: notCalled },
      disable: { auth, disableCode: notCalled },
    },
    admin: {
      agenciesList: { auth, listAgencies: notCalled },
      agencyCreate: { auth, createAgency: notCalled },
      usersList: { auth, listUsers: notCalled },
      userCreate: { auth, createUser: notCalled, findUserByEmailInOperator: notCalled },
      userDisable: { auth, disableUser: notCalled },
      userEnable: { auth, enableUser: notCalled },
    },
  };
}

function app(): ReturnType<typeof createApp> {
  return createApp(fakeAppDeps());
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
  const fullEnv = {
    SURVEY_BASE_URL: 'https://survey.example',
    DASHBOARD_WEB_ORIGIN: 'https://dash.example',
    PLACES_API_KEY: 'places-key',
    PORT: '9090',
  };

  it('必須 env が揃えば設定を返す', () => {
    const config = loadConfig(fullEnv);
    expect(config.surveyBaseUrl).toBe('https://survey.example');
    expect(config.corsOrigin).toBe('https://dash.example');
    expect(config.placesApiKey).toBe('places-key');
    expect(config.port).toBe(9090);
  });

  it('SURVEY_BASE_URL 欠落は明示エラー', () => {
    expect(() => loadConfig({})).toThrow(/SURVEY_BASE_URL/);
  });

  it('DASHBOARD_WEB_ORIGIN 欠落は明示エラー', () => {
    expect(() =>
      loadConfig({ SURVEY_BASE_URL: 'https://survey.example', PLACES_API_KEY: 'places-key' }),
    ).toThrow(/DASHBOARD_WEB_ORIGIN/);
  });

  it('PLACES_API_KEY 欠落は明示エラー', () => {
    expect(() =>
      loadConfig({ SURVEY_BASE_URL: 'https://survey.example', DASHBOARD_WEB_ORIGIN: 'https://dash.example' }),
    ).toThrow(/PLACES_API_KEY/);
  });
});
