import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  getPool,
  closePool,
  incrementStructuredTallies,
  readStoreSurveyDefinition,
  surveyDefinitionFingerprint,
  type StoreSurveyDefinition,
  type StructuredSurveyDefinition,
} from '@fwlm/db';
import { structuredMaterialCounts, validateStructuredAnswer } from '../src/lib/structured-answer';
import { createSessionTokenService, checkSurveyRevision, type CurrentSurvey } from '../src/lib/session-token';

/** 読み取りの結果から、回答受付と同じ形の照合の入力を作る。 */
function current(definition: StoreSurveyDefinition): CurrentSurvey {
  return definition.mode === 'legacy'
    ? { mode: 'legacy' }
    : { mode: 'structured', revision: definition.revision, definitionFingerprint: surveyDefinitionFingerprint(definition) };
}

// 実 postgres の店舗設定から読んだ定義で structured の回答を検証する（Issue #436）。
// 他店舗・非表示の Target を「定義に現れない」ことで拒否できること、設定の版を進めると表示済みの
// 画面が stale になることを、read model と検証を繋いだ形で確かめる。
// DATABASE_URL 無しの通常 ts-test では自動 skip。

const OP = 'a4360002-0000-4000-8000-000000000001';
const AG = 'a4360002-0000-4000-8000-000000000002';
const OW = 'a4360002-0000-4000-8000-000000000003';
const STORE = 'a4360002-0000-4000-8000-000000000004';
const OTHER = 'a4360002-0000-4000-8000-000000000005';
const SASHIMI = 'a4360002-0000-4000-8000-0000000000a1';
const HIDDEN = 'a4360002-0000-4000-8000-0000000000a2';
const OTHER_TARGET = 'a4360002-0000-4000-8000-0000000000a3';

async function structured(storeId: string): Promise<StructuredSurveyDefinition> {
  const def = await readStoreSurveyDefinition(await getPool(), storeId);
  if (def.mode !== 'structured') throw new Error('expected structured');
  return def;
}

describe.skipIf(!process.env.DATABASE_URL)('structured answer × DB definition', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, '構造化回答運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      AG,
      OP,
      '構造化回答代理店',
    ]);
    await pool.query(
      'INSERT INTO owners (id, agency_id, line_user_id, onboarding_status) VALUES ($1, $2, $3, $4)',
      [OW, AG, 'U-structured-answer-line-user', 'active'],
    );
    for (const id of [STORE, OTHER]) {
      await pool.query(
        `INSERT INTO stores (id, owner_id, name, place_id, place_status)
         VALUES ($1, $2, $3, $4, 'confirmed')`,
        [id, OW, `構造化回答店舗 ${id.slice(-1)}`, `ChIJ_structured_answer_${id.slice(-1)}`],
      );
      await pool.query(
        'INSERT INTO store_survey_configs (store_id, structured_enabled) VALUES ($1, true)',
        [id],
      );
    }
    await pool.query(
      `INSERT INTO store_survey_targets (id, store_id, category_code, label, sort_order, active)
       VALUES ($1, $4, 'food', '刺身盛り合わせ', 0, true),
              ($2, $4, 'food', '名物もつ煮', 1, false),
              ($3, $5, 'food', '別店舗の料理', 0, true)`,
      [SASHIMI, HIDDEN, OTHER_TARGET, STORE, OTHER],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it('自店の active な Target は受理し、他店舗・非表示の Target は拒否する', async () => {
    const def = await structured(STORE);
    expect(
      validateStructuredAnswer(
        { star: 4, positiveSelections: [{ categoryCode: 'food', targetId: SASHIMI, facetCodes: ['taste'] }] },
        def,
      ).ok,
    ).toBe(true);
    for (const targetId of [OTHER_TARGET, HIDDEN]) {
      expect(
        validateStructuredAnswer(
          { star: 4, positiveSelections: [{ categoryCode: 'food', targetId, facetCodes: [] }] },
          def,
        ),
      ).toEqual({
        ok: false,
        error: [{ field: 'positiveSelections', index: 0, code: 'UNKNOWN_TARGET' }],
      });
    }
  });

  it('seed の taxonomy だけで scope を判定する（料理全体に温度・状態は無い）', async () => {
    const def = await structured(STORE);
    expect(
      validateStructuredAnswer(
        { star: 4, positiveSelections: [{ categoryCode: 'food', facetCodes: ['temperature_condition'] }] },
        def,
      ),
    ).toEqual({
      ok: false,
      error: [{ field: 'positiveSelections', index: 0, code: 'FACET_SCOPE_MISMATCH' }],
    });
  });

  it('検証を通った回答の厚みは、集計の表の CHECK がすべて受理する（アプリと DB の意味が一致する）', async () => {
    const def = await structured(STORE);
    const answers = [
      // 何も選ばない（星だけ）
      { star: 3 },
      // Target だけ（facet 0）
      { star: 4, positiveSelections: [{ categoryCode: 'food', targetId: SASHIMI, facetCodes: [] }] },
      // カテゴリ全体の facet
      { star: 4, positiveSelections: [{ categoryCode: 'food', facetCodes: ['taste', 'volume'] }] },
      // Target だけ ＋ カテゴリ全体の facet、気になったところに Target ＋ Target 用の facet
      {
        star: 2,
        positiveSelections: [
          { categoryCode: 'food', targetId: SASHIMI, facetCodes: [] },
          { categoryCode: 'service_delivery', facetCodes: ['service_courtesy'] },
        ],
        concernSelections: [{ categoryCode: 'food', targetId: SASHIMI, facetCodes: ['temperature_condition'] }],
        comment: '少しぬるかった',
      },
    ];
    for (const input of answers) {
      const validated = validateStructuredAnswer(input, def);
      if (!validated.ok) throw new Error(`検証を通るはずの回答が拒否された: ${JSON.stringify(validated.error)}`);
      await expect(
        incrementStructuredTallies(
          await getPool(),
          { storeId: STORE, star: validated.value.star, ...structuredMaterialCounts(validated.value) },
          new Date('2026-09-15T03:00:00Z'),
        ),
      ).resolves.toBeUndefined();
    }
  });

  it('表示時の版と定義の指紋を署名した pageToken は、全店舗共通の taxonomy の変更でも stale になる（版は同じ）', async () => {
    const tokens = createSessionTokenService('structured-answer-db-key');
    const shown = await structured(STORE);
    const page = tokens.verifyPage(
      tokens.signStructuredPage(STORE, shown.revision, surveyDefinitionFingerprint(shown)),
      STORE,
    );
    if (!page.ok) throw new Error('page token should verify');
    expect(checkSurveyRevision(page.value, current(shown))).toEqual({ ok: true, value: 'structured' });

    // taxonomy を変える migration に相当する変更を、トランザクションの中だけで行って巻き戻す
    // （他のテストと共有する DB の seed を残さない）。店舗の revision は進まない。
    const client = await (await getPool()).connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE survey_facets SET label = '味わい' WHERE code = 'taste'`);
      const changed = await readStoreSurveyDefinition(client, STORE);
      if (changed.mode !== 'structured') throw new Error('expected structured');
      expect(changed.revision).toBe(shown.revision);
      expect(checkSurveyRevision(page.value, current(changed))).toEqual({ ok: false, error: 'STALE_SURVEY' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('表示時の版を署名した pageToken は、設定の版が進むと stale になる', async () => {
    const tokens = createSessionTokenService('structured-answer-db-key');
    const shown = await structured(STORE);
    const page = tokens.verifyPage(
      tokens.signStructuredPage(STORE, shown.revision, surveyDefinitionFingerprint(shown)),
      STORE,
    );
    if (!page.ok) throw new Error('page token should verify');
    expect(checkSurveyRevision(page.value, current(shown))).toEqual({ ok: true, value: 'structured' });

    // 店舗が設定を変えた（#437 では変更と同じトランザクションで +1 する）。
    await (await getPool()).query(
      'UPDATE store_survey_configs SET revision = revision + 1 WHERE store_id = $1',
      [STORE],
    );
    const now = await readStoreSurveyDefinition(await getPool(), STORE);
    expect(checkSurveyRevision(page.value, current(now))).toEqual({ ok: false, error: 'STALE_SURVEY' });
  });
});
