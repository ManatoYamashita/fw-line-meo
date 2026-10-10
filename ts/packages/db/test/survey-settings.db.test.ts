import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../src/pool.js';
import {
  addSurveyTarget,
  readStoreSurveySettings,
  renameSurveyTarget,
  reorderSurveyTargets,
  setSurveyCategoryEnabled,
  setSurveyTargetActive,
  type SurveySettingsChange,
} from '../src/survey-settings.js';
import { readStoreSurveyDefinition } from '../src/survey-definition.js';
import { ACTIVE_TARGET_LIMITS, TARGET_LABEL_MAX_LENGTH } from '../src/survey-settings-rules.js';

// 店舗オーナーのアンケート設定の書込（Issue #437）を実 PostgreSQL で確かめる。
// 他の DB テストと DB を共有するため、衝突しない固有 UUID / line_user_id を使う。
// 店舗はテストごとに分ける（版と件数が互いに干渉しないように）。
const OP = 'a4370000-0000-4000-8000-000000000001';
const AG = 'a4370000-0000-4000-8000-000000000002';
const OW = 'a4370000-0000-4000-8000-000000000003';
const OTHER_OW = 'a4370000-0000-4000-8000-000000000004';

let storeSeq = 0x10;
async function newStore(ownerId = OW): Promise<string> {
  storeSeq += 1;
  const id = `a4370000-0000-4000-8000-0000000000${storeSeq.toString(16).padStart(2, '0')}`;
  const pool = await getPool();
  await pool.query(
    `INSERT INTO stores (id, owner_id, name, place_id, place_status)
     VALUES ($1, $2, $3, $4, 'confirmed')`,
    [id, ownerId, `設定店舗 ${storeSeq}`, `ChIJ_survey_settings_${storeSeq}`],
  );
  return id;
}

async function revisionOf(storeId: string): Promise<number | null> {
  const res = await (await getPool()).query<{ revision: string }>(
    'SELECT revision FROM store_survey_configs WHERE store_id = $1',
    [storeId],
  );
  return res.rows[0] ? Number(res.rows[0].revision) : null;
}

function changedId(result: SurveySettingsChange): string {
  if (!result.ok || !result.changed || result.targetId === undefined) {
    throw new Error(`変更が確定していない: ${JSON.stringify(result)}`);
  }
  return result.targetId;
}

async function add(storeId: string, categoryCode: string, label: string): Promise<SurveySettingsChange> {
  return addSurveyTarget(await getPool(), storeId, { categoryCode, label });
}

describe.skipIf(!process.env.DATABASE_URL)('store survey settings (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, '設定運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [AG, OP, '設定代理店']);
    for (const [id, sub] of [
      [OW, 'U-survey-settings-owner'],
      [OTHER_OW, 'U-survey-settings-other-owner'],
    ] as const) {
      await pool.query(
        'INSERT INTO owners (id, agency_id, line_user_id, onboarding_status) VALUES ($1, $2, $3, $4)',
        [id, AG, sub, 'active'],
      );
    }
  });

  afterAll(async () => {
    await closePool();
  });

  it('一度も変更していない店舗は、設定行なし・seed の既定どおりのカテゴリ・Target なしで読める', async () => {
    const store = await newStore();
    const settings = await readStoreSurveySettings(await getPool(), store);
    expect(settings.structuredEnabled).toBe(false);
    expect(settings.revision).toBeNull();
    expect(settings.targets).toEqual([]);
    expect(settings.categories.map((c) => [c.code, c.enabled, c.toggleable, c.ownerTargets, c.targetLimit])).toEqual([
      ['food', true, false, true, ACTIVE_TARGET_LIMITS.food],
      ['drink', true, false, true, ACTIVE_TARGET_LIMITS.drink],
      ['service_delivery', true, false, false, null],
      ['atmosphere', true, false, false, null],
      ['price', true, false, false, null],
      ['reservation_visit', true, true, false, null],
    ]);
  });

  it('追加は設定行を作り（revision 1）、以後の変更ごとに revision を 1 つずつ進める', async () => {
    const store = await newStore();
    const first = await add(store, 'food', '刺身盛り合わせ');
    expect(first).toMatchObject({ ok: true, changed: true, action: 'survey_target_added', revision: 1 });
    expect(await revisionOf(store)).toBe(1);
    expect(await add(store, 'drink', '自家製レモンサワー')).toMatchObject({ revision: 2 });
    expect(await revisionOf(store)).toBe(2);
    const settings = await readStoreSurveySettings(await getPool(), store);
    expect(settings.targets.map((t) => [t.categoryCode, t.label, t.active, t.sortOrder])).toEqual([
      ['drink', '自家製レモンサワー', true, 0],
      ['food', '刺身盛り合わせ', true, 0],
    ]);
    // structured_enabled はオーナーの操作では変わらない（客向けの structured の画面が未接続のため）。
    expect(settings.structuredEnabled).toBe(false);
    expect(await readStoreSurveyDefinition(await getPool(), store)).toEqual({ mode: 'legacy' });
  });

  it('料理・ドリンク以外のカテゴリへは追加できない（版も進めない）', async () => {
    const store = await newStore();
    for (const code of ['price', 'service_delivery', 'reservation_visit', 'no_such_category', 42]) {
      expect(await addSurveyTarget(await getPool(), store, { categoryCode: code, label: '何か' })).toEqual({
        ok: false,
        error: 'CATEGORY_NOT_EDITABLE',
      });
    }
    expect(await revisionOf(store)).toBeNull();
  });

  it('名前はサーバー側で検証し、前後の空白を除いて保存する', async () => {
    const store = await newStore();
    const cases: [unknown, string][] = [
      ['', 'LABEL_EMPTY'],
      ['   　 ', 'LABEL_EMPTY'],
      ['あ'.repeat(TARGET_LABEL_MAX_LENGTH + 1), 'LABEL_TOO_LONG'],
      ['刺身\n盛り合わせ', 'LABEL_MULTILINE'],
      ['刺身\u0007盛り', 'LABEL_INVALID_CHARACTER'],
      ['刺身\uD800', 'LABEL_INVALID_CHARACTER'],
      [null, 'LABEL_INVALID'],
      [123, 'LABEL_INVALID'],
    ];
    for (const [label, error] of cases) {
      expect(await addSurveyTarget(await getPool(), store, { categoryCode: 'food', label }), String(label)).toEqual({
        ok: false,
        error,
      });
    }
    expect(await revisionOf(store)).toBeNull();
    // ちょうど上限の長さは通る。HTML として解釈せず、そのまま文字として保存する。
    const exact = 'い'.repeat(TARGET_LABEL_MAX_LENGTH);
    changedId(await add(store, 'food', `  ${exact}  `));
    changedId(await add(store, 'food', '<b>海鮮丼</b>'));
    const labels = (await readStoreSurveySettings(await getPool(), store)).targets.map((t) => t.label);
    expect(labels).toEqual([exact, '<b>海鮮丼</b>']);
  });

  it('表示中の同名は 409 相当（DUPLICATE_LABEL）で拒否し、版を進めない', async () => {
    const store = await newStore();
    changedId(await add(store, 'food', '焼き鳥5種盛り'));
    expect(await add(store, 'food', ' 焼き鳥5種盛り ')).toEqual({ ok: false, error: 'DUPLICATE_LABEL' });
    expect(await revisionOf(store)).toBe(1);
    // 別のカテゴリなら同じ名前でもよい。
    changedId(await add(store, 'drink', '焼き鳥5種盛り'));
  });

  it('非表示の同名を追加すると、その行を再表示して同じ UUID を引き継ぐ（新しい UUID を発行しない）', async () => {
    const pool = await getPool();
    const store = await newStore();
    const original = changedId(await add(store, 'food', '刺身盛り合わせ'));
    expect(await setSurveyTargetActive(pool, store, original, false)).toMatchObject({
      changed: true,
      action: 'survey_target_disabled',
    });
    const readded = await add(store, 'food', '刺身盛り合わせ');
    expect(readded).toMatchObject({ ok: true, changed: true, action: 'survey_target_enabled', targetId: original });
    const rows = await pool.query<{ id: string; active: boolean }>(
      'SELECT id, active FROM store_survey_targets WHERE store_id = $1',
      [store],
    );
    expect(rows.rows).toEqual([{ id: original, active: true }]);
    expect(await revisionOf(store)).toBe(3);
  });

  it('名前を変えても UUID は変わらない。同じ名前への変更は何も書かず、版を進めない', async () => {
    const pool = await getPool();
    const store = await newStore();
    const id = changedId(await add(store, 'food', '名物もつ煮'));
    changedId(await add(store, 'food', '刺身盛り合わせ'));
    expect(await renameSurveyTarget(pool, store, id, '名物もつ煮込み')).toMatchObject({
      changed: true,
      action: 'survey_target_renamed',
      targetId: id,
      revision: 3,
    });
    expect(await renameSurveyTarget(pool, store, id, ' 名物もつ煮込み ')).toEqual({ ok: true, changed: false });
    expect(await revisionOf(store)).toBe(3);
    expect(await renameSurveyTarget(pool, store, id, '刺身盛り合わせ')).toEqual({ ok: false, error: 'DUPLICATE_LABEL' });
    expect(await renameSurveyTarget(pool, store, id, '')).toEqual({ ok: false, error: 'LABEL_EMPTY' });
    expect(await revisionOf(store)).toBe(3);
    const target = (await readStoreSurveySettings(pool, store)).targets.find((t) => t.id === id);
    expect(target?.label).toBe('名物もつ煮込み');
  });

  it('上限（10 件）に達したら 11 件目の追加と再表示を拒否する。上限でも名前の変更・非表示・並び替えはできる', async () => {
    const pool = await getPool();
    const store = await newStore();
    const limit = ACTIVE_TARGET_LIMITS.food;
    const ids: string[] = [];
    for (let i = 0; i < limit; i++) ids.push(changedId(await add(store, 'food', `料理 ${i}`)));
    expect(await add(store, 'food', '11件目')).toEqual({ ok: false, error: 'TARGET_LIMIT_REACHED' });
    // ドリンクの上限は別に数える。
    changedId(await add(store, 'drink', 'ドリンク 0'));
    const before = await revisionOf(store);

    expect(await renameSurveyTarget(pool, store, ids[0]!, '料理 0（改）')).toMatchObject({ changed: true });
    expect(
      await reorderSurveyTargets(pool, store, { categoryCode: 'food', targetIds: [...ids].reverse() }),
    ).toMatchObject({ changed: true, action: 'survey_targets_reordered' });
    expect(await setSurveyTargetActive(pool, store, ids[1]!, false)).toMatchObject({ changed: true });
    // 1 件空いたので、非表示にした行の再表示はできる。もう 1 件の追加は上限に当たる。
    changedId(await add(store, 'food', '新しい料理'));
    expect(await setSurveyTargetActive(pool, store, ids[1]!, true)).toEqual({
      ok: false,
      error: 'TARGET_LIMIT_REACHED',
    });
    expect(await revisionOf(store)).toBe(before! + 4);
  });

  it('他店の Target・存在しない Target は「無い」として扱う（名前の変更・表示の切り替え）', async () => {
    const pool = await getPool();
    const mine = await newStore();
    const theirs = await newStore(OTHER_OW);
    const theirTarget = changedId(await add(theirs, 'food', '他店の料理'));
    changedId(await add(mine, 'food', '自店の料理'));
    const before = await revisionOf(mine);
    for (const id of [theirTarget, 'a4370000-0000-4000-8000-0000000000ff']) {
      expect(await renameSurveyTarget(pool, mine, id, '乗っ取り')).toEqual({ ok: false, error: 'TARGET_NOT_FOUND' });
      expect(await setSurveyTargetActive(pool, mine, id, false)).toEqual({ ok: false, error: 'TARGET_NOT_FOUND' });
      expect(await setSurveyTargetActive(pool, mine, id, true)).toEqual({ ok: false, error: 'TARGET_NOT_FOUND' });
    }
    expect(await revisionOf(mine)).toBe(before);
    const other = (await readStoreSurveySettings(pool, theirs)).targets;
    expect(other).toEqual([expect.objectContaining({ id: theirTarget, label: '他店の料理', active: true })]);
  });

  it('並び替えは、そのカテゴリの表示中の自店の Target の集合とちょうど一致するときだけ受け付ける', async () => {
    const pool = await getPool();
    const store = await newStore();
    const theirs = await newStore(OTHER_OW);
    const theirTarget = changedId(await add(theirs, 'food', '他店の料理'));
    const [a, b, c] = [
      changedId(await add(store, 'food', 'A')),
      changedId(await add(store, 'food', 'B')),
      changedId(await add(store, 'food', 'C')),
    ];
    const drink = changedId(await add(store, 'drink', 'D'));
    const hidden = changedId(await add(store, 'food', 'H'));
    await setSurveyTargetActive(pool, store, hidden, false);
    const before = await revisionOf(store);

    const invalid: unknown[] = [
      [a, b, b], // 重複
      [a, b], // 欠落
      [a, b, c, theirTarget], // 他店の ID
      [a, b, theirTarget], // 他店の ID に差し替え
      [a, b, c, drink], // 別カテゴリ
      [a, b, c, hidden], // 非表示
      [a, b, 'not-a-uuid'],
      'abc',
      null,
    ];
    for (const targetIds of invalid) {
      expect(await reorderSurveyTargets(pool, store, { categoryCode: 'food', targetIds }), JSON.stringify(targetIds)).toEqual({
        ok: false,
        error: 'INVALID_ORDER',
      });
    }
    expect(await reorderSurveyTargets(pool, store, { categoryCode: 'price', targetIds: [] })).toEqual({
      ok: false,
      error: 'CATEGORY_NOT_EDITABLE',
    });
    expect(await revisionOf(store)).toBe(before);

    expect(await reorderSurveyTargets(pool, store, { categoryCode: 'food', targetIds: [a, b, c] })).toEqual({
      ok: true,
      changed: false,
    });
    expect(await reorderSurveyTargets(pool, store, { categoryCode: 'food', targetIds: [c, a, b] })).toMatchObject({
      changed: true,
      revision: before! + 1,
    });
    const order = (await readStoreSurveySettings(pool, store)).targets
      .filter((t) => t.categoryCode === 'food' && t.active)
      .map((t) => t.id);
    expect(order).toEqual([c, a, b]);
    // 他店の並びは変わらない。
    expect((await readStoreSurveySettings(pool, theirs)).targets.map((t) => t.sortOrder)).toEqual([0]);
  });

  it('予約・来店の表示を切り替えられる。それ以外のカテゴリは切り替えられない', async () => {
    const pool = await getPool();
    const store = await newStore();
    expect(await setSurveyCategoryEnabled(pool, store, 'reservation_visit', false)).toMatchObject({
      ok: true,
      changed: true,
      action: 'survey_category_visibility_updated',
      revision: 1,
    });
    expect(await setSurveyCategoryEnabled(pool, store, 'reservation_visit', false)).toEqual({ ok: true, changed: false });
    for (const code of ['food', 'drink', 'price', 'no_such_category', null]) {
      expect(await setSurveyCategoryEnabled(pool, store, code, false)).toEqual({
        ok: false,
        error: 'CATEGORY_NOT_TOGGLEABLE',
      });
    }
    const settings = await readStoreSurveySettings(pool, store);
    expect(settings.categories.find((c) => c.code === 'reservation_visit')?.enabled).toBe(false);
    expect(settings.categories.filter((c) => !c.enabled).map((c) => c.code)).toEqual(['reservation_visit']);
    expect(await setSurveyCategoryEnabled(pool, store, 'reservation_visit', true)).toMatchObject({ revision: 2 });
    // カテゴリの並び順の override は seed の既定を写す（オーナーは並び順を変えられない）。
    const row = await pool.query('SELECT enabled, sort_order FROM store_survey_category_settings WHERE store_id = $1', [
      store,
    ]);
    expect(row.rows).toEqual([{ enabled: true, sort_order: 60 }]);
  });

  describe('並行する変更', () => {
    it('2 つの接続から同時に変えても、revision は 2 つ分進む（1 → 3・lost update なし）', async () => {
      const pool = await getPool();
      const store = await newStore();
      changedId(await add(store, 'food', '最初の料理'));
      expect(await revisionOf(store)).toBe(1);

      // 片方の接続が設定行のロックを持ったまま、もう片方の変更を走らせて待たせる（交互の順序を固定する）。
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          'UPDATE store_survey_configs SET revision = revision + 1, updated_at = now() WHERE store_id = $1',
          [store],
        );
        const waiting = add(store, 'drink', '待たされた変更');
        await new Promise((resolve) => setTimeout(resolve, 200));
        await holder.query('COMMIT');
        expect(await waiting).toMatchObject({ ok: true, changed: true, revision: 3 });
      } finally {
        holder.release();
      }
      expect(await revisionOf(store)).toBe(3);
    });

    it('同時に 4 つの変更を流しても、すべての加算が残る', async () => {
      const pool = await getPool();
      const store = await newStore();
      const results = await Promise.all([
        add(store, 'food', '並行 1'),
        add(store, 'food', '並行 2'),
        add(store, 'drink', '並行 3'),
        setSurveyCategoryEnabled(pool, store, 'reservation_visit', false),
      ]);
      expect(results.every((r) => r.ok && r.changed)).toBe(true);
      const revisions = results.map((r) => (r.ok && r.changed ? r.revision : 0)).sort((x, y) => x - y);
      expect(revisions).toEqual([1, 2, 3, 4]);
      expect(await revisionOf(store)).toBe(4);
    });

    it('同時に同じ名前を追加しても 1 件だけが登録され、上限も超えない', async () => {
      const store = await newStore();
      const same = await Promise.all([add(store, 'food', '同名'), add(store, 'food', '同名')]);
      expect(same.filter((r) => r.ok).length).toBe(1);
      expect(same.filter((r) => !r.ok)).toEqual([{ ok: false, error: 'DUPLICATE_LABEL' }]);

      for (let i = 1; i < ACTIVE_TARGET_LIMITS.food - 1; i++) changedId(await add(store, 'food', `料理 ${i}`));
      const last = await Promise.all([add(store, 'food', '最後 A'), add(store, 'food', '最後 B')]);
      expect(last.filter((r) => r.ok).length).toBe(1);
      expect(last.filter((r) => !r.ok)).toEqual([{ ok: false, error: 'TARGET_LIMIT_REACHED' }]);
      const active = (await readStoreSurveySettings(await getPool(), store)).targets.filter(
        (t) => t.categoryCode === 'food' && t.active,
      );
      expect(active).toHaveLength(ACTIVE_TARGET_LIMITS.food);
    });
  });
});
