import {
  diagnoseDraft,
  regenerationSimilarity,
  structureSameness,
  summarizeDiagnostics,
  type DiagnosticsSummary,
  type DraftDiagnostics,
  type StructureSameness,
} from './diagnostics';
import {
  claimsOf,
  evaluateStructuredDraft,
  exactOverlaps,
  gateFamily,
  runtimeViolations,
  type GateFinding,
  type LegacyLexicons,
  type StructuredEvalCase,
  type StructuredEvalLexicon,
  type StructuredEvaluation,
} from './gates';
import type { DraftSource, EvalGenerator, GeneratedDraft } from './methods';

// 実測の 1 本ずつの記録と、評価の対象（本番の通常生成・safe fallback）ごとの集計（Issue #440）。実 API を呼ばない純関数。
// 判定は offline eval gate（本番の runtime hard gate と同じ関数に、固定ケースの言い方・一言の語・ケース固有の禁止を
// 足したもの）で行う。本番の最終の下書きは runtime hard gate を通っているので、ここで落ちたものは runtime が拾えない
// 残差である。集計の形は EVAL_OUT に書き出す固定の形。

export type GeneratorId = EvalGenerator['id'];

export interface StructuredEvalSample {
  readonly caseId: string;
  readonly generator: GeneratorId;
  readonly run: number;
  /** 下書き（作れなかったときは null）。 */
  readonly draft: string | null;
  readonly source: DraftSource | null;
  readonly attempts: number;
  readonly evaluation: StructuredEvaluation | null;
  /**
   * release の判定に使う明確な捏造（本番の runtime hard gate の種類を、固定ケースの言い方つきで判定したもの）と
   * ケース固有の禁止の意味。片側の完全な無視（positiveDropped / concernDropped）もここに入る。
   */
  readonly release: readonly string[] | null;
  readonly diagnostics: DraftDiagnostics | null;
}

export function recordSample(
  c: StructuredEvalCase,
  generator: GeneratorId,
  run: number,
  generated: GeneratedDraft,
  lex: StructuredEvalLexicon,
  legacy: LegacyLexicons,
): StructuredEvalSample {
  const { draft } = generated;
  return {
    caseId: c.id,
    generator,
    run,
    draft,
    source: generated.source,
    attempts: generated.attempts,
    evaluation: draft === null ? null : evaluateStructuredDraft(c, draft, lex, legacy),
    release:
      draft === null
        ? null
        : [
            ...new Set([
              ...runtimeViolations(c, draft, lex, legacy),
              ...evaluateStructuredDraft(c, draft, lex, legacy).findings.map((f) => gateFamily(f.kind)).filter((k) => k === 'caseForbidden'),
            ]),
          ],
    diagnostics: draft === null ? null : diagnoseDraft(c, draft, lex),
  };
}

export interface GeneratorSummary {
  readonly generator: GeneratorId;
  readonly samples: number;
  /** 下書きを作れなかった本数。 */
  readonly missing: number;
  /** 1 回目が runtime hard gate を通らず作り直した本数（LLM を 2 回呼んだ）。 */
  readonly retried: number;
  /** 明確な捏造（release の判定）があった本数と、片側を完全に無視した本数。 */
  readonly fabricated: number;
  readonly sideDropped: number;
  /** offline eval gate（claim ごとの coverage・表面語を含む全部）を 1 つでも落とした本数と率。**診断**（release の条件にしない）。 */
  readonly hardFailed: number;
  readonly hardFailRate: number;
  /** 失格の種類（分類は頭の名前へまとめる）ごとの本数。 */
  readonly gateCounts: Readonly<Record<string, number>>;
  /** exact overlap のケースで、両面の理由を作った本数 / overlap のケースの本数。 */
  readonly overlapReason: { readonly failed: number; readonly of: number };
  /** claim を述べた割合（主題 × 極性）と、facet の意味まで述べた割合（統合・省略を許すので診断）。 */
  readonly claimCoverage: number;
  readonly facetMention: number;
  /** 自然さの診断（production は LLM の文・safe-fallback はテンプレートの文）。 */
  readonly diagnostics: DiagnosticsSummary;
  /** 同じケースの複数の生成で、書き出し・主題の順・文の数・文の組み立てが同じだったケースの数（LLM の文だけ）。 */
  readonly structure: StructureSameness;
  /** ケースごとの再生成の類似度（同じ対象の 2 本以上）。 */
  readonly regeneration: { readonly meanJaccard: number | null; readonly exactDuplicatePairs: number; readonly sameExceptEndingPairs: number; readonly pairs: number };
  /** ケースごとの合格の本数（どのケースで落ちるかを見る）。 */
  readonly byCase: Readonly<Record<string, { readonly passed: number; readonly of: number; readonly kinds: readonly string[] }>>;
}

export interface StructuredEvalSummary {
  readonly cases: number;
  readonly claims: number;
  readonly generators: readonly GeneratorSummary[];
}

export function summarize(cases: readonly StructuredEvalCase[], samples: readonly StructuredEvalSample[]): StructuredEvalSummary {
  const generators = [...new Set(samples.map((s) => s.generator))];
  const overlapCases = new Set(cases.filter((c) => exactOverlaps(c).length > 0).map((c) => c.id));
  return {
    cases: cases.length,
    claims: cases.reduce((n, c) => n + claimsOf(c).length, 0),
    generators: generators.map((generator) => {
      const mine = samples.filter((s) => s.generator === generator);
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
      // 自然さは通常生成の文で見る（本番の経路は safe fallback を返さない）。safe-fallback の対象はその文で見る。
      const natural = generator === 'safe-fallback' ? made : made.filter((s) => s.source !== 'fallback');
      let pairs = 0;
      let exact = 0;
      let sameExceptEnding = 0;
      let weighted = 0;
      for (const c of cases) {
        const drafts = natural.filter((s) => s.caseId === c.id).map((s) => s.draft!);
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
        generator,
        samples: mine.length,
        missing: mine.length - made.length,
        fabricated: made.filter((s) => s.release!.some((k) => k !== 'positiveDropped' && k !== 'concernDropped')).length,
        sideDropped: made.filter((s) => s.release!.some((k) => k === 'positiveDropped' || k === 'concernDropped')).length,
        retried: made.filter((s) => s.attempts >= 2).length,
        hardFailed: failed.length,
        hardFailRate: ratio(failed.length, made.length),
        gateCounts,
        overlapReason: {
          failed: overlapMade.filter((s) => s.evaluation!.findings.some((f) => f.kind === 'overlapReason')).length,
          of: overlapMade.length,
        },
        claimCoverage: ratio(coverage.filter((c) => c.covered).length, coverage.length),
        facetMention: ratio(coverage.filter((c) => c.facetMentioned).length, coverage.length),
        diagnostics: summarizeDiagnostics(natural.map((s) => s.diagnostics!)),
        structure: structureSameness(cases.map((c) => natural.filter((s) => s.caseId === c.id).map((s) => s.diagnostics!))),
        regeneration: { meanJaccard: pairs === 0 ? null : weighted / pairs, exactDuplicatePairs: exact, sameExceptEndingPairs: sameExceptEnding, pairs },
        byCase,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// 成功条件（本番の通常生成）
// ---------------------------------------------------------------------------

export interface SuccessCheck {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly threshold: string;
  readonly passed: boolean;
}

/**
 * 実 Gemini の実測に対する自動の成功条件（eval/README.md の「成功条件」と同じ表）。自然さの最終判断は人手の採点で行い、
 * ここは「事実性の残差が無いこと」と「通常生成が読み上げ・fallback 風へ寄っていないこと」の機械的な下限である。
 */
export function successChecks(production: GeneratorSummary): SuccessCheck[] {
  const made = production.samples - production.missing;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const errorRate = production.samples === 0 ? 0 : production.missing / production.samples;
  // release の条件は「明確な捏造が無い」「片側を完全に落としていない」「下書きを作れている」だけ。claim ごとの coverage と
  // style は条件にしない（診断・styleWarnings で見る）。自然さの最終判断は人手の採点。
  return [
    { id: 'fabrication', label: '明確な捏造（新しい具体的事実・数字・来店の文脈・勝手な因果・極性の反転など）', value: `${production.fabricated}/${made}`, threshold: '0 件', passed: production.fabricated === 0 },
    { id: 'overlapReason', label: 'exact overlap の理由の創作', value: `${production.overlapReason.failed}/${production.overlapReason.of}`, threshold: '0 件', passed: production.overlapReason.failed === 0 },
    { id: 'sideDropped', label: 'positive / concern の片側を完全に無視した', value: `${production.sideDropped}/${made}`, threshold: '0 件', passed: production.sideDropped === 0 },
    { id: 'generationErrors', label: '下書きを作れなかった（generation error）率', value: pct(errorRate), threshold: '≤ 10%', passed: errorRate <= 0.1 },
  ];
}

// ---------------------------------------------------------------------------
// 自然さの警告（hard fail にしない・実 Gemini の結果を見て目安を調整する）
// ---------------------------------------------------------------------------

export interface StyleWarning {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly threshold: string;
}

/**
 * 定型への寄りと再生成の構成の偏りの警告。**release gate の FAIL にはしない**（successChecks と分ける）。
 * 総評の句は単体では合格で、星を渡しうるケース（★3 以外）の 50% を超えて付くときだけ警告する。
 */
export function styleWarnings(summary: GeneratorSummary): StyleWarning[] {
  const r = (k: string) => summary.diagnostics.rates[k] ?? 0;
  const s = summary.structure;
  const share = (n: number) => (s.cases === 0 ? 0 : n / s.cases);
  const fmt = (x: number) => `${(x * 100).toFixed(1)}%`;
  const d = summary.diagnostics;
  const candidates: (StyleWarning & { readonly over: boolean })[] = [
    { id: 'fallbackLike', label: '通常生成の文が safe fallback 風（「〜良かったです。〜気になりました。」の羅列）', value: fmt(r('fallbackLike')), threshold: '≤ 5%', over: r('fallbackLike') > 0.05 },
    { id: 'checklistLike', label: '3 主題以上を入力の順に 1 文 1 主題で読み上げた', value: fmt(r('checklistLike')), threshold: '≤ 10%', over: r('checklistLike') > 0.1 },
    { id: 'sameEndingRun3', label: '同じ文末が 3 文続いた', value: fmt(r('sameEndingRun3')), threshold: '≤ 5%', over: r('sameEndingRun3') > 0.05 },
    { id: 'length', label: '1 claim あたりの平均字数 / 最長', value: `${d.meanCharsPerClaim.toFixed(0)} 字 / ${d.maxChars} 字`, threshold: '≤ 45 字 / ≤ 250 字', over: d.meanCharsPerClaim > 45 || d.maxChars > 250 },
    { id: 'duplicates', label: '同じケースの再生成が完全一致した組', value: `${summary.regeneration.exactDuplicatePairs}/${summary.regeneration.pairs}`, threshold: '0 組', over: summary.regeneration.exactDuplicatePairs > 0 },
    { id: 'overallClosing', label: '星を渡しうるケースで総評の句（全体として・全体的に・総じて）が付いた率', value: fmt(r('overallClosingStarred')), threshold: '≤ 50%', over: r('overallClosingStarred') > 0.5 },
    { id: 'abstractEvaluation', label: '「満足できる内容」「満足できるもの」のような抽象語のまとめ', value: fmt(r('abstractEvaluation')), threshold: '≤ 5%', over: r('abstractEvaluation') > 0.05 },
    { id: 'dakeWithMultipleConcerns', label: '気になったことが 2 つ以上あるのに「〜だけ」', value: fmt(r('dakeWithMultipleConcerns')), threshold: '0%', over: r('dakeWithMultipleConcerns') > 0 },
    // 再生成は同じ生成をもう一度行うだけなので、構成が似ること自体は問題にしない（目安は緩めに置く）。
    { id: 'sameStructure', label: '再生成の文の組み立て（文ごとの主題）がすべて同じだったケース', value: `${s.sameStructure}/${s.cases}`, threshold: '≤ 80%', over: share(s.sameStructure) > 0.8 },
  ];
  return candidates.filter((c) => c.over).map((c) => ({ id: c.id, label: c.label, value: c.value, threshold: c.threshold }));
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** 集計を人が読む表（Markdown）にする。BASELINE.md の記録と同じ形。 */
export function formatSummary(summary: StructuredEvalSummary): string {
  const rows = summary.generators.map((m) => {
    const made = m.samples - m.missing;
    return `| ${m.generator} | ${made}/${m.samples} | ${m.retried}/${made} | ${m.hardFailed}/${made}（${pct(m.hardFailRate)}） | ${m.overlapReason.failed}/${m.overlapReason.of} | ${pct(m.claimCoverage)} | ${m.diagnostics.meanChars.toFixed(0)} | ${m.diagnostics.meanSentences.toFixed(1)} | ${m.regeneration.meanJaccard === null ? '—' : m.regeneration.meanJaccard.toFixed(2)} |`;
  });
  const gates = summary.generators.map(
    (m) => `- ${m.generator}: ${Object.entries(m.gateCounts).sort().map(([k, v]) => `${k} ${v}`).join(' / ') || '失格なし'}`,
  );
  const diag = summary.generators.map(
    (m) => `- ${m.generator}: ${Object.entries(m.diagnostics.rates).map(([k, v]) => `${k} ${pct(v)}`).join(' / ')}；claim 数ごとの平均字数 ${Object.entries(m.diagnostics.charsByClaimCount).map(([k, v]) => `${k}:${v.toFixed(0)}`).join(' ')}`,
  );
  const production = summary.generators.find((m) => m.generator === 'production');
  const checks = production && production.samples - production.missing > 0 ? successChecks(production) : [];
  const structure = summary.generators.map(
    (m) => `- ${m.generator}: 比べたケース ${m.structure.cases}・書き出しが同じ ${m.structure.sameOpening}・主題の順が同じ ${m.structure.sameClaimOrder}・文の数が同じ ${m.structure.sameSentenceCount}・文の組み立てが同じ ${m.structure.sameStructure}`,
  );
  const warnings = production && production.samples - production.missing > 0 ? styleWarnings(production) : [];
  return [
    `ケース ${summary.cases} 件・claim ${summary.claims} 件`,
    '',
    '| 対象 | 生成できた本数 | 作り直し | offline eval gate の失格（診断） | exact overlap の理由 | claim の coverage（診断） | 平均字数 | 平均文数 | 再生成の類似度 |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    '失格の種類（本数）:',
    ...gates,
    '',
    '自然さの診断（率・個々の合否ではない。production は LLM の文だけで集計）:',
    ...diag,
    '',
    '再生成の構成の偏り（同じケースの 2 本以上・すべて同じだったケースの数）:',
    ...structure,
    ...(checks.length > 0
      ? ['', '成功条件（production・自動の下限。最終判断は人手の採点）:', '', '| 条件 | 値 | 目安 | 判定 |', '|---|---|---|---|', ...checks.map((c) => `| ${c.label} | ${c.value} | ${c.threshold} | ${c.passed ? 'PASS' : 'FAIL'} |`)]
      : []),
    ...(warnings.length > 0
      ? ['', '自然さの警告（hard fail ではない。目安は実測を見て調整する）:', ...warnings.map((w) => `- WARN ${w.label}: ${w.value}（目安 ${w.threshold}）`)]
      : []),
  ].join('\n');
}
