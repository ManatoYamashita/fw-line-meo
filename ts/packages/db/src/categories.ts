import type { Queryable } from './pool.js';

/**
 * 店舗ジャンル（categories）を code 昇順で取得する。
 * seed（0002_reference_seed.sql）が単一情報源（SoT）であり、カテゴリ値をコード内に二重定義しない。
 */
export async function listCategories(
  db: Queryable,
): Promise<{ code: string; label: string }[]> {
  const res = await db.query<{ code: string; label: string }>(
    'SELECT code, label FROM categories ORDER BY code ASC',
  );
  return res.rows;
}
