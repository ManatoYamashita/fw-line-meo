// ブラインドの人手評価の出力と集計（Issue #440）。
//
// 自然さ・AI っぽさ・投稿しやすさ・内容の忠実さは、AI detector を正解にせず、**生成方式名を隠した**候補を人が
// 読んで比べる。ここは実 API を呼ばない純関数だけを持つ。
//   - buildBlindPacket: ケースごとに方式の候補をシード付きの乱数で並べ替え、「候補A/B/C」として出す。
//     対応表（key）は別のファイルへ分け、評価者には見せない
//   - 評価表（CSV）: 1〜5 の 4 観点と、2 候補の比較（どちらを自分の口コミとして使いたいか）
//   - aggregateRatings / aggregatePairwise: 記入済みの表と key から方式ごとの平均・勝率を出す
// **評価者の名前などの個人情報をリポジトリへ入れない。** 評価者は `R1` のような符号だけで記録する。
// 出力（候補の本文・記入済みの表）はリポジトリ外（EVAL_OUT の隣）へ置く。

export interface BlindSample {
  readonly caseId: string;
  readonly caseTitle: string;
  readonly method: string;
  readonly run: number;
  readonly draft: string;
}

export interface BlindPacket {
  /** 評価者に渡す本文（方式名を含まない）。 */
  readonly sheet: string;
  /** ケース → 候補の記号 → 方式名。評価者に渡さない。 */
  readonly key: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** 1〜5 の採点の記入用 CSV（ヘッダと空欄の行）。 */
  readonly ratingsTemplate: string;
  /** 2 候補の比較の記入用 CSV。 */
  readonly pairwiseTemplate: string;
}

export const RATING_METRICS = ['naturalness', 'ai_likeness', 'postability', 'fidelity'] as const;
export type RatingMetric = (typeof RATING_METRICS)[number];

const METRIC_LABELS: Readonly<Record<RatingMetric, string>> = {
  naturalness: '自然さ（実際の利用者が自分で書いた文章として違和感が少ないか）',
  ai_likeness: 'AIっぽさ（整いすぎ・定型的・アンケート読み上げ的に感じるか。5 が最も AI っぽい）',
  postability: '投稿しやすさ（ほぼそのまま投稿してよいと思えるか）',
  fidelity: '内容の忠実さ（与えられた回答から意味がずれていないか）',
};

/** シード付きの乱数（mulberry32）。同じシードからは同じ並びになる（評価の手順を再現できる）。 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * 方式名を隠した評価の束を作る。ケースごとに、各方式から 1 本（`run` が最小のもの）を選び、シード付きで並べる。
 * 候補の本文が同じ方式の印（「方式:」など）を含まないことは呼び手の責務ではなく、ここでは本文をそのまま出す。
 */
export function buildBlindPacket(
  samples: readonly BlindSample[],
  options: { readonly seed: number; readonly caseContext?: Readonly<Record<string, string>> },
): BlindPacket {
  const random = seededRandom(options.seed);
  const byCase = new Map<string, BlindSample[]>();
  for (const s of samples) byCase.set(s.caseId, [...(byCase.get(s.caseId) ?? []), s]);
  const key: Record<string, Record<string, string>> = {};
  const lines: string[] = [
    '# 口コミ下書きのブラインド評価',
    '',
    '同じ回答から作った下書きの候補を並べています。どの方法で作ったかは伏せてあります。',
    '各候補を次の 4 観点で 1〜5 で採点し、`ratings.csv` に記入してください（評価者は R1 などの符号で記録し、名前は書かないでください）。',
    '',
    ...RATING_METRICS.map((m) => `- ${m}: ${METRIC_LABELS[m]}`),
    '',
    '2 候補の比較は `pairwise.csv` の choice に「どちらを自分の口コミとして使いたいか」を候補の記号（例: A）か「同等」で記入してください。',
    '',
  ];
  const ratingRows: string[] = [];
  const pairRows: string[] = [];
  let caseIndex = 0;
  for (const [caseId, list] of [...byCase.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    caseIndex++;
    const one = new Map<string, BlindSample>();
    for (const s of [...list].sort((a, b) => a.run - b.run)) if (!one.has(s.method)) one.set(s.method, s);
    const ordered = seededShuffle([...one.values()].sort((a, b) => a.method.localeCompare(b.method)), random);
    key[caseId] = {};
    lines.push(`## Case ${String(caseIndex).padStart(2, '0')}（${caseId}）`, '');
    if (options.caseContext?.[caseId]) lines.push(`回答: ${options.caseContext[caseId]}`, '');
    ordered.forEach((s, i) => {
      const letter = LETTERS[i]!;
      key[caseId]![letter] = s.method;
      lines.push(`### 候補${letter}`, '', s.draft, '');
      ratingRows.push(`${caseId},${letter},,,,,`);
    });
    const letters = ordered.map((_, i) => LETTERS[i]!);
    for (let i = 0; i < letters.length; i++) {
      for (let j = i + 1; j < letters.length; j++) pairRows.push(`${caseId},${letters[i]},${letters[j]},,`);
    }
  }
  return {
    sheet: lines.join('\n'),
    key,
    ratingsTemplate: ['case_id,candidate,rater,naturalness,ai_likeness,postability,fidelity', ...ratingRows].join('\n') + '\n',
    pairwiseTemplate: ['case_id,left,right,rater,choice', ...pairRows].join('\n') + '\n',
  };
}

/** 簡易の CSV（カンマ区切り・引用符なし・先頭行がヘッダ）。記入済みの表を読む。 */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines[0]?.split(',').map((h) => h.trim()) ?? [];
  return lines.slice(1).map((line) => {
    const cells = line.split(',').map((c) => c.trim());
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
}

export interface MethodRatings {
  readonly n: number;
  readonly mean: Readonly<Record<RatingMetric, number | null>>;
}

/** 記入済みの採点を方式ごとに平均する。空欄・範囲外は数えない。 */
export function aggregateRatings(
  rows: readonly Record<string, string>[],
  key: BlindPacket['key'],
): Record<string, MethodRatings> {
  const acc = new Map<string, { n: number; sums: Record<RatingMetric, number[]> }>();
  for (const row of rows) {
    const method = key[row.case_id ?? '']?.[row.candidate ?? ''];
    if (!method) continue;
    const entry = acc.get(method) ?? { n: 0, sums: { naturalness: [], ai_likeness: [], postability: [], fidelity: [] } };
    let any = false;
    for (const m of RATING_METRICS) {
      const v = Number(row[m]);
      if (Number.isInteger(v) && v >= 1 && v <= 5) {
        entry.sums[m].push(v);
        any = true;
      }
    }
    if (any) entry.n++;
    acc.set(method, entry);
  }
  const mean = (xs: readonly number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
  return Object.fromEntries(
    [...acc.entries()].map(([method, e]) => [
      method,
      { n: e.n, mean: Object.fromEntries(RATING_METRICS.map((m) => [m, mean(e.sums[m])])) as MethodRatings['mean'] },
    ]),
  );
}

export interface PairwiseResult {
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
}

/** 2 候補の比較を、方式どうしの勝ち・負け・同等へ数える（キーは `方式A vs 方式B`・方式名の辞書順）。 */
export function aggregatePairwise(
  rows: readonly Record<string, string>[],
  key: BlindPacket['key'],
): Record<string, PairwiseResult> {
  const out = new Map<string, { wins: number; losses: number; ties: number }>();
  for (const row of rows) {
    const k = key[row.case_id ?? ''];
    const left = k?.[row.left ?? ''];
    const right = k?.[row.right ?? ''];
    const choice = (row.choice ?? '').trim();
    if (!left || !right || ![row.left, row.right, '同等'].includes(choice)) continue;
    const [first, second] = [left, right].sort();
    const name = `${first} vs ${second}`;
    const e = out.get(name) ?? { wins: 0, losses: 0, ties: 0 };
    if (choice === '同等') e.ties++;
    else {
      const winner = choice === row.left ? left : right;
      if (winner === first) e.wins++;
      else e.losses++;
    }
    out.set(name, e);
  }
  return Object.fromEntries(out);
}
