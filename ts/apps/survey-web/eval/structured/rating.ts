// 人手の採点（Issue #440・自然さ重視への方針変更で、方式を当て合うブラインド比較から、本番の通常生成の採点へ整理した）。
//
// 自然さ・投稿しやすさ・内容の忠実さは、AI detector を正解にせず、**本番の通常生成の下書き**を人が読んで採点する。
// 下書きが LLM の文か safe fallback の文かは評価者に見せない（先入観で採点を変えない）。実 API を呼ばない純関数だけを持つ。
//   - buildRatingPacket: ケースごとに下書きを「S1・S2…」の符号で並べた採点用の本文と、記入用の CSV を作る
//   - aggregateRatings: 記入済みの CSV を、全体・評価者ごとの平均と、創作の指摘の件数へ集計する
// **評価者の名前などの個人情報をリポジトリへ入れない。** 評価者は `R1` のような符号だけで記録する。
// 出力（下書きの本文・記入済みの表）はリポジトリ外（EVAL_OUT の隣）へ置く。

export interface RatingSample {
  readonly caseId: string;
  readonly run: number;
  readonly draft: string;
}

export interface RatingPacket {
  /** 評価者に渡す本文（下書きの出どころを含まない）。 */
  readonly sheet: string;
  /** 採点の記入用 CSV（ヘッダと空欄の行）。 */
  readonly ratingsTemplate: string;
}

export const RATING_METRICS = ['naturalness', 'postability', 'fidelity'] as const;
export type RatingMetric = (typeof RATING_METRICS)[number];

const METRIC_LABELS: Readonly<Record<RatingMetric, string>> = {
  naturalness: '自然さ（実際の利用者が自分で書いた口コミとして違和感が少ないか。アンケートの読み上げに見えたら低い）',
  postability: '投稿しやすさ（ほぼそのまま自分の口コミとして投稿してよいと思えるか）',
  fidelity: '内容の忠実さ（与えられた回答から意味がずれていないか）',
};

export const RATINGS_HEADER = 'case_id,sample,rater,naturalness,postability,fidelity,fabrication';

/** 採点の束を作る。ケースの順は id の順、下書きは run の順で `S1`・`S2`… と符号を振る。 */
export function buildRatingPacket(
  samples: readonly RatingSample[],
  options: { readonly caseContext?: Readonly<Record<string, string>> } = {},
): RatingPacket {
  const byCase = new Map<string, RatingSample[]>();
  for (const s of samples) byCase.set(s.caseId, [...(byCase.get(s.caseId) ?? []), s]);
  const lines: string[] = [
    '# 口コミ下書きの採点',
    '',
    '同じ回答から作った下書きを並べています。各下書きを次の 3 観点で 1〜5 で採点し、`ratings.csv` に記入してください（評価者は R1 などの符号で記録し、名前は書かないでください）。',
    '',
    ...RATING_METRICS.map((m) => `- ${m}: ${METRIC_LABELS[m]}`),
    '- fabrication: 回答に無い具体的な事実（数字・原因・来店の状況・店員の様子・料理の具体的な描写・また行きたい など）が書かれていれば 1、無ければ 0',
    '',
  ];
  const rows: string[] = [];
  for (const [caseId, list] of [...byCase.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`## ${caseId}`, '');
    if (options.caseContext?.[caseId]) lines.push(`回答: ${options.caseContext[caseId]}`, '');
    [...list].sort((a, b) => a.run - b.run).forEach((s, i) => {
      const id = `S${i + 1}`;
      lines.push(`### ${id}`, '', s.draft, '');
      rows.push(`${caseId},${id},,,,,`);
    });
  }
  return { sheet: lines.join('\n'), ratingsTemplate: [RATINGS_HEADER, ...rows].join('\n') + '\n' };
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

export interface RatingSummary {
  /** 1 観点以上を記入した行の数。 */
  readonly n: number;
  readonly mean: Readonly<Record<RatingMetric, number | null>>;
  /** 創作ありと記入された行の数。 */
  readonly fabrication: number;
}

export interface RatingAggregate {
  readonly raters: readonly string[];
  readonly overall: RatingSummary;
  readonly byRater: Readonly<Record<string, RatingSummary>>;
}

function summarizeRows(rows: readonly Record<string, string>[]): RatingSummary {
  const sums: Record<RatingMetric, number[]> = { naturalness: [], postability: [], fidelity: [] };
  let n = 0;
  let fabrication = 0;
  for (const row of rows) {
    let any = false;
    for (const m of RATING_METRICS) {
      const v = Number(row[m]);
      if (row[m] !== '' && Number.isInteger(v) && v >= 1 && v <= 5) {
        sums[m].push(v);
        any = true;
      }
    }
    if (any) n++;
    if (row.fabrication === '1') fabrication++;
  }
  const mean = (xs: readonly number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
  return { n, fabrication, mean: Object.fromEntries(RATING_METRICS.map((m) => [m, mean(sums[m])])) as RatingSummary['mean'] };
}

/** 記入済みの採点を、全体と評価者ごとに集計する。評価者の欄が空の行・範囲外の値は数えない。 */
export function aggregateRatings(rows: readonly Record<string, string>[]): RatingAggregate {
  const rated = rows.filter((r) => (r.rater ?? '').trim() !== '');
  const raters = [...new Set(rated.map((r) => r.rater!.trim()))].sort();
  return {
    raters,
    overall: summarizeRows(rated),
    byRater: Object.fromEntries(raters.map((r) => [r, summarizeRows(rated.filter((x) => x.rater!.trim() === r))])),
  };
}
