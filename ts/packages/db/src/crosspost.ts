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
  | 'owner_reported_not_posted'
  /** 外部 API へ送る前に処理が中断した（送っていないことが確か）。 */
  | 'interrupted_before_send';

/** 0019 の CHECK と 1:1。 */
export type CrosspostUnknownReason =
  | 'timeout'
  | 'network'
  | 'upstream_5xx'
  | 'rate_limited_after_send'
  | 'adapter_threw'
  | 'stale_in_progress';

export const CROSSPOST_DESTINATIONS: readonly CrosspostDestination[] = ['instagram', 'google'];

/**
 * 写真の保存期間（受け取りから・line-crosspost Req 8.3）。line-webhook と配信ジョブの両方が使うので、ここに 1 つだけ置く。
 * 置き場（GCS）の寿命の規則も同じ 7 日にする（tasks 6.1）。
 */
export const CROSSPOST_MEDIA_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** 素材の文の上限（0019 の CHECK と同じ値）。 */
export const CROSSPOST_MATERIAL_MAX_CHARS = 2000;

export interface CrosspostDraftRow {
  id: string;
  owner_id: string;
  store_id: string;
  status: CrosspostDraftStatus;
  input_mode: CrosspostInputMode;
  input_destination: CrosspostDestination | null;
  /** 入力モードを切り替えた操作の LINE の時刻（モードが none なら NULL）。 */
  input_mode_set_at: Date | null;
  /** 下書きを始めた操作の LINE の時刻。これより後に送られた写真・文だけを素材にする。 */
  line_started_at: Date;
  revision: number;
  material_text: string;
  instagram_text: string | null;
  google_text: string | null;
  approved_revision: number | null;
  approved_at: Date | null;
  /** 結果を店主へ届けられた最後の時刻（NULL = まだ一度も届けていない）。 */
  result_notified_at: Date | null;
  expires_at: Date;
  purge_after: Date;
  created_at: Date;
  updated_at: Date;
}

export interface CrosspostMediaRow {
  id: string;
  draft_id: string;
  line_message_id: string;
  /** 店主が送った写真のメッセージの quoteToken（最終確認で引用する）。 */
  line_quote_token: string | null;
  /** 店主が写真を送った時刻（Webhook のイベントの timestamp）。差し替えの順序の判定に使う。 */
  line_sent_at: Date;
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
  /** この試行が外部 API への送信を始めた時刻（NULL = この試行では何も送っていない）。 */
  send_started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** 本機能の対象にできる店舗（所有・Place 確定・利用中・有効化の指定に含まれる）。 */
export interface CrosspostStoreSummary {
  id: string;
  name: string;
}

const DRAFT_COLUMNS = `id, owner_id, store_id, status, input_mode, input_destination, input_mode_set_at, line_started_at,
  revision, material_text,
  instagram_text, google_text, approved_revision, approved_at, result_notified_at, expires_at, purge_after, created_at, updated_at`;

const MEDIA_COLUMNS = `id, draft_id, line_message_id, line_quote_token, line_sent_at, storage_key, content_type, width, height, byte_size, sha256, created_at`;

const DELIVERY_COLUMNS = `id, draft_id, destination, status, body_text, with_media, media_id, attempt_count, retryable,
  failure_reason, unknown_reason, checkpoint, external_id, external_url, last_attempt_at, send_started_at, finished_at,
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
  /** 下書きを始めた操作（「投稿」の文・開始の postback）の LINE のイベントの時刻。 */
  lineStartedAt: Date;
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
      `INSERT INTO crosspost_drafts (owner_id, store_id, expires_at, purge_after, line_started_at)
       SELECT s.owner_id, s.id, $3, $4, $5
         FROM stores s
        WHERE s.id = $2
          AND s.owner_id = $1
          AND s.place_status = 'confirmed'
          AND s.place_id IS NOT NULL
          AND s.suspended_at IS NULL
       RETURNING ${DRAFT_COLUMNS}`,
      [input.ownerId, input.storeId, input.expiresAt, input.purgeAfter, input.lineStartedAt],
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
          SET status = 'canceled', input_mode = 'none', input_destination = NULL, input_mode_set_at = NULL,
              updated_at = now()
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

export type AppendMaterialError = 'NOT_COLLECTING' | 'TOO_LONG' | 'NOT_AFTER_START';

/**
 * 素材の文を追記する（受け取り中だけ・合計 2,000 字まで）。追記の前後を改行でつなぐ。
 * 受け取り中でない（下書きを作り始めた後に届いた文など）なら NOT_COLLECTING を返し、何も変えない。
 * 文を送った LINE の時刻（`sentAt`）が下書きを始めた時刻より後でなければ（前の下書きの文が遅れて届いた・
 * 同じ時刻・時刻不明）NOT_AFTER_START を返し、何も変えない（別の下書きの素材を混ぜない）。
 */
export async function appendCrosspostMaterial(
  db: Queryable,
  input: { ownerId: string; draftId: string; text: string; sentAt: Date | null; expiresAt: Date },
): Promise<Result<CrosspostDraftRow, AppendMaterialError>> {
  if (!isUuid(input.ownerId) || !isUuid(input.draftId)) return { ok: false, error: 'NOT_COLLECTING' };
  if (input.sentAt === null) return { ok: false, error: 'NOT_AFTER_START' };
  const started = await db.query<{ ok: boolean }>(
    `SELECT line_started_at < $3 AS ok FROM crosspost_drafts WHERE id = $1 AND owner_id = $2`,
    [input.draftId, input.ownerId, input.sentAt],
  );
  if (started.rows[0] && started.rows[0].ok !== true) return { ok: false, error: 'NOT_AFTER_START' };
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
  /**
   * 入力モードの文（修正指示・書き直し）から保存するとき、その文を送った LINE の時刻。入力モードを切り替えた
   * 時刻より後でなければ保存しない（切り替えの前に送った文を、書き直しの文にしない）。
   */
  inputSentAt?: Date;
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
            input_mode_set_at = NULL,
            expires_at = $9,
            updated_at = now()
      WHERE id = $1 AND owner_id = $2 AND status = 'reviewing' AND revision = $3
        AND ($10::timestamptz IS NULL OR (input_mode_set_at IS NOT NULL AND input_mode_set_at < $10::timestamptz))
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
      input.inputSentAt ?? null,
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
    /**
     * 切り替えた操作（postback）の LINE の時刻。モードが none 以外では必須。これより後に送られた文だけを
     * 修正指示・書き直しの文として扱う（`saveCrosspostTexts` の `inputSentAt`）。
     */
    lineEventAt: Date | null;
    expiresAt: Date;
  },
): Promise<CrosspostDraftRow | null> {
  if (!isUuid(input.ownerId) || !isUuid(input.draftId)) return null;
  if ((input.mode === 'none') !== (input.destination === null)) return null;
  if (input.mode !== 'none' && input.lineEventAt === null) return null;
  const res = await db.query<CrosspostDraftRow>(
    `UPDATE crosspost_drafts
        SET input_mode = $4, input_destination = $5, input_mode_set_at = $7, expires_at = $6, updated_at = now()
      WHERE id = $1 AND owner_id = $2 AND status = 'reviewing' AND revision = $3
      RETURNING ${DRAFT_COLUMNS}`,
    [
      input.draftId,
      input.ownerId,
      input.expectedRevision,
      input.mode,
      input.destination,
      input.expiresAt,
      input.mode === 'none' ? null : input.lineEventAt,
    ],
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
  lineQuoteToken: string | null;
  /** 店主が写真を送った時刻（Webhook のイベントの timestamp）。 */
  lineSentAt: Date;
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
  /**
   * いまの写真より前に送られた写真（処理が遅れて後から届いた）。店主が最後に送った写真を保つため、差し替えない。
   * 何も変えていない。
   */
  | { kind: 'older'; draft: CrosspostDraftRow; media: CrosspostMediaRow }
  /**
   * いまの写真と同じ時刻（ミリ秒）に送られた別の写真。どちらが後かを決められないので、推測で差し替えない。
   * 何も変えていない（呼び出し側は、使いたい写真を 1 枚だけ送り直すよう求める）。
   */
  | { kind: 'ambiguous'; draft: CrosspostDraftRow; media: CrosspostMediaRow }
  /**
   * 下書きを始める前（または同じ時刻）に送られた写真。前の下書き・別の店舗の下書きへ送った写真が遅れて届いた
   * 可能性があるので、この下書きには付けない。何も変えていない。
   */
  | { kind: 'before_draft'; draft: CrosspostDraftRow }
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
    // 下書きを始めた時刻と、写真を送った時刻を同じ LINE の時計で比べる。始める前・同じ時刻の写真は、別の下書き
    // （取り消した下書き・別の店舗の下書き）へ送ったものが遅れて届いた可能性を否定できないので付けない。
    if (input.media.lineSentAt.getTime() <= locked.rows[0].line_started_at.getTime()) {
      return { kind: 'before_draft', draft: locked.rows[0] } as const;
    }

    const existing = await client.query<CrosspostMediaRow>(
      `SELECT ${MEDIA_COLUMNS} FROM crosspost_media WHERE draft_id = $1`,
      [input.draftId],
    );
    const current = existing.rows[0];
    if (current && current.line_message_id === input.media.lineMessageId) {
      return { kind: 'duplicate', draft: locked.rows[0], media: current } as const;
    }
    // 送った順で判定する（届いた順・処理が終わった順ではない）。下書きの行を FOR UPDATE で固定しているので、
    // 並行して届いた写真の比較と差し替えは直列になる。
    if (current) {
      const currentAt = current.line_sent_at.getTime();
      const incomingAt = input.media.lineSentAt.getTime();
      if (incomingAt < currentAt) return { kind: 'older', draft: locked.rows[0], media: current } as const;
      if (incomingAt === currentAt) return { kind: 'ambiguous', draft: locked.rows[0], media: current } as const;
    }

    const removed = await client.query<{ storage_key: string }>(
      'DELETE FROM crosspost_media WHERE draft_id = $1 RETURNING storage_key',
      [input.draftId],
    );
    const inserted = await client.query<CrosspostMediaRow>(
      `INSERT INTO crosspost_media
         (draft_id, line_message_id, line_quote_token, line_sent_at, storage_key, content_type, width, height, byte_size, sha256)
       VALUES ($1, $2, $9, $10, $3, $4, $5, $6, $7, $8)
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
        input.media.lineQuoteToken,
        input.media.lineSentAt,
      ],
    );
    const bumped = await client.query<CrosspostDraftRow>(
      `UPDATE crosspost_drafts
          SET revision = revision + 1, input_mode = 'none', input_destination = NULL, input_mode_set_at = NULL,
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
              input_mode = 'none', input_destination = NULL, input_mode_set_at = NULL, updated_at = now()
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
            m.id AS m_id, m.line_message_id AS m_line_message_id, m.line_quote_token AS m_line_quote_token,
            m.line_sent_at AS m_line_sent_at,
            m.storage_key AS m_storage_key,
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
  m_line_quote_token: string | null;
  m_line_sent_at: Date | null;
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
    m_line_quote_token,
    m_line_sent_at,
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
          line_quote_token: m_line_quote_token,
          line_sent_at: m_line_sent_at!,
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
  input: {
    ownerId: string;
    deliveryId: string;
    mode: ClaimMode;
    maxAttempts: number;
    /**
     * 投稿を実行してよい、承認からの時間（ミリ秒）。過ぎた投稿は初回（queued）も再試行も獲得しない（Req 6.12）。
     * 判定は DB の時計で、獲得の UPDATE と同じ文の中で行う（取りやめの確認と獲得の間に期限を越えても公開しない）。
     */
    queuedWindowMs: number;
  },
): Promise<CrosspostDeliveryRow | null> {
  if (!isUuid(input.ownerId) || !isUuid(input.deliveryId)) return null;
  const res = await db.query<CrosspostDeliveryRow>(
    `UPDATE crosspost_deliveries v
        SET status = 'in_progress', attempt_count = v.attempt_count + 1, last_attempt_at = now(),
            finished_at = NULL, retryable = false, failure_reason = NULL, unknown_reason = NULL,
            send_started_at = NULL, updated_at = now()
       FROM crosspost_drafts d, stores s
      WHERE v.id = $1
        AND d.id = v.draft_id AND d.owner_id = $2 AND d.status = 'approved'
        AND s.id = d.store_id AND s.owner_id = d.owner_id
        AND s.place_status = 'confirmed' AND s.place_id IS NOT NULL AND s.suspended_at IS NULL
        AND v.attempt_count < $4
        -- 承認から期限（queuedWindowMs）を過ぎた投稿は、初回も再試行も獲得しない（Req 6.12）
        AND d.approved_at > now() - ($5::bigint * interval '1 millisecond')
        AND (
          ($3 = 'first' AND v.status = 'queued')
          OR ($3 = 'retry' AND v.status = 'failed' AND v.retryable)
        )
      RETURNING ${prefixed(DELIVERY_COLUMNS, 'v')}`,
    [input.deliveryId, input.ownerId, input.mode, input.maxAttempts, Math.max(0, Math.trunc(input.queuedWindowMs))],
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

export type BeginSendOutcome =
  /** 期限の内。send_started_at を書いた。この後に外部 API へ送ってよい。 */
  | { kind: 'started'; delivery: CrosspostDeliveryRow }
  /** 期限（安全余裕を引いたもの）を過ぎていて、まだ何も送っていない。取りやめた（canceled）。送ってはならない。 */
  | { kind: 'expired'; delivery: CrosspostDeliveryRow }
  /** この試行はもう古い（期限切れで結果不明・取りやめへ移された・送信を始め済み）。送ってはならない。 */
  | { kind: 'superseded' };

/**
 * 外部 API へ送る直前に呼ぶ（Req 6.12）。DB の時計で「承認から windowMs − safetyMarginMs 以内」を確かめ、
 * 期限の内なら send_started_at を書いて started を返す。期限を過ぎていれば、まだ送っていないことが確かなので
 * 取りやめ（canceled）にして expired を返す。判定と記録は 1 文の UPDATE で行う（並行した獲得・後始末と競合しない）。
 *
 * **保証の範囲**: send_started_at を書いた時刻と、外部 API が要求を受け取る時刻の間には、アプリの処理と通信の
 * 遅延がある。この差は原子的には保証できないので、安全余裕（safetyMarginMs）で吸収する。送信を始めた後に
 * 期限を過ぎても、取りやめ・再送はしない（結果に従う）。
 */
export async function beginCrosspostSend(
  db: Queryable,
  input: { deliveryId: string; attempt: number; windowMs: number; safetyMarginMs: number },
): Promise<BeginSendOutcome> {
  if (!isUuid(input.deliveryId)) return { kind: 'superseded' };
  const allowedMs = Math.max(0, Math.trunc(input.windowMs) - Math.max(0, Math.trunc(input.safetyMarginMs)));
  const res = await db.query<CrosspostDeliveryRow & { started: boolean }>(
    `WITH target AS (
       SELECT v.id, d.approved_at > now() - ($3::bigint * interval '1 millisecond') AS in_window
         FROM crosspost_deliveries v
         JOIN crosspost_drafts d ON d.id = v.draft_id
        WHERE v.id = $1 AND v.status = 'in_progress' AND v.attempt_count = $2 AND v.send_started_at IS NULL
          FOR UPDATE OF v
     ), updated AS (
       UPDATE crosspost_deliveries v
          SET send_started_at = CASE WHEN t.in_window THEN now() ELSE NULL END,
              status = CASE WHEN t.in_window THEN v.status ELSE 'canceled'::crosspost_delivery_status END,
              finished_at = CASE WHEN t.in_window THEN NULL ELSE now() END,
              updated_at = now()
         FROM target t
        WHERE v.id = t.id
       RETURNING ${prefixed(DELIVERY_COLUMNS, 'v')}, t.in_window AS started
     )
     SELECT * FROM updated`,
    [input.deliveryId, input.attempt, allowedMs],
  );
  const row = res.rows[0];
  if (!row) return { kind: 'superseded' };
  const { started, ...delivery } = row;
  return started ? { kind: 'started', delivery } : { kind: 'expired', delivery };
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
 * 処理の中断の後始末（そのオーナーの行だけ・Req 6.9, 6.11）。移した件数を返す。
 * - 実行中のまま `olderThan` より前に試行を始めた行は、送信を始めていれば「結果不明」（外部へ送ったかもしれない）、
 *   始めていなければ「再試行できる失敗」（期限を過ぎていれば取りやめ）にする
 * - 承認から `queuedWindowMs` を過ぎたまま待ち（queued）の行を「取りやめ」にする（DB の時計で判定・獲得の条件と同じ境界）。待ちは一度も送っていない
 *   ことが確かだが、時間が経った投稿（「本日限定」など）を店主の知らないうちに出さないため、再開を許す時間に
 *   上限を設ける
 */
export async function markStaleCrosspostDeliveries(
  db: Queryable,
  input: { ownerId: string; olderThan: Date; queuedWindowMs: number },
): Promise<number> {
  if (!isUuid(input.ownerId)) return 0;
  const windowMs = Math.max(0, Math.trunc(input.queuedWindowMs));
  // 送信を始めていた試行（send_started_at あり）は、送ったかもしれないので結果不明。
  const startedStale = await db.query(
    `UPDATE crosspost_deliveries v
        SET status = 'unknown', unknown_reason = 'stale_in_progress', finished_at = now(), updated_at = now()
       FROM crosspost_drafts d
      WHERE d.id = v.draft_id AND d.owner_id = $1
        AND v.status = 'in_progress' AND v.last_attempt_at < $2 AND v.send_started_at IS NOT NULL`,
    [input.ownerId, input.olderThan],
  );
  // 送信を始める前に止まった試行（send_started_at なし）は、外部へ何も送っていないことが確か。期限の内なら
  // 再試行できる失敗、期限を過ぎていれば取りやめ。
  const notStartedStale = await db.query(
    `UPDATE crosspost_deliveries v
        SET status = CASE WHEN d.approved_at > now() - ($3::bigint * interval '1 millisecond')
                          THEN 'failed'::crosspost_delivery_status ELSE 'canceled'::crosspost_delivery_status END,
            failure_reason = CASE WHEN d.approved_at > now() - ($3::bigint * interval '1 millisecond')
                                  THEN 'interrupted_before_send' ELSE NULL END,
            retryable = d.approved_at > now() - ($3::bigint * interval '1 millisecond'),
            finished_at = now(), updated_at = now()
       FROM crosspost_drafts d
      WHERE d.id = v.draft_id AND d.owner_id = $1
        AND v.status = 'in_progress' AND v.last_attempt_at < $2 AND v.send_started_at IS NULL`,
    [input.ownerId, input.olderThan, windowMs],
  );
  // 期限を過ぎた待ちは取りやめ、期限を過ぎた再試行できる失敗は再試行できない失敗にする（獲得の条件と同じ境界）。
  const expired = await db.query(
    `UPDATE crosspost_deliveries v
        SET status = 'canceled', finished_at = now(), updated_at = now()
       FROM crosspost_drafts d
      WHERE d.id = v.draft_id AND d.owner_id = $1
        AND v.status = 'queued' AND d.approved_at <= now() - ($2::bigint * interval '1 millisecond')`,
    [input.ownerId, windowMs],
  );
  const expiredRetry = await db.query(
    `UPDATE crosspost_deliveries v
        SET retryable = false, updated_at = now()
       FROM crosspost_drafts d
      WHERE d.id = v.draft_id AND d.owner_id = $1
        AND v.status = 'failed' AND v.retryable AND d.approved_at <= now() - ($2::bigint * interval '1 millisecond')`,
    [input.ownerId, windowMs],
  );
  return (startedStale.rowCount ?? 0) + (notStartedStale.rowCount ?? 0) + (expired.rowCount ?? 0) + (expiredRetry.rowCount ?? 0);
}

/**
 * 待ち（queued）の投稿先を取りやめる（店主の操作・一度も送っていないことが確か）。待ちでなければ null。
 */
export async function cancelQueuedCrosspostDelivery(
  db: Queryable,
  input: { ownerId: string; deliveryId: string },
): Promise<CrosspostDeliveryRow | null> {
  if (!isUuid(input.ownerId) || !isUuid(input.deliveryId)) return null;
  const res = await db.query<CrosspostDeliveryRow>(
    `UPDATE crosspost_deliveries v
        SET status = 'canceled', finished_at = now(), updated_at = now()
       FROM crosspost_drafts d
      WHERE v.id = $1 AND d.id = v.draft_id AND d.owner_id = $2 AND v.status = 'queued'
      RETURNING ${prefixed(DELIVERY_COLUMNS, 'v')}`,
    [input.deliveryId, input.ownerId],
  );
  return res.rows[0] ?? null;
}

/**
 * 結果を店主へ届けられたことを記録する（Req 7.2）。`deliveredAt` 以前に終わった結果が届いたことになる。
 * `deliveredAt` には、**届けたメッセージに示した投稿先の行の finished_at の最大**を渡す（アプリの時計を使わない。
 * 時計のずれ・精度の違いで、届けていない結果を届けたことにしないため）。
 */
export async function markCrosspostResultNotified(
  db: Queryable,
  input: { ownerId: string; draftIds: readonly string[]; deliveredAt: Date },
): Promise<void> {
  const ids = input.draftIds.filter(isUuid);
  if (!isUuid(input.ownerId) || ids.length === 0) return;
  await db.query(
    `UPDATE crosspost_drafts
        SET result_notified_at = GREATEST(COALESCE(result_notified_at, '-infinity'::timestamptz), $3::timestamptz),
            updated_at = now()
      WHERE owner_id = $1 AND id = ANY($2::uuid[]) AND status = 'approved'`,
    [input.ownerId, ids, input.deliveredAt],
  );
}

/**
 * まだ店主へ届けていない結果を持つ承認済みの下書き（新しい順）。投稿先の行のどれかが、最後に届けた時刻より
 * 後に終わっていれば「届けていない」（結果不明の確定・再試行の結果・取りやめを含む）。
 */
export async function listUnnotifiedCrosspostResults(
  db: Queryable,
  input: { ownerId: string; limit: number },
): Promise<Array<{ draftId: string; storeName: string }>> {
  if (!isUuid(input.ownerId)) return [];
  const limit = Math.min(Math.max(Math.trunc(input.limit) || 1, 1), 5);
  const res = await db.query<{ id: string; store_name: string }>(
    `SELECT d.id, s.name AS store_name
       FROM crosspost_drafts d
       JOIN stores s ON s.id = d.store_id
      WHERE d.owner_id = $1 AND d.status = 'approved'
        AND EXISTS (
          SELECT 1 FROM crosspost_deliveries v
           WHERE v.draft_id = d.id AND v.finished_at IS NOT NULL
             -- 届けた記録は、示した行の finished_at（JS の Date を経てミリ秒に丸まる）で書く。比べる側もミリ秒にそろえる
             AND date_trunc('milliseconds', v.finished_at) > COALESCE(d.result_notified_at, '-infinity'::timestamptz)
        )
      ORDER BY d.approved_at DESC, d.id DESC
      LIMIT $2`,
    [input.ownerId, limit],
  );
  return res.rows.map((row) => ({ draftId: row.id, storeName: row.store_name }));
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
    /** 投稿を実行してよい承認からの時間。過ぎていれば「投稿されていなかった」でも再試行できない失敗にする。 */
    windowMs: number;
  },
): Promise<CrosspostDeliveryRow | null> {
  if (!isUuid(input.ownerId) || !isUuid(input.deliveryId)) return null;
  const res = await db.query<CrosspostDeliveryRow>(
    `UPDATE crosspost_deliveries v
        SET status = CASE WHEN $3 THEN 'succeeded'::crosspost_delivery_status ELSE 'failed'::crosspost_delivery_status END,
            retryable = (NOT $3) AND d.approved_at > now() - ($6::bigint * interval '1 millisecond'),
            failure_reason = CASE WHEN $3 THEN NULL ELSE 'owner_reported_not_posted' END,
            unknown_reason = NULL,
            external_id = COALESCE($4, v.external_id),
            external_url = COALESCE($5, v.external_url),
            finished_at = now(),
            updated_at = now()
       FROM crosspost_drafts d
      WHERE v.id = $1 AND d.id = v.draft_id AND d.owner_id = $2 AND v.status = 'unknown'
      RETURNING ${prefixed(DELIVERY_COLUMNS, 'v')}`,
    [
      input.deliveryId,
      input.ownerId,
      input.posted,
      input.externalId ?? null,
      input.externalUrl ?? null,
      Math.max(0, Math.trunc(input.windowMs)),
    ],
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

export interface CrosspostRetentionResult {
  /** 保存期間（purge_after）を過ぎて消した下書き。 */
  purgedDrafts: number;
  /** 期限切れのまま残っていた作成中の下書き（写真の行を含めて消した）。 */
  expiredOpenDrafts: number;
  /** 写真の保存期間を過ぎて消した写真の行（作成中でない下書きのもの）。 */
  purgedMedia: number;
  /**
   * 写真の保存期間で消した写真の行の置き場の名前（下書きごと消した写真の名前は含まない）。
   * 実体の削除は置き場の寿命の規則（7 日）が保証し、呼び出し側は任意で早めに消してよい。
   */
  removedStorageKeys: string[];
}

/**
 * 保存期間の削除（Req 8.3, 8.4, 8.8）。**利用者の操作に依存せず**、毎時の配信ジョブ（delivery-job）が呼ぶ。
 * line-webhook も開始の操作のついでに呼ぶ（どちらが先でも結果は同じ・冪等）。全オーナーが対象。
 * 1. 保存期間（purge_after）を過ぎた下書きを消す（写真・投稿先の行は CASCADE）
 * 2. 期限（expires_at）を過ぎた作成中の下書きを消す（まだ承認していないので投稿先の行は無い）
 * 3. `mediaOlderThan` より前に受け取った写真の行を消す（作成中の下書きは 2. の期限が先に効く）。
 *    待ち・結果不明の投稿先が残っていても消す（写真の保存期間を投稿の都合で延ばさない）。その後の再試行は
 *    写真が無いので送らない（failed・media_unavailable）
 * 1 回に消す件数に上限がある（多いときは次の回に続く）。
 */
export async function purgeCrosspostRetention(
  db: Queryable,
  input: { now: Date; mediaOlderThan: Date; limit: number },
): Promise<CrosspostRetentionResult> {
  const limit = Math.min(Math.max(Math.trunc(input.limit) || 1, 1), 500);
  // 行ロック（FOR UPDATE）は使わない。配信ジョブの SA は DELETE しか持たず、FOR UPDATE は UPDATE の権限を要する。
  // 条件は DELETE 自身の WHERE に置く。line-webhook が同じ行を更新中なら DELETE はその完了を待ち、更新後の行で
  // 条件を評価し直す（期限を延ばした・承認した下書きは消さない）。
  const drafts = await db.query<{ id: string; reason: 'purge' | 'expired' }>(
    `DELETE FROM crosspost_drafts d
      WHERE (d.purge_after <= $1 OR (d.status IN ('collecting', 'reviewing') AND d.expires_at <= $1))
        AND d.id IN (
          SELECT id FROM crosspost_drafts
           WHERE purge_after <= $1 OR (status IN ('collecting', 'reviewing') AND expires_at <= $1)
           ORDER BY purge_after
           LIMIT $2
        )
      RETURNING d.id, CASE WHEN d.purge_after <= $1 THEN 'purge' ELSE 'expired' END AS reason`,
    [input.now, limit],
  );
  // 消した下書きの写真の行は CASCADE で消えた。置き場の名前は呼び出し側で使わない（実体は寿命の規則が消す）。
  const media = await db.query<{ storage_key: string }>(
    `DELETE FROM crosspost_media m
      USING crosspost_drafts d
      WHERE m.draft_id = d.id
        AND m.created_at <= $1
        AND d.status NOT IN ('collecting', 'reviewing')
        AND m.id IN (SELECT id FROM crosspost_media WHERE created_at <= $1 ORDER BY created_at LIMIT $2)
      RETURNING m.storage_key`,
    [input.mediaOlderThan, limit],
  );
  const purged = new Set(drafts.rows.filter((r) => r.reason === 'purge').map((r) => r.id));
  const expired = new Set(drafts.rows.filter((r) => r.reason === 'expired').map((r) => r.id));
  return {
    purgedDrafts: purged.size,
    expiredOpenDrafts: expired.size,
    purgedMedia: media.rowCount ?? 0,
    removedStorageKeys: media.rows.map((row) => row.storage_key),
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
