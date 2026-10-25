import type { Queryable, TransactionCapable } from './pool.js';

// オーナーと LINE アカウントの紐づけの解除（owner-line-unlink spec・Issue #487）。
// 解除の列（line_user_id の NULL 化・line_unlinked_at・menu_pending_line_user_id）を書くのは
// dashboard-api（運営・代理店の操作）だけである。オーナーの面（line-webhook・客向け Web）は列単位の
// GRANT でこれらの列を書けず、不在検査 (B5) がこのモジュールの識別子の利用も検出する。

export interface UnlinkOwnerLineInput {
  ownerId: string;
  /** null は運営（全オーナー）。値があればその代理店のオーナーに限る */
  agencyId: string | null;
}

/**
 * menuTarget: これから個別リンクを外すべき LINE ユーザー ID。
 * 未解除の印が無いか、元の ID を別の連携中オーナーが持っている場合は null
 * （後者は同じトランザクションで印を消す）。
 */
export type UnlinkOwnerLineOutcome =
  | { kind: 'changed'; ownerId: string; menuTarget: string | null }
  | { kind: 'unchanged'; ownerId: string; menuTarget: string | null }
  | { kind: 'not_found' };

/**
 * 範囲内のオーナーの LINE の紐づけを解除する（Req 1.1–1.3, 1.5–1.7, 3.3, 4.2, 5.5）。
 *
 * 1 つのトランザクションで次を行う。
 * 1. 範囲の判定と施錠を 1 文で行う。範囲は agencyId が null なら全オーナー（運営）、値があれば
 *    その代理店のオーナーに限る。範囲外と不存在はどちらも行が選ばれず `not_found` になり、
 *    応答から区別できない（Req 1.3）。
 * 2. 連携中なら、LINE ユーザー ID を NULL にし、解除の時刻を入れ、元の ID を未解除の印として残す。
 *    あわせて、元の ID をキーに持つ会話の行と、当該オーナーに紐づく会話の行を消す。解除後の会話へ
 *    段階・候補・招待コードの失敗回数を持ち越さないためである（Req 4.2）。
 *    既に解除済みなら行を変えず `unchanged` を返す（Req 1.5）。
 * 3. 未解除の印があり、その ID を別の連携中オーナーが持っているとき（同じ LINE アカウントが
 *    招待コードから再登録した後）は、メニュー操作の対象を返さずに印を消す。新しいオーナーの
 *    完了後メニューを外さないためである。
 *
 * 書き換えるのは owners の 3 列と onboarding_sessions の行だけで、店舗・日次データ・匿名集計・
 * 監査記録・代理店との関係には触れない（Req 1.6, 5.5）。途中で失敗すればロールバックして例外を
 * 投げ、紐づけは解除前のまま残る（Req 1.7）。
 *
 * 同時実行: 対象の行を FOR UPDATE で押さえるため、同じオーナーへの同時の解除は直列化され、
 * 後着は先着が書いた状態を読んで `unchanged` になる。
 *
 * ownerId・agencyId の UUID 形式の検証は呼び出し側が行う（形式外の値は uuid への変換で失敗する）。
 */
export async function unlinkOwnerLine(
  pool: TransactionCapable,
  input: UnlinkOwnerLineInput,
): Promise<UnlinkOwnerLineOutcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const target = await client.query<{
      id: string;
      line_user_id: string | null;
      menu_pending_line_user_id: string | null;
    }>(
      `SELECT id, line_user_id, menu_pending_line_user_id
         FROM owners
        WHERE id = $1::uuid
          AND ($2::uuid IS NULL OR agency_id = $2::uuid)
          FOR UPDATE`,
      [input.ownerId, input.agencyId],
    );
    const row = target.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return { kind: 'not_found' };
    }

    let kind: 'changed' | 'unchanged';
    let pending: string | null;
    if (row.line_user_id !== null) {
      // 連携中 → 解除済み・メニュー未解除。3 列を 1 文で書き、ck_owner_line_link・
      // ck_owner_menu_pending を途中の状態でも満たす。
      const previousLineUserId = row.line_user_id;
      await client.query(
        `UPDATE owners
            SET line_user_id = NULL,
                line_unlinked_at = now(),
                menu_pending_line_user_id = $2
          WHERE id = $1::uuid`,
        [row.id, previousLineUserId],
      );
      await client.query(
        'DELETE FROM onboarding_sessions WHERE line_user_id = $1 OR owner_id = $2::uuid',
        [previousLineUserId, row.id],
      );
      kind = 'changed';
      pending = previousLineUserId;
    } else {
      kind = 'unchanged';
      pending = row.menu_pending_line_user_id;
    }

    let menuTarget = pending;
    if (pending !== null) {
      // 元の ID を別の連携中オーナーが持っていれば、そのオーナーのメニューを外さないよう対象から外す。
      // line_user_id は UNIQUE なので、直前に解除した場合（changed）はここで 1 行も見つからない。
      const holder = await client.query(
        'SELECT 1 FROM owners WHERE line_user_id = $1 AND id <> $2::uuid',
        [pending, row.id],
      );
      if ((holder.rowCount ?? 0) > 0) {
        await client.query(
          'UPDATE owners SET menu_pending_line_user_id = NULL WHERE id = $1::uuid',
          [row.id],
        );
        menuTarget = null;
      }
    }

    await client.query('COMMIT');
    return { kind, ownerId: row.id, menuTarget };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 完了後メニューの個別リンクを外せたときに、未解除の印を消す（Req 3.3）。
 * 印が lineUserId と一致するときだけ消すので、印が既に消えている・別の値に変わっている場合は
 * 何もしない（並行の解除と取り違えない）。連携中のオーナーは印を持たないので、触れない。
 */
export async function clearOwnerMenuPending(
  db: Queryable,
  input: { ownerId: string; lineUserId: string },
): Promise<void> {
  await db.query(
    `UPDATE owners
        SET menu_pending_line_user_id = NULL
      WHERE id = $1::uuid
        AND menu_pending_line_user_id = $2`,
    [input.ownerId, input.lineUserId],
  );
}
