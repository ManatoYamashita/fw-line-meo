import type { AspectOption } from './types';

// アンケートページの SSR データロード（依存注入でテスト可能・DB/token を切り離す）。

export interface StoreForPage {
  id: string;
  name: string;
  placeId: string | null;
  placeStatus: 'pending' | 'confirmed';
}

export interface SurveyPageDeps {
  findStore: (id: string) => Promise<StoreForPage | null>;
  listAspects: () => Promise<AspectOption[]>;
  signPage: (storeId: string) => string;
  buildReviewUrl: (placeId: string) => string;
}

export type SurveyPageData =
  | { kind: 'unavailable' }
  | {
      kind: 'ready';
      store: { id: string; name: string };
      aspects: AspectOption[];
      pageToken: string;
      googleReviewUrl: string;
    };

/** 店舗が存在し place 確定済みなら回答可能データを、そうでなければ unavailable を返す。 */
export async function loadSurveyPageData(
  deps: SurveyPageDeps,
  storeId: string,
): Promise<SurveyPageData> {
  const store = await deps.findStore(storeId);
  if (!store || store.placeStatus !== 'confirmed' || !store.placeId) {
    return { kind: 'unavailable' };
  }
  const aspects = await deps.listAspects();
  return {
    kind: 'ready',
    store: { id: store.id, name: store.name },
    aspects,
    pageToken: deps.signPage(store.id),
    googleReviewUrl: deps.buildReviewUrl(store.placeId),
  };
}
