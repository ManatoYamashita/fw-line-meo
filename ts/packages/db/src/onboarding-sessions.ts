import type { Queryable } from './pool.js';
import type { OnboardingSessionRow, SessionPatch } from './types.js';

const SESSION_COLUMNS =
  'line_user_id, stage, owner_id, candidates, selected_index, invite_failures, locked_until, created_at, updated_at';

/**
 * line_user_id をキーにセッションを取得し、無ければ既定値（await_invite_code・owner_id=null）で新規作成する。
 * 友だち追加のたび・オンボーディング中の全メッセージ受信のたびに呼ばれる想定（Req 5.1, 5.2）。
 */
export async function getOrCreateSession(
  db: Queryable,
  lineUserId: string,
): Promise<OnboardingSessionRow> {
  const inserted = await db.query<OnboardingSessionRow>(
    `INSERT INTO onboarding_sessions (line_user_id)
     VALUES ($1)
     ON CONFLICT (line_user_id) DO NOTHING
     RETURNING ${SESSION_COLUMNS}`,
    [lineUserId],
  );
  if (inserted.rows[0]) return inserted.rows[0];

  const existing = await db.query<OnboardingSessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM onboarding_sessions WHERE line_user_id = $1`,
    [lineUserId],
  );
  const row = existing.rows[0];
  if (!row) throw new Error('getOrCreateSession: row missing after insert race');
  return row;
}

/**
 * セッションの一部フィールドを更新する（Req 5.1: 進捗保持／2.3: 失敗カウンタ・ロック／3.1-3.4: 候補保持）。
 * patch に含まれないキーは変更しない。undefined=不変・null=NULL 設定として扱う。
 * `ck_session_owner_stage` CHECK（stage=await_invite_code ⇔ owner_id IS NULL）を満たすため、
 * await_invite_code から離脱する際は stage と ownerId を同一呼び出しで渡すこと（単一 UPDATE で原子的に適用される）。
 */
export async function updateSession(
  db: Queryable,
  lineUserId: string,
  patch: SessionPatch,
): Promise<void> {
  const sets: string[] = ['updated_at = now()'];
  const values: unknown[] = [lineUserId];

  const push = (column: string, value: unknown): void => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };

  if (patch.stage !== undefined) push('stage', patch.stage);
  if (patch.ownerId !== undefined) push('owner_id', patch.ownerId);
  if (patch.candidates !== undefined) {
    push('candidates', patch.candidates === null ? null : JSON.stringify(patch.candidates));
  }
  if (patch.selectedIndex !== undefined) push('selected_index', patch.selectedIndex);
  if (patch.inviteFailures !== undefined) push('invite_failures', patch.inviteFailures);
  if (patch.lockedUntil !== undefined) push('locked_until', patch.lockedUntil);

  await db.query(`UPDATE onboarding_sessions SET ${sets.join(', ')} WHERE line_user_id = $1`, values);
}
