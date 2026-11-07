import { describe, expect, it } from 'vitest';
import {
  choiceToDestinations,
  decodeCrosspostPostback,
  encodeCrosspostPostback,
  isCrosspostPostbackData,
  type CrosspostPostback,
} from '../../src/crosspost/postback.js';
import { isGbpPostbackData } from '../../src/gbp/postback.js';

const D = '11111111-2222-4333-8444-555555555555';
const V = '66666666-7777-4888-9999-000000000000';

describe('crosspost postback', () => {
  const samples: CrosspostPostback[] = [
    { action: 'x_start', storeId: null },
    { action: 'x_start', storeId: D },
    { action: 'x_resume' },
    { action: 'x_new', storeId: null },
    { action: 'x_new', storeId: D },
    { action: 'x_gen', draftId: D },
    { action: 'x_regen', draftId: D, revision: 3, destination: 'instagram' },
    { action: 'x_ai', draftId: D, revision: 0, destination: 'google' },
    { action: 'x_edit', draftId: D, revision: 12, destination: 'google' },
    { action: 'x_view', draftId: D },
    { action: 'x_conf', draftId: D, revision: 4, choice: 'both' },
    { action: 'x_ok', draftId: D, revision: 4, choice: 'google' },
    { action: 'x_cancel', draftId: D },
    { action: 'x_status' },
    { action: 'x_retry', deliveryId: V },
    { action: 'x_check', deliveryId: V },
    { action: 'x_seen', deliveryId: V, posted: true },
    { action: 'x_seen', deliveryId: V, posted: false },
  ];

  it.each(samples)('往復できる: %o', (sample) => {
    const encoded = encodeCrosspostPostback(sample);
    expect(encoded.length).toBeLessThanOrEqual(300);
    expect(isCrosspostPostbackData(encoded)).toBe(true);
    expect(isGbpPostbackData(encoded)).toBe(false);
    expect(decodeCrosspostPostback(encoded)).toEqual(sample);
  });

  it.each([
    'a=x_ok&d=not-a-uuid&r=1&t=both',
    `a=x_ok&d=${D}&r=-1&t=both`,
    `a=x_ok&d=${D}&r=1.5&t=both`,
    `a=x_ok&d=${D}&r=1&t=tiktok`,
    `a=x_ok&d=${D}&t=both`,
    `a=x_regen&d=${D}&r=1&k=facebook`,
    `a=x_seen&v=${V}&y=2`,
    `a=x_unknown`,
    `a=x_ok&d=${D}&r=1&t=both&pad=${'x'.repeat(300)}`,
    '',
  ])('形の誤りは null: %s', (data) => {
    expect(decodeCrosspostPostback(data)).toBeNull();
  });

  it('GBP・レポートの data は一括発信のものと見なさない', () => {
    expect(isCrosspostPostbackData('a=g_post')).toBe(false);
    expect(isCrosspostPostbackData('a=rpt&k=nr')).toBe(false);
    expect(isCrosspostPostbackData('a=x_anything')).toBe(true);
  });

  it('選び方を投稿先の並びにする', () => {
    expect(choiceToDestinations('both')).toEqual(['instagram', 'google']);
    expect(choiceToDestinations('google')).toEqual(['google']);
  });
});
