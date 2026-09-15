// @ts-check
// Lighthouse の計測結果（LHR）が、E2E の確定店舗の回答画面を測ったものかを確かめる判定（Issue #264）。
//
// lhci の判定（LCP・accessibility）だけでは、店舗が見つからない 1 段落の画面
// （「このアンケートは現在ご利用いただけません。」）でも合格する。LCP は速く、a11y も満点になるため、
// 別の画面を測ったまま緑になる。storeId が 4 箇所で一致していても、seed の投入に失敗した・店舗の
// 状態を変える migration が入った・画面側の分岐が変わった、のいずれでもこの形になる。
//
// そこで lhci の後に、測った画面そのものを次の 4 点で確かめる。
//   1. 件数: lighthouserc.json の numberOfRuns × URL 数ちょうど（lhci の collect は開始時に古い
//      lhr-*.json を消し、失敗した試行は保存しない。0 件も古い結果の混入も赤にする）
//   2. URL: finalDisplayedUrl と mainDocumentUrl の pathname が /s/<seed の店舗 id> と完全に一致する
//   3. 店名: LCP 要素の文言が seed の店名と等しい（回答画面では店名の h1 が LCP になる。1 段落の画面は
//      店名を出さない）
//   4. フォーム: 回答フォームがあって初めて評価される accessibility の監査が評価されている
//      （1 段落の画面ではこれらが notApplicable になり、a11y の満点は何も監査していない満点になる）
//
// 期待値はすべて seed.sql と lighthouserc.json から読む。店名や件数をここへ書き写さない。
// CI（ts-ci の lighthouse ジョブ）とローカルの実行装置（scripts/run-e2e-local.sh）は、
// どちらも perf/verify-lhr.mjs を通してこの判定を使う。判定を 2 箇所に持たないこと。
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Lighthouse は LCP 要素の文言（nodeLabel）を 80 字で切り詰める
 * （lighthouse/core/lib/page-functions.js の getNodeLabel → Util.truncate。80 字以下はそのまま返す）。
 * これを超える店名は、切り詰められた文言と一致しなくなる。
 */
export const NODE_LABEL_MAX = 80;

/**
 * 回答フォームがあって初めて評価される accessibility の監査。
 * 回答画面（ボタンと入力欄を持つ）では binary（評価済み）、1 段落の画面では notApplicable になる。
 * 選定は seed なしの画面を実測して確かめた（Issue #264 の記録を参照）。
 */
export const FORM_AUDITS = ['button-name', 'label'];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * @typedef {{ id: string, name: string }} SeedStore
 * @typedef {{ kind: 'string' | 'raw', text: string }} SqlValue
 * @typedef {{ ci?: { collect?: { url?: unknown, numberOfRuns?: unknown } } }} LhciConfig
 */

/**
 * 判定が読む LHR の部分集合。実物は Lighthouse の LH.Result だが、その型定義には依存しない。
 * @typedef {object} LhrAudit
 * @property {string} [scoreDisplayMode]
 * @property {number} [numericValue]
 * @property {{ items?: Array<{ items?: Array<{ node?: { nodeLabel?: string } }> }> }} [details]
 *
 * @typedef {object} Lhr
 * @property {string} [requestedUrl]
 * @property {string} [finalDisplayedUrl]
 * @property {string} [mainDocumentUrl]
 * @property {string} [fetchTime]
 * @property {Record<string, LhrAudit | undefined>} [audits]
 * @property {{ accessibility?: { score?: number | null } }} [categories]
 *
 * @typedef {{ file: string, lhr: Lhr }} LhrEntry
 * @typedef {{ ok: boolean, lines: string[], errors: string[], count: number, expected: number }} VerifyResult
 */

/**
 * SQL の `--` 行コメントを落とす。文字列リテラルの中の `--` は残す。
 * @param {string} sql
 * @returns {string}
 */
function stripLineComments(sql) {
  let out = '';
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (inString) {
      out += c;
      if (c === "'") {
        if (sql[i + 1] === "'") {
          out += "'";
          i++;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (c === "'") {
      inString = true;
      out += c;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * 位置 i から空白を読み飛ばした位置を返す。
 * @param {string} s
 * @param {number} i
 * @returns {number}
 */
function skipSpaces(s, i) {
  let j = i;
  while (j < s.length && /\s/.test(s[j] ?? '')) j++;
  return j;
}

/**
 * 位置 i の `'` から文字列リテラルを読み、中身（`''` を戻したもの）と閉じた直後の位置を返す。
 * @param {string} s
 * @param {number} i
 * @returns {{ text: string, end: number }}
 */
function readStringLiteral(s, i) {
  let text = '';
  let j = i + 1;
  for (;;) {
    if (j >= s.length) throw new Error('文字列リテラルが閉じていません');
    if (s[j] === "'") {
      if (s[j + 1] === "'") {
        text += "'";
        j += 2;
        continue;
      }
      return { text, end: j + 1 };
    }
    text += s[j];
    j++;
  }
}

/**
 * 位置 open の `(` から値の並びを読み、値と `)` の直後の位置を返す。
 * 値は文字列リテラル（kind: 'string'）か、それ以外の式（NULL・数値・関数呼び出しなど。kind: 'raw'）。
 * @param {string} s
 * @param {number} open
 * @returns {{ values: SqlValue[], end: number }}
 */
function readTuple(s, open) {
  /** @type {SqlValue[]} */
  const values = [];
  let i = open + 1;
  for (;;) {
    i = skipSpaces(s, i);
    if (s[i] === "'") {
      const lit = readStringLiteral(s, i);
      values.push({ kind: 'string', text: lit.text });
      i = lit.end;
    } else {
      let depth = 0;
      let text = '';
      while (i < s.length) {
        const c = s[i];
        if (c === "'") {
          const lit = readStringLiteral(s, i);
          text += s.slice(i, lit.end);
          i = lit.end;
          continue;
        }
        if (c === '(') depth++;
        else if (c === ')') {
          if (depth === 0) break;
          depth--;
        } else if (c === ',' && depth === 0) break;
        text += c;
        i++;
      }
      values.push({ kind: 'raw', text: text.trim() });
    }
    i = skipSpaces(s, i);
    if (s[i] === ',') {
      i++;
      continue;
    }
    if (s[i] === ')') return { values, end: i + 1 };
    throw new Error('値の並びを読めません（括弧が閉じていません）');
  }
}

/**
 * 列名の並び `(a, b, "C")` を読む。引用符の無い名前は PostgreSQL と同じく小文字に畳む。
 * @param {string} s
 * @param {number} open
 * @returns {{ columns: string[], end: number }}
 */
function readColumns(s, open) {
  const close = s.indexOf(')', open);
  if (close < 0) throw new Error('列名の並びが閉じていません');
  const columns = s
    .slice(open + 1, close)
    .split(',')
    .map((c) => c.trim())
    .map((c) => (c.startsWith('"') && c.endsWith('"') ? c.slice(1, -1) : c.toLowerCase()));
  return { columns, end: close + 1 };
}

/**
 * seed.sql から E2E の確定店舗（stores へ入れる 1 行）を読む。
 *
 * 値は列名で対応づける（列の並べ替えで別の値を掴まない）。確定店舗が 1 つに決まらない形・
 * 照合が空振りする形（空の店名・UUID でない id）はすべて例外にする。
 * @param {string} sqlText
 * @returns {SeedStore}
 */
export function readSeedStore(sqlText) {
  const sql = stripLineComments(sqlText);
  // `stores` の直後に `(` を要求し、stores_x のような別のテーブルを掴まない。
  const pattern = /\bINSERT\s+INTO\s+stores\s*\(/gi;
  const matches = [...sql.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(
      `stores への INSERT が ${matches.length} 件あります（確定店舗を 1 つに決めるため、ちょうど 1 件である必要があります）`,
    );
  }
  const match = matches[0];
  if (match === undefined || match.index === undefined) throw new Error('stores への INSERT を読めません');
  const open = match.index + match[0].length - 1;
  const { columns, end: afterColumns } = readColumns(sql, open);

  const valuesKeyword = /\s*VALUES\s*\(/iy;
  valuesKeyword.lastIndex = afterColumns;
  const valuesMatch = valuesKeyword.exec(sql);
  if (valuesMatch === null) throw new Error('stores への INSERT に VALUES (…) が続いていません');
  const { values, end: afterTuple } = readTuple(sql, valuesKeyword.lastIndex - 1);
  if (sql[skipSpaces(sql, afterTuple)] === ',') {
    throw new Error('stores への INSERT の VALUES が複数行です（確定店舗を 1 つに決められません）');
  }
  if (columns.length !== values.length) {
    throw new Error(`stores への INSERT の列（${columns.length} 個）と値（${values.length} 個）の数が合いません`);
  }

  /** @param {string} name */
  const valueOf = (name) => {
    const idx = columns.indexOf(name);
    if (idx < 0) throw new Error(`stores への INSERT に ${name} の列がありません`);
    if (columns.lastIndexOf(name) !== idx) throw new Error(`stores への INSERT に ${name} の列が 2 つあります`);
    const v = values[idx];
    if (v === undefined) throw new Error(`stores への INSERT に ${name} の値がありません`);
    return v;
  };

  const id = valueOf('id');
  if (id.kind !== 'string' || !UUID_PATTERN.test(id.text)) {
    throw new Error(`店舗の id が UUID の文字列リテラルではありません（${id.text}）`);
  }
  const name = valueOf('name');
  if (name.kind !== 'string') throw new Error(`店名が文字列リテラルではありません（${name.text}）`);
  const store = { id: id.text, name: name.text };
  assertStore(store);
  return store;
}

/**
 * 照合が空振りする店舗を拒む。空の店名との照合は必ず成立し、何も確かめないまま合格させるため。
 * @param {SeedStore} store
 */
function assertStore(store) {
  if (!UUID_PATTERN.test(store.id)) throw new Error(`店舗の id が UUID ではありません（${store.id}）`);
  if (store.name.trim() === '') throw new Error('店名が空です（空の店名との照合は必ず成立し、何も確かめません）');
  if (/[\t\r\n]/.test(store.name)) throw new Error('店名にタブか改行が含まれています');
  if (store.name.length > NODE_LABEL_MAX) {
    throw new Error(
      `店名が ${NODE_LABEL_MAX} 字を超えています（${store.name.length} 字）。Lighthouse が LCP 要素の文言を ${NODE_LABEL_MAX} 字で切り詰めるため照合できません`,
    );
  }
}

/**
 * lighthouserc.json から、URL ごとに期待する結果の件数を求める。
 * url は lhci と同じく文字列も配列も受ける。numberOfRuns の省略は受けない（lhci の既定値が
 * 暗黙に使われ、期待件数を設定から読めなくなるため）。
 * @param {LhciConfig} config
 * @returns {Map<string, number>}
 */
export function expectedRuns(config) {
  const collect = config.ci?.collect;
  const raw = collect?.url;
  const urls = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
  if (urls.length === 0) throw new Error('lighthouserc.json の ci.collect.url がありません');
  const runs = collect?.numberOfRuns;
  if (typeof runs !== 'number' || !Number.isInteger(runs) || runs < 1) {
    throw new Error(
      'lighthouserc.json の ci.collect.numberOfRuns を 1 以上の整数で明示してください（省略すると lhci の既定値が暗黙に使われ、期待件数を設定から読めません）',
    );
  }
  /** @type {Map<string, number>} */
  const expected = new Map();
  for (const url of urls) {
    if (typeof url !== 'string' || url === '') throw new Error('lighthouserc.json の ci.collect.url に空の値があります');
    expected.set(url, (expected.get(url) ?? 0) + runs);
  }
  return expected;
}

/** @param {string} s */
const normalizeSpaces = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * @param {string | undefined} url
 * @returns {string | undefined}
 */
function pathnameOf(url) {
  if (url === undefined || !URL.canParse(url)) return undefined;
  return new URL(url).pathname;
}

/**
 * @param {Lhr} lhr
 * @returns {string | undefined}
 */
function lcpNodeLabel(lhr) {
  const node = lhr.audits?.['largest-contentful-paint-element']?.details?.items?.[0]?.items?.[0]?.node;
  return typeof node?.nodeLabel === 'string' ? node.nodeLabel : undefined;
}

/**
 * 今回の結果すべてが、seed の店舗の回答画面を測ったものかを確かめる。
 * 1 件でも外れていれば赤。どの結果がどの理由で外れたかを errors に出す。
 * @param {LhrEntry[]} entries
 * @param {SeedStore} store
 * @param {LhciConfig} config
 * @returns {VerifyResult}
 */
export function verifyLhrs(entries, store, config) {
  assertStore(store);
  const expected = expectedRuns(config);
  let expectedTotal = 0;
  for (const n of expected.values()) expectedTotal += n;

  const wantPath = `/s/${store.id}`;
  const wantLabel = normalizeSpaces(store.name);
  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  const errors = [];
  /** @type {Map<string, number>} */
  const seen = new Map();

  for (const { file, lhr } of entries) {
    const requested = lhr.requestedUrl ?? '(requestedUrl なし)';
    seen.set(requested, (seen.get(requested) ?? 0) + 1);

    const label = lcpNodeLabel(lhr);
    const lcp = lhr.audits?.['largest-contentful-paint']?.numericValue;
    const a11y = lhr.categories?.accessibility?.score;
    lines.push(
      `  ${file}  fetchTime=${lhr.fetchTime ?? '?'}  LCP=${typeof lcp === 'number' ? `${Math.round(lcp)}ms` : '?'}  accessibility=${a11y ?? '?'}  LCP要素=${label ?? '(なし)'}`,
    );

    /** @type {Array<[string, string | undefined]>} */
    const urls = [
      ['finalDisplayedUrl', lhr.finalDisplayedUrl],
      ['mainDocumentUrl', lhr.mainDocumentUrl],
    ];
    for (const [field, value] of urls) {
      if (pathnameOf(value) !== wantPath) {
        errors.push(
          `${file}: ${field} が seed の店舗の回答画面ではありません（${value ?? '(なし)'}・期待する pathname は ${wantPath}）`,
        );
      }
    }

    if (label === undefined) {
      errors.push(`${file}: LCP 要素の監査（largest-contentful-paint-element）がありません`);
    } else if (normalizeSpaces(label) !== wantLabel) {
      errors.push(
        `${file}: LCP 要素が seed の店名ではありません（「${label}」）。店舗が見つからない画面を測った可能性があります`,
      );
    }

    for (const auditId of FORM_AUDITS) {
      const mode = lhr.audits?.[auditId]?.scoreDisplayMode;
      if (mode !== 'binary') {
        errors.push(
          `${file}: accessibility の監査 ${auditId} が評価されていません（scoreDisplayMode=${mode ?? '(なし)'}）。回答フォームが無い画面での満点です`,
        );
      }
    }
  }

  for (const [url, n] of expected) {
    const got = seen.get(url) ?? 0;
    if (got !== n) errors.push(`${url} の結果が ${got} 件です（lighthouserc.json の設定では ${n} 件）`);
  }
  for (const [url, n] of seen) {
    if (!expected.has(url)) errors.push(`lighthouserc.json に無い URL の結果が ${n} 件あります: ${url}`);
  }

  return { ok: errors.length === 0, lines, errors, count: entries.length, expected: expectedTotal };
}

/** @param {unknown} e */
const messageOf = (e) => (e instanceof Error ? e.message : String(e));

/**
 * CLI の本体。終了コードを返す（0: 合格 / 1: 不合格・読めない / 2: 引数の誤り）。
 *   引数なし       seed.sql・lighthouserc.json・.lighthouseci/lhr-*.json を読んで判定する
 *   --print-seed   seed の店舗を `<id>\t<店名>` で 1 行出す（実行装置が同じパーサーで seed を読むため）
 * @param {{ surveyDir: string, argv: string[], out?: (s: string) => void, err?: (s: string) => void }} options
 * @returns {number}
 */
export function main({ surveyDir, argv, out = (s) => console.log(s), err = (s) => console.error(s) }) {
  const printSeed = argv.length === 1 && argv[0] === '--print-seed';
  if (argv.length > 0 && !printSeed) {
    err(`ERROR: 不明な引数です: ${argv.join(' ')}（使い方: node perf/verify-lhr.mjs [--print-seed]）`);
    return 2;
  }

  const seedPath = path.join(surveyDir, 'e2e', 'seed.sql');
  /** @type {SeedStore} */
  let store;
  try {
    store = readSeedStore(readFileSync(seedPath, 'utf8'));
  } catch (e) {
    err(`ERROR: seed の店舗を読めません（${path.relative(surveyDir, seedPath)}）: ${messageOf(e)}`);
    return 1;
  }
  if (printSeed) {
    out(`${store.id}\t${store.name}`);
    return 0;
  }

  const configPath = path.join(surveyDir, 'perf', 'lighthouserc.json');
  /** @type {LhciConfig} */
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    err(`ERROR: ${path.relative(surveyDir, configPath)} を読めません: ${messageOf(e)}`);
    return 1;
  }

  const resultsDir = path.join(surveyDir, '.lighthouseci');
  /** @type {string[]} */
  let files;
  try {
    files = readdirSync(resultsDir)
      .filter((f) => /^lhr-\d+\.json$/.test(f))
      .sort();
  } catch (e) {
    err(`ERROR: 結果のディレクトリ .lighthouseci を読めません（lhci autorun の後に実行してください）: ${messageOf(e)}`);
    return 1;
  }

  /** @type {LhrEntry[]} */
  const entries = [];
  for (const file of files) {
    try {
      entries.push({ file, lhr: JSON.parse(readFileSync(path.join(resultsDir, file), 'utf8')) });
    } catch (e) {
      err(`ERROR: .lighthouseci/${file} を読めません: ${messageOf(e)}`);
      return 1;
    }
  }

  /** @type {VerifyResult} */
  let result;
  try {
    result = verifyLhrs(entries, store, config);
  } catch (e) {
    err(`ERROR: 判定の前提が崩れています: ${messageOf(e)}`);
    return 1;
  }
  for (const line of result.lines) out(line);
  if (!result.ok) {
    for (const e of result.errors) err(`NG: ${e}`);
    err(
      `NG: Lighthouse が測った画面は seed の店舗（${store.id}・${store.name}）の回答画面ではありません（結果 ${result.count}/${result.expected} 件）。lhci の判定が合格でも、別の画面を測っています`,
    );
    return 1;
  }
  out(
    `OK: Lighthouse の結果 ${result.count}/${result.expected} 件が、seed の店舗（${store.id}・${store.name}）の回答画面を測っていました（URL・LCP 要素＝店名・回答フォームの監査: ${FORM_AUDITS.join(', ')}）`,
  );
  return 0;
}
