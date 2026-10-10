import { detectVisitContextClaims, readVisitContextLexicon, type VisitContextLexicon } from '../../src/lib/draft/visit-context';
import { attributeAspectOf, detectEmbellishments, readEmbellishmentLexicon, type EmbellishmentLexicon } from '../../src/lib/draft/embellishment';
import { detectAbsenceAssertions, readAbsenceLexicon, type AbsenceLexicon } from '../../src/lib/draft/absence';
import { detectUngroundedClaims, readGroundingLexicon, type GroundingLexicon } from '../../src/lib/draft/material-grounding';
import visitLexiconRaw from '../../src/lib/draft/visit-context-lexicon.json';
import embellishmentLexiconRaw from '../../src/lib/draft/embellishment-lexicon.json';
import absenceLexiconRaw from '../../src/lib/draft/absence-lexicon.json';
import groundingLexiconRaw from '../../src/lib/draft/material-grounding-lexicon.json';

// structured survey の下書きの hard gate と coverage（Issue #440）。実 API を呼ばない純関数。
//
// 「自然でも、これが起きたら失格」を決定的に判定する。既存の検出器（来店の経緯・期待と再訪・属性・断定・
// 固有名詞と数値と日付）はそのまま再利用し、structured 固有の検査（Target / facet の同一性・極性・片側の欠落・
// 未回答の追加・exact overlap の理由・一言の因果づけ・強度・推奨）をここで足す。
//
// 判定は既存と同じく **高 precision** に倒す（検出したものは確実に違反・測るのは下限）。coverage は文字列一致では
// なく、ケースの言い方（subjects）と語彙の意味の手がかり（facetMeanings・polarityCues）で文単位に判定する。
// 例: 「刺身盛り合わせ / 味 / positive」は「刺身盛り合わせがおいしかったです」で満たす（「味」の字は要らない）。

// ---------------------------------------------------------------------------
// fixture の形
// ---------------------------------------------------------------------------

export type Polarity = 'positive' | 'concern';

export interface EvalFacet {
  readonly code: string;
  readonly label: string;
}

/** 回答受付が作る素材（resolveStructuredAnswer の selections）と同じ形。 */
export interface EvalSelection {
  readonly polarity: Polarity;
  readonly categoryCode: string;
  readonly categoryLabel: string;
  readonly targetId?: string;
  readonly targetLabel?: string;
  readonly facets: readonly EvalFacet[];
}

export interface EvalMenuTarget {
  readonly id: string;
  readonly label: string;
  readonly categoryCode: string;
  readonly aliases: readonly string[];
}

export interface EvalExample {
  readonly text: string;
  readonly kinds: readonly string[];
}

export interface StructuredEvalCase {
  readonly id: string;
  readonly title: string;
  readonly storeName: string;
  readonly star: 1 | 2 | 3 | 4 | 5;
  readonly comment?: string;
  readonly commentTone?: 'formal' | 'neutral' | 'casual';
  readonly selections: readonly EvalSelection[];
  /** Target を指す言い方（Target の名前そのものは常に含む）。 */
  readonly subjects: Readonly<Record<string, readonly string[]>>;
  readonly menuTargets: readonly EvalMenuTarget[];
  readonly commentKeywords: readonly string[];
  readonly forbiddenMeanings: readonly { readonly id: string; readonly pattern: RegExp; readonly note?: string }[];
  readonly allowedParaphrases: readonly string[];
  readonly forbiddenExamples: readonly EvalExample[];
}

const POLARITIES: readonly Polarity[] = ['positive', 'concern'];
const TONES = ['formal', 'neutral', 'casual'] as const;

function fail(message: string): never {
  throw new Error(`structured eval cases: ${message}`);
}

function str(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.trim() === '') fail(`${where} は空でない文字列である必要があります`);
  return v;
}

function strList(v: unknown, where: string): string[] {
  if (!Array.isArray(v)) fail(`${where} は配列である必要があります`);
  return v.map((x, i) => str(x, `${where}[${i}]`));
}

/**
 * cases.json を読み、形を検証する。形の誤り（極性の綴り・facet の欠落・同じ id の重複・参照例の欠落）は
 * 測定の前に止める。誤ったまま流すと、存在しない claim を測って結果を読み違える。
 */
export function readStructuredCases(raw: unknown): StructuredEvalCase[] {
  const root = raw as { cases?: unknown };
  if (!Array.isArray(root.cases) || root.cases.length === 0) fail('cases が空です');
  const ids = new Set<string>();
  return root.cases.map((c: Record<string, unknown>, ci) => {
    const where = `cases[${ci}]`;
    const id = str(c.id, `${where}.id`);
    if (ids.has(id)) fail(`id ${id} が重複しています`);
    ids.add(id);
    const star = c.star;
    if (typeof star !== 'number' || !Number.isInteger(star) || star < 1 || star > 5) fail(`${id}.star は 1〜5 の整数`);
    if (!Array.isArray(c.selections) || c.selections.length === 0) fail(`${id}.selections が空です`);
    const selections = c.selections.map((s: Record<string, unknown>, si) => {
      const sw = `${id}.selections[${si}]`;
      if (!POLARITIES.includes(s.polarity as Polarity)) fail(`${sw}.polarity は positive / concern`);
      if (!Array.isArray(s.facets)) fail(`${sw}.facets は配列`);
      const hasTarget = s.targetId !== undefined;
      if (hasTarget !== (s.targetLabel !== undefined)) fail(`${sw} は targetId と targetLabel を対で持つ`);
      if (!hasTarget && s.facets.length === 0) fail(`${sw} は Target も facet も無い（開いただけは回答ではない）`);
      const selection: EvalSelection = {
        polarity: s.polarity as Polarity,
        categoryCode: str(s.categoryCode, `${sw}.categoryCode`),
        categoryLabel: str(s.categoryLabel, `${sw}.categoryLabel`),
        facets: s.facets.map((f: Record<string, unknown>, fi) => ({
          code: str(f.code, `${sw}.facets[${fi}].code`),
          label: str(f.label, `${sw}.facets[${fi}].label`),
        })),
        ...(hasTarget
          ? { targetId: str(s.targetId, `${sw}.targetId`), targetLabel: str(s.targetLabel, `${sw}.targetLabel`) }
          : {}),
      };
      return selection;
    });
    const subjectsRaw = (c.subjects ?? {}) as Record<string, unknown>;
    const subjects: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(subjectsRaw)) subjects[k] = strList(v, `${id}.subjects.${k}`);
    if (c.comment !== undefined) str(c.comment, `${id}.comment`);
    if (c.commentTone !== undefined && !(TONES as readonly unknown[]).includes(c.commentTone)) {
      fail(`${id}.commentTone は formal / neutral / casual`);
    }
    const allowed = strList(c.allowedParaphrases, `${id}.allowedParaphrases`);
    if (allowed.length === 0) fail(`${id}.allowedParaphrases に許す言い換えの例が 1 つも無い`);
    return {
      id,
      title: str(c.title, `${id}.title`),
      storeName: str(c.storeName, `${id}.storeName`),
      star: star as StructuredEvalCase['star'],
      ...(c.comment !== undefined ? { comment: c.comment as string } : {}),
      ...(c.commentTone !== undefined ? { commentTone: c.commentTone as StructuredEvalCase['commentTone'] } : {}),
      selections,
      subjects,
      menuTargets: ((c.menuTargets ?? []) as Record<string, unknown>[]).map((m, mi) => ({
        id: str(m.id, `${id}.menuTargets[${mi}].id`),
        label: str(m.label, `${id}.menuTargets[${mi}].label`),
        categoryCode: str(m.categoryCode, `${id}.menuTargets[${mi}].categoryCode`),
        aliases: strList(m.aliases ?? [], `${id}.menuTargets[${mi}].aliases`),
      })),
      commentKeywords: strList(c.commentKeywords ?? [], `${id}.commentKeywords`),
      forbiddenMeanings: ((c.forbiddenMeanings ?? []) as Record<string, unknown>[]).map((f, fi) => ({
        id: str(f.id, `${id}.forbiddenMeanings[${fi}].id`),
        pattern: new RegExp(str(f.pattern, `${id}.forbiddenMeanings[${fi}].pattern`)),
        ...(typeof f.note === 'string' ? { note: f.note } : {}),
      })),
      allowedParaphrases: allowed,
      forbiddenExamples: ((c.forbiddenExamples ?? []) as Record<string, unknown>[]).map((e, ei) => ({
        text: str(e.text, `${id}.forbiddenExamples[${ei}].text`),
        kinds: strList(e.kinds, `${id}.forbiddenExamples[${ei}].kinds`),
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// 語彙
// ---------------------------------------------------------------------------

export interface StructuredEvalLexicon {
  readonly facetMeanings: Readonly<Record<string, readonly RegExp[]>>;
  readonly categoryMeanings: Readonly<Record<string, readonly RegExp[]>>;
  readonly polarityCues: Readonly<Record<Polarity, readonly RegExp[]>>;
  readonly lists: Readonly<Record<
    'intensity' | 'recommendation' | 'revisit' | 'cause' | 'timing' | 'companion' | 'attribute' | 'overlapReason' | 'commentConnective',
    readonly RegExp[]
  >>;
  readonly aiish: Readonly<Record<string, readonly RegExp[]>>;
}

const LIST_KEYS = [
  'intensity',
  'recommendation',
  'revisit',
  'cause',
  'timing',
  'companion',
  'attribute',
  'overlapReason',
  'commentConnective',
] as const;

function regexes(v: unknown, where: string): RegExp[] {
  return strList(v, where).map((s) => new RegExp(s));
}

function regexMap(v: unknown, where: string): Record<string, RegExp[]> {
  if (typeof v !== 'object' || v === null) fail(`${where} はオブジェクト`);
  return Object.fromEntries(Object.entries(v).map(([k, list]) => [k, regexes(list, `${where}.${k}`)]));
}

export function readStructuredEvalLexicon(raw: unknown): StructuredEvalLexicon {
  const r = raw as Record<string, unknown>;
  const cues = regexMap(r.polarityCues, 'polarityCues');
  if (!cues.positive || !cues.concern) fail('polarityCues は positive と concern を持つ');
  const lists = Object.fromEntries(LIST_KEYS.map((k) => [k, regexes(r[k], k)])) as unknown as StructuredEvalLexicon['lists'];
  return {
    facetMeanings: regexMap(r.facetMeanings, 'facetMeanings'),
    categoryMeanings: regexMap(r.categoryMeanings, 'categoryMeanings'),
    polarityCues: { positive: cues.positive, concern: cues.concern },
    lists,
    aiish: regexMap(r.aiish, 'aiish'),
  };
}

/** 既存の検出器の語彙（本番と同じファイル）。 */
export interface LegacyLexicons {
  readonly visit: VisitContextLexicon;
  readonly embellishment: EmbellishmentLexicon;
  readonly absence: AbsenceLexicon;
  readonly grounding: GroundingLexicon;
}

export function readLegacyLexicons(): LegacyLexicons {
  return {
    visit: readVisitContextLexicon(visitLexiconRaw),
    embellishment: readEmbellishmentLexicon(embellishmentLexiconRaw),
    absence: readAbsenceLexicon(absenceLexiconRaw),
    grounding: readGroundingLexicon(groundingLexiconRaw),
  };
}

// ---------------------------------------------------------------------------
// claim（言ってよい意味の最小単位）
// ---------------------------------------------------------------------------

export interface EvalClaim {
  /** 入力の順の連番つきの id（例: `positive:t-sashimi:taste`）。 */
  readonly id: string;
  readonly polarity: Polarity;
  readonly categoryCode: string;
  readonly targetId?: string;
  readonly targetLabel?: string;
  readonly facetCode?: string;
  readonly facetLabel?: string;
}

/**
 * 素材を claim へ分ける（入力の順）。Target だけ → facet の無い claim、Target + facet → facet ごと、
 * カテゴリ全体の facet → Target の無い claim。#439 の compileStructuredClaims の本体ではなく、評価のための写し。
 */
export function claimsOf(c: StructuredEvalCase): EvalClaim[] {
  const claims: EvalClaim[] = [];
  for (const s of c.selections) {
    const base = {
      polarity: s.polarity,
      categoryCode: s.categoryCode,
      ...(s.targetId !== undefined ? { targetId: s.targetId, targetLabel: s.targetLabel! } : {}),
    };
    const subject = s.targetId ?? s.categoryCode;
    if (s.facets.length === 0) claims.push({ ...base, id: `${s.polarity}:${subject}` });
    for (const f of s.facets) claims.push({ ...base, id: `${s.polarity}:${subject}:${f.code}`, facetCode: f.code, facetLabel: f.label });
  }
  return claims;
}

/** 同じ identity（Target・facet、または カテゴリ全体の facet）が両群にある組。 */
export function exactOverlaps(c: StructuredEvalCase): string[] {
  const key = (cl: EvalClaim) => `${cl.targetId ?? cl.categoryCode}:${cl.facetCode ?? ''}`;
  const pos = new Set(claimsOf(c).filter((x) => x.polarity === 'positive').map(key));
  return [...new Set(claimsOf(c).filter((x) => x.polarity === 'concern').map(key))].filter((k) => pos.has(k));
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

/** 失格の種類。`ungrounded:<axis>`・`visitContext:<分類>`・`caseForbidden:<id>` は分類つき。 */
export type HardGateKind = string;

export interface GateFinding {
  readonly kind: HardGateKind;
  readonly evidence: string;
}

export interface ClaimCoverage {
  readonly claimId: string;
  /** その claim の主題を、その極性の文で述べたか（facet の字の有無は問わない）。 */
  readonly covered: boolean;
  /** facet の意味の手がかりまで同じ文にあったか（統合・省略を許すので失格にはしない・診断）。 */
  readonly facetMentioned: boolean;
}

export interface StructuredEvaluation {
  readonly passed: boolean;
  readonly findings: readonly GateFinding[];
  readonly coverage: readonly ClaimCoverage[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 文に分ける（句点・感嘆符・疑問符・改行）。空の文は捨てる。 */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！!？?\n])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function firstMatch(text: string, patterns: readonly RegExp[]): string | null {
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) return m[0];
  }
  return null;
}

function mask(text: string, words: readonly string[]): string {
  let out = text;
  // 長い語から先に消す（「刺身盛り合わせ」を「刺身」より先に）。空白で置き換え、前後の文字を繋げない。
  for (const w of [...new Set(words)].filter((x) => x.trim() !== '').sort((a, b) => b.length - a.length)) {
    out = out.split(w).join(' '.repeat(Math.min(w.length, 1)));
  }
  return out;
}

function subjectWords(c: StructuredEvalCase, targetId: string, label: string): string[] {
  return [label, ...(c.subjects[targetId] ?? [])];
}

function polarityOf(sentence: string, lex: StructuredEvalLexicon): Set<Polarity> {
  const set = new Set<Polarity>();
  for (const p of POLARITIES) if (firstMatch(sentence, lex.polarityCues[p]) !== null) set.add(p);
  return set;
}

/**
 * 下書きを 1 本判定する。findings が空なら合格（hard gate をすべて通った）。
 *
 * 一言に同じ意味があれば、その分類は数えない（既存の検出器と同じ意味論・客が自分で書いたことは素材である）。
 */
export function evaluateStructuredDraft(
  c: StructuredEvalCase,
  draft: string,
  lex: StructuredEvalLexicon,
  legacy: LegacyLexicons,
): StructuredEvaluation {
  const findings: GateFinding[] = [];
  const add = (kind: string, evidence: string) => {
    if (!findings.some((f) => f.kind === kind && f.evidence === evidence)) findings.push({ kind, evidence });
  };
  const comment = c.comment !== undefined && c.comment.trim() !== '' ? c.comment : undefined;
  const inComment = (pattern: RegExp) => comment !== undefined && pattern.test(comment);

  const claims = claimsOf(c);
  const selectedTargets = c.selections.filter((s) => s.targetId !== undefined);
  const targetWords = selectedTargets.flatMap((s) => subjectWords(c, s.targetId!, s.targetLabel!));
  const selectedFacetCodes = new Set(claims.flatMap((cl) => (cl.facetCode ? [cl.facetCode] : [])));
  const selectedCategoryCodes = new Set(c.selections.map((s) => s.categoryCode));

  // 店名は素材そのもの。Target の名前は回答の主題で、属性の語を含みうる（「だし巻き玉子」の「だし」）ので消してから走査する。
  const text = mask(draft, [c.storeName, c.storeName.replace(/\s+/g, '')]);
  // 回答した facet の表示名も客が選んだ語なので消す（「料理・ドリンクの提供」の「ドリンク」を、未回答のカテゴリに数えない）。
  const selectedFacetLabels = claims.flatMap((cl) => (cl.facetLabel ? [cl.facetLabel] : []));
  const scan = mask(text, [...targetWords, ...selectedFacetLabels]);

  // --- 未回答の Target ------------------------------------------------------------
  for (const m of c.menuTargets) {
    for (const w of [m.label, ...m.aliases]) {
      if (scan.includes(w) && !(comment ?? '').includes(w)) {
        add('unselectedTarget', w);
        break;
      }
    }
  }

  // --- 未回答の facet / カテゴリ（回答した facet・カテゴリの手がかりに当たる語は数えない） ----------
  const selectedHint = (word: string) =>
    [...selectedFacetCodes].some((code) => (lex.facetMeanings[code] ?? []).some((p) => p.test(word))) ||
    [...selectedCategoryCodes].some((code) => (lex.categoryMeanings[code] ?? []).some((p) => p.test(word)));
  for (const [code, patterns] of Object.entries(lex.facetMeanings)) {
    if (selectedFacetCodes.has(code)) continue;
    for (const p of patterns) {
      const hit = p.exec(scan);
      if (hit && !selectedHint(hit[0]) && !inComment(p)) {
        add('unselectedFacet', `${code}:${hit[0]}`);
        break;
      }
    }
  }
  for (const [code, patterns] of Object.entries(lex.categoryMeanings)) {
    if (selectedCategoryCodes.has(code)) continue;
    for (const p of patterns) {
      const hit = p.exec(scan);
      if (hit && !selectedHint(hit[0]) && !inComment(p)) {
        add('unselectedCategory', `${code}:${hit[0]}`);
        break;
      }
    }
  }

  // --- 語彙で決まる追加（一言にあれば数えない） ---------------------------------------
  const listGate = (key: keyof StructuredEvalLexicon['lists'], kind: string) => {
    for (const p of lex.lists[key]) {
      const hit = p.exec(scan);
      if (hit && !inComment(p)) {
        add(kind, hit[0]);
        return;
      }
    }
  };
  listGate('intensity', 'intensity');
  listGate('recommendation', 'recommendation');
  listGate('revisit', 'revisit');
  listGate('cause', 'cause');
  listGate('timing', 'timing');
  listGate('companion', 'companion');
  listGate('attribute', 'newAttribute');

  for (const f of c.forbiddenMeanings) {
    const hit = f.pattern.exec(scan);
    if (hit && !inComment(f.pattern)) add(`caseForbidden:${f.id}`, hit[0]);
  }

  // --- 既存の検出器の再利用 ---------------------------------------------------------------
  for (const v of detectVisitContextClaims(scan, comment, legacy.visit)) add(`visitContext:${v.category}`, v.matchedText);
  for (const e of detectEmbellishments(scan, { storeName: c.storeName, ...(comment ? { comment } : {}) }, legacy.embellishment)) {
    if (e.category === 'expectation') add('expectation', e.matchedText);
    else if (e.category === 'intention') add('revisit', e.matchedText);
    else if (attributeAspectOf(e.category) !== undefined) add('newAttribute', e.matchedText);
  }
  for (const a of detectAbsenceAssertions(scan, comment, legacy.absence)) add('absence', a.matchedText);
  // 固有名詞・数値・日付: 回答した Target の名前は素材なので、一言と一緒に照合の素材へ渡す。
  const groundingComment = [comment ?? '', ...targetWords].join(' ');
  for (const g of detectUngroundedClaims(text, { storeName: c.storeName, comment: groundingComment }, legacy.grounding)) {
    add(`ungrounded:${g.axis}`, g.matchedText);
  }

  // --- 文単位: coverage・極性・片側の欠落・Target の欠落・overlap・一言の因果づけ -----------------
  const sentences = splitSentences(text);
  const subjectPatternsOf = (cl: EvalClaim): RegExp[] =>
    cl.targetId !== undefined
      ? subjectWords(c, cl.targetId, cl.targetLabel!).map((w) => new RegExp(escape(w)))
      : [...(lex.facetMeanings[cl.facetCode!] ?? []), new RegExp(escape(cl.facetLabel!))];

  // 主題の引き継ぎ: Target を名指さない文は、直前の文の Target について述べているとみなす（日本語は主題を
  // 省略する。「刺身盛り合わせはおいしかったです。量は気になりました。」の 2 文目は刺身盛り合わせの量）。
  const topics: ReadonlySet<string>[] = [];
  for (const sentence of sentences) {
    const named = new Set(
      selectedTargets
        .filter((s) => subjectWords(c, s.targetId!, s.targetLabel!).some((w) => sentence.includes(w)))
        .map((s) => s.targetId!),
    );
    // 別の claim の主題（カテゴリ全体の facet）を名指す文は、Target を引き継がない（話題が移った）。
    const namesOther = claims.some((cl) => cl.targetId === undefined && firstMatch(sentence, subjectPatternsOf(cl)) !== null);
    topics.push(named.size > 0 ? named : namesOther ? new Set() : (topics[topics.length - 1] ?? new Set()));
  }
  const aboutClaim = (cl: EvalClaim, index: number): boolean => {
    const sentence = sentences[index]!;
    if (cl.targetId !== undefined) return topics[index]!.has(cl.targetId);
    return firstMatch(sentence, subjectPatternsOf(cl)) !== null;
  };

  const coverage: ClaimCoverage[] = claims.map((cl) => {
    const about = sentences.filter((_, i) => aboutClaim(cl, i));
    const covered = about.some((s) => polarityOf(s, lex).has(cl.polarity));
    const facetPatterns = cl.facetCode ? (lex.facetMeanings[cl.facetCode] ?? []) : [];
    const facetMentioned = cl.facetCode === undefined ? covered : about.some((s) => firstMatch(s, facetPatterns) !== null);
    return { claimId: cl.id, covered, facetMentioned };
  });

  for (const p of POLARITIES) {
    const ofP = claims.filter((cl) => cl.polarity === p);
    if (ofP.length > 0 && !ofP.some((cl) => coverage.find((cv) => cv.claimId === cl.id)!.covered)) {
      add(`${p}Dropped`, `${p} の claim が ${ofP.length} 件あるが、どれもその極性で述べていない`);
    }
  }
  for (const s of selectedTargets) {
    const words = subjectWords(c, s.targetId!, s.targetLabel!);
    if (!words.some((w) => draft.includes(w))) add('targetDropped', s.targetLabel!);
  }

  // 極性の反転: 主題（と facet）について述べた文の極性が、回答のどの極性とも重ならない。
  for (const [index, sentence] of sentences.entries()) {
    const sp = polarityOf(sentence, lex);
    if (sp.size === 0) continue;
    for (const cl of claims) {
      if (!aboutClaim(cl, index)) continue;
      const sameSubject = claims.filter((x) => (x.targetId ?? `${x.categoryCode}:${x.facetCode}`) === (cl.targetId ?? `${cl.categoryCode}:${cl.facetCode}`));
      // Target の文で facet の手がかりがあれば、その facet の極性で照らす。無ければ Target 全体の極性で照らす。
      const facetHits = cl.targetId !== undefined
        ? sameSubject.filter((x) => x.facetCode && firstMatch(sentence, lex.facetMeanings[x.facetCode] ?? []) !== null)
        : sameSubject;
      const expected = new Set((facetHits.length > 0 ? facetHits : sameSubject).map((x) => x.polarity));
      if (![...sp].some((p) => expected.has(p))) add('polarityReversal', sentence);
    }
  }
  // Target の文に、回答した facet と逆の極性で別の facet が出た場合（「味も量も良かった」で量が concern）。
  for (const [index, sentence] of sentences.entries()) {
    const sp = polarityOf(sentence, lex);
    if (sp.size !== 1) continue;
    for (const s of selectedTargets) {
      if (!topics[index]!.has(s.targetId!)) continue;
      for (const cl of claims.filter((x) => x.targetId === s.targetId && x.facetCode)) {
        if (firstMatch(sentence, lex.facetMeanings[cl.facetCode!] ?? []) === null) continue;
        const polarities = new Set(claims.filter((x) => x.targetId === s.targetId && x.facetCode === cl.facetCode).map((x) => x.polarity));
        if (![...sp].some((p) => polarities.has(p))) add('polarityReversal', sentence);
      }
    }
  }

  // exact overlap: 両面の共存の理由を作らない（Issue #418）。理由の語は、overlap のケースでだけ数える。
  if (exactOverlaps(c).length > 0) {
    for (const p of lex.lists.overlapReason) {
      const hit = p.exec(scan);
      if (hit && !inComment(p)) {
        add('overlapReason', hit[0]);
        break;
      }
    }
  }

  // 一言の内容を、別の claim の理由として結ぶ（「店員さんが丁寧だったので、刺身もおいしく感じた」）。
  if (comment !== undefined && c.commentKeywords.length > 0) {
    for (const sentence of sentences) {
      const keyword = c.commentKeywords.find((k) => sentence.includes(k));
      if (!keyword) continue;
      const connective = firstMatch(sentence, lex.lists.commentConnective);
      if (!connective) continue;
      // 別の claim の主題（Target の名前、またはカテゴリ全体の facet の手がかり）が同じ文にある。一言そのものを
      // 指す語（一言の言い換え）に当たっただけなら、別の claim とは数えない。
      const otherSubject = claims.some((cl) => {
        if (cl.targetId !== undefined) {
          return subjectWords(c, cl.targetId, cl.targetLabel!).some((w) => sentence.includes(w) && !c.commentKeywords.includes(w));
        }
        const hit = firstMatch(sentence, subjectPatternsOf(cl));
        return hit !== null && !c.commentKeywords.some((k) => k.includes(hit) || hit.includes(k));
      });
      if (otherSubject) add('commentLinkage', sentence);
    }
  }

  return { passed: findings.length === 0, findings, coverage };
}

/** 失格の種類を、分類つきのものは頭の名前へまとめる（集計の表の行）。 */
export function gateFamily(kind: string): string {
  const i = kind.indexOf(':');
  return i < 0 ? kind : kind.slice(0, i);
}
