import type { AspectOption } from './types';
import { logSurveyPageViewed, type SurveyLogger } from '../../../lib/structured-log';

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
  log: SurveyLogger;
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
  // ファネルの分母（Issue #137 段階3）。**回答可能な状態で表示できたときだけ** 数える。
  // 店舗不在・place 未確定は客が回答へ進める状態ではなく、離脱として数えると
  // 「導線を変えたら獲得率がどう動いたか」の分母が別物になる。
  logSurveyPageViewed(deps.log, store.id);
  return {
    kind: 'ready',
    store: { id: store.id, name: store.name },
    aspects,
    pageToken: deps.signPage(store.id),
    googleReviewUrl: deps.buildReviewUrl(store.placeId),
  };
}
