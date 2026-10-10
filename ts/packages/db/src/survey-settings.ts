import type { Queryable, TransactionCapable, TransactionClient } from './pool.js';
import type { AuditLogAction } from './audit-logs.js';
import {
  ACTIVE_TARGET_LIMITS,
  isOwnerTargetCategoryCode,
  isOwnerToggleableCategoryCode,
  normalizeTargetLabel,
  type TargetLabelError,
} from './survey-settings-rules.js';

// 店舗オーナーが編集するアンケート設定の読み書き（Issue #437・#441 の PR2）。
//
// 呼び手（store-detail の API）は、LIFF の ID トークンから解決した **認可済みの店舗 ID だけ** を渡す。
// このモジュールは店舗の所有を判定しない。代わりに、どの書込も「その店舗の行」に限って読み書きし、
// 他店の Target の ID を渡されても「無い」として扱う（存在するかどうかを区別して返さない）。
//
// 書込の規律:
//   - **どの変更も、最初に store_survey_configs の行を `revision = revision + 1` で更新してから行う。**
//     同じトランザクションの中で行うので、変更が確定すれば版も必ず進み、取り消されれば版も戻る。
//     アプリ側で版を読んで +1 して書き戻さない（並行する 2 つの変更が同じ版を書く lost update になる）。
//     この UPDATE が設定行の行ロックを取るので、同じ店舗への変更は直列になり、件数の上限と同名の判定も
//     並行する変更に追い越されない。
//   - 変化の無い操作（同じ名前への変更・既に非表示の行の非表示など）は書かずに巻き戻し、版を進めない。
//   - Target の行は消さない（非表示は active = false）。
//   - 同名の非表示の Target を「追加」したときは、その行を再表示して同じ UUID を引き継ぐ（Issue #437 で決定）。
//   - structured_enabled は書かない（客向けの structured の画面が接続されるまで、オーナーは切り替えられない）。

/** 設定画面に出すカテゴリ 1 つ。 */
export interface SurveySettingsCategory {
  readonly code: string;
  readonly label: string;
  readonly allowsTargets: boolean;
  /** 店舗の override を反映した表示 / 非表示。 */
  readonly enabled: boolean;
  /** オーナーが表示 / 非表示を切り替えられるか（survey-settings-rules の OWNER_TOGGLEABLE_CATEGORY_CODES）。 */
  readonly toggleable: boolean;
  /** オーナーが Target を登録できるか（survey-settings-rules の ACTIVE_TARGET_LIMITS）。 */
  readonly ownerTargets: boolean;
  /** active な Target の上限。Target を登録できないカテゴリは null。 */
  readonly targetLimit: number | null;
}

/** 設定画面に出す Target 1 つ（非表示の行も含む）。 */
export interface SurveySettingsTarget {
  readonly id: string;
  readonly categoryCode: string;
  readonly label: string;
  readonly active: boolean;
  readonly sortOrder: number;
}

export interface StoreSurveySettings {
  /** 設定行が無い店舗は false（legacy のまま）。 */
  readonly structuredEnabled: boolean;
  /** 設定行が無い店舗は null（まだ一度も変更していない）。 */
  readonly revision: number | null;
  readonly categories: readonly SurveySettingsCategory[];
  /** カテゴリごとに、active な行を sort_order 順に、その後に非表示の行を登録順に並べる。 */
  readonly targets: readonly SurveySettingsTarget[];
}

interface CategoryRow {
  code: string;
  label: string;
  allows_targets: boolean;
  enabled: boolean;
}

interface TargetRow {
  id: string;
  category_code: string;
  label: string;
  active: boolean;
  sort_order: number;
}

/** 店舗のアンケート設定を読む（設定画面の表示用）。 */
export async function readStoreSurveySettings(db: Queryable, storeId: string): Promise<StoreSurveySettings> {
  const config = await db.query<{ structured_enabled: boolean; revision: string }>(
    'SELECT structured_enabled, revision FROM store_survey_configs WHERE store_id = $1',
    [storeId],
  );
  const categories = await db.query<CategoryRow>(
    `SELECT c.code, c.label, c.allows_targets,
            COALESCE(s.enabled, c.default_enabled) AS enabled
       FROM survey_categories c
       LEFT JOIN store_survey_category_settings s
         ON s.category_code = c.code AND s.store_id = $1
      ORDER BY COALESCE(s.sort_order, c.default_sort_order), c.code`,
    [storeId],
  );
  const targets = await db.query<TargetRow>(
    `SELECT id, category_code, label, active, sort_order
       FROM store_survey_targets
      WHERE store_id = $1
      ORDER BY category_code, active DESC,
               CASE WHEN active THEN sort_order END, created_at, id`,
    [storeId],
  );
  const row = config.rows[0];
  return {
    structuredEnabled: row?.structured_enabled ?? false,
    revision: row ? Number(row.revision) : null,
    categories: categories.rows.map((c) => ({
      code: c.code,
      label: c.label,
      allowsTargets: c.allows_targets,
      enabled: c.enabled,
      toggleable: isOwnerToggleableCategoryCode(c.code),
      ownerTargets: isOwnerTargetCategoryCode(c.code),
      targetLimit: isOwnerTargetCategoryCode(c.code) ? ACTIVE_TARGET_LIMITS[c.code] : null,
    })),
    targets: targets.rows.map((t) => ({
      id: t.id,
      categoryCode: t.category_code,
      label: t.label,
      active: t.active,
      sortOrder: t.sort_order,
    })),
  };
}

// --- 変更 ---------------------------------------------------------------------------

export type SurveySettingsError =
  /** オーナーが Target を登録できないカテゴリ。 */
  | 'CATEGORY_NOT_EDITABLE'
  /** オーナーが表示を切り替えられないカテゴリ（存在しないカテゴリを含む）。 */
  | 'CATEGORY_NOT_TOGGLEABLE'
  /** 自店に無い Target（他店の Target・存在しない ID を区別しない）。 */
  | 'TARGET_NOT_FOUND'
  /** 同じカテゴリに表示中の同名の Target がある。 */
  | 'DUPLICATE_LABEL'
  /** 表示中の Target が上限に達している。 */
  | 'TARGET_LIMIT_REACHED'
  /** 並び順の ID が、そのカテゴリの表示中の自店の Target の集合と一致しない（重複・欠落・他店を含む）。 */
  | 'INVALID_ORDER'
  | TargetLabelError;

export type SurveySettingsChange =
  /** 変更して確定した。audit は呼び手が確定の後に書く。 */
  | { readonly ok: true; readonly changed: true; readonly action: AuditLogAction; readonly revision: number; readonly targetId?: string }
  /** 変化が無かった（書かず、版も進めない）。 */
  | { readonly ok: true; readonly changed: false }
  | { readonly ok: false; readonly error: SurveySettingsError };

const fail = (error: SurveySettingsError): SurveySettingsChange => ({ ok: false, error });
const unchanged: SurveySettingsChange = { ok: true, changed: false };

/** 取り消しの合図（変化なし・検証失敗）。トランザクションを巻き戻して、この結果を返す。 */
class Rollback {
  constructor(readonly result: SurveySettingsChange) {}
}

/**
 * 設定行を作るか版を 1 進め、行ロックを取ってから `body` を同じトランザクションで流す。
 *
 * 行が無い店舗では、最初の変更で revision = 1 の行を作る（行が無い = まだ一度も変えていない）。
 */
async function withSettingsChange(
  pool: TransactionCapable,
  storeId: string,
  body: (client: TransactionClient, revision: number) => Promise<SurveySettingsChange>,
): Promise<SurveySettingsChange> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bumped = await client.query<{ revision: string }>(
      `INSERT INTO store_survey_configs (store_id) VALUES ($1)
       ON CONFLICT (store_id) DO UPDATE
         SET revision = store_survey_configs.revision + 1, updated_at = now()
       RETURNING revision`,
      [storeId],
    );
    const revision = Number(bumped.rows[0]!.revision);
    let result: SurveySettingsChange;
    try {
      result = await body(client, revision);
    } catch (err) {
      if (err instanceof Rollback) {
        await client.query('ROLLBACK');
        return err.result;
      }
      throw err;
    }
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function activeCount(client: TransactionClient, storeId: string, categoryCode: string): Promise<number> {
  const res = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM store_survey_targets
      WHERE store_id = $1 AND category_code = $2 AND active`,
    [storeId, categoryCode],
  );
  return res.rows[0]!.n;
}

async function nextSortOrder(client: TransactionClient, storeId: string, categoryCode: string): Promise<number> {
  const res = await client.query<{ n: number }>(
    `SELECT COALESCE(max(sort_order) + 1, 0)::int AS n FROM store_survey_targets
      WHERE store_id = $1 AND category_code = $2 AND active`,
    [storeId, categoryCode],
  );
  return res.rows[0]!.n;
}

async function hasActiveLabel(
  client: TransactionClient,
  storeId: string,
  categoryCode: string,
  label: string,
  exceptId: string | null,
): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM store_survey_targets
      WHERE store_id = $1 AND category_code = $2 AND label = $3 AND active
        AND ($4::uuid IS NULL OR id <> $4::uuid)`,
    [storeId, categoryCode, label, exceptId],
  );
  return res.rows.length > 0;
}

async function findOwnTarget(client: TransactionClient, storeId: string, targetId: string): Promise<TargetRow | null> {
  const res = await client.query<TargetRow>(
    `SELECT id, category_code, label, active, sort_order FROM store_survey_targets
      WHERE id = $1 AND store_id = $2
      FOR UPDATE`,
    [targetId, storeId],
  );
  return res.rows[0] ?? null;
}

/**
 * 料理名・ドリンク名を登録する。
 *
 * 同じカテゴリに **非表示の同名** の行があれば、新しい行を作らずにその行を再表示する（同じ UUID を
 * 引き継ぐ・Issue #437 で決定）。完全に同じ名前の再登録は同じ商品として扱い、identity を分けない。
 */
export async function addSurveyTarget(
  pool: TransactionCapable,
  storeId: string,
  input: { categoryCode: unknown; label: unknown },
): Promise<SurveySettingsChange> {
  if (!isOwnerTargetCategoryCode(input.categoryCode)) return fail('CATEGORY_NOT_EDITABLE');
  const categoryCode = input.categoryCode;
  const label = normalizeTargetLabel(input.label);
  if (!label.ok) return fail(label.error);

  return withSettingsChange(pool, storeId, async (client, revision) => {
    if (await hasActiveLabel(client, storeId, categoryCode, label.value, null)) {
      throw new Rollback(fail('DUPLICATE_LABEL'));
    }
    if ((await activeCount(client, storeId, categoryCode)) >= ACTIVE_TARGET_LIMITS[categoryCode]) {
      throw new Rollback(fail('TARGET_LIMIT_REACHED'));
    }
    const sortOrder = await nextSortOrder(client, storeId, categoryCode);
    // 非表示の同名が複数ある（名前の変更で同名が生まれた）ときは、最後に触った行を選ぶ。
    const hidden = await client.query<{ id: string }>(
      `SELECT id FROM store_survey_targets
        WHERE store_id = $1 AND category_code = $2 AND label = $3 AND NOT active
        ORDER BY updated_at DESC, created_at DESC, id
        LIMIT 1
        FOR UPDATE`,
      [storeId, categoryCode, label.value],
    );
    const reuse = hidden.rows[0];
    if (reuse) {
      await client.query(
        `UPDATE store_survey_targets SET active = true, sort_order = $2, updated_at = now() WHERE id = $1`,
        [reuse.id, sortOrder],
      );
      return { ok: true, changed: true, action: 'survey_target_enabled', revision, targetId: reuse.id };
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO store_survey_targets (store_id, category_code, label, sort_order)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [storeId, categoryCode, label.value, sortOrder],
    );
    return { ok: true, changed: true, action: 'survey_target_added', revision, targetId: inserted.rows[0]!.id };
  });
}

/** 名前を変える。identity（UUID）は変えない。 */
export async function renameSurveyTarget(
  pool: TransactionCapable,
  storeId: string,
  targetId: string,
  rawLabel: unknown,
): Promise<SurveySettingsChange> {
  const label = normalizeTargetLabel(rawLabel);
  if (!label.ok) return fail(label.error);

  return withSettingsChange(pool, storeId, async (client, revision) => {
    const target = await findOwnTarget(client, storeId, targetId);
    if (!target) throw new Rollback(fail('TARGET_NOT_FOUND'));
    if (target.label === label.value) throw new Rollback(unchanged);
    if (target.active && (await hasActiveLabel(client, storeId, target.category_code, label.value, target.id))) {
      throw new Rollback(fail('DUPLICATE_LABEL'));
    }
    await client.query(`UPDATE store_survey_targets SET label = $2, updated_at = now() WHERE id = $1`, [
      target.id,
      label.value,
    ]);
    return { ok: true, changed: true, action: 'survey_target_renamed', revision, targetId: target.id };
  });
}

/** 表示 / 非表示を切り替える。行は消さない。再表示は上限と同名の判定を通す。 */
export async function setSurveyTargetActive(
  pool: TransactionCapable,
  storeId: string,
  targetId: string,
  active: boolean,
): Promise<SurveySettingsChange> {
  return withSettingsChange(pool, storeId, async (client, revision) => {
    const target = await findOwnTarget(client, storeId, targetId);
    if (!target) throw new Rollback(fail('TARGET_NOT_FOUND'));
    if (target.active === active) throw new Rollback(unchanged);
    if (!active) {
      await client.query(`UPDATE store_survey_targets SET active = false, updated_at = now() WHERE id = $1`, [
        target.id,
      ]);
      return { ok: true, changed: true, action: 'survey_target_disabled', revision, targetId: target.id };
    }
    if (!isOwnerTargetCategoryCode(target.category_code)) throw new Rollback(fail('CATEGORY_NOT_EDITABLE'));
    if (await hasActiveLabel(client, storeId, target.category_code, target.label, target.id)) {
      throw new Rollback(fail('DUPLICATE_LABEL'));
    }
    if ((await activeCount(client, storeId, target.category_code)) >= ACTIVE_TARGET_LIMITS[target.category_code]) {
      throw new Rollback(fail('TARGET_LIMIT_REACHED'));
    }
    const sortOrder = await nextSortOrder(client, storeId, target.category_code);
    await client.query(
      `UPDATE store_survey_targets SET active = true, sort_order = $2, updated_at = now() WHERE id = $1`,
      [target.id, sortOrder],
    );
    return { ok: true, changed: true, action: 'survey_target_enabled', revision, targetId: target.id };
  });
}

/**
 * 1 つのカテゴリの表示中の Target を、渡された順に並べ直す。
 *
 * `orderedIds` は、そのカテゴリの表示中の自店の Target の **集合とちょうど一致** しなければならない
 * （重複・欠落・他店の ID・非表示の ID・別カテゴリの ID はすべて INVALID_ORDER）。
 */
export async function reorderSurveyTargets(
  pool: TransactionCapable,
  storeId: string,
  input: { categoryCode: unknown; targetIds: unknown },
): Promise<SurveySettingsChange> {
  if (!isOwnerTargetCategoryCode(input.categoryCode)) return fail('CATEGORY_NOT_EDITABLE');
  const categoryCode = input.categoryCode;
  const ids = input.targetIds;
  if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === 'string')) return fail('INVALID_ORDER');
  if (new Set(ids).size !== ids.length) return fail('INVALID_ORDER');

  return withSettingsChange(pool, storeId, async (client, revision) => {
    const current = await client.query<{ id: string }>(
      `SELECT id FROM store_survey_targets
        WHERE store_id = $1 AND category_code = $2 AND active
        ORDER BY sort_order, created_at, id
        FOR UPDATE`,
      [storeId, categoryCode],
    );
    const currentIds = current.rows.map((r) => r.id);
    const known = new Set(currentIds);
    if (ids.length !== currentIds.length || !ids.every((id) => known.has(id))) {
      throw new Rollback(fail('INVALID_ORDER'));
    }
    if (ids.every((id, i) => id === currentIds[i])) throw new Rollback(unchanged);
    await client.query(
      `UPDATE store_survey_targets t SET sort_order = o.ord - 1, updated_at = now()
         FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, ord)
        WHERE t.id = o.id AND t.store_id = $1`,
      [storeId, ids],
    );
    return { ok: true, changed: true, action: 'survey_targets_reordered', revision };
  });
}

/** カテゴリ（MVP では予約・来店）の表示 / 非表示を切り替える。 */
export async function setSurveyCategoryEnabled(
  pool: TransactionCapable,
  storeId: string,
  categoryCode: unknown,
  enabled: boolean,
): Promise<SurveySettingsChange> {
  if (!isOwnerToggleableCategoryCode(categoryCode)) return fail('CATEGORY_NOT_TOGGLEABLE');

  return withSettingsChange(pool, storeId, async (client, revision) => {
    const current = await client.query<{ enabled: boolean; default_sort_order: number }>(
      `SELECT COALESCE(s.enabled, c.default_enabled) AS enabled, c.default_sort_order
         FROM survey_categories c
         LEFT JOIN store_survey_category_settings s
           ON s.category_code = c.code AND s.store_id = $1
        WHERE c.code = $2`,
      [storeId, categoryCode],
    );
    const row = current.rows[0];
    if (!row) throw new Rollback(fail('CATEGORY_NOT_TOGGLEABLE'));
    if (row.enabled === enabled) throw new Rollback(unchanged);
    // 並び順の override はオーナーの操作に無いので、初めて行を作るときは seed の既定を写す。
    await client.query(
      `INSERT INTO store_survey_category_settings (store_id, category_code, enabled, sort_order)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (store_id, category_code) DO UPDATE SET enabled = EXCLUDED.enabled`,
      [storeId, categoryCode, enabled, row.default_sort_order],
    );
    return { ok: true, changed: true, action: 'survey_category_visibility_updated', revision };
  });
}
