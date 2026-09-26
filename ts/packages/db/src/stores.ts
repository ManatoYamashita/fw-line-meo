import type { Queryable } from './pool.js';
import type { PlaceStatus, StoreListItem, StoreRow } from './types.js';

const STORE_COLUMNS =
  'id, owner_id, category_code, name, latitude, longitude, place_id, place_status, created_at';

// アンケート表示に必要な最小の店舗情報。
export interface SurveyStore {
  id: string;
  name: string;
  placeId: string | null;
  placeStatus: PlaceStatus;
  /** 停止時刻（Issue #252）。null は利用中、値があれば停止中。 */
  suspendedAt: Date | null;
}

// QR RBAC 判定用に owner 経由の agency を同梱した店舗情報。
export interface StoreWithAgency extends SurveyStore {
  ownerId: string;
  agencyId: string;
}

// UUID 形式でない storeId は DB を叩かず not-found 扱い（無効 URL → エラーページ用・Req 2.7）。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** アンケート用に店舗を取得（不在・無効 ID は null）。 */
export async function findStoreForSurvey(
  db: Queryable,
  id: string,
): Promise<SurveyStore | null> {
  if (!UUID_RE.test(id)) return null;
  const res = await db.query<{
    id: string;
    name: string;
    place_id: string | null;
    place_status: PlaceStatus;
    suspended_at: Date | null;
  }>('SELECT id, name, place_id, place_status, suspended_at FROM stores WHERE id = $1', [id]);
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    placeId: row.place_id,
    placeStatus: row.place_status,
    suspendedAt: row.suspended_at,
  };
}

/** QR 発行の RBAC 判定用に店舗＋担当代理店を取得（不在・無効 ID は null）。 */
export async function findStoreWithAgency(
  db: Queryable,
  id: string,
): Promise<StoreWithAgency | null> {
  if (!UUID_RE.test(id)) return null;
  const res = await db.query<{
    id: string;
    name: string;
    place_id: string | null;
    place_status: PlaceStatus;
    suspended_at: Date | null;
    owner_id: string;
    agency_id: string;
  }>(
    `SELECT s.id, s.name, s.place_id, s.place_status, s.suspended_at, s.owner_id, o.agency_id
       FROM stores s
       JOIN owners o ON o.id = s.owner_id
      WHERE s.id = $1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    placeId: row.place_id,
    placeStatus: row.place_status,
    suspendedAt: row.suspended_at,
    ownerId: row.owner_id,
    agencyId: row.agency_id,
  };
}

export interface CreateConfirmedStoreInput {
  ownerId: string;
  placeId: string;
  name: string;
  latitude?: number | null;
  longitude?: number | null;
  categoryCode?: string | null;
}

/**
 * 店舗確定オンボーディング（line-onboarding spec）が候補確定時に呼ぶ。place_status='confirmed'・
 * place_id 設定済みで作成する（既存 CHECK `ck_place_confirmed` を満たす。Req 4.2）。
 * stores テーブルに address/types の格納列は無いため、StoreCandidate のうち name/lat/lng/place_id のみ永続化する。
 */
export async function createConfirmedStore(
  db: Queryable,
  input: CreateConfirmedStoreInput,
): Promise<StoreRow> {
  const res = await db.query<StoreRow>(
    `INSERT INTO stores (owner_id, category_code, name, latitude, longitude, place_id, place_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'confirmed')
     RETURNING ${STORE_COLUMNS}`,
    [
      input.ownerId,
      input.categoryCode ?? null,
      input.name,
      input.latitude ?? null,
      input.longitude ?? null,
      input.placeId,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('createConfirmedStore: insert did not return a row');
  return row;
}

/** Place 確定済み店舗の最小情報（GBP 連携の対象候補・gbp-post-review-reply Req 1.1）。 */
export interface ConfirmedStoreSummary {
  id: string;
  name: string;
  /** place_status='confirmed' の店舗のみを返すため常に非 null。 */
  placeId: string;
}

/**
 * オーナーの Place 確定済み店舗を列挙する（gbp-post-review-reply Req 1.1, 1.3, 2.6）。
 * 連携誘導・店舗選択・連携状態確認の対象を「日次サマリーが稼働している店舗」に限るため、
 * place_status='confirmed' かつ place_id を持つ行のみを返す。
 *
 * owner_id を WHERE に置く所有検証込みのクエリ形状であり、この結果集合が
 * 「そのオーナーが GBP 操作を行える店舗の全体」の唯一の定義になる
 * （postback 由来の storeId は必ずこの集合との突合で検証する）。
 *
 * 並び順は postback の index 選択が安定するよう created_at → id の全順序で固定する。
 */
export async function listConfirmedStoresByOwner(
  db: Queryable,
  ownerId: string,
): Promise<ConfirmedStoreSummary[]> {
  if (!UUID_RE.test(ownerId)) return [];
  const res = await db.query<{ id: string; name: string; place_id: string }>(
    `SELECT id, name, place_id
       FROM stores
      WHERE owner_id = $1
        AND place_status = 'confirmed'
        AND place_id IS NOT NULL
      ORDER BY created_at ASC, id ASC`,
    [ownerId],
  );
  return res.rows.map((row) => ({ id: row.id, name: row.name, placeId: row.place_id }));
}

/**
 * place_id で既存店舗を検索する。既に他オーナーの店舗として登録済みかどうかの判定に使う
 * （Req 4.4: 登録済み Place は確定拒否）。未登録は null。
 */
export async function findStoreByPlaceId(db: Queryable, placeId: string): Promise<StoreRow | null> {
  const res = await db.query<StoreRow>(
    `SELECT ${STORE_COLUMNS} FROM stores WHERE place_id = $1`,
    [placeId],
  );
  return res.rows[0] ?? null;
}

interface StoreListRow {
  id: string;
  name: string;
  place_status: PlaceStatus;
  suspended_at: Date | null;
  competitor_configured: boolean;
  owner_id: string;
  owner_display_name: string | null;
  agency_id: string;
  agency_name: string;
  created_at: Date;
}

/**
 * ダッシュボードの店舗一覧を取得する（agency-dashboard spec）。
 * stores×owners×agencies を JOIN し、competitors(active) の EXISTS で competitorConfigured を導出する
 * （Req 4.1, 4.2, 4.3）。competitors は read のみ（本アクセサは競合を変更しない・Req 4.5）。
 * filter.agencyId 指定時は当該代理店の店舗のみ（agency スコープ・Req 2.1）、未指定時は全代理店（Req 2.2）。
 * 来店客系テーブルには一切触れない（Req 7.2）。
 */
export async function listStoresWithStatus(
  db: Queryable,
  filter: { agencyId?: string },
): Promise<StoreListItem[]> {
  const res = await db.query<StoreListRow>(
    `SELECT s.id,
            s.name,
            s.place_status,
            s.suspended_at,
            EXISTS (
              SELECT 1 FROM competitors c WHERE c.store_id = s.id AND c.active
            ) AS competitor_configured,
            s.owner_id,
            o.display_name AS owner_display_name,
            a.id           AS agency_id,
            a.name         AS agency_name,
            s.created_at
       FROM stores s
       JOIN owners o   ON o.id = s.owner_id
       JOIN agencies a ON a.id = o.agency_id
      WHERE $1::uuid IS NULL OR a.id = $1
      ORDER BY s.created_at DESC`,
    [filter.agencyId ?? null],
  );
  return res.rows.map((row) => ({
    id: row.id,
    name: row.name,
    placeStatus: row.place_status,
    suspendedAt: row.suspended_at,
    competitorConfigured: row.competitor_configured,
    ownerId: row.owner_id,
    ownerDisplayName: row.owner_display_name,
    agencyId: row.agency_id,
    agencyName: row.agency_name,
    createdAt: row.created_at,
  }));
}

/**
 * 店舗のカテゴリを設定する（店舗登録の後追い設定・design「registerStore 合成」参照）。
 * confirmStore の凍結 TX 契約の外で呼ばれる best-effort 更新のため、
 * 失敗時の扱い（登録本体を失敗させない）は呼び出し側が決める。
 */
export async function setStoreCategory(
  db: Queryable,
  storeId: string,
  categoryCode: string,
): Promise<void> {
  await db.query('UPDATE stores SET category_code = $1 WHERE id = $2', [categoryCode, storeId]);
}

export type SuspensionDirection = 'suspend' | 'resume';

export interface SetStoreSuspensionInput {
  storeId: string;
  direction: SuspensionDirection;
  /** null は運営（全店舗）。値があればその代理店の店舗に限る。 */
  agencyId: string | null;
}

export type SetStoreSuspensionOutcome =
  | { kind: 'changed'; store: { id: string; suspendedAt: Date | null } }
  | { kind: 'unchanged'; store: { id: string; suspendedAt: Date | null } }
  | { kind: 'not_found' };

/**
 * 店舗の停止状態を範囲つきで切り替える（store-suspension spec・Issue #252）。
 *
 * 範囲の判定と状態の更新を 1 文で行う。範囲は agencyId が null なら全店舗（運営）、値があれば
 * owners 経由でその代理店の店舗に限る（Req 1.1, 1.2）。範囲外と不存在はどちらも行が選ばれず
 * `not_found` になり、応答から区別できない（Req 1.4）。既に目的の状態にある店舗は行を変えず
 * `unchanged` を返す（Req 1.5）。更新するのは `suspended_at` だけで、他の列・他のテーブルには
 * 触れない（Req 1.7, 5.3）。
 *
 * 同時実行: `target` が対象行を FOR UPDATE で押さえ、後着はロック解放後の最新版を読み直す。
 * 更新側の条件も最新版で再評価されるため、同じ店舗への同時の停止は 1 回だけ `changed` になり、
 * 後着は先着が書いた現在の停止時刻を持つ `unchanged` になる。
 *
 * storeId の UUID 形式の検証は呼び出し側が行う（形式外の値は uuid への変換で失敗する）。
 */
export async function setStoreSuspension(
  db: Queryable,
  input: SetStoreSuspensionInput,
): Promise<SetStoreSuspensionOutcome> {
  const suspend = input.direction === 'suspend';
  const res = await db.query<{ id: string; changed: boolean; suspended_at: Date | null }>(
    `WITH target AS (
       SELECT s.id, s.suspended_at
         FROM stores s
         JOIN owners o ON o.id = s.owner_id
        WHERE s.id = $1::uuid
          AND ($3::uuid IS NULL OR o.agency_id = $3::uuid)
          FOR UPDATE OF s
     ), updated AS (
       UPDATE stores s
          SET suspended_at = CASE WHEN $2::boolean THEN now() ELSE NULL END
         FROM target t
        WHERE s.id = t.id
          AND (s.suspended_at IS NULL) = $2::boolean
       RETURNING s.id, s.suspended_at
     )
     SELECT t.id,
            (u.id IS NOT NULL) AS changed,
            CASE WHEN u.id IS NOT NULL THEN u.suspended_at ELSE t.suspended_at END AS suspended_at
       FROM target t
       LEFT JOIN updated u ON u.id = t.id`,
    [input.storeId, suspend, input.agencyId],
  );
  const row = res.rows[0];
  if (!row) return { kind: 'not_found' };
  return {
    kind: row.changed ? 'changed' : 'unchanged',
    store: { id: row.id, suspendedAt: row.suspended_at },
  };
}
