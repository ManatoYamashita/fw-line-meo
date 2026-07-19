import type { Queryable } from './pool.js';
import type { GbpFlow, GbpSessionRow, GbpStage, Result } from './types.js';

// gbp_sessions アクセサ（gbp-post-review-reply spec・Req 2.6）。
// owner_id が唯一のキーのためオーナー間は自然に隔離される。加えて storeId を伴う upsert は
// stores.owner_id との突合を通し、他オーナーの store_id をセッションへ持ち込む経路を塞ぐ。

const SESSION_COLUMNS = 'id, owner_id, store_id, flow, stage, payload, draft_text, expires_at, updated_at';

/**
 * getActiveGbpSession の結果。期限切れは行ごと識別して返す
 * （design エラー戦略: 期限切れ session は次回入力時に案内して行削除。
 * その判断と clearGbpSession の呼び出しはアクセサ利用側が行う）。
 */
export type GbpSessionLookup =
  | { kind: 'active'; session: GbpSessionRow }
  | { kind: 'expired'; session: GbpSessionRow }
  | { kind: 'none' };

/**
 * オーナーのセッションを取得し、expires_at と now の比較で active / expired を判別する。
 * now は既定で現在時刻（テストで注入可能・副作用なし）。
 */
export async function getActiveGbpSession(
  db: Queryable,
  ownerId: string,
  now: Date = new Date(),
): Promise<GbpSessionLookup> {
  const res = await db.query<GbpSessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM gbp_sessions WHERE owner_id = $1`,
    [ownerId],
  );
  const row = res.rows[0];
  if (!row) return { kind: 'none' };
  if (row.expires_at.getTime() <= now.getTime()) return { kind: 'expired', session: row };
  return { kind: 'active', session: row };
}

export interface UpsertGbpSessionInput {
  ownerId: string;
  /** await_store（店舗選択中）は null。 */
  storeId: string | null;
  flow: GbpFlow;
  stage: GbpStage;
  /** flow 別の具体形状は gbp ドメイン側の型で規律する（types.ts の GbpSessionRow 参照）。 */
  payload: Record<string, unknown>;
  draftText: string | null;
  expiresAt: Date;
}

/**
 * セッションを upsert する（owner_id 一意・新フロー開始は旧セッションの全置換）。
 * storeId 非 null のとき ownerId の所有 store であることをクエリ内で検証し、
 * 所有外・不在なら既存セッションへ一切触れず STORE_NOT_OWNED を返す（Req 2.6）。
 */
export async function upsertGbpSession(
  db: Queryable,
  input: UpsertGbpSessionInput,
): Promise<Result<GbpSessionRow, 'STORE_NOT_OWNED'>> {
  // jsonb へは既存規約どおり明示的に JSON 文字列で渡す（pg の配列直渡しは
  // Postgres 配列リテラルに変換され jsonb と不整合になるため。onboarding-sessions.ts 参照）。
  const payloadJson = JSON.stringify(input.payload);

  if (input.storeId === null) {
    const res = await db.query<GbpSessionRow>(
      `INSERT INTO gbp_sessions (owner_id, store_id, flow, stage, payload, draft_text, expires_at)
       VALUES ($1, NULL, $2, $3, $4, $5, $6)
       ON CONFLICT (owner_id) DO UPDATE
          SET store_id = EXCLUDED.store_id,
              flow = EXCLUDED.flow,
              stage = EXCLUDED.stage,
              payload = EXCLUDED.payload,
              draft_text = EXCLUDED.draft_text,
              expires_at = EXCLUDED.expires_at,
              updated_at = now()
       RETURNING ${SESSION_COLUMNS}`,
      [input.ownerId, input.flow, input.stage, payloadJson, input.draftText, input.expiresAt],
    );
    const row = res.rows[0];
    if (!row) throw new Error('upsertGbpSession: insert did not return a row');
    return { ok: true, value: row };
  }

  const res = await db.query<GbpSessionRow>(
    `INSERT INTO gbp_sessions (owner_id, store_id, flow, stage, payload, draft_text, expires_at)
     SELECT $1, s.id, $3, $4, $5, $6, $7
       FROM stores s
      WHERE s.id = $2 AND s.owner_id = $1
     ON CONFLICT (owner_id) DO UPDATE
        SET store_id = EXCLUDED.store_id,
            flow = EXCLUDED.flow,
            stage = EXCLUDED.stage,
            payload = EXCLUDED.payload,
            draft_text = EXCLUDED.draft_text,
            expires_at = EXCLUDED.expires_at,
            updated_at = now()
     RETURNING ${SESSION_COLUMNS}`,
    [
      input.ownerId,
      input.storeId,
      input.flow,
      input.stage,
      payloadJson,
      input.draftText,
      input.expiresAt,
    ],
  );
  const row = res.rows[0];
  if (!row) return { ok: false, error: 'STORE_NOT_OWNED' };
  return { ok: true, value: row };
}

/**
 * セッションを削除する（完了・キャンセル・期限切れ破棄）。戻り値は行が消えたか（冪等）。
 * owner_id キーのため他オーナーの行には構造的に到達できない。
 */
export async function clearGbpSession(db: Queryable, ownerId: string): Promise<boolean> {
  const res = await db.query('DELETE FROM gbp_sessions WHERE owner_id = $1', [ownerId]);
  return (res.rowCount ?? 0) > 0;
}

// --- 承認実行の CAS ガード（design「GbpFlows > State Management」・Req 3.6, 4.5）---
//
// 承認（g_approve）から GBP へ書き込む経路は「executing への条件付き遷移 → 実行 →
// 成功なら削除／失敗なら await_decision へ戻す」の 3 手に分解される。各手はいずれも
// **現在の stage を WHERE に含む単一文**であり、以下を同時に保証する:
// - 二重タップ・並行リクエストでも `executing` を獲得できるのは高々 1 リクエスト
//   （＝ GBP 書込は高々 1 回）。
// - 実行中に別フロー（例: 連携開始）がセッションを置換した場合、完了処理は
//   `stage = 'executing'` に一致しないため他フローのセッションを巻き込んで破壊しない。

/**
 * 承認実行の権利を獲得する（`await_decision` → `executing` の条件付き更新）。
 * 獲得できたときのみ更新後の行を返す。null は「他リクエストが実行中」または
 * 「stage が承認待ちではない」を意味し、呼び出し側は **実行してはならない**。
 */
export async function beginGbpSessionExecution(
  db: Queryable,
  ownerId: string,
): Promise<GbpSessionRow | null> {
  const res = await db.query<GbpSessionRow>(
    `UPDATE gbp_sessions
        SET stage = 'executing', updated_at = now()
      WHERE owner_id = $1 AND stage = 'await_decision'
      RETURNING ${SESSION_COLUMNS}`,
    [ownerId],
  );
  return res.rows[0] ?? null;
}

/**
 * 実行成功時の後始末（`executing` の行のみ削除）。戻り値は行が消えたか。
 * false は「実行中に別のセッションへ置換された」ことを意味する（新セッションは温存される）。
 */
export async function completeGbpSessionExecution(
  db: Queryable,
  ownerId: string,
): Promise<boolean> {
  const res = await db.query(
    `DELETE FROM gbp_sessions WHERE owner_id = $1 AND stage = 'executing'`,
    [ownerId],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * 実行失敗時の巻き戻し（`executing` → `await_decision`）。`draft_text` と `payload` は
 * 触れないため承認済みの下書きが失われない（Req 3.7・4.7）。期限は再試行のため延長する。
 */
export async function revertGbpSessionExecution(
  db: Queryable,
  ownerId: string,
  expiresAt: Date,
): Promise<GbpSessionRow | null> {
  const res = await db.query<GbpSessionRow>(
    `UPDATE gbp_sessions
        SET stage = 'await_decision', expires_at = $2, updated_at = now()
      WHERE owner_id = $1 AND stage = 'executing'
      RETURNING ${SESSION_COLUMNS}`,
    [ownerId, expiresAt],
  );
  return res.rows[0] ?? null;
}
