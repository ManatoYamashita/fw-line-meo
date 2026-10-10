import { STAR_NARRATION } from '../../src/lib/draft/material-grounding';
import { claimsOf, splitSentences, type StructuredEvalCase, type StructuredEvalLexicon } from './gates';

// 「AI っぽさ」の自動診断（Issue #440）。**合否の判定ではない。** 特定の語を禁止するためではなく、生成方式が定型へ
// 寄りすぎていないか（アンケートの読み上げ・まとめの定型句・締めの定型）を傾向として観察するための数値である。
// 自然さの主評価はブラインドの人手比較（blind.ts）で行う。

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
// 集計
// ---------------------------------------------------------------------------

export interface DiagnosticsSummary {
  readonly n: number;
  /** 各句・各定型の出現率（0〜1）。 */
  readonly rates: Readonly<Record<string, number>>;
  readonly meanChars: number;
  readonly meanSentences: number;
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
    charsByClaimCount: Object.fromEntries([...byClaims.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), mean(v)])),
  };
}
