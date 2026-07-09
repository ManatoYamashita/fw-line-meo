import { describe, it, expect, vi } from 'vitest';
import { loadSurveyPageData, type SurveyPageDeps, type StoreForPage } from '../src/app/s/[storeId]/page-data';

const STORE = '44444444-4444-4444-4444-444444444444';

function deps(store: StoreForPage | null, over: Partial<SurveyPageDeps> = {}): SurveyPageDeps {
  return {
    findStore: () => Promise.resolve(store),
    listAspects: () => Promise.resolve([{ code: 'taste', label: '味' }]),
    signPage: (id) => `page-token-for-${id}`,
    buildReviewUrl: (placeId) => `https://review/${placeId}`,
    ...over,
  };
}

describe('loadSurveyPageData', () => {
  it('確定店舗は ready（pageToken・googleReviewUrl を同梱）', async () => {
    const data = await loadSurveyPageData(
      deps({ id: STORE, name: 'テスト店', placeId: 'ChIJ', placeStatus: 'confirmed' }),
      STORE,
    );
    expect(data.kind).toBe('ready');
    if (data.kind === 'ready') {
      expect(data.store).toEqual({ id: STORE, name: 'テスト店' });
      expect(data.pageToken).toBe(`page-token-for-${STORE}`);
      expect(data.googleReviewUrl).toBe('https://review/ChIJ');
      expect(data.aspects).toHaveLength(1);
    }
  });

  it('店舗不在は unavailable', async () => {
    const data = await loadSurveyPageData(deps(null), STORE);
    expect(data.kind).toBe('unavailable');
  });

  it('place 未確定は unavailable（aspects も引かない）', async () => {
    const listAspects = vi.fn(() => Promise.resolve([]));
    const data = await loadSurveyPageData(
      deps({ id: STORE, name: '店', placeId: null, placeStatus: 'pending' }, { listAspects }),
      STORE,
    );
    expect(data.kind).toBe('unavailable');
    expect(listAspects).not.toHaveBeenCalled();
  });
});
