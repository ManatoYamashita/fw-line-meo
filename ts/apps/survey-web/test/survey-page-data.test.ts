import { describe, it, expect, vi } from 'vitest';
import { loadSurveyPageData, type SurveyPageDeps, type StoreForPage } from '../src/app/s/[storeId]/page-data';
import type { SurveyLogger } from '../src/lib/structured-log';

const STORE = '44444444-4444-4444-4444-444444444444';

function deps(store: StoreForPage | null, over: Partial<SurveyPageDeps> = {}): SurveyPageDeps {
  return {
    findStore: () => Promise.resolve(store),
    listAspects: () => Promise.resolve([{ code: 'taste', label: '味' }]),
    signPage: (id) => `page-token-for-${id}`,
    buildReviewUrl: (placeId) => `https://review/${placeId}`,
    log: () => {},
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

  // Issue #137 段階3: 表示はファネルの分母。回答可能な状態で表示できたときだけ数える。
  it('ready のとき survey_page_viewed を storeId つきで 1 件出す', async () => {
    const log: SurveyLogger = vi.fn();
    await loadSurveyPageData(
      deps({ id: STORE, name: 'テスト店', placeId: 'ChIJ', placeStatus: 'confirmed' }, { log }),
      STORE,
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('info', 'survey_page_viewed', { storeId: STORE });
  });

  it('unavailable のときは数えない（回答へ進める状態ではないため分母に入れない）', async () => {
    const log: SurveyLogger = vi.fn();
    await loadSurveyPageData(deps(null, { log }), STORE);
    await loadSurveyPageData(
      deps({ id: STORE, name: '店', placeId: null, placeStatus: 'pending' }, { log }),
      STORE,
    );
    expect(log).not.toHaveBeenCalled();
  });
});
