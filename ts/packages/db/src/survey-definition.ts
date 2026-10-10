import { createHash } from 'node:crypto';
import type { Queryable } from './pool.js';

// structured survey の客向けの有効な定義（Issue #436・Issue #441 の PR1）。
//
// 店舗の設定（store_survey_configs / store_survey_category_settings / store_survey_targets）と
// taxonomy（survey_categories / survey_facets / survey_category_facets・seed が SoT）を合成して、
// その店舗の客に見せてよいものだけを返す。カテゴリ・facet の code はコード内に列挙しない
// （write-boundary.md の共有定数の規律）。
//
// **legacy survey の経路（listSurveyAspects・survey_aspects）とは独立である。** 設定行の無い店舗・
// structured_enabled = false の店舗は `{ mode: 'legacy' }` だけを返し、legacy の画面・回答は
// これまでどおり survey_aspects を使う。

/** 評価ポイント 1 つ（Category 全体用・Target 用のどちらでも同じ形）。 */
export interface SurveyFacetOption {
  code: string;
  label: string;
  sortOrder: number;
}

/** 店舗が登録した具体的な料理・ドリンク。**identity は id（UUID）であって label ではない。** */
export interface SurveyTargetOption {
  id: string;
  label: string;
  sortOrder: number;
}

/** 客に見せる 1 カテゴリ。店舗で非表示にしたカテゴリはここに現れない。 */
export interface SurveyCategoryDefinition {
  code: string;
  label: string;
  sortOrder: number;
  allowsTargets: boolean;
  /** Target を選ばずに付けられる facet（例: 料理全体 → 味）。 */
  categoryFacets: SurveyFacetOption[];
  /** Target に付けられる facet（例: 刺身盛り合わせ → 味）。Target を持てないカテゴリでは空。 */
  targetFacets: SurveyFacetOption[];
  /** active な Target だけ。Target を持てないカテゴリでは空。 */
  targets: SurveyTargetOption[];
}

export interface LegacySurveyDefinition {
  mode: 'legacy';
}

export interface StructuredSurveyDefinition {
  mode: 'structured';
  /** 表示時の設定の版。structured survey の pageToken へ署名し、送信時に照合する。 */
  revision: number;
  categories: SurveyCategoryDefinition[];
}

export type StoreSurveyDefinition = LegacySurveyDefinition | StructuredSurveyDefinition;

interface DefinitionRow {
  revision: string;
  categories: SurveyCategoryDefinition[];
}

// **1 文で読む。** 設定の版・カテゴリ・Target を別々の文で読むと、間に店舗が設定を変えたとき
// 「新しい revision と古い Target」の組を返しうる（pool は文ごとに別の接続を使いうる）。
// 1 文なら同じスナップショットを見るので、返す revision と中身が必ず対応する。
//
// 並び順はすべて決定的にする: カテゴリは有効な sort_order → code、facet は sort_order → code、
// Target は sort_order → created_at → id。
//
// revision は bigint なので text で受けて数値へ戻す（pg は int8 を文字列で返す）。
const DEFINITION_SQL = `
WITH cfg AS (
  SELECT revision
  FROM store_survey_configs
  WHERE store_id = $1 AND structured_enabled
),
cats AS (
  SELECT c.code, c.label, c.allows_targets,
         COALESCE(o.sort_order, c.default_sort_order) AS sort_order
  FROM survey_categories c
  LEFT JOIN store_survey_category_settings o
    ON o.store_id = $1 AND o.category_code = c.code
  WHERE COALESCE(o.enabled, c.default_enabled)
)
SELECT
  cfg.revision::text AS revision,
  COALESCE((
    SELECT json_agg(json_build_object(
      'code', cats.code,
      'label', cats.label,
      'sortOrder', cats.sort_order,
      'allowsTargets', cats.allows_targets,
      'categoryFacets', COALESCE((
        SELECT json_agg(json_build_object('code', f.code, 'label', f.label, 'sortOrder', cf.sort_order)
                        ORDER BY cf.sort_order, f.code)
        FROM survey_category_facets cf
        JOIN survey_facets f ON f.code = cf.facet_code
        WHERE cf.category_code = cats.code AND cf.scope = 'category'
      ), '[]'::json),
      'targetFacets', COALESCE((
        SELECT json_agg(json_build_object('code', f.code, 'label', f.label, 'sortOrder', cf.sort_order)
                        ORDER BY cf.sort_order, f.code)
        FROM survey_category_facets cf
        JOIN survey_facets f ON f.code = cf.facet_code
        WHERE cats.allows_targets AND cf.category_code = cats.code AND cf.scope = 'target'
      ), '[]'::json),
      'targets', COALESCE((
        SELECT json_agg(json_build_object('id', t.id, 'label', t.label, 'sortOrder', t.sort_order)
                        ORDER BY t.sort_order, t.created_at, t.id)
        FROM store_survey_targets t
        WHERE cats.allows_targets AND t.store_id = $1 AND t.category_code = cats.code AND t.active
      ), '[]'::json)
    ) ORDER BY cats.sort_order, cats.code)
    FROM cats
  ), '[]'::json) AS categories
FROM cfg
`;

/**
 * 店舗の有効なアンケート定義を返す。
 *
 * - 設定行が無い・structured_enabled = false → `{ mode: 'legacy' }`（既定。既存店舗はすべてこれ）
 * - structured_enabled = true → 表示するカテゴリ（非表示を除く）・facet・active な Target と revision
 *
 * 店舗の存在・place 確定・利用停止の判定はしない（呼び手が findStoreForSurvey で行う）。
 */
export async function readStoreSurveyDefinition(
  db: Queryable,
  storeId: string,
): Promise<StoreSurveyDefinition> {
  const res = await db.query<DefinitionRow>(DEFINITION_SQL, [storeId]);
  const row = res.rows[0];
  if (!row) return { mode: 'legacy' };
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error(`store_survey_configs.revision is out of range: ${row.revision}`);
  }
  return { mode: 'structured', revision, categories: row.categories };
}

/**
 * 有効な定義の指紋（Issue #438）。客が見た定義の **意味** が同じかを、送信時に確かめるための値。
 *
 * store_survey_configs.revision は店舗設定の変更しか表せず、全店舗共通の taxonomy（survey_categories・
 * survey_facets・survey_category_facets）を変える migration を見逃す。指紋は、客の画面に出るもの
 * そのものから決定的に導くので、どちらの変更でも変わる。含めるもの（並び順は配列の順そのもの）:
 *   - 表示するカテゴリの code・名前・Target を持てるか・並び
 *   - カテゴリ全体用 / Target 用の facet の code・名前・並び（Category × Facet の対応）
 *   - active な Target の UUID・名前・並び
 * 含めないもの: revision（別に照合する）と、数値の sort_order（並びが同じなら意味は同じ）。
 *
 * 出力は SHA-256 の base64url（43 文字）。pageToken へ署名し、送信時に同じ読み取りの結果から計算し直して
 * 照合する（呼び手は readStoreSurveyDefinition を 1 回だけ呼び、その結果を照合・検証・解決へ渡すこと）。
 */
export function surveyDefinitionFingerprint(definition: StructuredSurveyDefinition): string {
  const canonical = definition.categories.map((c) => [
    c.code,
    c.label,
    c.allowsTargets,
    c.categoryFacets.map((f) => [f.code, f.label]),
    c.targetFacets.map((f) => [f.code, f.label]),
    c.targets.map((t) => [t.id, t.label]),
  ]);
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('base64url');
}
