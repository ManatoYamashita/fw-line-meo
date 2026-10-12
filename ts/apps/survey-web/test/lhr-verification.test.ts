import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FORM_AUDITS,
  NODE_LABEL_MAX,
  expectedRuns,
  main,
  matchStoreLabel,
  readSeedStore,
  verifyLhrs,
} from '../perf/lhr-verification.mjs';

// Lighthouse が測った画面が、E2E の確定店舗の回答画面であることを確かめる判定（Issue #264）。
//
// lhci の判定（LCP・accessibility）は、店舗が見つからない 1 段落の画面でも合格する。
// この判定はそれを赤にするためのものなので、**「別の画面を測ったときに赤になる」側を厚く固定する。**
// 緑になることだけを確かめても、判定が何も見ていない状態と区別できない。

const surveyDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const STORE_ID = '12345678-90ab-cdef-1234-567890abcdef';
const OTHER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const STORE_NAME = 'テスト食堂 本店';
const UNAVAILABLE = 'このアンケートは現在ご利用いただけません。';
const PAGE_URL = `http://127.0.0.1:3000/s/${STORE_ID}`;
const CONFIG = { ci: { collect: { url: [PAGE_URL], numberOfRuns: 3 } } };

type Audit = {
  scoreDisplayMode?: string;
  numericValue?: number;
  details?: { items?: Array<{ items?: Array<{ node?: { nodeLabel?: string } }> }> };
};
type Lhr = {
  requestedUrl?: string;
  finalDisplayedUrl?: string;
  mainDocumentUrl?: string;
  fetchTime?: string;
  audits?: Record<string, Audit | undefined>;
  categories?: { accessibility?: { score?: number | null } };
};

/** 実物の LHR（Lighthouse 12.6.1）の形のうち、判定が読む部分だけを持つ。既定は回答画面を測った 1 回。 */
function lhr(
  over: { label?: string | null; url?: string; formMode?: string; mainDocumentUrl?: string } = {},
): Lhr {
  const url = over.url ?? PAGE_URL;
  const label = over.label === undefined ? STORE_NAME : over.label;
  const formMode = over.formMode ?? 'binary';
  const audits: Record<string, Audit | undefined> = {
    'largest-contentful-paint': { numericValue: 2051.4 },
    'largest-contentful-paint-element':
      label === null
        ? undefined
        : { details: { items: [{ items: [{ node: { nodeLabel: label } }] }, { items: [] }] } },
  };
  for (const id of FORM_AUDITS) audits[id] = { scoreDisplayMode: formMode };
  return {
    requestedUrl: PAGE_URL,
    finalDisplayedUrl: url,
    mainDocumentUrl: over.mainDocumentUrl ?? url,
    fetchTime: '2026-09-13T00:28:43.567Z',
    audits,
    categories: { accessibility: { score: 1 } },
  };
}

/** 1 段落の画面（seed が無い・店舗が confirmed でない）を測った 1 回。 */
function unavailableLhr(): Lhr {
  return lhr({ label: UNAVAILABLE, formMode: 'notApplicable' });
}

function entries(...lhrs: Lhr[]) {
  return lhrs.map((l, i) => ({ file: `lhr-${1000 + i}.json`, lhr: l }));
}

const store = { id: STORE_ID, name: STORE_NAME };

/**
 * lhci が標準出力を区切りごとに文字列へ変換して連結したときの化け方を、同じ機構で作る（Issue #408）。
 * text の charIndex 文字目（コードポイント単位）を、先頭から bytesBefore バイトのところで 2 つの Buffer に分け、
 * 別々に toString() して連結する。U+FFFD を手で書かないのは、書いた個数が実際の化け方と食い違うのを防ぐため。
 * 化けた箇所がちょうど 1 つ・U+FFFD が expected 個であることも確かめる（ヘルパーの空振りを防ぐ）。
 */
function splitDecode(text: string, charIndex: number, bytesBefore: number, expected: number): string {
  const prefix = Array.from(text).slice(0, charIndex).join('');
  const offset = Buffer.byteLength(prefix, 'utf8') + bytesBefore;
  const bytes = Buffer.from(text, 'utf8');
  const out = bytes.subarray(0, offset).toString() + bytes.subarray(offset).toString();
  expect([...out.matchAll(/\uFFFD+/g)].map((m) => m[0].length)).toEqual([expected]);
  return out;
}

const FFFD = '\uFFFD';
// 2 バイト（é）・3 バイト（食・テ）・4 バイト（😀）の文字を持つ店名。
const MIXED_NAME = 'Café 😀 テスト';

function seedSql(storesInsert: string): string {
  return [
    "INSERT INTO owners (id, agency_id) VALUES ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222') ON CONFLICT DO NOTHING;",
    storesInsert,
  ].join('\n');
}

const STORES_INSERT = `INSERT INTO stores (id, owner_id, name, place_id, place_status)
  VALUES ('${STORE_ID}', '33333333-3333-3333-3333-333333333333', '${STORE_NAME}', 'ChIJxxxx', 'confirmed') ON CONFLICT DO NOTHING;`;

describe('readSeedStore', () => {
  it('実物の seed.sql から店舗を読み、その id は lighthouserc.json が開く URL と一致する', () => {
    const seed = readSeedStore(readFileSync(join(surveyDir, 'e2e', 'seed.sql'), 'utf8'));
    const config = JSON.parse(readFileSync(join(surveyDir, 'perf', 'lighthouserc.json'), 'utf8')) as {
      ci: { collect: { url: string[] } };
    };
    expect(seed.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // 店名の値そのものはここへ書き写さない（seed.sql が正典）。形だけを見る。
    expect(seed.name.trim().length).toBeGreaterThan(0);
    expect(seed.name).not.toContain("'");
    expect(seed.name).not.toBe(seed.id);
    expect(config.ci.collect.url.map((u) => new URL(u).pathname)).toEqual([`/s/${seed.id}`]);
  });

  it('値は位置ではなく列名で対応づける', () => {
    const sql = seedSql(
      `INSERT INTO stores (name, place_status, id, owner_id, place_id) VALUES ('${STORE_NAME}', 'confirmed', '${STORE_ID}', '33333333-3333-3333-3333-333333333333', 'ChIJxxxx');`,
    );
    expect(readSeedStore(sql)).toEqual({ id: STORE_ID, name: STORE_NAME });
  });

  it("文字列リテラルの '' を ' へ戻し、店名の中の -- ・カンマ・括弧で切らない", () => {
    const sql = seedSql(
      `INSERT INTO stores (id, owner_id, name) VALUES ('${STORE_ID}', '33333333-3333-3333-3333-333333333333', 'O''Brien -- 食堂, (本店)');`,
    );
    expect(readSeedStore(sql).name).toBe("O'Brien -- 食堂, (本店)");
  });

  it('行コメントの中の INSERT は数えない', () => {
    const commented = `-- INSERT INTO stores (id, name) VALUES ('${OTHER_ID}', '古い店');\n${STORES_INSERT}`;
    expect(readSeedStore(seedSql(commented))).toEqual({ id: STORE_ID, name: STORE_NAME });
    // コメントの中にしか無ければ、店舗は 0 件である。
    expect(() => readSeedStore(seedSql(`-- ${STORES_INSERT.replace(/\n/g, ' ')}`))).toThrow('0 件');
  });

  it('名前の似た別のテーブル（stores_x / pre_stores）を掴まない', () => {
    const decoys = [
      `INSERT INTO stores_x (id, name) VALUES ('${OTHER_ID}', '別テーブル');`,
      `INSERT INTO pre_stores (id, name) VALUES ('${OTHER_ID}', '別テーブル');`,
    ].join('\n');
    expect(readSeedStore(seedSql(`${decoys}\n${STORES_INSERT}`))).toEqual({ id: STORE_ID, name: STORE_NAME });
    expect(() => readSeedStore(seedSql(decoys))).toThrow('0 件');
  });

  it('stores の INSERT が 2 件あれば、どちらが確定店舗か決まらないので例外', () => {
    const second = STORES_INSERT.replace(STORE_ID, OTHER_ID);
    expect(() => readSeedStore(seedSql(`${STORES_INSERT}\n${second}`))).toThrow('2 件');
  });

  it('VALUES が複数行なら例外', () => {
    const sql = seedSql(
      `INSERT INTO stores (id, name) VALUES ('${STORE_ID}', '${STORE_NAME}'), ('${OTHER_ID}', '二号店');`,
    );
    expect(() => readSeedStore(sql)).toThrow('複数行');
  });

  it('id か name の列が無ければ例外', () => {
    expect(() => readSeedStore(seedSql(`INSERT INTO stores (id, owner_id) VALUES ('${STORE_ID}', 'x');`))).toThrow(
      'name',
    );
    expect(() => readSeedStore(seedSql(`INSERT INTO stores (owner_id, name) VALUES ('x', '${STORE_NAME}');`))).toThrow(
      'id',
    );
  });

  it('id が UUID の文字列リテラルでなければ例外', () => {
    expect(() => readSeedStore(seedSql(`INSERT INTO stores (id, name) VALUES ('store-1', '${STORE_NAME}');`))).toThrow(
      'UUID',
    );
    expect(() =>
      readSeedStore(seedSql(`INSERT INTO stores (id, name) VALUES (gen_random_uuid(), '${STORE_NAME}');`)),
    ).toThrow('UUID');
  });

  it('店名が空なら例外（空の店名との照合は必ず成立し、何も確かめないため）', () => {
    expect(() => readSeedStore(seedSql(`INSERT INTO stores (id, name) VALUES ('${STORE_ID}', '');`))).toThrow('空');
    expect(() => readSeedStore(seedSql(`INSERT INTO stores (id, name) VALUES ('${STORE_ID}', '   ');`))).toThrow('空');
  });

  it(`店名は ${NODE_LABEL_MAX} 字まで通し、それを超えると例外（Lighthouse が LCP 要素の文言を切り詰めるため）`, () => {
    const at = 'あ'.repeat(NODE_LABEL_MAX);
    expect(readSeedStore(seedSql(`INSERT INTO stores (id, name) VALUES ('${STORE_ID}', '${at}');`)).name).toBe(at);
    expect(() =>
      readSeedStore(seedSql(`INSERT INTO stores (id, name) VALUES ('${STORE_ID}', '${at}い');`)),
    ).toThrow(`${NODE_LABEL_MAX} 字`);
  });
});

describe('expectedRuns', () => {
  it('url の配列の各 URL に numberOfRuns を割り当てる', () => {
    expect(expectedRuns(CONFIG)).toEqual(new Map([[PAGE_URL, 3]]));
  });

  it('url が文字列でも配列と同じに読む（lhci と同じ正規化）', () => {
    expect(expectedRuns({ ci: { collect: { url: PAGE_URL, numberOfRuns: 2 } } })).toEqual(new Map([[PAGE_URL, 2]]));
  });

  it('同じ URL が 2 回あれば、その URL の件数は 2 倍になる（lhci は url の要素ごとに測る）', () => {
    expect(expectedRuns({ ci: { collect: { url: [PAGE_URL, PAGE_URL], numberOfRuns: 3 } } })).toEqual(
      new Map([[PAGE_URL, 6]]),
    );
  });

  it('numberOfRuns を省略すると例外（lhci の既定値が暗黙に使われ、期待件数を設定から読めない）', () => {
    expect(() => expectedRuns({ ci: { collect: { url: [PAGE_URL] } } })).toThrow('numberOfRuns');
    expect(() => expectedRuns({ ci: { collect: { url: [PAGE_URL], numberOfRuns: 0 } } })).toThrow('numberOfRuns');
    expect(() => expectedRuns({ ci: { collect: { url: [PAGE_URL], numberOfRuns: 1.5 } } })).toThrow('numberOfRuns');
  });

  it('url が無ければ例外', () => {
    expect(() => expectedRuns({ ci: { collect: { numberOfRuns: 3 } } })).toThrow('url');
    expect(() => expectedRuns({ ci: { collect: { url: [], numberOfRuns: 3 } } })).toThrow('url');
  });
});

describe('matchStoreLabel', () => {
  it('店名と等しい文言は exact（空白の揺れも同じ店名として読む）', () => {
    expect(matchStoreLabel(STORE_NAME, STORE_NAME)).toBe('exact');
    expect(matchStoreLabel(` ${STORE_NAME.replace(' ', '  ')}\n`, STORE_NAME)).toBe('exact');
  });

  // 緑: 1 文字が区切りをまたいだときに出る U+FFFD は 2〜(その文字の UTF-8 バイト数) 個。
  it.each([
    ['é（2 バイト）を 1｜1 で切る → 2 個', MIXED_NAME, 3, 1, 2],
    ['食（3 バイト）を 2｜1 で切る → 2 個', STORE_NAME, 3, 2, 2],
    ['食（3 バイト）を 1｜2 で切る → 3 個（2026-09-28 の観測と同形）', STORE_NAME, 3, 1, 3],
    ['😀（4 バイト）を 1｜3 で切る → 4 個', MIXED_NAME, 5, 1, 4],
    ['😀（4 バイト）を 2｜2 で切る → 3 個', MIXED_NAME, 5, 2, 3],
    ['😀（4 バイト）を 3｜1 で切る → 2 個', MIXED_NAME, 5, 3, 2],
  ])('区切りで化けた 1 文字は split（%s）', (_case, name, charIndex, bytesBefore, n) => {
    expect(matchStoreLabel(splitDecode(name, charIndex, bytesBefore, n), name)).toBe('split');
  });

  it('観測した文言そのもの（「ッ」が U+FFFD 3 個）は split', () => {
    const name = 'スターバックス コーヒー';
    expect(matchStoreLabel(`スターバ${FFFD.repeat(3)}クス コーヒー`, name)).toBe('split');
  });

  // 赤: 許容を広げすぎていないことの確認。
  it.each([
    ['U+FFFD が 1 個（区切りの化けでは出ない数）', `テスト${FFFD}堂 本店`, STORE_NAME],
    ['U+FFFD が 5 個（4 バイト文字の位置でも 1 文字の分割では出ない数）', `Café ${FFFD.repeat(5)} テスト`, MIXED_NAME],
    ['3 バイト文字の位置に U+FFFD が 4 個', `テスト${FFFD.repeat(4)}堂 本店`, STORE_NAME],
    ['2 バイト文字の位置に U+FFFD が 3 個', `Caf${FFFD.repeat(3)} 😀 テスト`, MIXED_NAME],
    ['ASCII の位置に U+FFFD が 2 個（1 バイト文字は割れない）', `Ca${FFFD.repeat(2)}é 😀 テスト`, MIXED_NAME],
    ['化けが 2 箇所', `テ${FFFD.repeat(3)}ト${FFFD.repeat(3)}堂 本店`, STORE_NAME],
    ['U+FFFD が文字を置き換えず挿入されている', `テスト食${FFFD.repeat(3)}堂 本店`, STORE_NAME],
    ['U+FFFD が 2 文字ぶんを置き換えている', `テスト${FFFD.repeat(3)} 本店`, STORE_NAME],
    ['化けていない別の店名', 'べつの食堂', STORE_NAME],
    ['1 文字違いの店名', 'テスト食堂 支店', STORE_NAME],
    ['店名＋文言の段落', `${STORE_NAME}は休業中です`, STORE_NAME],
  ])('mismatch（%s）', (_case, label, name) => {
    expect(matchStoreLabel(label, name)).toBe('mismatch');
  });

  // 違う文字が化けた箇所の前にある場合と後ろにある場合の両方を置く（片側だけでは、もう片側の一致の判定を
  // 外しても緑のまま残る）。
  it.each([
    ['化けた箇所より後ろ', 'テスト食堂 支店'],
    ['化けた箇所より前', 'ベスト食堂 本店'],
  ])('化けた箇所以外の文字も違う店名は mismatch（%s）', (_where, other) => {
    expect(matchStoreLabel(splitDecode(other, 3, 1, 3), STORE_NAME)).toBe('mismatch');
  });

  it('店舗が見つからない 1 段落の画面の文言は、化けていても mismatch（#264 の防御を崩さない）', () => {
    expect(matchStoreLabel(splitDecode(UNAVAILABLE, 3, 1, 3), STORE_NAME)).toBe('mismatch');
  });
});

describe('verifyLhrs', () => {
  it('回答画面を測った 3 回は合格し、1 回ごとの行を出す', () => {
    const result = verifyLhrs(entries(lhr(), lhr(), lhr()), store, CONFIG);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(3);
    expect(result.expected).toBe(3);
    expect(result.lines).toHaveLength(3);
    expect(result.lines[0]).toContain('lhr-1000.json');
    expect(result.lines[0]).toContain(`LCP要素=${STORE_NAME}`);
    expect(result.lines[0]).toContain('LCP=2051ms');
  });

  it('店舗が見つからない 1 段落の画面は赤（lhci の判定は合格する形そのもの）', () => {
    const result = verifyLhrs(entries(unavailableLhr(), unavailableLhr(), unavailableLhr()), store, CONFIG);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(`LCP 要素が seed の店名ではありません（「${UNAVAILABLE}」）`);
    expect(result.errors.join('\n')).toContain('button-name');
  });

  it.each([
    ['先頭', [unavailableLhr(), lhr(), lhr()], 'lhr-1000.json'],
    ['末尾', [lhr(), lhr(), unavailableLhr()], 'lhr-1002.json'],
  ])('3 回のうち 1 回だけ別の画面でも赤（%s）', (_where, lhrs, badFile) => {
    const result = verifyLhrs(entries(...lhrs), store, CONFIG);
    expect(result.ok).toBe(false);
    expect(result.errors.every((e) => e.startsWith(`${badFile}:`))).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('LCP 要素は店名と等しいことを求める（「店名＋文言」の段落は通さない）', () => {
    const result = verifyLhrs(entries(lhr(), lhr(), lhr({ label: `${STORE_NAME}は休業中です` })), store, CONFIG);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('LCP 要素が seed の店名ではありません');
  });

  it('3 回のうち 1 回の LCP 要素が lhci の区切りで化けていても合格し、その 1 件だけを警告する（Issue #408）', () => {
    const garbled = lhr({ label: splitDecode(STORE_NAME, 3, 1, 3) });
    const result = verifyLhrs(entries(lhr(), garbled, lhr()), store, CONFIG);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/^lhr-1001\.json: /);
    expect(result.warnings[0]).toContain('Issue #408');
  });

  it('化けていない結果では警告を出さない', () => {
    expect(verifyLhrs(entries(lhr(), lhr(), lhr()), store, CONFIG).warnings).toEqual([]);
  });

  it('化けた箇所以外も違う LCP 要素は赤のままで、警告にしない', () => {
    const result = verifyLhrs(entries(lhr(), lhr(), lhr({ label: splitDecode('テスト食堂 支店', 3, 1, 3) })), store, CONFIG);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('LCP 要素が seed の店名ではありません');
    expect(result.warnings).toEqual([]);
  });

  it('LCP 要素の空白の揺れ（連続・前後）は同じ店名として読む', () => {
    const spaced = ` ${STORE_NAME.replace(' ', '  ')}\n`;
    expect(verifyLhrs(entries(lhr(), lhr(), lhr({ label: spaced })), store, CONFIG).ok).toBe(true);
  });

  it('LCP 要素の監査が無ければ赤', () => {
    const result = verifyLhrs(entries(lhr(), lhr({ label: null }), lhr()), store, CONFIG);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('largest-contentful-paint-element');
  });

  it('測った URL が seed の店舗の回答画面でなければ赤', () => {
    const result = verifyLhrs(entries(lhr(), lhr(), lhr({ url: `http://127.0.0.1:3000/s/${OTHER_ID}` })), store, CONFIG);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('finalDisplayedUrl');
  });

  it('id がクエリにだけ現れても赤（pathname の完全一致を求める）', () => {
    const url = `http://127.0.0.1:3000/s/${OTHER_ID}?from=${STORE_ID}`;
    expect(verifyLhrs(entries(lhr(), lhr(), lhr({ url })), store, CONFIG).ok).toBe(false);
  });

  it('mainDocumentUrl だけが違っても赤', () => {
    const result = verifyLhrs(
      entries(lhr(), lhr(), lhr({ mainDocumentUrl: 'http://127.0.0.1:3000/ui-check' })),
      store,
      CONFIG,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('mainDocumentUrl');
  });

  it.each(FORM_AUDITS)('回答フォームで評価される監査 %s が評価されていなければ赤', (auditId) => {
    const bad = lhr();
    bad.audits![auditId] = { scoreDisplayMode: 'notApplicable' };
    const result = verifyLhrs(entries(lhr(), bad, lhr()), store, CONFIG);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(auditId);
  });

  it('フォームの監査は 1 つ以上ある（空だと何も確かめない）', () => {
    expect(FORM_AUDITS.length).toBeGreaterThan(0);
  });

  it('結果が 0 件なら赤', () => {
    const result = verifyLhrs([], store, CONFIG);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('0 件');
  });

  it('件数が設定より少なくても多くても赤（古い結果の混入を含む）', () => {
    expect(verifyLhrs(entries(lhr(), lhr()), store, CONFIG).ok).toBe(false);
    expect(verifyLhrs(entries(lhr(), lhr(), lhr(), lhr()), store, CONFIG).ok).toBe(false);
  });

  it('設定に無い URL の結果が混ざると赤', () => {
    const stray = lhr();
    stray.requestedUrl = `http://127.0.0.1:3200/s/${STORE_ID}`;
    const result = verifyLhrs(entries(lhr(), lhr(), lhr(), stray), store, CONFIG);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('lighthouserc.json に無い URL');
  });

  it('店名が空・id が UUID でない店舗を渡されたら例外（何も確かめないまま合格させない）', () => {
    expect(() => verifyLhrs(entries(lhr()), { id: STORE_ID, name: '' }, CONFIG)).toThrow();
    expect(() => verifyLhrs(entries(lhr()), { id: '', name: STORE_NAME }, CONFIG)).toThrow();
  });
});

describe('main', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** survey-web の配置を一時ディレクトリに作る。results が null なら .lighthouseci を作らない。 */
  function fixture(results: Lhr[] | null, seed = seedSql(STORES_INSERT)): string {
    const dir = mkdtempSync(join(tmpdir(), 'lhr-verification-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'e2e'));
    mkdirSync(join(dir, 'perf'));
    writeFileSync(join(dir, 'e2e', 'seed.sql'), seed);
    writeFileSync(join(dir, 'perf', 'lighthouserc.json'), JSON.stringify(CONFIG));
    if (results !== null) {
      mkdirSync(join(dir, '.lighthouseci'));
      results.forEach((r, i) => {
        writeFileSync(join(dir, '.lighthouseci', `lhr-${1000 + i}.json`), JSON.stringify(r));
        // lhci が同じ名前で残す HTML と判定結果は数えない。
        writeFileSync(join(dir, '.lighthouseci', `lhr-${1000 + i}.html`), '<html></html>');
      });
      writeFileSync(join(dir, '.lighthouseci', 'assertion-results.json'), '[]');
    }
    return dir;
  }

  function run(surveyDirArg: string, argv: string[] = []) {
    const out: string[] = [];
    const err: string[] = [];
    const code = main({ surveyDir: surveyDirArg, argv, out: (s: string) => out.push(s), err: (s: string) => err.push(s) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('回答画面を測った結果なら 0 を返し、母数を出す', () => {
    const r = run(fixture([lhr(), lhr(), lhr()]));
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('3/3 件');
    expect(r.out).toContain(STORE_ID);
  });

  it('回答画面を測った結果では WARN: を出さない', () => {
    const r = run(fixture([lhr(), lhr(), lhr()]));
    expect(r.out).not.toContain('WARN:');
  });

  it('LCP 要素が lhci の区切りで化けた結果は 0 を返し、WARN: の行を出す（Issue #408）', () => {
    const r = run(fixture([lhr(), lhr({ label: splitDecode(STORE_NAME, 3, 1, 3) }), lhr()]));
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^WARN: lhr-1001\.json: /m);
    expect(r.out).toContain('3/3 件');
  });

  it('1 段落の画面を測った結果なら 1 を返し、理由を出す', () => {
    const r = run(fixture([unavailableLhr(), unavailableLhr(), unavailableLhr()]));
    expect(r.code).toBe(1);
    expect(r.err).toContain('LCP 要素が seed の店名ではありません');
  });

  it('結果のディレクトリが無ければ 1', () => {
    const r = run(fixture(null));
    expect(r.code).toBe(1);
    expect(r.err).toContain('.lighthouseci');
  });

  it('結果が壊れた JSON なら 1', () => {
    const dir = fixture([lhr(), lhr()]);
    writeFileSync(join(dir, '.lighthouseci', 'lhr-9999.json'), '{');
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain('lhr-9999.json');
  });

  it('seed の店舗を読めなければ 1', () => {
    const r = run(fixture([lhr(), lhr(), lhr()], seedSql('')));
    expect(r.code).toBe(1);
    expect(r.err).toContain('seed');
  });

  it('--print-seed は id と店名をタブ区切りで 1 行出す（結果のディレクトリは要らない）', () => {
    const r = run(fixture(null), ['--print-seed']);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${STORE_ID}\t${STORE_NAME}`);
  });

  it('不明な引数は 2', () => {
    expect(run(fixture([lhr(), lhr(), lhr()]), ['--since-ms=0']).code).toBe(2);
    expect(run(fixture([lhr(), lhr(), lhr()]), ['--print-seed', 'x']).code).toBe(2);
  });
});
