import { STAR_NARRATION } from '../../src/lib/draft/material-grounding';
import { compileStructuredClaims } from '../../src/lib/draft/structured/claims';
import { structuredFallbackDraft } from '../../src/lib/draft/structured/fallback';
import { claimsOf, splitSentences, type StructuredEvalCase, type StructuredEvalLexicon } from './gates';

// 自然さの自動診断（Issue #440）。**個々の下書きの合否ではない。** 特定の語を禁止するためではなく、通常生成が定型へ
// 寄りすぎていないか（アンケートの読み上げ・safe fallback 風の文・まとめの定型句・締めの定型）を傾向として観察する
// 数値である。release の目安は率で置く（eval/README.md の「成功条件」）。自然さの主評価は人手の採点（rating.ts）で行う。

export interface DraftDiagnostics {
  readonly charCount: number;
  readonly sentenceCount: number;
  readonly claimCount: number;
  /** 1 claim あたりの字数。薄い素材ほど不自然に長い状態（字数を埋めるための膨らみ）を見る。 */
  readonly charsPerClaim: number;
  /** 語彙の aiish の各分類が出たか（全体として・一方で・好印象・満足度・という印象・良かったです）。 */
  readonly phrases: Readonly<Record<string, boolean>>;
  /** 「良かったです」の出現回数（2 以上で反復）。 */
  readonly yokattadesuCount: number;
  /** 同じ語尾（文末 3 字）の最長の連続。 */
  readonly maxSameEndingRun: number;
  readonly startsWithStoreName: boolean;
  readonly endsWithRevisit: boolean;
  readonly endsWithRecommendation: boolean;
  /** 星の数を読み上げたか（「星5」「評価は5点」）。 */
  readonly starNarration: boolean;
  /**
   * 主題（極性 × Target / カテゴリ全体の facet）を入力の順に、1 文 1 主題で並べたか（3 主題以上・チェックリストの
   * 読み上げ）。同じ料理の味と見た目を 1 文にまとめるのは自然な統合なので、claim ではなく主題で数える。
   */
  readonly checklistLike: boolean;
  /** claim を主題（極性 × Target / カテゴリ全体の facet）にまとめた数。 */
  readonly subjectCount: number;
  /** 3 主題以上を、順番を問わず 1 文 1 主題で並べたか（checklistLike の順番を問わない版・読み上げの傾向）。 */
  readonly subjectPerSentence: boolean;
  /**
   * safe fallback 風か: safe fallback と同じ文、または 2 文以上がすべて「〜良かったです。」「〜気になりました。」で
   * 終わる（通常生成がこの形へ寄ったら、自然さの方針が効いていない）。
   */
  readonly fallbackLike: boolean;
  /** 3 字以上の項目名（「入店までの待ち時間」「接客の丁寧さ」など）を、項目名のまま書いた割合（読み上げの傾向）。 */
  readonly labelVerbatimRate: number | null;
  /** 星由来の総評を渡しうるケース（★3 以外）か。総評の句の頻度の母数。 */
  readonly starSignal: boolean;
  /** 総評の句（「全体として」「全体的に」「総じて」）があるか。単体では合格で、頻度だけを見る。 */
  readonly overallClosing: boolean;
  /** 「満足できる内容」「満足できるもの」「良い内容」のような抽象語でまとめる言い方があるか。 */
  readonly abstractEvaluation: boolean;
  /** 気になったことが 2 主題以上あるのに「〜だけ」で 1 つに絞って書いたか。 */
  readonly dakeWithMultipleConcerns: boolean;
  /** 書き出しの 2 字（同じケースの再生成で文頭が同じかを見る・「予約が」「予約は」を同じと数える）。 */
  readonly opening: string;
  /** 主題（極性 × Target / カテゴリ全体の facet）を本文で最初に述べた順。 */
  readonly subjectOrder: readonly string[];
  /** 文ごとに述べた主題の並び（文の分け方・まとめ方の粗い形）。 */
  readonly structure: string;
  /** claim の最初の言及の順が入力の順と一致した割合（2 claim 以上のとき・言及した claim だけで見る）。 */
  readonly inputOrderPreserved: boolean | null;
  /** 一言より感嘆符・絵文字が増えたか（一言のあるケースだけ）。 */
  readonly exclamationAdded: boolean | null;
}

const EMOJI = /\p{Extended_Pictographic}/gu;
const EXCLAMATION = /[!！]/g;

function count(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

function ending(sentence: string): string {
  return sentence.replace(/[。！!？?\s]+$/u, '').slice(-3);
}

/** claim ごとに、最初に述べた文の位置（述べていなければ null）。主題は Target の名前か facet の手がかりで見る。 */
function firstMentions(c: StructuredEvalCase, sentences: readonly string[], lex: StructuredEvalLexicon): (number | null)[] {
  return claimsOf(c).map((cl) => {
    const words =
      cl.targetId !== undefined ? [cl.targetLabel!, ...(c.subjects[cl.targetId] ?? [])] : [];
    const facet = cl.facetCode ? (lex.facetMeanings[cl.facetCode] ?? []) : [];
    const index = sentences.findIndex((s) =>
      cl.targetId !== undefined
        ? words.some((w) => s.includes(w)) && (facet.length === 0 || facet.some((p) => p.test(s)))
        : facet.some((p) => p.test(s)),
    );
    return index < 0 ? null : index;
  });
}

function subjectKeyOf(cl: ReturnType<typeof claimsOf>[number]): string {
  return `${cl.polarity}:${cl.targetId ?? `${cl.categoryCode}:${cl.facetCode}`}`;
}

/** 主題を述べた位置（本文の文字位置）。Target は名前か言い方、カテゴリ全体の facet は意味の手がかりで見る。 */
function subjectPositions(c: StructuredEvalCase, text: string, lex: StructuredEvalLexicon): Map<string, number> {
  const out = new Map<string, number>();
  for (const cl of claimsOf(c)) {
    const patterns =
      cl.targetId !== undefined
        ? [cl.targetLabel!, ...(c.subjects[cl.targetId] ?? [])].map((w) => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        : (lex.facetMeanings[cl.facetCode!] ?? []);
    const hits = patterns.map((p) => p.exec(text)?.index ?? -1).filter((i) => i >= 0);
    if (hits.length === 0) continue;
    const key = subjectKeyOf(cl);
    out.set(key, Math.min(out.get(key) ?? Infinity, ...hits));
  }
  return out;
}

export function diagnoseDraft(c: StructuredEvalCase, draft: string, lex: StructuredEvalLexicon): DraftDiagnostics {
  const sentences = splitSentences(draft);
  const claimCount = claimsOf(c).length;
  const charCount = [...draft.replace(/\s+/g, '')].length;
  const phrases = Object.fromEntries(
    Object.entries(lex.aiish).map(([k, patterns]) => [k, patterns.some((p) => p.test(draft))]),
  );
  let maxRun = 0;
  let run = 0;
  let prev = '';
  for (const s of sentences) {
    const e = ending(s);
    run = e !== '' && e === prev ? run + 1 : 1;
    prev = e;
    maxRun = Math.max(maxRun, run);
  }
  const last = sentences[sentences.length - 1] ?? '';
  const mentions = firstMentions(c, sentences, lex);
  const mentioned = mentions.filter((m): m is number => m !== null);
  const inOrder = mentioned.every((m, i) => i === 0 || m >= mentioned[i - 1]!);
  // 主題ごとの最初の言及（同じ主題の claim のうち最も早い文）。
  const subjectFirst = new Map<string, number | null>();
  claimsOf(c).forEach((cl, i) => {
    const key = `${cl.polarity}:${cl.targetId ?? `${cl.categoryCode}:${cl.facetCode}`}`;
    const m = mentions[i] ?? null;
    const prev = subjectFirst.has(key) ? subjectFirst.get(key)! : undefined;
    subjectFirst.set(key, prev === undefined ? m : prev === null || m === null ? (prev ?? m) : Math.min(prev, m));
  });
  const subjectMentions = [...subjectFirst.values()];
  const subjectIdx = subjectMentions.filter((m): m is number => m !== null);
  const checklistLike =
    subjectMentions.length >= 3 &&
    subjectIdx.length === subjectMentions.length &&
    new Set(subjectIdx).size === subjectIdx.length &&
    subjectIdx.every((m, i) => i === 0 || m > subjectIdx[i - 1]!);
  const subjectPerSentence =
    subjectMentions.length >= 3 && subjectIdx.length === subjectMentions.length && new Set(subjectIdx).size === subjectIdx.length;
  const fallbackText = structuredFallbackDraft(compileStructuredClaims(c.selections));
  const fallbackLike =
    draft.trim() === fallbackText ||
    (sentences.length >= 2 && sentences.every((s) => /(?:良かったです|気になりました|気になるところもありました|両方がありました)[。！!]?$/u.test(s)));
  const longLabels = [
    ...new Set(claimsOf(c).flatMap((cl) => (cl.facetLabel !== undefined && [...cl.facetLabel].length >= 3 ? [cl.facetLabel] : []))),
  ];
  const labelVerbatimRate = longLabels.length === 0 ? null : longLabels.filter((l) => draft.includes(l)).length / longLabels.length;
  const positions = subjectPositions(c, draft, lex);
  const subjectOrder = [...positions.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k);
  const structure = sentences
    .map((s) => [...subjectPositions(c, s, lex).keys()].sort().join('+') || '-')
    .join('|');
  const concernSubjects = new Set(claimsOf(c).filter((cl) => cl.polarity === 'concern').map(subjectKeyOf));
  const comment = c.comment ?? null;
  return {
    charCount,
    sentenceCount: sentences.length,
    claimCount,
    charsPerClaim: claimCount === 0 ? charCount : charCount / claimCount,
    phrases,
    yokattadesuCount: count(draft, /良かったです|よかったです/g),
    maxSameEndingRun: maxRun,
    startsWithStoreName: draft.trimStart().startsWith(c.storeName) || draft.trimStart().startsWith(c.storeName.replace(/\s+/g, '')),
    endsWithRevisit: lex.lists.revisit.some((p) => p.test(last)),
    endsWithRecommendation: lex.lists.recommendation.some((p) => p.test(last)),
    starNarration: STAR_NARRATION.test(draft),
    checklistLike,
    subjectCount: subjectMentions.length,
    subjectPerSentence,
    fallbackLike,
    labelVerbatimRate,
    starSignal: c.star !== 3,
    overallClosing: (lex.aiish.zentai ?? []).some((p) => p.test(draft)),
    abstractEvaluation: (lex.aiish.naiyou ?? []).some((p) => p.test(draft)),
    dakeWithMultipleConcerns: concernSubjects.size >= 2 && /だけ/.test(draft),
    opening: [...draft.trim()].slice(0, 2).join(''),
    subjectOrder,
    structure,
    inputOrderPreserved: mentioned.length >= 2 ? inOrder : null,
    exclamationAdded:
      comment === null
        ? null
        : count(draft, EXCLAMATION) + count(draft, EMOJI) > count(comment, EXCLAMATION) + count(comment, EMOJI),
  };
}

// ---------------------------------------------------------------------------
// 再生成の類似度
// ---------------------------------------------------------------------------

function bigrams(text: string): Set<string> {
  const chars = [...text.replace(/[\s。、！!？?]/g, '')];
  const set = new Set<string>();
  for (let i = 0; i < chars.length - 1; i++) set.add(chars[i]! + chars[i + 1]!);
  return set;
}

/** 文字 bigram の Jaccard 係数（0〜1）。完全一致は 1。 */
export function bigramJaccard(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.size === 0 && y.size === 0) return 1;
  let inter = 0;
  for (const g of x) if (y.has(g)) inter++;
  return inter / (x.size + y.size - inter);
}

export interface RegenerationSimilarity {
  readonly pairs: number;
  readonly exactDuplicatePairs: number;
  readonly meanJaccard: number | null;
  /** 店名と語尾を除いても同じ（語尾だけ変えた「多様」を多様と数えない）。 */
  readonly sameExceptEndingPairs: number;
}

/** 同じ入力・同じ方式から再生成した下書きどうしの類似度。 */
export function regenerationSimilarity(drafts: readonly string[], storeName: string): RegenerationSimilarity {
  const strip = (d: string) =>
    splitSentences(d.split(storeName).join(''))
      .map((s) => s.replace(/(です|でした|ます|ました|だ|だった)?[。！!？?]*$/u, ''))
      .join('|');
  let pairs = 0;
  let exact = 0;
  let sameExceptEnding = 0;
  let sum = 0;
  for (let i = 0; i < drafts.length; i++) {
    for (let j = i + 1; j < drafts.length; j++) {
      pairs++;
      if (drafts[i] === drafts[j]) exact++;
      if (strip(drafts[i]!) === strip(drafts[j]!)) sameExceptEnding++;
      sum += bigramJaccard(drafts[i]!, drafts[j]!);
    }
  }
  return { pairs, exactDuplicatePairs: exact, meanJaccard: pairs === 0 ? null : sum / pairs, sameExceptEndingPairs: sameExceptEnding };
}

// ---------------------------------------------------------------------------
// 再生成の構成の偏り（同じケースの複数の生成が、語尾違いだけになっていないか）
// ---------------------------------------------------------------------------

export interface StructureSameness {
  /** 2 本以上の生成があったケースの数（母数）。 */
  readonly cases: number;
  /** すべての生成で、書き出しの 2 字が同じだったケースの数。 */
  readonly sameOpening: number;
  /** すべての生成で、主題を述べた順が同じだったケースの数。 */
  readonly sameClaimOrder: number;
  /** すべての生成で、文の数が同じだったケースの数。 */
  readonly sameSentenceCount: number;
  /** すべての生成で、文ごとの主題の並び（文の分け方・まとめ方）が同じだったケースの数。 */
  readonly sameStructure: number;
}

/** ケースごとの生成の診断（同じケース・2 本以上）から、構成の偏りを数える。厳密な解析ではない簡単な目安。 */
export function structureSameness(byCase: readonly (readonly DraftDiagnostics[])[]): StructureSameness {
  const groups = byCase.filter((list) => list.length >= 2);
  const all = (list: readonly DraftDiagnostics[], f: (d: DraftDiagnostics) => string | number) =>
    new Set(list.map((d) => String(f(d)))).size === 1;
  return {
    cases: groups.length,
    sameOpening: groups.filter((l) => all(l, (d) => d.opening)).length,
    sameClaimOrder: groups.filter((l) => all(l, (d) => d.subjectOrder.join('>'))).length,
    sameSentenceCount: groups.filter((l) => all(l, (d) => d.sentenceCount)).length,
    sameStructure: groups.filter((l) => all(l, (d) => d.structure)).length,
  };
}

// ---------------------------------------------------------------------------
// 集計
// ---------------------------------------------------------------------------

export interface DiagnosticsSummary {
  readonly n: number;
  /** 各句・各定型の出現率（0〜1）。 */
  readonly rates: Readonly<Record<string, number>>;
  readonly meanChars: number;
  readonly meanSentences: number;
  readonly maxChars: number;
  /** 1 claim あたりの字数の平均（必要以上に長くないか）。 */
  readonly meanCharsPerClaim: number;
  /** claim の数ごとの平均字数（薄い素材ほど長い状態を見る）。 */
  readonly charsByClaimCount: Readonly<Record<string, number>>;
}

export function summarizeDiagnostics(list: readonly DraftDiagnostics[]): DiagnosticsSummary {
  const n = list.length;
  const rate = (pred: (d: DraftDiagnostics) => boolean) => (n === 0 ? 0 : list.filter(pred).length / n);
  const phraseKeys = n === 0 ? [] : Object.keys(list[0]!.phrases);
  const rates: Record<string, number> = {};
  for (const k of phraseKeys) rates[k] = rate((d) => d.phrases[k] === true);
  rates.yokattadesuRepeated = rate((d) => d.yokattadesuCount >= 2);
  rates.sameEndingRun3 = rate((d) => d.maxSameEndingRun >= 3);
  rates.startsWithStoreName = rate((d) => d.startsWithStoreName);
  rates.endsWithRevisit = rate((d) => d.endsWithRevisit);
  rates.endsWithRecommendation = rate((d) => d.endsWithRecommendation);
  rates.starNarration = rate((d) => d.starNarration);
  rates.checklistLike = rate((d) => d.checklistLike);
  rates.subjectPerSentence = rate((d) => d.subjectPerSentence);
  rates.abstractEvaluation = rate((d) => d.abstractEvaluation);
  rates.dakeWithMultipleConcerns = rate((d) => d.dakeWithMultipleConcerns);
  const starred = list.filter((d) => d.starSignal);
  rates.overallClosingStarred = starred.length === 0 ? 0 : starred.filter((d) => d.overallClosing).length / starred.length;
  rates.fallbackLike = rate((d) => d.fallbackLike);
  const labelled = list.filter((d) => d.labelVerbatimRate !== null);
  rates.labelVerbatim = labelled.length === 0 ? 0 : labelled.reduce((a, d) => a + d.labelVerbatimRate!, 0) / labelled.length;
  const ordered = list.filter((d) => d.inputOrderPreserved !== null);
  rates.inputOrderPreserved = ordered.length === 0 ? 0 : ordered.filter((d) => d.inputOrderPreserved).length / ordered.length;
  const commented = list.filter((d) => d.exclamationAdded !== null);
  rates.exclamationAdded = commented.length === 0 ? 0 : commented.filter((d) => d.exclamationAdded).length / commented.length;
  const byClaims = new Map<number, number[]>();
  for (const d of list) byClaims.set(d.claimCount, [...(byClaims.get(d.claimCount) ?? []), d.charCount]);
  const mean = (xs: readonly number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
  return {
    n,
    rates,
    meanChars: mean(list.map((d) => d.charCount)),
    meanSentences: mean(list.map((d) => d.sentenceCount)),
    maxChars: list.reduce((m, d) => Math.max(m, d.charCount), 0),
    meanCharsPerClaim: mean(list.map((d) => d.charsPerClaim)),
    charsByClaimCount: Object.fromEntries([...byClaims.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), mean(v)])),
  };
}
