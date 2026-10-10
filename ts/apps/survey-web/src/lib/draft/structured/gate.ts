import { detectVisitContextClaims, readVisitContextLexicon, type VisitContextLexicon } from '../visit-context';
import { attributeAspectOf, detectEmbellishments, readEmbellishmentLexicon, type EmbellishmentLexicon } from '../embellishment';
import { detectAbsenceAssertions, readAbsenceLexicon, type AbsenceLexicon } from '../absence';
import { detectUngroundedClaims, readGroundingLexicon, type GroundingLexicon } from '../material-grounding';
import visitLexiconRaw from '../visit-context-lexicon.json';
import embellishmentLexiconRaw from '../embellishment-lexicon.json';
import absenceLexiconRaw from '../absence-lexicon.json';
import groundingLexiconRaw from '../material-grounding-lexicon.json';

// structured survey の下書きの hard gate と coverage（Issue #440 で評価のために作り、Issue #439 で本番の事後検証へ移した）。
// 実 API を呼ばない純関数。**本番（Natural LLM Realizer の作り直しと generation error の判断）と評価（eval/structured）は
// 同じこの判定を使う。** 物差しを 2 つに分けると、評価で緑の方式が本番では別の基準で通ることになる。
//
// 「自然でも、これが起きたら失格」を決定的に判定する。既存の検出器（来店の経緯・期待と再訪・属性・断定・
// 固有名詞と数値と日付）はそのまま再利用し、structured 固有の検査（Target / facet の同一性・極性・片側の欠落・
// 未回答の追加・exact overlap の理由・一言の因果づけ・強度・推奨）をここで足す。
//
// 止めるのは **具体的な創作**（未回答の Target / facet・数字・原因・来店の文脈・人物の様子・観測していない属性・
// 強い強度・推奨・再訪・exact overlap の理由・一言の因果づけ）である。回答から自然に導ける弱い主観（「少し」「やや」
// 「満足できた」「印象に残った」「過ごしやすかった」）と意味を保った言い換えは、自然な口コミの言い方として通す
// （controlled inference）。自然な文章まで過剰に弾くと、作り直しと safe fallback が増えて読み上げの文章へ戻る。
//
// 判定は既存と同じく **高 precision** に倒す（検出したものは確実に違反・測るのは下限）。coverage は文字列一致では
// なく、Target の言い方（subjects）と語彙の意味の手がかり（facetMeanings・polarityCues）で文単位に判定する。
// 例: 「刺身盛り合わせ / 味 / positive」は「刺身盛り合わせがおいしかったです」で満たす（「味」の字は要らない）。
//
// 責務の境界（本番の runtime hard gate と、最終 PR 前の offline eval gate）:
//   runtime hard gate … この関数そのもの。高 precision に検出できるものを本番で自動的に止める（作り直し → generation error）。
//     本番の入力が持つのは、回答の素材・一言・回答時点の定義の未回答の Target の名前（完全一致）である。
//   offline eval gate … 同じ関数を、固定ケースの追加の知識（Target の言い換え・一言の内容の語・ケース固有の禁止の
//     意味）つきで流す（eval/structured）。runtime より広く拾う。さらに、語彙で決まらないもの（主題を省いた因果・
//     言い換えた未回答の Target・語彙に無い属性や強度）はブラインドの人手評価で測る。
// **runtime hard gate を通った = 事実どおりの保証ではない。** 語彙の判定は違反の下限である。

// ---------------------------------------------------------------------------
// 判定の入力（回答受付が作る素材と、評価の固定ケースの共通部分）
// ---------------------------------------------------------------------------

export type Polarity = 'positive' | 'concern';

export interface GateFacet {
  readonly code: string;
  readonly label: string;
}

/** 回答受付が作る素材（resolveStructuredAnswer の selections）と同じ形。 */
export interface GateSelection {
  readonly polarity: Polarity;
  readonly categoryCode: string;
  readonly categoryLabel: string;
  readonly targetId?: string;
  readonly targetLabel?: string;
  readonly facets: readonly GateFacet[];
}

/**
 * 店舗に登録済みだが客が選ばなかった Target。本番は回答の検証に使った同じ定義の active な Target から作り
 * （素材の unselectedTargets・LLM へは渡さない）、評価は固定ケースが持つ。aliases は評価の固定ケースだけが持つ。
 */
export interface GateMenuTarget {
  readonly id: string;
  readonly label: string;
  readonly categoryCode: string;
  readonly aliases: readonly string[];
}

/**
 * 判定の入力。本番（Natural LLM Realizer の事後検証）は素材から作り、menuTargets は素材の unselectedTargets から、
 * subjects・commentKeywords・forbiddenMeanings は空で渡す。評価の固定ケース（eval/structured/cases.json）はこれらも持つ。
 */
export interface StructuredGateInput {
  readonly storeName: string;
  readonly comment?: string;
  readonly selections: readonly GateSelection[];
  /** Target を指す言い方（Target の名前そのものは常に含む）。 */
  readonly subjects: Readonly<Record<string, readonly string[]>>;
  readonly menuTargets: readonly GateMenuTarget[];
  /** 一言の内容を指す語（固定ケースだけが持つ）。判定は一言から取り出した語（commentContentWords）を常に足す。 */
  readonly commentKeywords: readonly string[];
  readonly forbiddenMeanings: readonly { readonly id: string; readonly pattern: RegExp; readonly note?: string }[];
}

const POLARITIES: readonly Polarity[] = ['positive', 'concern'];

function fail(message: string): never {
  throw new Error(`structured gate lexicon: ${message}`);
}

function str(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.trim() === '') fail(`${where} は空でない文字列である必要があります`);
  return v;
}

function strList(v: unknown, where: string): string[] {
  if (!Array.isArray(v)) fail(`${where} は配列である必要があります`);
  return v.map((x, i) => str(x, `${where}[${i}]`));
}

// 語彙
// ---------------------------------------------------------------------------

export interface StructuredGateLexicon {
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

export function readStructuredGateLexicon(raw: unknown): StructuredGateLexicon {
  const r = raw as Record<string, unknown>;
  const cues = regexMap(r.polarityCues, 'polarityCues');
  if (!cues.positive || !cues.concern) fail('polarityCues は positive と concern を持つ');
  const lists = Object.fromEntries(LIST_KEYS.map((k) => [k, regexes(r[k], k)])) as unknown as StructuredGateLexicon['lists'];
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

export interface GateClaim {
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
 * カテゴリ全体の facet → Target の無い claim。Issue #439 の compileStructuredClaims の本体ではなく、評価のための写し。
 */
export function claimsOf(c: StructuredGateInput): GateClaim[] {
  const claims: GateClaim[] = [];
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
export function exactOverlaps(c: StructuredGateInput): string[] {
  const key = (cl: GateClaim) => `${cl.targetId ?? cl.categoryCode}:${cl.facetCode ?? ''}`;
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

const nfkc = (s: string) => s.normalize('NFKC');

/** 全体の印象を述べる文の印（個別の料理・項目の話ではない）。 */
const OVERALL = /全体|総じて|トータル|総合的/;

/**
 * 表示名の照合の形（NFKC・名前の中の空白の有無を問わない）。**完全一致の範囲だけ** を見て、言い換え
 * （「刺身盛り合わせ」→「刺し盛り」）は推測しない。1 文字の名前は普通名詞の一部に当たりやすいので照合しない。
 */
function labelPattern(label: string): RegExp | null {
  const parts = nfkc(label).trim().split(/\s+/).filter((p) => p !== '');
  if (parts.join('').length < 2) return null;
  return new RegExp(parts.map(escape).join('\\s*'));
}

/**
 * 一言から内容の語を取り出す（漢字・カタカナ・英数字の 2 文字以上の連なり）。形態素解析はしない。
 * 一言の因果づけ（commentLinkage）の判定に使う。本番は素材の一言から、評価は固定ケースの語に足して使う。
 */
export function commentContentWords(comment: string): string[] {
  return [...new Set(nfkc(comment).match(/[\p{Script=Han}\p{Script=Katakana}ー々A-Za-z0-9]{2,}/gu) ?? [])];
}

/** パターンのどれかが最後に当たった位置（理由を表す接続の、文の中で最も後ろのもの）。 */
function lastMatchIndex(text: string, patterns: readonly RegExp[]): number {
  let last = -1;
  for (const p of patterns) {
    for (const m of text.matchAll(new RegExp(p.source, p.flags.includes('g') ? p.flags : `${p.flags}g`))) {
      if (m.index > last) last = m.index;
    }
  }
  return last;
}

function subjectWords(c: StructuredGateInput, targetId: string, label: string): string[] {
  return [label, ...(c.subjects[targetId] ?? [])];
}

function polarityOf(sentence: string, lex: StructuredGateLexicon): Set<Polarity> {
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
  c: StructuredGateInput,
  draft: string,
  lex: StructuredGateLexicon,
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

  // --- 未回答の Target（店舗の active な Target のうち、客が選ばなかったもの） ----------------------
  // 名前（と固定ケースの言い方）の完全一致だけを見る。選んだ Target の名前に含まれる名前（選んだ「刺身盛り合わせ」と
  // 未回答の「刺身」）は、選んだ名前を消してから探す。一言に書かれた名前は客の素材なので数えない。
  const selectedNames = targetWords.map(nfkc);
  const textN = nfkc(text);
  const withoutSelected = mask(textN, selectedNames);
  const commentN = nfkc(comment ?? '');
  for (const m of c.menuTargets) {
    if (selectedTargets.some((s) => s.targetId === m.id)) continue;
    for (const w of [m.label, ...m.aliases]) {
      const p = labelPattern(w);
      if (p === null) continue;
      const haystack = selectedNames.some((t) => p.test(t)) ? withoutSelected : textN;
      if (p.test(haystack) && !p.test(commentN)) {
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
  const listGate = (key: keyof StructuredGateLexicon['lists'], kind: string) => {
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
  const subjectPatternsOf = (cl: GateClaim): RegExp[] =>
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
    // 別の claim の主題（カテゴリ全体の facet）を名指す文と、全体の印象を述べる文（「全体としては満足でした」・
    // 星から許す抽象的な満足）は、Target を引き継がない（話題が移った）。
    const namesOther =
      OVERALL.test(sentence) || claims.some((cl) => cl.targetId === undefined && firstMatch(sentence, subjectPatternsOf(cl)) !== null);
    topics.push(named.size > 0 ? named : namesOther ? new Set() : (topics[topics.length - 1] ?? new Set()));
  }
  const aboutClaim = (cl: GateClaim, index: number): boolean => {
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

  // exact overlap: 両面の共存の理由を作らない（Issue #418）。理由の語は、overlap のケースの **overlap の主題を述べた文**
  // （と、その直後の主題を名指さない文）でだけ数える。下書き全体で数えると、overlap と関係の無い文の「〜によって」
  // 「〜ものの」まで理由と数え、自然な下書きが作り直し → safe fallback へ落ちた（実 Gemini・2026-10-11）。
  const overlapKeys = new Set(exactOverlaps(c));
  const overlapClaims = claims.filter((cl) => overlapKeys.has(`${cl.targetId ?? cl.categoryCode}:${cl.facetCode ?? ''}`));
  if (overlapClaims.length > 0) {
    const aboutAny = (i: number) => claims.some((cl) => aboutClaim(cl, i));
    const aboutOverlap = (i: number) => overlapClaims.some((cl) => aboutClaim(cl, i));
    const scoped = sentences.filter((_, i) => aboutOverlap(i) || (i > 0 && aboutOverlap(i - 1) && !aboutAny(i)));
    const scopedScan = mask(scoped.join(''), [...targetWords, ...selectedFacetLabels]);
    for (const p of lex.lists.overlapReason) {
      const hit = p.exec(scopedScan);
      if (hit && !inComment(p)) {
        add('overlapReason', hit[0]);
        break;
      }
    }
  }

  // 一言の内容を、別の claim の理由として結ぶ（「店員さんが丁寧だったので、刺身もおいしく感じた」「窓側の席だったので
  // 居心地が良かった」）。拾うのは次の 3 つが揃った文だけである（高 precision・同じ文に並べるだけなら数えない）:
  //   1. 一言の語（固定ケースの語 ＋ 一言から取り出した語。選んだ Target の名前と重なる語は除く）が、
  //   2. 理由を表す接続（commentConnective）より **前**（理由の側）にあり、
  //   3. 同じ文に別の claim の主題（Target の名前・カテゴリ全体の facet の手がかり）がある。
  // 一言そのものが理由を述べている（一言に接続がある）なら、客が自分で書いた因果なので数えない。
  // 主題を省いた文（「窓側の席だったので、おいしく感じました」）は拾えない（評価の人手の読みで測る）。
  if (comment !== undefined && firstMatch(nfkc(comment), lex.lists.commentConnective) === null) {
    const keywords = [...new Set([...c.commentKeywords, ...commentContentWords(comment)].map(nfkc))].filter(
      (k) => !selectedNames.some((t) => t.includes(k) || k.includes(t)),
    );
    const overlapsKeyword = (w: string) => keywords.some((k) => k.includes(w) || w.includes(k));
    for (const sentence of sentences) {
      const s = nfkc(sentence);
      const at = lastMatchIndex(s, lex.lists.commentConnective);
      if (at < 0) continue;
      const cause = mask(s.slice(0, at), selectedNames);
      if (!keywords.some((k) => cause.includes(k))) continue;
      const otherSubject = claims.some((cl) => {
        if (cl.targetId !== undefined) return subjectWords(c, cl.targetId, cl.targetLabel!).some((w) => s.includes(nfkc(w)));
        const hit = firstMatch(s, subjectPatternsOf(cl));
        return hit !== null && !overlapsKeyword(hit);
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
