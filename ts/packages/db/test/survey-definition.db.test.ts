import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../src/pool.js';
import { readStoreSurveyDefinition, type StructuredSurveyDefinition } from '../src/survey-definition.js';

// structured survey の有効な定義の read model（Issue #436）。
// 他の DB テストと DB を共有するため、衝突しない固有 UUID / line_user_id を使う。
const OP = 'a4360000-0000-4000-8000-000000000001';
const AG = 'a4360000-0000-4000-8000-000000000002';
const OW = 'a4360000-0000-4000-8000-000000000003';
const NO_CONFIG = 'a4360000-0000-4000-8000-000000000010';
const DISABLED = 'a4360000-0000-4000-8000-000000000011';
const DEFAULTS = 'a4360000-0000-4000-8000-000000000012';
const CUSTOM = 'a4360000-0000-4000-8000-000000000013';
const OTHER = 'a4360000-0000-4000-8000-000000000014';
const LARGE = 'a4360000-0000-4000-8000-000000000015';

const SASHIMI = 'a4360000-0000-4000-8000-0000000000a1';
const YAKITORI = 'a4360000-0000-4000-8000-0000000000a2';
const HIDDEN = 'a4360000-0000-4000-8000-0000000000a3';
const LEMON_SOUR = 'a4360000-0000-4000-8000-0000000000a4';
const OTHER_STORE_TARGET = 'a4360000-0000-4000-8000-0000000000a5';
const TIE_LATER = 'a4360000-0000-4000-8000-0000000000a6';

async function structured(storeId: string): Promise<StructuredSurveyDefinition> {
  const def = await readStoreSurveyDefinition(await getPool(), storeId);
  if (def.mode !== 'structured') throw new Error(`expected structured, got ${def.mode}`);
  return def;
}

describe.skipIf(!process.env.DATABASE_URL)('readStoreSurveyDefinition (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, '定義運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      AG,
      OP,
      '定義代理店',
    ]);
    await pool.query(
      'INSERT INTO owners (id, agency_id, line_user_id, onboarding_status) VALUES ($1, $2, $3, $4)',
      [OW, AG, 'U-survey-definition-line-user', 'active'],
    );
    for (const id of [NO_CONFIG, DISABLED, DEFAULTS, CUSTOM, OTHER, LARGE]) {
      await pool.query(
        `INSERT INTO stores (id, owner_id, name, place_id, place_status)
         VALUES ($1, $2, $3, $4, 'confirmed')`,
        [id, OW, `定義店舗 ${id.slice(-2)}`, `ChIJ_def_${id.slice(-2)}`],
      );
    }
    // structured_enabled = false（設定はあるが legacy）。Target を持っていても legacy のまま。
    await pool.query('INSERT INTO store_survey_configs (store_id) VALUES ($1)', [DISABLED]);
    await pool.query(
      `INSERT INTO store_survey_targets (store_id, category_code, label, sort_order)
       VALUES ($1, 'food', '登録済みだが無効', 0)`,
      [DISABLED],
    );
    // structured・override なし・Target なし。
    await pool.query(
      'INSERT INTO store_survey_configs (store_id, structured_enabled) VALUES ($1, true)',
      [DEFAULTS],
    );
    // structured・override あり・Target あり・revision 7。
    await pool.query(
      'INSERT INTO store_survey_configs (store_id, structured_enabled, revision) VALUES ($1, true, 7)',
      [CUSTOM],
    );
    await pool.query(
      `INSERT INTO store_survey_category_settings (store_id, category_code, enabled, sort_order)
       VALUES ($1, 'reservation_visit', false, 60), ($1, 'drink', true, 5)`,
      [CUSTOM],
    );
    await pool.query(
      `INSERT INTO store_survey_targets (id, store_id, category_code, label, sort_order, active, created_at)
       VALUES ($1, $5, 'food', '焼き鳥5種盛り', 2, true, '2026-10-01T00:00:00Z'),
              ($2, $5, 'food', '刺身盛り合わせ', 1, true, '2026-10-02T00:00:00Z'),
              ($3, $5, 'food', '名物もつ煮', 0, false, '2026-10-01T00:00:00Z'),
              ($4, $5, 'drink', '自家製レモンサワー', 0, true, '2026-10-01T00:00:00Z'),
              ($6, $5, 'food', '同順位の後発', 2, true, '2026-10-03T00:00:00Z')`,
      [YAKITORI, SASHIMI, HIDDEN, LEMON_SOUR, CUSTOM, TIE_LATER],
    );
    // 別店舗の Target（CUSTOM の定義に出てはならない）。
    await pool.query(
      'INSERT INTO store_survey_configs (store_id, structured_enabled) VALUES ($1, true)',
      [OTHER],
    );
    await pool.query(
      `INSERT INTO store_survey_targets (id, store_id, category_code, label, sort_order)
       VALUES ($1, $2, 'food', '別店舗の料理', 0)`,
      [OTHER_STORE_TARGET, OTHER],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it('設定行の無い店舗は legacy（既存店舗の既定）', async () => {
    expect(await readStoreSurveyDefinition(await getPool(), NO_CONFIG)).toEqual({ mode: 'legacy' });
  });

  it('structured_enabled = false は legacy（Target を持っていても中身を返さない）', async () => {
    expect(await readStoreSurveyDefinition(await getPool(), DISABLED)).toEqual({ mode: 'legacy' });
  });

  it('存在しない店舗も legacy（店舗の可否は呼び手が判定する）', async () => {
    const def = await readStoreSurveyDefinition(
      await getPool(),
      'a4360000-0000-4000-8000-0000000000ff',
    );
    expect(def).toEqual({ mode: 'legacy' });
  });

  it('structured_enabled = true は seed の既定どおりの 6 カテゴリと revision を返す', async () => {
    const def = await structured(DEFAULTS);
    expect(def.revision).toBe(1);
    expect(def.categories.map((c) => [c.code, c.label, c.allowsTargets])).toEqual([
      ['food', '料理', true],
      ['drink', 'ドリンク', true],
      ['service_delivery', '接客・提供', false],
      ['atmosphere', '店内・雰囲気', false],
      ['price', '価格', false],
      ['reservation_visit', '予約・来店', false],
    ]);
    const food = def.categories[0];
    expect(food?.categoryFacets.map((f) => f.code)).toEqual(['taste', 'volume', 'variety', 'appearance']);
    expect(food?.targetFacets.map((f) => f.code)).toEqual([
      'taste',
      'volume',
      'appearance',
      'temperature_condition',
    ]);
    expect(food?.targets).toEqual([]);
    const service = def.categories.find((c) => c.code === 'service_delivery');
    expect(service?.categoryFacets.map((f) => f.label)).toEqual([
      '接客の丁寧さ',
      '説明・案内',
      '注文時の対応',
      '料理・ドリンクの提供',
      '会計時の対応',
    ]);
    // Target を持てないカテゴリは Target 用の facet も Target も持たない。
    for (const c of def.categories.filter((x) => !x.allowsTargets)) {
      expect(c.targetFacets).toEqual([]);
      expect(c.targets).toEqual([]);
    }
  });

  it('店舗の override で非表示のカテゴリを除き、並び順を差し替える', async () => {
    const def = await structured(CUSTOM);
    expect(def.revision).toBe(7);
    expect(def.categories.map((c) => c.code)).toEqual([
      'drink',
      'food',
      'service_delivery',
      'atmosphere',
      'price',
    ]);
    expect(def.categories[0]?.sortOrder).toBe(5);
  });

  it('active な自店の Target だけを sort_order → created_at の順で UUID つきで返す', async () => {
    const def = await structured(CUSTOM);
    const food = def.categories.find((c) => c.code === 'food');
    expect(food?.targets).toEqual([
      { id: SASHIMI, label: '刺身盛り合わせ', sortOrder: 1 },
      { id: YAKITORI, label: '焼き鳥5種盛り', sortOrder: 2 },
      { id: TIE_LATER, label: '同順位の後発', sortOrder: 2 },
    ]);
    const drink = def.categories.find((c) => c.code === 'drink');
    expect(drink?.targets).toEqual([{ id: LEMON_SOUR, label: '自家製レモンサワー', sortOrder: 0 }]);
    const allIds = def.categories.flatMap((c) => c.targets.map((t) => t.id));
    expect(allIds).not.toContain(HIDDEN);
    expect(allIds).not.toContain(OTHER_STORE_TARGET);
  });

  it('名称を変えても同じ UUID のまま新しい名称で返す', async () => {
    const pool = await getPool();
    await pool.query("UPDATE store_survey_targets SET label = '名物もつ煮込み' WHERE id = $1", [
      HIDDEN,
    ]);
    await pool.query('UPDATE store_survey_targets SET active = true WHERE id = $1', [HIDDEN]);
    const food = (await structured(CUSTOM)).categories.find((c) => c.code === 'food');
    expect(food?.targets[0]).toEqual({ id: HIDDEN, label: '名物もつ煮込み', sortOrder: 0 });
    await pool.query('UPDATE store_survey_targets SET active = false WHERE id = $1', [HIDDEN]);
  });

  it('Target 10 件でも facet・Target が重複しない（結合で行が増幅しない）', async () => {
    const pool = await getPool();
    await pool.query(
      'INSERT INTO store_survey_configs (store_id, structured_enabled) VALUES ($1, true)',
      [LARGE],
    );
    for (let i = 0; i < 10; i++) {
      await pool.query(
        `INSERT INTO store_survey_targets (store_id, category_code, label, sort_order)
         VALUES ($1, 'food', $2, $3)`,
        [LARGE, `料理 ${i}`, i],
      );
    }
    const food = (await structured(LARGE)).categories.find((c) => c.code === 'food');
    expect(food?.categoryFacets).toHaveLength(4);
    expect(food?.targetFacets).toHaveLength(4);
    expect(food?.targets).toHaveLength(10);
    expect(new Set(food?.targets.map((t) => t.id)).size).toBe(10);
    expect(food?.targets.map((t) => t.label)).toEqual(Array.from({ length: 10 }, (_, i) => `料理 ${i}`));
  });

  it('facet は taxonomy の対応表にあるものだけ（scope を混ぜず・補完しない）', async () => {
    const pool = await getPool();
    const mapping = await pool.query<{ category_code: string; scope: string; facets: string[] }>(
      `SELECT category_code, scope, array_agg(facet_code ORDER BY sort_order, facet_code) AS facets
       FROM survey_category_facets GROUP BY category_code, scope`,
    );
    const expected = new Map(mapping.rows.map((r) => [`${r.category_code}/${r.scope}`, r.facets]));
    for (const c of (await structured(DEFAULTS)).categories) {
      expect(c.categoryFacets.map((f) => f.code)).toEqual(expected.get(`${c.code}/category`) ?? []);
      expect(c.targetFacets.map((f) => f.code)).toEqual(expected.get(`${c.code}/target`) ?? []);
    }
  });

  it('同じ入力に対して同じ並びを返す（決定的）', async () => {
    const a = await structured(CUSTOM);
    const b = await structured(CUSTOM);
    expect(b).toEqual(a);
  });
});
