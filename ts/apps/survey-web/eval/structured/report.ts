import { diagnoseDraft, regenerationSimilarity, summarizeDiagnostics, type DiagnosticsSummary, type DraftDiagnostics } from './diagnostics';
import {
  claimsOf,
  evaluateStructuredDraft,
  exactOverlaps,
  gateFamily,
  type GateFinding,
  type LegacyLexicons,
  type StructuredEvalCase,
  type StructuredEvalLexicon,
  type StructuredEvaluation,
} from './gates';

// 実測の 1 本ずつの記録と、方式ごとの集計（Issue #440）。実 API を呼ばない純関数。
// 集計の形（StructuredEvalSummary）は baseline と候補を同じ物差しで並べるための固定の形で、EVAL_OUT に書き出す。

export interface StructuredEvalSample {
  readonly caseId: string;
  readonly method: string;
  readonly run: number;
  /** 下書き（作れなかったときは null）。 */
  readonly draft: string | null;
  readonly evaluation: StructuredEvaluation | null;
  readonly diagnostics: DraftDiagnostics | null;
}

export function recordSample(
  c: StructuredEvalCase,
  method: string,
  run: number,
  draft: string | null,
  lex: StructuredEvalLexicon,
  legacy: LegacyLexicons,
): StructuredEvalSample {
  return {
    caseId: c.id,
    method,
    run,
    draft,
    evaluation: draft === null ? null : evaluateStructuredDraft(c, draft, lex, legacy),
    diagnostics: draft === null ? null : diagnoseDraft(c, draft, lex),
  };
}

export interface MethodSummary {
  readonly method: string;
  readonly samples: number;
  /** 下書きを作れなかった本数（生成失敗・未実装）。 */
  readonly missing: number;
  /** hard gate を 1 つでも落とした本数と率（作れた下書きが母数）。 */
  readonly hardFailed: number;
  readonly hardFailRate: number;
  /** 失格の種類（分類は頭の名前へまとめる）ごとの本数。 */
  readonly gateCounts: Readonly<Record<string, number>>;
  /** exact overlap のケースで、両面の理由を作った本数 / overlap のケースの本数。 */
  readonly overlapReason: { readonly failed: number; readonly of: number };
  /** claim を述べた割合（主題 × 極性）と、facet の意味まで述べた割合（統合を許すので診断）。 */
  readonly claimCoverage: number;
  readonly facetMention: number;
  readonly diagnostics: DiagnosticsSummary;
  /** ケースごとの再生成の類似度の平均（同じ方式の 2 本以上）。 */
  readonly regeneration: { readonly meanJaccard: number | null; readonly exactDuplicatePairs: number; readonly sameExceptEndingPairs: number; readonly pairs: number };
  /** ケースごとの合格の本数（どのケースで落ちるかを見る）。 */
  readonly byCase: Readonly<Record<string, { readonly passed: number; readonly of: number; readonly kinds: readonly string[] }>>;
}

export interface StructuredEvalSummary {
  readonly cases: number;
  readonly claims: number;
  readonly methods: readonly MethodSummary[];
}

export function summarize(cases: readonly StructuredEvalCase[], samples: readonly StructuredEvalSample[]): StructuredEvalSummary {
  const methods = [...new Set(samples.map((s) => s.method))];
  const overlapCases = new Set(cases.filter((c) => exactOverlaps(c).length > 0).map((c) => c.id));
  return {
    cases: cases.length,
    claims: cases.reduce((n, c) => n + claimsOf(c).length, 0),
    methods: methods.map((method) => {
      const mine = samples.filter((s) => s.method === method);
      const made = mine.filter((s) => s.evaluation !== null);
      const failed = made.filter((s) => !s.evaluation!.passed);
      const gateCounts: Record<string, number> = {};
      for (const s of made) {
        for (const kind of new Set(s.evaluation!.findings.map((f: GateFinding) => gateFamily(f.kind)))) {
          gateCounts[kind] = (gateCounts[kind] ?? 0) + 1;
        }
      }
      const overlapMade = made.filter((s) => overlapCases.has(s.caseId));
      const coverage = made.flatMap((s) => s.evaluation!.coverage);
      const ratio = (n: number, d: number) => (d === 0 ? 0 : n / d);
      let pairs = 0;
      let exact = 0;
      let sameExceptEnding = 0;
      let weighted = 0;
      for (const c of cases) {
        const drafts = made.filter((s) => s.caseId === c.id).map((s) => s.draft!);
        const sim = regenerationSimilarity(drafts, c.storeName);
        pairs += sim.pairs;
        exact += sim.exactDuplicatePairs;
        sameExceptEnding += sim.sameExceptEndingPairs;
        if (sim.meanJaccard !== null) weighted += sim.meanJaccard * sim.pairs;
      }
      const byCase: Record<string, { passed: number; of: number; kinds: string[] }> = {};
      for (const c of cases) {
        const list = made.filter((s) => s.caseId === c.id);
        byCase[c.id] = {
          passed: list.filter((s) => s.evaluation!.passed).length,
          of: list.length,
          kinds: [...new Set(list.flatMap((s) => s.evaluation!.findings.map((f) => gateFamily(f.kind))))].sort(),
        };
      }
      return {
        method,
        samples: mine.length,
        missing: mine.length - made.length,
        hardFailed: failed.length,
        hardFailRate: ratio(failed.length, made.length),
        gateCounts,
        overlapReason: {
          failed: overlapMade.filter((s) => s.evaluation!.findings.some((f) => f.kind === 'overlapReason')).length,
          of: overlapMade.length,
        },
        claimCoverage: ratio(coverage.filter((c) => c.covered).length, coverage.length),
        facetMention: ratio(coverage.filter((c) => c.facetMentioned).length, coverage.length),
        diagnostics: summarizeDiagnostics(made.map((s) => s.diagnostics!)),
        regeneration: { meanJaccard: pairs === 0 ? null : weighted / pairs, exactDuplicatePairs: exact, sameExceptEndingPairs: sameExceptEnding, pairs },
        byCase,
      };
    }),
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** 集計を人が読む表（Markdown）にする。baseline の記録（BASELINE.md）と同じ形。 */
export function formatSummary(summary: StructuredEvalSummary): string {
  const rows = summary.methods.map((m) => {
    const made = m.samples - m.missing;
    return `| ${m.method} | ${made}/${m.samples} | ${m.hardFailed}/${made}（${pct(m.hardFailRate)}） | ${m.overlapReason.failed}/${m.overlapReason.of} | ${pct(m.claimCoverage)} | ${pct(m.facetMention)} | ${m.diagnostics.meanChars.toFixed(0)} | ${m.diagnostics.meanSentences.toFixed(1)} | ${m.regeneration.meanJaccard === null ? '—' : m.regeneration.meanJaccard.toFixed(2)} |`;
  });
  const gates = summary.methods.map(
    (m) => `- ${m.method}: ${Object.entries(m.gateCounts).sort().map(([k, v]) => `${k} ${v}`).join(' / ') || '失格なし'}`,
  );
  const diag = summary.methods.map(
    (m) => `- ${m.method}: ${Object.entries(m.diagnostics.rates).map(([k, v]) => `${k} ${pct(v)}`).join(' / ')}；claim 数ごとの平均字数 ${Object.entries(m.diagnostics.charsByClaimCount).map(([k, v]) => `${k}:${v.toFixed(0)}`).join(' ')}`,
  );
  return [
    `ケース ${summary.cases} 件・claim ${summary.claims} 件`,
    '',
    '| 方式 | 生成できた本数 | hard gate を落とした本数 | exact overlap の理由 | claim の coverage | facet の言及 | 平均字数 | 平均文数 | 再生成の類似度 |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    '失格の種類（本数）:',
    ...gates,
    '',
    'AI っぽさの診断（率・合否ではない）:',
    ...diag,
  ].join('\n');
}
