import type { StoreCandidate } from '@fwlm/db';

// Google Places API (New) searchText の型付きラッパ（design.md「PlacesSearchAdapter」）。
// Requirement 3.1: 店名→候補最大 10 件（店名＋住所）。
// Requirement 3.2: 0 件時は型付き結果 `empty`（呼び出し側の ConversationHandlers が再入力案内を送る）。
// Requirement 3.3: 検索失敗時は型付き結果 `error`（呼び出し側が進捗を保持したままエラー案内を送る）。
// Requirement 3.5: 候補取得は Google 公式手段（Places API (New)）のみ。スクレイピング等は行わない。
//
// StoreCandidate は onboarding_sessions.candidates（jsonb）の要素型と同一契約のため、
// 型の二重定義を避けるためここでは @fwlm/db からそのまま再利用する。
//
// FieldMask は SKU 課金区分を固定する設計判断（research.md「Google Places API (New) Text Search」）。
// id/displayName/formattedAddress/location/types のみ＝Pro SKU。rating 等を混ぜると
// Enterprise SKU に昇格するため、ここに 1 文字でも足してはならない。
const FIELD_MASK =
  'places.id,places.displayName,places.formattedAddress,places.location,places.types';

const SEARCH_TEXT_URL = 'https://places.googleapis.com/v1/places:searchText';

// design.md 契約: AbortController で 1.5 秒タイムアウト（固定・注入不可）。
const TIMEOUT_MS = 1500;

export type SearchOutcome =
  | { kind: 'found'; candidates: readonly StoreCandidate[] } // 1..10 件
  | { kind: 'empty' }
  | { kind: 'error' }; // 外部要因の失敗（3.3）

export interface PlacesSearchAdapter {
  searchCandidates(storeName: string): Promise<SearchOutcome>;
}

export interface PlacesSearchAdapterDeps {
  apiKey: string;
  // グローバル fetch を直接使わず注入する（テスト容易性・実行時の環境依存を切り離すため）。
  // 実配線（タスク 4.2）では Node 22 のネイティブ fetch をそのまま渡す想定。
  fetch: typeof fetch;
}

// Places API (New) searchText の実レスポンス形状（FieldMask で固定した必要フィールドのみ）。
interface RawPlace {
  id?: unknown;
  displayName?: { text?: unknown };
  formattedAddress?: unknown;
  location?: { latitude?: unknown; longitude?: unknown };
  types?: unknown;
}

interface RawSearchTextResponse {
  places?: RawPlace[];
}

// レスポンス 1 件を StoreCandidate へマッピングする。必須フィールドのいずれかが
// 期待した型でない場合（パース不能）は null を返し、呼び出し側で error 扱いにする。
function toStoreCandidate(raw: RawPlace): StoreCandidate | null {
  const placeId = raw.id;
  const name = raw.displayName?.text;
  const address = raw.formattedAddress;
  const latitude = raw.location?.latitude;
  const longitude = raw.location?.longitude;

  if (
    typeof placeId !== 'string' ||
    typeof name !== 'string' ||
    typeof address !== 'string' ||
    typeof latitude !== 'number' ||
    typeof longitude !== 'number'
  ) {
    return null;
  }

  const types = Array.isArray(raw.types) ? raw.types.filter((t): t is string => typeof t === 'string') : [];

  return { placeId, name, address, latitude, longitude, types };
}

export function createPlacesSearchAdapter(deps: PlacesSearchAdapterDeps): PlacesSearchAdapter {
  return {
    async searchCandidates(storeName: string): Promise<SearchOutcome> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const response = await deps.fetch(SEARCH_TEXT_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': deps.apiKey,
            'X-Goog-FieldMask': FIELD_MASK,
          },
          body: JSON.stringify({
            textQuery: storeName,
            languageCode: 'ja',
            regionCode: 'JP',
            pageSize: 10,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          // HTTP 失敗（非2xx）。検索クエリ（店名）はログに出力しない（3.5 隣接のプライバシー規律）。
          return { kind: 'error' };
        }

        let body: RawSearchTextResponse;
        try {
          body = (await response.json()) as RawSearchTextResponse;
        } catch {
          // パース不能。
          return { kind: 'error' };
        }

        const rawPlaces = Array.isArray(body.places) ? body.places : [];
        if (rawPlaces.length === 0) {
          return { kind: 'empty' };
        }

        const candidates: StoreCandidate[] = [];
        for (const raw of rawPlaces) {
          const candidate = toStoreCandidate(raw);
          if (!candidate) {
            // 想定フィールドを欠いたレスポンス＝パース不能として扱う。
            return { kind: 'error' };
          }
          candidates.push(candidate);
        }

        return { kind: 'found', candidates };
      } catch {
        // fetch 自体の失敗（ネットワークエラー・AbortController によるタイムアウト含む）。
        return { kind: 'error' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
