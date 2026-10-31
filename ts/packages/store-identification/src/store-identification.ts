import {
  createConfirmedStore,
  findOwnerById,
  findStoreByPlaceId,
  lockPlaceHolder,
  markOwnerStoreIdentified,
  moveAllStores,
  type Queryable,
  type StoreCandidate,
} from '@fwlm/db';
import type { PlacesSearchAdapter, SearchOutcome } from './places-search.js';

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

// オンボーディングの確定の結果（owner-line-unlink Req 6.1, 6.3–6.6）。
// taken_over の storeId は確定した Place の店舗、movedStoreIds は引き継いだ全店舗（作成順）。
export type ConfirmForOnboardingOutcome =
  | { kind: 'confirmed'; storeId: string }
  | {
      kind: 'taken_over';
      storeId: string;
      previousOwnerId: string;
      movedStoreIds: readonly string[];
    }
  | { kind: 'place_already_registered' };

export interface StoreIdentificationService {
  searchCandidates(storeName: string): Promise<SearchOutcome>;
  confirmStore(ownerId: string, candidate: StoreCandidate): Promise<ConfirmOutcome>;
  confirmStoreForOnboarding(
    ownerId: string,
    candidate: StoreCandidate,
  ): Promise<ConfirmForOnboardingOutcome>;
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

// confirmStoreForOnboarding の試行回数。新規の挿入が並行の挿入の一意制約に当たったときだけ、
// 最初から 1 回だけやり直す（2 回目は Place の店舗が見えるので、施錠と判断の経路へ進む）。
const ONBOARDING_CONFIRM_MAX_ATTEMPTS = 2;

/**
 * オンボーディングの確定の 1 回分を、BEGIN 済みの接続の中で行う（owner-line-unlink Req 6.1, 6.3–6.6）。
 * COMMIT・ROLLBACK は呼び出し側が行う。結果が place_already_registered のときは何も書いていない。
 */
async function decideOnboardingConfirm(
  tx: Queryable,
  ownerId: string,
  candidate: StoreCandidate,
): Promise<ConfirmForOnboardingOutcome> {
  // 新しいオーナーの代理店は、招待コードの受理で決まった owners.agency_id から読む。
  const owner = await findOwnerById(tx, ownerId);
  if (!owner) throw new Error(`owner not found: ${ownerId}`);

  // Place の店舗の所有者を施錠して読む。並行の引継ぎが先に確定していれば、引き継いだ連携中の
  // オーナーを所有者として読むので、後着は下の拒否に落ちる（Req 6.6）。
  const holder = await lockPlaceHolder(tx, candidate.placeId);

  if (!holder) {
    const store = await createConfirmedStore(tx, {
      ownerId,
      placeId: candidate.placeId,
      name: candidate.name,
      latitude: candidate.latitude,
      longitude: candidate.longitude,
    });
    await markOwnerStoreIdentified(tx, ownerId);
    return { kind: 'confirmed', storeId: store.id };
  }

  if (holder.ownerId === ownerId) {
    // 連打・遅延再送による自分自身の重複。confirmStore と同じく冪等に成功とし、段階は書き換えない
    // （完了済みのオーナーを店舗特定済みへ戻さないため）。
    return { kind: 'confirmed', storeId: holder.storeId };
  }

  if (holder.unlinked && holder.agencyId === owner.agency_id) {
    // 解除済みオーナーの全店舗を引き継ぐ。書き換えるのは stores.owner_id と旧オーナーの引継ぎ先だけで、
    // 店舗の身元・停止状態・蓄積には触れない（Req 6.1, 6.3）。
    const movedStoreIds = await moveAllStores(tx, { fromOwnerId: holder.ownerId, toOwnerId: ownerId });
    await markOwnerStoreIdentified(tx, ownerId);
    return {
      kind: 'taken_over',
      storeId: holder.storeId,
      previousOwnerId: holder.ownerId,
      movedStoreIds,
    };
  }

  // 連携中の所有者（Req 6.5）、または別の代理店の解除済み所有者（Req 6.4）。
  return { kind: 'place_already_registered' };
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

    // オンボーディング専用の確定（owner-line-unlink Req 6.1, 6.3–6.6）。新規の確定・自分の重複・
    // 解除済みオーナーからの引継ぎ・登録済みとしての拒否を、1 つのトランザクションの中で決める。
    // 管理画面の店舗登録（dashboard-api）は confirmStore を使い続け、このメソッドを配線しない。
    async confirmStoreForOnboarding(
      ownerId: string,
      candidate: StoreCandidate,
    ): Promise<ConfirmForOnboardingOutcome> {
      const client = await deps.pool.connect();
      try {
        for (let attempt = 1; ; attempt += 1) {
          try {
            await client.query('BEGIN');
            const outcome = await decideOnboardingConfirm(client, ownerId, candidate);
            await client.query(outcome.kind === 'place_already_registered' ? 'ROLLBACK' : 'COMMIT');
            return outcome;
          } catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            if (!isPlaceIdUniqueViolation(err)) throw err;
            // 施錠の時点では見えなかった並行の挿入が先に確定した。最初からやり直せば、その店舗を
            // 所有者つきで読み直して判断できる。やり直しでも当たるなら、登録済みとして返す。
            if (attempt >= ONBOARDING_CONFIRM_MAX_ATTEMPTS) return { kind: 'place_already_registered' };
          }
        }
      } finally {
        client.release();
      }
    },
  };
}
