import {
  createConfirmedStore,
  findStoreByPlaceId,
  markOwnerStoreIdentified,
  type Queryable,
  type StoreCandidate,
} from '@fwlm/db';
import type { PlacesSearchAdapter, SearchOutcome } from '../places/search.js';

// 店舗特定サービス（design.md「StoreIdentificationService（拡張縫）」）。
// Requirement 3.1: 店名検索は PlacesSearchAdapter（2.3）にそのまま委譲する。
// Requirement 4.2: confirmStore は stores INSERT（confirmed・place_id 設定）→
//   owners.onboarding_status 更新を単一トランザクションで行う。
// Requirement 4.4: 登録済み Place（ux_stores_place_id UNIQUE 違反。競合レース含む）は
//   `place_already_registered` に正規化する（例外を投げない）。
//
// LINE・会話・セッションの概念には依存しない（引数は ownerId と候補データのみ）。
// LIFF・代理店ダッシュボード（Issue #5 代行）が将来この契約をそのまま再利用する想定。

// stores テーブルには address/types の格納列が無いため、確定時は
// name/lat/lng/place_id のみ永続化する（StoreCandidate の他フィールドは捨てる）。

const PLACE_ID_UNIQUE_CONSTRAINT = 'ux_stores_place_id';

export type ConfirmOutcome =
  | { kind: 'confirmed'; storeId: string }
  | { kind: 'place_already_registered' }; // Req 4.4

export interface StoreIdentificationService {
  searchCandidates(storeName: string): Promise<SearchOutcome>;
  confirmStore(ownerId: string, candidate: StoreCandidate): Promise<ConfirmOutcome>;
}

// pg.Pool/PoolClient と構造的に互換な最小面（`pg` を line-webhook の直接依存に
// 追加しないための自前インターフェース。実配線では @fwlm/db の getPool() 戻り値をそのまま渡せる）。
export interface TransactionClient extends Queryable {
  release(): void;
}

export interface ConnectablePool {
  connect(): Promise<TransactionClient>;
}

export interface StoreIdentificationDeps {
  pool: ConnectablePool;
  places: PlacesSearchAdapter;
}

// pg driver が投げる DatabaseError の必要フィールドのみを型付ける（`pg` 型を直接 import しない）。
interface PossiblePgError {
  code?: string;
  constraint?: string;
}

// `ux_stores_place_id` の一意制約違反だけを狭く判定する。他の一意制約違反まで
// 誤って `place_already_registered` に丸めないため、code と constraint 名の両方を見る。
function isPlaceIdUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, constraint } = err as PossiblePgError;
  return code === '23505' && constraint === PLACE_ID_UNIQUE_CONSTRAINT;
}

export function createStoreIdentificationService(
  deps: StoreIdentificationDeps,
): StoreIdentificationService {
  return {
    // 2.3 の PlacesSearchAdapter にそのまま委譲する薄いパススルー（Req 3.1）。
    searchCandidates(storeName: string): Promise<SearchOutcome> {
      return deps.places.searchCandidates(storeName);
    },

    // stores 作成＋owners 状態遷移を単一トランザクションで行う（tallies.ts の
    // incrementTallies と同一パターン: BEGIN → 操作 → COMMIT／エラー時 ROLLBACK → rethrow）。
    async confirmStore(ownerId: string, candidate: StoreCandidate): Promise<ConfirmOutcome> {
      const client = await deps.pool.connect();
      try {
        await client.query('BEGIN');

        const store = await createConfirmedStore(client, {
          ownerId,
          placeId: candidate.placeId,
          name: candidate.name,
          latitude: candidate.latitude,
          longitude: candidate.longitude,
        });

        await markOwnerStoreIdentified(client, ownerId);

        await client.query('COMMIT');
        return { kind: 'confirmed', storeId: store.id };
      } catch (err) {
        await client.query('ROLLBACK');
        if (isPlaceIdUniqueViolation(err)) {
          // 連打・遅延再送による自分自身の重複試行は、他オーナー競合と区別する
          // （区別しないと「既に別のオーナー様の店舗として登録されている」という
          // 事実と異なる案内を本人に返してしまう）。1回目の呼び出しで owner の
          // 状態遷移は既に commit 済みのため、再実行はせず冪等に成功扱いする。
          const existing = await findStoreByPlaceId(client, candidate.placeId);
          if (existing && existing.owner_id === ownerId) {
            return { kind: 'confirmed', storeId: existing.id };
          }
          return { kind: 'place_already_registered' };
        }
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
