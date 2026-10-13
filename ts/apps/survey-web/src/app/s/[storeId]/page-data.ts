import { surveyDefinitionFingerprint, type StoreSurveyDefinition, type StructuredSurveyDefinition } from '@fwlm/db';
import type { AspectOption } from './types';
import { logSurveyPageViewed, type SurveyLogger } from '../../../lib/structured-log';

// アンケートページの SSR データロード（依存注入でテスト可能・DB/token を切り離す）。

export interface StoreForPage {
  id: string;
  name: string;
  placeId: string | null;
  placeStatus: 'pending' | 'confirmed';
  /** 利用停止の時刻（Issue #252）。null なら利用中。 */
  suspendedAt: Date | null;
}

export interface SurveyPageDeps {
  findStore: (id: string) => Promise<StoreForPage | null>;
  /** 店舗の有効なアンケート定義（@fwlm/db の readStoreSurveyDefinition）。1 回の表示につき 1 回だけ読む。 */
  readDefinition: (storeId: string) => Promise<StoreSurveyDefinition>;
  listAspects: () => Promise<AspectOption[]>;
  signPage: (storeId: string) => string;
  signStructuredPage: (storeId: string, surveyRevision: number, definitionFingerprint: string) => string;
  buildReviewUrl: (placeId: string) => string;
  log: SurveyLogger;
}

export type SurveyPageData =
  | { kind: 'unavailable' }
  | {
      kind: 'ready';
      /** 設定行が無い・structured_enabled = false の店舗（既定）。従来の観点の一覧で回答する。 */
      mode: 'legacy';
      store: { id: string; name: string };
      aspects: AspectOption[];
      pageToken: string;
      googleReviewUrl: string;
    }
  | {
      kind: 'ready';
      /** structured survey の店舗（Issue #438）。店舗別の定義で段階的に回答する。 */
      mode: 'structured';
      store: { id: string; name: string };
      definition: StructuredSurveyDefinition;
      pageToken: string;
      googleReviewUrl: string;
    };

/**
 * 店舗が存在し place 確定済みかつ利用中なら回答可能データを、そうでなければ unavailable を返す。
 * 停止中（Issue #252）は店舗を特定できない場合と同じ表示にし、停止中であることを客へ示さない。
 */
export async function loadSurveyPageData(
  deps: SurveyPageDeps,
  storeId: string,
): Promise<SurveyPageData> {
  const store = await deps.findStore(storeId);
  if (!store || store.placeStatus !== 'confirmed' || store.suspendedAt !== null || !store.placeId) {
    return { kind: 'unavailable' };
  }
  // 種類は店舗の設定で決まる（Issue #438）。定義は 1 回だけ読み、structured なら **その結果** から指紋を計算して
  // 版と一緒に pageToken へ署名する。送信時は回答受付が現在の定義を読み直して同じ計算で照合する。
  const definition = await deps.readDefinition(store.id);
  const storeView = { id: store.id, name: store.name };
  const googleReviewUrl = deps.buildReviewUrl(store.placeId);
  if (definition.mode === 'structured') {
    logSurveyPageViewed(deps.log, store.id);
    return {
      kind: 'ready',
      mode: 'structured',
      store: storeView,
      definition,
      pageToken: deps.signStructuredPage(store.id, definition.revision, surveyDefinitionFingerprint(definition)),
      googleReviewUrl,
    };
  }
  const aspects = await deps.listAspects();
  // ファネルの分母（Issue #137 段階3）。**回答可能な状態で表示できたときだけ** 数える。
  // 店舗不在・place 未確定は客が回答へ進める状態ではなく、離脱として数えると
  // 「導線を変えたら獲得率がどう動いたか」の分母が別物になる。
  logSurveyPageViewed(deps.log, store.id);
  return {
    kind: 'ready',
    mode: 'legacy',
    store: storeView,
    aspects,
    pageToken: deps.signPage(store.id),
    googleReviewUrl,
  };
}
