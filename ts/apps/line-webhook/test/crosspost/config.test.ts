import { describe, expect, it } from 'vitest';
import { loadCrosspostConfig } from '../../src/crosspost/config.js';

const S1 = '11111111-2222-4333-8444-555555555555';
const S2 = 'AAAAAAAA-2222-4333-8444-555555555555';

describe('loadCrosspostConfig', () => {
  it('env が無ければ null（既定 OFF）', () => {
    expect(loadCrosspostConfig({})).toBeNull();
  });

  it('全部あれば有効。店舗 ID は小文字にそろえ、重複を除く', () => {
    expect(
      loadCrosspostConfig({
        CROSSPOST_PILOT_STORE_IDS: ` ${S1},${S2},${S1} `,
        CROSSPOST_MEDIA_BUCKET: 'fwlm-crosspost-media',
        GEMINI_API_KEY: 'k',
      }),
    ).toEqual({ pilotStoreIds: [S1, S2.toLowerCase()], mediaBucket: 'fwlm-crosspost-media', googleEnabled: false });
  });

  it('一部だけなら起動時に落とし、不足を示す', () => {
    expect(() => loadCrosspostConfig({ CROSSPOST_PILOT_STORE_IDS: S1 })).toThrow(/CROSSPOST_MEDIA_BUCKET/);
    expect(() => loadCrosspostConfig({ CROSSPOST_MEDIA_BUCKET: 'b-ucket' })).toThrow(/CROSSPOST_PILOT_STORE_IDS/);
  });

  it('形の誤り・GEMINI_API_KEY の欠落・Google の有効化だけの指定を拒む', () => {
    const base = { CROSSPOST_PILOT_STORE_IDS: S1, CROSSPOST_MEDIA_BUCKET: 'fwlm-media', GEMINI_API_KEY: 'k' };
    expect(() => loadCrosspostConfig({ ...base, CROSSPOST_PILOT_STORE_IDS: 'store-1' })).toThrow(/UUID/);
    expect(() => loadCrosspostConfig({ ...base, CROSSPOST_MEDIA_BUCKET: 'Bad_Bucket!' })).toThrow(/バケット/);
    expect(() => loadCrosspostConfig({ ...base, GEMINI_API_KEY: '' })).toThrow(/GEMINI_API_KEY/);
    expect(() => loadCrosspostConfig({ ...base, CROSSPOST_GOOGLE_ENABLED: 'yes' })).toThrow(/CROSSPOST_GOOGLE_ENABLED/);
    expect(() => loadCrosspostConfig({ CROSSPOST_GOOGLE_ENABLED: '1' })).toThrow(/CROSSPOST_PILOT_STORE_IDS/);
    expect(loadCrosspostConfig({ ...base, CROSSPOST_GOOGLE_ENABLED: '1' })?.googleEnabled).toBe(true);
  });
});
