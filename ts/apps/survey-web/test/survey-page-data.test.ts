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
      deps({ id: STORE, name: 'テスト店', placeId: 'ChIJ', placeStatus: 'confirmed', suspendedAt: null }),
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
      deps({ id: STORE, name: '店', placeId: null, placeStatus: 'pending', suspendedAt: null }, { listAspects }),
      STORE,
    );
    expect(data.kind).toBe('unavailable');
    expect(listAspects).not.toHaveBeenCalled();
  });

  // Issue #252: 停止中の店舗は、店舗を特定できない場合と同じ unavailable にする（Requirement 5.1）。
  // 回答の入力を出さないため、選択肢も引かず、表示の分母にも数えない。
  it('停止中の確定店舗は unavailable（aspects も引かず、表示も数えない）', async () => {
    const listAspects = vi.fn(() => Promise.resolve([{ code: 'taste', label: '味' }]));
    const signPage = vi.fn((id: string) => `page-token-for-${id}`);
    const log: SurveyLogger = vi.fn();
    const data = await loadSurveyPageData(
      deps(
        {
          id: STORE,
          name: 'テスト店',
          placeId: 'ChIJ',
          placeStatus: 'confirmed',
          suspendedAt: new Date('2026-09-01T00:00:00Z'),
        },
        { listAspects, signPage, log },
      ),
      STORE,
    );
    expect(data).toEqual({ kind: 'unavailable' });
    expect(listAspects).not.toHaveBeenCalled();
    expect(signPage).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('再開された店舗（suspendedAt が null に戻った）は通常どおり ready（Requirement 5.4）', async () => {
    let suspendedAt: Date | null = new Date('2026-09-01T00:00:00Z');
    const findStore = () =>
      Promise.resolve({ id: STORE, name: 'テスト店', placeId: 'ChIJ', placeStatus: 'confirmed' as const, suspendedAt });
    expect((await loadSurveyPageData(deps(null, { findStore }), STORE)).kind).toBe('unavailable');
    suspendedAt = null;
    const data = await loadSurveyPageData(deps(null, { findStore }), STORE);
    expect(data.kind).toBe('ready');
    if (data.kind === 'ready') expect(data.pageToken).toBe(`page-token-for-${STORE}`);
  });

  // Issue #137 段階3: 表示はファネルの分母。回答可能な状態で表示できたときだけ数える。
  it('ready のとき survey_page_viewed を storeId つきで 1 件出す', async () => {
    const log: SurveyLogger = vi.fn();
    await loadSurveyPageData(
      deps({ id: STORE, name: 'テスト店', placeId: 'ChIJ', placeStatus: 'confirmed', suspendedAt: null }, { log }),
      STORE,
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('info', 'survey_page_viewed', { storeId: STORE });
  });

  it('unavailable のときは数えない（回答へ進める状態ではないため分母に入れない）', async () => {
    const log: SurveyLogger = vi.fn();
    await loadSurveyPageData(deps(null, { log }), STORE);
    await loadSurveyPageData(
      deps({ id: STORE, name: '店', placeId: null, placeStatus: 'pending', suspendedAt: null }, { log }),
      STORE,
    );
    expect(log).not.toHaveBeenCalled();
  });
});
