import type { Queryable, TransactionCapable } from '../../src/pool.js';

// grants.sql を検証用のロールへ当てる試験（survey-settings-privileges・owner-takeover）は、同じ DB の
// 同じ表の権限を書き換える。vitest は試験ファイルを並行に流すので、2 つのファイルの GRANT / REVOKE /
// DROP OWNED BY が同時に走ると、PostgreSQL は表の権限の行を同時に更新したとして
// `tuple concurrently updated` で片方を落とす（owner-line-unlink の全件実行で実測）。
// 権限を書き換える区間だけを、同じ番号のアドバイザリロックで直列にする。

/** 権限を書き換える試験が共有するアドバイザリロックの番号。 */
const GRANTS_LOCK_KEY = 487_437;

/**
 * アドバイザリロックを取った 1 本の接続で `fn` を実行する。ロックはセッション単位なので、
 * 区間の文はすべて渡した接続（`db`）で流すこと（プールへ流すと別の接続になり、直列にならない）。
 */
export async function withGrantsLock<T>(
  pool: TransactionCapable,
  fn: (db: Queryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [GRANTS_LOCK_KEY]);
    try {
      return await fn(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [GRANTS_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
