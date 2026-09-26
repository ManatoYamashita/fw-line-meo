import type { Queryable } from './pool.js';
import type { OauthProvider, OauthTokenRow, Result } from './types.js';

// oauth_tokens アクセサ（gbp-post-review-reply spec・Req 1.7, 2.6）。
// テナント隔離の構造的強制: store に到達する全操作は ownerId を必須引数とし、
// stores.owner_id との突合をクエリ内で行う。storeId 単独で他店舗の行に到達できる
// アクセサは存在しない（偽造 postback の storeId は所有検証で 0 行に落ちる）。

const TOKEN_COLUMNS = 'id, store_id, provider, token_ref, scopes, expires_at, created_at';

/** store×provider を指す所有検証込みのキー。 */
export interface OauthTokenKey {
  ownerId: string;
  storeId: string;
  provider: OauthProvider;
}

export interface UpsertOauthTokenInput extends OauthTokenKey {
  /** 暗号化ペイロード（`v1:<iv>:<tag>:<ciphertext>`）。平文トークンを渡してはならない（Req 2.1）。 */
  tokenRef: string;
  scopes: string | null;
  expiresAt: Date | null;
}

/**
 * 認可トークン参照を upsert する（store_id×provider 一意・0001 の UNIQUE 制約）。
 * storeId が ownerId の所有でない（または存在しない）場合は挿入・更新とも行わず
 * STORE_NOT_OWNED を返す（不在と所有外は意図的に区別しない・Req 2.6）。
 */
export async function upsertOauthToken(
  db: Queryable,
  input: UpsertOauthTokenInput,
): Promise<Result<OauthTokenRow, 'STORE_NOT_OWNED'>> {
  const res = await db.query<OauthTokenRow>(
    `INSERT INTO oauth_tokens (store_id, provider, token_ref, scopes, expires_at)
     SELECT s.id, $3, $4, $5, $6
       FROM stores s
      WHERE s.id = $1 AND s.owner_id = $2
     ON CONFLICT (store_id, provider) DO UPDATE
        SET token_ref = EXCLUDED.token_ref,
            scopes = EXCLUDED.scopes,
            expires_at = EXCLUDED.expires_at
     RETURNING ${TOKEN_COLUMNS}`,
    [input.storeId, input.ownerId, input.provider, input.tokenRef, input.scopes, input.expiresAt],
  );
  const row = res.rows[0];
  if (!row) return { ok: false, error: 'STORE_NOT_OWNED' };
  return { ok: true, value: row };
}

/**
 * 認可トークン参照を取得する。行が無い・store が所有外・store 不在はいずれも null
 * （fail-closed。他オーナーのトークンには構造的に到達できない・Req 2.6）。
 */
export async function getOauthToken(
  db: Queryable,
  key: OauthTokenKey,
): Promise<OauthTokenRow | null> {
  const res = await db.query<OauthTokenRow>(
    `SELECT t.id, t.store_id, t.provider, t.token_ref, t.scopes, t.expires_at, t.created_at
       FROM oauth_tokens t
       JOIN stores s ON s.id = t.store_id
      WHERE s.id = $1 AND s.owner_id = $2 AND t.provider = $3`,
    [key.storeId, key.ownerId, key.provider],
  );
  return res.rows[0] ?? null;
}

/**
 * 認可トークン参照を削除する（連携解除・Req 2.4）。戻り値は行が消えたか。
 * 所有外・不在は削除せず false（冪等・Req 1.7: 他店舗の連携状態に影響しない）。
 */
export async function deleteOauthToken(db: Queryable, key: OauthTokenKey): Promise<boolean> {
  const res = await db.query(
    `DELETE FROM oauth_tokens t
      USING stores s
      WHERE s.id = t.store_id AND s.id = $1 AND s.owner_id = $2 AND t.provider = $3`,
    [key.storeId, key.ownerId, key.provider],
  );
  return (res.rowCount ?? 0) > 0;
}
