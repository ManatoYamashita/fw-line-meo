import type { Queryable, TransactionCapable, TransactionClient } from './pool.js';
import type { Result } from './types.js';

// LINE 起点の一括発信（line-crosspost spec・migration 0019・Issue #494）のアクセサ。
//
// 不変条件（design.md「下書きの状態機械」「投稿先ごとの状態機械」）:
// - すべての文が owner_id を条件に持つ。postback に含まれる下書き ID・投稿先 ID は端末から偽造できるので、
//   ID だけで他のオーナーの行へ届く文を作らない（Req 8.1）。
// - 店舗の現在の所有（stores.owner_id）も確かめる。店舗の引継ぎ（owner-line-unlink）で店舗が別のオーナーへ
//   移った後、旧オーナーの下書きから操作できないようにする。
// - 状態の遷移はすべて「現在の状態を WHERE に含む 1 文」で行う（CAS）。0 行は「遷移できなかった」で、
//   呼び出し側は何も実行してはならない。
// - 外部 API へ投稿してよいのは claimCrosspostDelivery が行を返したリクエストだけ。結果の記録は
//   獲得した試行回数（attempt_count）を条件にし、遅れて戻った古い試行が新しい試行の結果を上書きしない。

export type CrosspostDraftStatus = 'collecting' | 'reviewing' | 'approved' | 'canceled';
export type CrosspostInputMode = 'none' | 'ai_revision' | 'manual';
export type CrosspostDestination = 'instagram' | 'google';
export type CrosspostDeliveryStatus =
  | 'queued'
  | 'in_progress'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'canceled';

/** 0019 の CHECK と 1:1。 */
export type CrosspostFailureReason =
  | 'not_ready'
  | 'not_linked'
  | 'token_invalid'
  | 'permission_denied'
  | 'rejected'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'media_unavailable'
  | 'unsupported_content'
  | 'owner_reported_not_posted';

/** 0019 の CHECK と 1:1。 */
export type CrosspostUnknownReason =
  | 'timeout'
  | 'network'
  | 'upstream_5xx'
  | 'adapter_threw'
  | 'stale_in_progress';

export const CROSSPOST_DESTINATIONS: readonly CrosspostDestination[] = ['instagram', 'google'];

/** 素材の文の上限（0019 の CHECK と同じ値）。 */
export const CROSSPOST_MATERIAL_MAX_CHARS = 2000;

export interface CrosspostDraftRow {
  id: string;
  owner_id: string;
  store_id: string;
  status: CrosspostDraftStatus;
  input_mode: CrosspostInputMode;
  input_destination: CrosspostDestination | null;
  revision: number;
  material_text: string;
  instagram_text: string | null;
  google_text: string | null;
  approved_revision: number | null;
  approved_at: Date | null;
  expires_at: Date;
  purge_after: Date;
  created_at: Date;
  updated_at: Date;
}

export interface CrosspostMediaRow {
  id: string;
  draft_id: string;
  line_message_id: string;
  storage_key: string;
  content_type: string;
  width: number;
  height: number;
  byte_size: number;
  sha256: string;
  created_at: Date;
}

export interface CrosspostDeliveryRow {
  id: string;
  draft_id: string;
  destination: CrosspostDestination;
  status: CrosspostDeliveryStatus;
  body_text: string;
  with_media: boolean;
  media_id: string | null;
  attempt_count: number;
  retryable: boolean;
  failure_reason: CrosspostFailureReason | null;
  unknown_reason: CrosspostUnknownReason | null;
  checkpoint: string | null;
  external_id: string | null;
  external_url: string | null;
  last_attempt_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** 本機能の対象にできる店舗（所有・Place 確定・利用中・有効化の指定に含まれる）。 */
export interface CrosspostStoreSummary {
  id: string;
  name: string;
}

const DRAFT_COLUMNS = `id, owner_id, store_id, status, input_mode, input_destination, revision, material_text,
  instagram_text, google_text, approved_revision, approved_at, expires_at, purge_after, created_at, updated_at`;

const MEDIA_COLUMNS = `id, draft_id, line_message_id, storage_key, content_type, width, height, byte_size, sha256, created_at`;

const DELIVERY_COLUMNS = `id, draft_id, destination, status, body_text, with_media, media_id, attempt_count, retryable,
  failure_reason, unknown_reason, checkpoint, external_id, external_url, last_attempt_at, finished_at,
  created_at, updated_at`;

function prefixed(columns: string, alias: string): string {
  return columns
    .split(',')
    .map((column) => `${alias}.${column.trim()}`)
    .join(', ');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

// =====================================================================
// 店舗
// =====================================================================

/**
 * 本機能の対象にできる店舗を、作成順（created_at・id）で返す。`allowedStoreIds` は有効化の指定
 * （env の CROSSPOST_PILOT_STORE_IDS）で、空なら 0 件を返す（既定 OFF・Req 10.1）。
 */
export async function listCrosspostEligibleStores(
  db: Queryable,
  ownerId: string,
  allowedStoreIds: readonly string[],
): Promise<CrosspostStoreSummary[]> {
  const allowed = allowedStoreIds.filter(isUuid);
  if (!isUuid(ownerId) || allowed.length === 0) return [];
  const res = await db.query<CrosspostStoreSummary>(
    `SELECT s.id, s.name
       FROM stores s
      WHERE s.owner_id = $1
        AND s.place_status = 'confirmed'
        AND s.place_id IS NOT NULL
        AND s.suspended_at IS NULL
        AND s.id = ANY($2::uuid[])
      ORDER BY s.created_at ASC, s.id ASC`,
    [ownerId, allowed],
  );
  return res.rows;
}

// =====================================================================
// 下書き
// =====================================================================

/** 作成中の下書き（と、その店舗名）。店舗の所有が変わった・停止中なら serviceable = false。 */
export interface OpenCrosspostDraft {
  draft: CrosspostDraftRow;
  storeName: string;
  serviceable: boolean;
}

/** オーナーの作成中（collecting / reviewing）の下書きを返す。期限切れの判定は呼び出し側（now を持つ側）が行う。 */
export async function getOpenCrosspostDraft(db: Queryable, ownerId: string): Promise<OpenCrosspostDraft | null> {
  if (!isUuid(ownerId)) return null;
  const res = await db.query<CrosspostDraftRow & { store_name: string; serviceable: boolean }>(
    `SELECT ${prefixed(DRAFT_COLUMNS, 'd')}, s.name AS store_name,
            (s.owner_id = d.owner_id AND s.place_status = 'confirmed' AND s.place_id IS NOT NULL AND s.suspended_at IS NULL) AS serviceable
       FROM crosspost_drafts d
       JOIN stores s ON s.id = d.store_id
      WHERE d.owner_id = $1
        AND d.status IN ('collecting', 'reviewing')`,
    [ownerId],
  );
  const row = res.rows[0];
  if (!row) return null;
  const { store_name, serviceable, ...draft } = row;
  return { draft, storeName: store_name, serviceable };
}

/** 下書きを ID で返す（そのオーナーのものだけ）。承認の後の表示・確認に使う。 */
export async function getCrosspostDraft(
  db: Queryable,
  key: { ownerId: string; draftId: string },
): Promise<{ draft: CrosspostDraftRow; storeName: string } | null> {
  if (!isUuid(key.ownerId) || !isUuid(key.draftId)) return null;
  const res = await db.query<CrosspostDraftRow & { store_name: string }>(
    `SELECT ${prefixed(DRAFT_COLUMNS, 'd')}, s.name AS store_name
       FROM crosspost_drafts d
       JOIN stores s ON s.id = d.store_id
      WHERE d.id = $1 AND d.owner_id = $2`,
    [key.draftId, key.ownerId],
  );
  const row = res.rows[0];
  if (!row) return null;
  const { store_name, ...draft } = row;
  return { draft, storeName: store_name };
}

export interface CreateCrosspostDraftInput {
  ownerId: string;
  storeId: string;
  /** 有効化の指定（この店舗が含まれていなければ作らない）。 */
  allowedStoreIds: readonly string[];
  expiresAt: Date;
  purgeAfter: Date;
}

/**
 * 下書きを作る。店舗がそのオーナーの、本機能の対象にできる店舗でなければ作らない（STORE_NOT_ELIGIBLE）。
 * 作成中の下書きが既にあれば作らない（OPEN_DRAFT_EXISTS・部分一意索引）。黙って置き換えない（Req 1.5）。
 */
export async function createCrosspostDraft(
  db: Queryable,
  input: CreateCrosspostDraftInput,
): Promise<Result<CrosspostDraftRow, 'STORE_NOT_ELIGIBLE' | 'OPEN_DRAFT_EXISTS'>> {
  const allowed = input.allowedStoreIds.filter(isUuid);
  if (!isUuid(input.ownerId) || !isUuid(input.storeId) || !allowed.includes(input.storeId)) {
    return { ok: false, error: 'STORE_NOT_ELIGIBLE' };
  }
  try {
    const res = await db.query<CrosspostDraftRow>(
      `INSERT INTO crosspost_drafts (owner_id, store_id, expires_at, purge_after)
       SELECT s.owner_id, s.id, $3, $4
         FROM stores s
        WHERE s.id = $2
          AND s.owner_id = $1
          AND s.place_status = 'confirmed'
          AND s.place_id IS NOT NULL
          AND s.suspended_at IS NULL
       RETURNING ${DRAFT_COLUMNS}`,
      [input.ownerId, input.storeId, input.expiresAt, input.purgeAfter],
    );
    const row = res.rows[0];
    if (!row) return { ok: false, error: 'STORE_NOT_ELIGIBLE' };
    return { ok: true, value: row };
  } catch (err) {
    if (isUniqueViolation(err, 'ux_crosspost_drafts_open_owner')) {
      return { ok: false, error: 'OPEN_DRAFT_EXISTS' };
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const record = err as { code?: unknown; constraint?: unknown };
  return record.code === '23505' && record.constraint === constraint;
}

/** 取り消し・期限切れの結果。消した写真の置き場の名前（実体の削除は呼び出し側）を伴う。 */
export interface ClosedCrosspostDraft {
  draftId: string;
  removedStorageKeys: string[];
}

/**
 * 作成中の下書きを取り消す（canceled）。写真の行も消し、置き場の名前を返す。
 * `onlyIfExpiredAt` を渡すと、その時刻で期限切れのときだけ取り消す（期限切れの片付け）。
 * 0 行（作成中でない・他のオーナーの下書き・期限内）は null。
 */
export async function closeCrosspostDraft(
  db: Queryable,
  key: { ownerId: string; draftId: string; onlyIfExpiredAt?: Date },
): Promise<ClosedCrosspostDraft | null> {
  if (!isUuid(key.ownerId) || !isUuid(key.draftId)) return null;
  const res = await db.query<{ draft_id: string; storage_key: string | null }>(
    `WITH closed AS (
       UPDATE crosspost_drafts
          SET status = 'canceled', input_mode = 'none', input_destination = NULL, updated_at = now()
        WHERE id = $1 AND owner_id = $2
          AND status IN ('collecting', 'reviewing')
          AND ($3::timestamptz IS NULL OR expires_at <= $3::timestamptz)
       RETURNING id
     ), removed AS (
       DELETE FROM crosspost_media m USING closed c
        WHERE m.draft_id = c.id
       RETURNING m.storage_key
     )
     SELECT c.id AS draft_id, r.storage_key
       FROM closed c
       LEFT JOIN removed r ON true`,
    [key.draftId, key.ownerId, key.onlyIfExpiredAt ?? null],
  );
  const first = res.rows[0];
  if (!first) return null;
  return {
    draftId: first.draft_id,
    removedStorageKeys: res.rows.flatMap((row) => (row.storage_key === null ? [] : [row.storage_key])),
  };
}

export type AppendMaterialError = 'NOT_COLLECTING' | 'TOO_LONG';

/**
 * 素材の文を追記する（受け取り中だけ・合計 2,000 字まで）。追記の前後を改行でつなぐ。
 * 受け取り中でない（下書きを作り始めた後に届いた文など）なら NOT_COLLECTING を返し、何も変えない。
 */
export async function appendCrosspostMaterial(
  db: Queryable,
  input: { ownerId: string; draftId: string; text: string; expiresAt: Date },
): Promise<Result<CrosspostDraftRow, AppendMaterialError>> {
  if (!isUuid(input.ownerId) || !isUuid(input.draftId)) return { ok: false, error: 'NOT_COLLECTING' };
  const res = await db.query<CrosspostDraftRow & { appended: boolean }>(
    `WITH target AS (
       SELECT id,
              CASE WHEN material_text = '' THEN $3 ELSE material_text || E'\\n' || $3 END AS next_text
         FROM crosspost_drafts
        WHERE id = $1 AND owner_id = $2 AND status = 'collecting'
          FOR UPDATE
     ), updated AS (
       UPDATE crosspost_drafts d
          SET material_text = t.next_text, expires_at = $4, updated_at = now()
         FROM target t
        WHERE d.id = t.id AND char_length(t.next_text) <= ${CROSSPOST_MATERIAL_MAX_CHARS}
       RETURNING ${prefixed(DRAFT_COLUMNS, 'd')}
     )
     SELECT u.*, true AS appended FROM updated u
     UNION ALL
     SELECT ${prefixed(DRAFT_COLUMNS, 'd')}, false AS appended
       FROM crosspost_drafts d JOIN target t ON t.id = d.id
      WHERE NOT EXISTS (SELECT 1 FROM updated)`,
    [input.draftId, input.ownerId, input.text, input.expiresAt],
  );
  const row = res.rows[0];
  if (!row) return { ok: false, error: 'NOT_COLLECTING' };
  const { appended, ...draft } = row;
  if (!appended) return { ok: false, error: 'TOO_LONG' };
  return { ok: true, value: draft };
}

/**
 * 受け取り中から確認中へ進める（「下書きを作る」）。素材の文が空なら進めない。
 * 版を 1 進める（受け取り中に出したボタンを古くする）。0 行は null。
 */
export async function beginCrosspostReview(
  db: Queryable,
  input: { ownerId: string; draftId: string; expiresAt: Date },
): Promise<CrosspostDraftRow | null> {
  if (!isUuid(input.ownerId) || !isUuid(input.draftId)) return null;
  const res = await db.query<CrosspostDraftRow>(
    `UPDATE crosspost_drafts
        SET status = 'reviewing', revision = revision + 1, expires_at = $3, updated_at = now()
      WHERE id = $1 AND owner_id = $2 AND status = 'collecting' AND btrim(material_text) <> ''
      RETURNING ${DRAFT_COLUMNS}`,
    [input.draftId, input.ownerId, input.expiresAt],
  );
  return res.rows[0] ?? null;
}

export interface SaveCrosspostTextsInput {
  ownerId: string;
  draftId: string;
  /** この版のときだけ保存する（生成の間に別の変更が入ったら保存しない）。 */
  expectedRevision: number;
  /** 渡した投稿先の文だけを置き換える。undefined の投稿先は変えない。 */
  texts: Partial<Record<CrosspostDestination, string>>;
  /** 修正指示を素材へ足すとき（AI への修正指示は素材として扱う・Req 4.3）。 */
  appendMaterial?: string;
  expiresAt: Date;
}

/**
 * 確認中の下書きの文を保存し、版を 1 進め、入力モードを戻す。版が一致しなければ null（何も変えない）。
 */
export async function saveCrosspostTexts(
  db: Queryable,
  input: SaveCrosspostTextsInput,
): Promise<CrosspostDraftRow | null> {
  if (!isUuid(input.ownerId) || !isUuid(input.draftId)) return null;
  const instagram = input.texts.instagram;
  const google = input.texts.google;
  const res = await db.query<CrosspostDraftRow>(
    `UPDATE crosspost_drafts
        SET instagram_text = CASE WHEN $4::boolean THEN $5 ELSE instagram_text END,
            google_text = CASE WHEN $6::boolean THEN $7 ELSE google_text END,
            material_text = CASE
              WHEN $8::text IS NULL THEN material_text
              WHEN material_text = '' THEN $8::text
              ELSE material_text || E'\\n' || $8::text
            END,
            revision = revision + 1,
            input_mode = 'none',
            input_destination = NULL,
            expires_at = $9,
            updated_at = now()
      WHERE id = $1 AND owner_id = $2 AND status = 'reviewing' AND revision = $3
        AND ($8::text IS NULL
             OR char_length(material_text) + 1 + char_length($8::text) <= ${CROSSPOST_MATERIAL_MAX_CHARS})
      RETURNING ${DRAFT_COLUMNS}`,
    [
      input.draftId,
      input.ownerId,
      input.expectedRevision,
      instagram !== undefined,
      instagram ?? null,
      google !== undefined,
      google ?? null,
      input.appendMaterial ?? null,
      input.expiresAt,
    ],
  );
  return res.rows[0] ?? null;
}

/**
 * 確認中の入力モードを切り替える（AI への修正指示・店主の書き直し・解除）。版は進めない
 * （文は変わらないので、最終確認のカードは有効のまま）。版が一致しなければ null。
 */
export async function setCrosspostInputMode(
  db: Queryable,
  input: {
    ownerId: string;
    draftId: string;
    expectedRevision: number;
    mode: CrosspostInputMode;
    destination: CrosspostDestination | null;
    expiresAt: Date;
  },
): Promise<CrosspostDraftRow | null> {
  if (!isUuid(input.ownerId) || !isUuid(input.draftId)) return null;
  if ((input.mode === 'none') !== (input.destination === null)) return null;
  const res = await db.query<CrosspostDraftRow>(
    `UPDATE crosspost_drafts
        SET input_mode = $4, input_destination = $5, expires_at = $6, updated_at = now()
      WHERE id = $1 AND owner_id = $2 AND status = 'reviewing' AND revision = $3
      RETURNING ${DRAFT_COLUMNS}`,
    [input.draftId, input.ownerId, input.expectedRevision, input.mode, input.destination, input.expiresAt],
  );
  return res.rows[0] ?? null;
}

/**
 * 期限を延ばす（確認のカードを出し直したときなど）。作成中だけ。
 */
export async function extendCrosspostDraft(
  db: Queryable,
  input: { ownerId: string; draftId: string; expiresAt: Date },
): Promise<void> {
  if (!isUuid(input.ownerId) || !isUuid(input.draftId)) return;
  await db.query(
    `UPDATE crosspost_drafts SET expires_at = $3, updated_at = now()
      WHERE id = $1 AND owner_id = $2 AND status IN ('collecting', 'reviewing')`,
    [input.draftId, input.ownerId, input.expiresAt],
  );
}

// =====================================================================
// 写真
// =====================================================================

export interface CrosspostMediaInput {
  lineMessageId: string;
  storageKey: string;
  contentType: 'image/jpeg';
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
}

export type AttachMediaOutcome =
  | { kind: 'attached'; draft: CrosspostDraftRow; media: CrosspostMediaRow; replacedStorageKeys: string[] }
  /** 同じ LINE のメッセージの写真が既にある（再配信など）。何も変えていない。 */
  | { kind: 'duplicate'; draft: CrosspostDraftRow; media: CrosspostMediaRow }
  /** 作成中でない・他のオーナーの下書き。何も変えていない。 */
  | { kind: 'not_open' };

/**
 * 写真を付ける。既にある写真は差し替える（古い行を消して置き場の名前を返す）。版を 1 進める
 * （確認中に写真が変わったら、古い最終確認から投稿させない・Req 4.5）。
 * 下書きの行を FOR UPDATE で固定し、同じ下書きへ並行して届いた写真の付け替えを直列にする。
 */
export async function attachCrosspostMedia(
  pool: TransactionCapable,
  input: { ownerId: string; draftId: string; media: CrosspostMediaInput; expiresAt: Date },
): Promise<AttachMediaOutcome> {
  if (!isUuid(input.ownerId) || !isUuid(input.draftId)) return { kind: 'not_open' };
  return inTransaction(pool, async (client) => {
    const locked = await client.query<CrosspostDraftRow>(
      `SELECT ${DRAFT_COLUMNS} FROM crosspost_drafts
        WHERE id = $1 AND owner_id = $2 AND status IN ('collecting', 'reviewing')
        FOR UPDATE`,
      [input.draftId, input.ownerId],
    );
    if (!locked.rows[0]) return { kind: 'not_open' } as const;

    const existing = await client.query<CrosspostMediaRow>(
      `SELECT ${MEDIA_COLUMNS} FROM crosspost_media WHERE draft_id = $1`,
      [input.draftId],
    );
    const current = existing.rows[0];
    if (current && current.line_message_id === input.media.lineMessageId) {
      return { kind: 'duplicate', draft: locked.rows[0], media: current } as const;
    }

    const removed = await client.query<{ storage_key: string }>(
      'DELETE FROM crosspost_media WHERE draft_id = $1 RETURNING storage_key',
      [input.draftId],
    );
    const inserted = await client.query<CrosspostMediaRow>(
      `INSERT INTO crosspost_media
         (draft_id, line_message_id, storage_key, content_type, width, height, byte_size, sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${MEDIA_COLUMNS}`,
      [
        input.draftId,
        input.media.lineMessageId,
        input.media.storageKey,
        input.media.contentType,
        input.media.width,
        input.media.height,
        input.media.byteSize,
        input.media.sha256,
      ],
    );
    const bumped = await client.query<CrosspostDraftRow>(
      `UPDATE crosspost_drafts
          SET revision = revision + 1, input_mode = 'none', input_destination = NULL,
              expires_at = $2, updated_at = now()
        WHERE id = $1
        RETURNING ${DRAFT_COLUMNS}`,
      [input.draftId, input.expiresAt],
    );
    return {
      kind: 'attached',
      draft: bumped.rows[0]!,
      media: inserted.rows[0]!,
      replacedStorageKeys: removed.rows.map((row) => row.storage_key),
    } as const;
  });
}

/** 下書きの写真（そのオーナーのものだけ）。 */
export async function getCrosspostMedia(
  db: Queryable,
  key: { ownerId: string; draftId: string },
): Promise<CrosspostMediaRow | null> {
  if (!isUuid(key.ownerId) || !isUuid(key.draftId)) return null;
  const res = await db.query<CrosspostMediaRow>(
    `SELECT ${prefixed(MEDIA_COLUMNS, 'm')}
       FROM crosspost_media m
       JOIN crosspost_drafts d ON d.id = m.draft_id
      WHERE m.draft_id = $1 AND d.owner_id = $2`,
    [key.draftId, key.ownerId],
  );
  return res.rows[0] ?? null;
}

// =====================================================================
// 承認と投稿先の状態
// =====================================================================

export type ApproveCrosspostOutcome =
  | { kind: 'approved'; draft: CrosspostDraftRow; deliveries: CrosspostDeliveryRow[] }
  /** 版の不一致・確認中でない・選んだ投稿先の文が無い・店舗を操作できない・二重の承認。何も変えていない。 */
  | { kind: 'stale' };

/**
 * 承認する。下書きを approved にし、選んだ投稿先ごとに本文の写しを持つ行を作る（1 トランザクション）。
 * 承認の UPDATE は「確認中・版が一致・選んだ投稿先の文がある・店舗を今も操作できる」をすべて WHERE に含む
 * 1 文なので、二重タップ・並行したリクエストでも承認できるのは高々 1 回（Req 5.4, 5.5, 5.7）。
 */
export async function approveCrosspostDraft(
  pool: TransactionCapable,
  input: {
    ownerId: string;
    draftId: string;
    expectedRevision: number;
    destinations: readonly CrosspostDestination[];
  },
): Promise<ApproveCrosspostOutcome> {
  const destinations = [...new Set(input.destinations)];
  if (!isUuid(input.ownerId) || !isUuid(input.draftId) || destinations.length === 0) return { kind: 'stale' };
  const wantsInstagram = destinations.includes('instagram');
  const wantsGoogle = destinations.includes('google');

  return inTransaction(pool, async (client) => {
    const approved = await client.query<CrosspostDraftRow>(
      `UPDATE crosspost_drafts d
          SET status = 'approved', approved_revision = d.revision, approved_at = now(),
              input_mode = 'none', input_destination = NULL, updated_at = now()
         FROM stores s
        WHERE d.id = $1 AND d.owner_id = $2
          AND d.status = 'reviewing' AND d.revision = $3
          AND (NOT $4::boolean OR d.instagram_text IS NOT NULL)
          AND (NOT $5::boolean OR d.google_text IS NOT NULL)
          AND s.id = d.store_id
          AND s.owner_id = d.owner_id
          AND s.place_status = 'confirmed'
          AND s.place_id IS NOT NULL
          AND s.suspended_at IS NULL
        RETURNING ${prefixed(DRAFT_COLUMNS, 'd')}`,
      [input.draftId, input.ownerId, input.expectedRevision, wantsInstagram, wantsGoogle],
    );
    const draft = approved.rows[0];
    if (!draft) return { kind: 'stale' } as const;

    const media = await client.query<{ id: string }>('SELECT id FROM crosspost_media WHERE draft_id = $1', [
      draft.id,
    ]);
    const mediaId = media.rows[0]?.id ?? null;

    const deliveries: CrosspostDeliveryRow[] = [];
    for (const destination of destinations) {
      const body = destination === 'instagram' ? draft.instagram_text : draft.google_text;
      const inserted = await client.query<CrosspostDeliveryRow>(
        `INSERT INTO crosspost_deliveries (draft_id, destination, body_text, with_media, media_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${DELIVERY_COLUMNS}`,
        [draft.id, destination, body, mediaId !== null, mediaId],
      );
      deliveries.push(inserted.rows[0]!);
    }
    return { kind: 'approved', draft, deliveries } as const;
  });
}

/** 投稿先の行と、その下書き・店舗の情報（表示と実行の入力）。 */
export interface CrosspostDeliveryContext {
  delivery: CrosspostDeliveryRow;
  ownerId: string;
  storeId: string;
  storeName: string;
  media: CrosspostMediaRow | null;
}

const DELIVERY_CONTEXT_SELECT = `SELECT ${prefixed(DELIVERY_COLUMNS, 'v')},
            d.owner_id AS ctx_owner_id, d.store_id AS ctx_store_id, s.name AS ctx_store_name,
            m.id AS m_id, m.line_message_id AS m_line_message_id, m.storage_key AS m_storage_key,
            m.content_type AS m_content_type, m.width AS m_width, m.height AS m_height,
            m.byte_size AS m_byte_size, m.sha256 AS m_sha256, m.created_at AS m_created_at
       FROM crosspost_deliveries v
       JOIN crosspost_drafts d ON d.id = v.draft_id
       JOIN stores s ON s.id = d.store_id
       LEFT JOIN crosspost_media m ON m.id = v.media_id`;

type DeliveryContextRow = CrosspostDeliveryRow & {
  ctx_owner_id: string;
  ctx_store_id: string;
  ctx_store_name: string;
  m_id: string | null;
  m_line_message_id: string | null;
  m_storage_key: string | null;
  m_content_type: string | null;
  m_width: number | null;
  m_height: number | null;
  m_byte_size: number | null;
  m_sha256: string | null;
  m_created_at: Date | null;
};

function toDeliveryContext(row: DeliveryContextRow): CrosspostDeliveryContext {
  const {
    ctx_owner_id,
    ctx_store_id,
    ctx_store_name,
    m_id,
    m_line_message_id,
    m_storage_key,
    m_content_type,
    m_width,
    m_height,
    m_byte_size,
    m_sha256,
    m_created_at,
    ...delivery
  } = row;
  const media: CrosspostMediaRow | null =
    m_id === null
      ? null
      : {
          id: m_id,
          draft_id: delivery.draft_id,
          line_message_id: m_line_message_id!,
          storage_key: m_storage_key!,
          content_type: m_content_type!,
          width: m_width!,
          height: m_height!,
          byte_size: m_byte_size!,
          sha256: m_sha256!,
          created_at: m_created_at!,
        };
  return { delivery, ownerId: ctx_owner_id, storeId: ctx_store_id, storeName: ctx_store_name, media };
}

/** 投稿先の行を ID で返す（そのオーナーのものだけ）。 */
export async function getCrosspostDelivery(
  db: Queryable,
  key: { ownerId: string; deliveryId: string },
): Promise<CrosspostDeliveryContext | null> {
  if (!isUuid(key.ownerId) || !isUuid(key.deliveryId)) return null;
  const res = await db.query<DeliveryContextRow>(`${DELIVERY_CONTEXT_SELECT} WHERE v.id = $1 AND d.owner_id = $2`, [
    key.deliveryId,
    key.ownerId,
  ]);
  const row = res.rows[0];
  return row ? toDeliveryContext(row) : null;
}

/** 下書きの投稿先の行（そのオーナーのものだけ・投稿先の名前順）。 */
export async function listCrosspostDeliveries(
  db: Queryable,
  key: { ownerId: string; draftId: string },
): Promise<CrosspostDeliveryContext[]> {
  if (!isUuid(key.ownerId) || !isUuid(key.draftId)) return [];
  const res = await db.query<DeliveryContextRow>(
    `${DELIVERY_CONTEXT_SELECT} WHERE v.draft_id = $1 AND d.owner_id = $2 ORDER BY v.destination`,
    [key.draftId, key.ownerId],
  );
  return res.rows.map(toDeliveryContext);
}

/** 直近の承認済みの下書きと、その投稿先の状態（新しい順）。 */
export async function listRecentCrosspostPosts(
  db: Queryable,
  input: { ownerId: string; limit: number },
): Promise<Array<{ draft: CrosspostDraftRow; storeName: string; deliveries: CrosspostDeliveryRow[] }>> {
  if (!isUuid(input.ownerId)) return [];
  const limit = Math.min(Math.max(Math.trunc(input.limit) || 1, 1), 10);
  const drafts = await db.query<CrosspostDraftRow & { store_name: string }>(
    `SELECT ${prefixed(DRAFT_COLUMNS, 'd')}, s.name AS store_name
       FROM crosspost_drafts d
       JOIN stores s ON s.id = d.store_id
      WHERE d.owner_id = $1 AND d.status = 'approved'
      ORDER BY d.approved_at DESC, d.id DESC
      LIMIT $2`,
    [input.ownerId, limit],
  );
  if (drafts.rows.length === 0) return [];
  const ids = drafts.rows.map((row) => row.id);
  const deliveries = await db.query<CrosspostDeliveryRow>(
    `SELECT ${DELIVERY_COLUMNS} FROM crosspost_deliveries WHERE draft_id = ANY($1::uuid[]) ORDER BY destination`,
    [ids],
  );
  return drafts.rows.map(({ store_name, ...draft }) => ({
    draft,
    storeName: store_name,
    deliveries: deliveries.rows.filter((row) => row.draft_id === draft.id),
  }));
}

export type ClaimMode =
  /** 承認の直後の初回（queued だけ）。 */
  | 'first'
  /** 店主の再試行（retryable な failed だけ・回数の上限つき）。 */
  | 'retry';

/**
 * 投稿の実行権を獲得する（queued / 再試行できる failed → in_progress・試行回数 +1）。
 * 行を返したリクエストだけが外部 API へ投稿してよい。店舗を今も操作できることも条件にする。
 */
export async function claimCrosspostDelivery(
  db: Queryable,
  input: { ownerId: string; deliveryId: string; mode: ClaimMode; maxAttempts: number },
): Promise<CrosspostDeliveryRow | null> {
  if (!isUuid(input.ownerId) || !isUuid(input.deliveryId)) return null;
  const res = await db.query<CrosspostDeliveryRow>(
    `UPDATE crosspost_deliveries v
        SET status = 'in_progress', attempt_count = v.attempt_count + 1, last_attempt_at = now(),
            finished_at = NULL, retryable = false, failure_reason = NULL, unknown_reason = NULL,
            updated_at = now()
       FROM crosspost_drafts d, stores s
      WHERE v.id = $1
        AND d.id = v.draft_id AND d.owner_id = $2 AND d.status = 'approved'
        AND s.id = d.store_id AND s.owner_id = d.owner_id
        AND s.place_status = 'confirmed' AND s.place_id IS NOT NULL AND s.suspended_at IS NULL
        AND v.attempt_count < $4
        AND (
          ($3 = 'first' AND v.status = 'queued')
          OR ($3 = 'retry' AND v.status = 'failed' AND v.retryable)
        )
      RETURNING ${prefixed(DELIVERY_COLUMNS, 'v')}`,
    [input.deliveryId, input.ownerId, input.mode, input.maxAttempts],
  );
  return res.rows[0] ?? null;
}

/** 途中の到達点を保存する（獲得した試行の間だけ）。保存できたか（false = 試行が古い）。 */
export async function saveCrosspostCheckpoint(
  db: Queryable,
  input: { deliveryId: string; attempt: number; checkpoint: string },
): Promise<boolean> {
  if (!isUuid(input.deliveryId)) return false;
  const res = await db.query(
    `UPDATE crosspost_deliveries SET checkpoint = $3, updated_at = now()
      WHERE id = $1 AND status = 'in_progress' AND attempt_count = $2`,
    [input.deliveryId, input.attempt, input.checkpoint],
  );
  return (res.rowCount ?? 0) > 0;
}

export type CrosspostOutcomeRecord =
  | { kind: 'succeeded'; externalId: string | null; externalUrl: string | null }
  | { kind: 'failed'; reason: CrosspostFailureReason; retryable: boolean }
  | { kind: 'unknown'; reason: CrosspostUnknownReason };

/**
 * 試行の結果を記録する。獲得した試行（in_progress かつ attempt_count が一致）のときだけ書く。
 * null は「古い試行の結果」で、何も変えていない。
 */
export async function recordCrosspostOutcome(
  db: Queryable,
  input: { deliveryId: string; attempt: number; outcome: CrosspostOutcomeRecord },
): Promise<CrosspostDeliveryRow | null> {
  if (!isUuid(input.deliveryId)) return null;
  const o = input.outcome;
  const res = await db.query<CrosspostDeliveryRow>(
    `UPDATE crosspost_deliveries
        SET status = $3::crosspost_delivery_status,
            retryable = $4,
            failure_reason = $5,
            unknown_reason = $6,
            external_id = COALESCE($7, external_id),
            external_url = COALESCE($8, external_url),
            finished_at = now(),
            updated_at = now()
      WHERE id = $1 AND status = 'in_progress' AND attempt_count = $2
      RETURNING ${DELIVERY_COLUMNS}`,
    [
      input.deliveryId,
      input.attempt,
      o.kind,
      o.kind === 'failed' ? o.retryable : false,
      o.kind === 'failed' ? o.reason : null,
      o.kind === 'unknown' ? o.reason : null,
      o.kind === 'succeeded' ? o.externalId : null,
      o.kind === 'succeeded' ? o.externalUrl : null,
    ],
  );
  return res.rows[0] ?? null;
}

/**
 * 実行中のまま `olderThan` より前に試行を始めた行を「結果不明」にする（処理の中断・Req 6.9）。
 * そのオーナーの行だけ。移した件数を返す。
 */
export async function markStaleCrosspostDeliveries(
  db: Queryable,
  input: { ownerId: string; olderThan: Date },
): Promise<number> {
  if (!isUuid(input.ownerId)) return 0;
  const res = await db.query(
    `UPDATE crosspost_deliveries v
        SET status = 'unknown', unknown_reason = 'stale_in_progress', finished_at = now(), updated_at = now()
       FROM crosspost_drafts d
      WHERE d.id = v.draft_id AND d.owner_id = $1
        AND v.status = 'in_progress' AND v.last_attempt_at < $2`,
    [input.ownerId, input.olderThan],
  );
  return res.rowCount ?? 0;
}

/**
 * 結果不明の投稿先を確定する。posted = true は成功へ、false は「投稿されていないことを確かめた」失敗
 * （再試行できる）へ。結果不明でなければ null（何も変えない）。
 */
export async function resolveUnknownCrosspostDelivery(
  db: Queryable,
  input: {
    ownerId: string;
    deliveryId: string;
    posted: boolean;
    externalId?: string | null;
    externalUrl?: string | null;
  },
): Promise<CrosspostDeliveryRow | null> {
  if (!isUuid(input.ownerId) || !isUuid(input.deliveryId)) return null;
  const res = await db.query<CrosspostDeliveryRow>(
    `UPDATE crosspost_deliveries v
        SET status = CASE WHEN $3 THEN 'succeeded'::crosspost_delivery_status ELSE 'failed'::crosspost_delivery_status END,
            retryable = NOT $3,
            failure_reason = CASE WHEN $3 THEN NULL ELSE 'owner_reported_not_posted' END,
            unknown_reason = NULL,
            external_id = COALESCE($4, v.external_id),
            external_url = COALESCE($5, v.external_url),
            finished_at = now(),
            updated_at = now()
       FROM crosspost_drafts d
      WHERE v.id = $1 AND d.id = v.draft_id AND d.owner_id = $2 AND v.status = 'unknown'
      RETURNING ${prefixed(DELIVERY_COLUMNS, 'v')}`,
    [input.deliveryId, input.ownerId, input.posted, input.externalId ?? null, input.externalUrl ?? null],
  );
  return res.rows[0] ?? null;
}

/**
 * 投稿が終わった下書きの写真の行を消し、置き場の名前を返す（実体の削除は呼び出し側）。
 * 「終わった」= どの投稿先も、待ち・実行中・結果不明・再試行できる失敗（上限内）でない。
 */
export async function releaseSettledCrosspostMedia(
  db: Queryable,
  input: { ownerId: string; draftId: string; maxAttempts: number },
): Promise<string[]> {
  if (!isUuid(input.ownerId) || !isUuid(input.draftId)) return [];
  const res = await db.query<{ storage_key: string }>(
    `DELETE FROM crosspost_media m
      USING crosspost_drafts d
      WHERE m.draft_id = $1 AND d.id = m.draft_id AND d.owner_id = $2 AND d.status = 'approved'
        AND NOT EXISTS (
          SELECT 1 FROM crosspost_deliveries v
           WHERE v.draft_id = m.draft_id
             AND (v.status IN ('queued', 'in_progress', 'unknown')
                  OR (v.status = 'failed' AND v.retryable AND v.attempt_count < $3))
        )
      RETURNING m.storage_key`,
    [input.draftId, input.ownerId, input.maxAttempts],
  );
  return res.rows.map((row) => row.storage_key);
}

/**
 * 保存期間（purge_after）を過ぎた下書きを、少数ずつ削除する（写真・投稿先の行は CASCADE）。
 * 消した写真の置き場の名前を返す。全オーナーが対象（保存期間の削除は利用者の操作ではない）。
 */
export async function purgeExpiredCrosspostDrafts(
  db: Queryable,
  input: { now: Date; limit: number },
): Promise<{ deletedDrafts: number; removedStorageKeys: string[] }> {
  const limit = Math.min(Math.max(Math.trunc(input.limit) || 1, 1), 100);
  const res = await db.query<{ id: string; storage_key: string | null }>(
    `WITH doomed AS (
       SELECT id FROM crosspost_drafts
        WHERE purge_after <= $1
        ORDER BY purge_after
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     ), keys AS (
       SELECT m.draft_id, m.storage_key FROM crosspost_media m JOIN doomed x ON x.id = m.draft_id
     ), deleted AS (
       DELETE FROM crosspost_drafts d USING doomed x WHERE d.id = x.id RETURNING d.id
     )
     SELECT de.id, k.storage_key FROM deleted de LEFT JOIN keys k ON k.draft_id = de.id`,
    [input.now, limit],
  );
  const ids = new Set(res.rows.map((row) => row.id));
  return {
    deletedDrafts: ids.size,
    removedStorageKeys: res.rows.flatMap((row) => (row.storage_key === null ? [] : [row.storage_key])),
  };
}

// =====================================================================
// 内部
// =====================================================================

async function inTransaction<T>(pool: TransactionCapable, body: (client: TransactionClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await body(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // swallowed-exception: intentional — 巻き戻しの失敗は元の例外を隠さない（元の例外を投げ直す）。
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
