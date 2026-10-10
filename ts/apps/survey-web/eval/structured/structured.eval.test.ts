import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GenAiClient, GenAiResponse } from '../../src/lib/draft/generator';
import casesRaw from './cases.json';
import lexiconRaw from '../../src/lib/draft/structured/lexicon.json';
import { evaluateStructuredDraft, readLegacyLexicons, readStructuredCases, readStructuredEvalLexicon, claimsOf } from './gates';
import { evalGenerators, type GeneratedDraft } from './methods';
import { buildRatingPacket } from './rating';
import { formatSummary, recordSample, styleWarnings, successChecks, summarize, type StructuredEvalSample } from './report';

// structured survey の下書きの実測（Issue #440）。対象は **本番の通常生成（production）と safe fallback** の 2 つだけ。
// production（実 Gemini を叩く）は GEMINI_API_KEY が無ければ skip し、API の要らない safe fallback だけを流す。
// 通常の `pnpm test` では走らない（vitest.eval.config.ts）。
//
//   GEMINI_API_KEY=... GEMINI_MODEL=gemini-3.1-flash-lite EVAL_OUT=/tmp/structured-eval.json \
//     pnpm --filter @fwlm/survey-web run eval:structured
//
// 手順・環境変数・成功条件・結果の読み方は eval/README.md の「structured survey の評価」を参照。

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../../../../..');
const RUNS = Number.parseInt(process.env.EVAL_RUNS ?? '3', 10);
const OUT = process.env.EVAL_OUT ?? '';
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-lite';
const ONLY_CASES = (process.env.EVAL_CASES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const hasKey = (process.env.GEMINI_API_KEY ?? '').length > 0;

const allCases = readStructuredCases(casesRaw);
const cases = ONLY_CASES.length === 0 ? allCases : allCases.filter((c) => ONLY_CASES.includes(c.id));
const lex = readStructuredEvalLexicon(lexiconRaw);
const legacy = readLegacyLexicons();

/** EVAL_OUT はリポジトリの外でなければならない（実出力をコミットしない・既存の eval と同じ契約）。 */
function assertOutsideRepo(path: string): void {
  const rel = relative(REPO_ROOT, resolve(path));
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error(`EVAL_OUT はリポジトリの外のパスを指定してください（指定: ${path}）`);
  }
}

async function realClient(): Promise<GenAiClient> {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({});
  return {
    models: {
      generateContent: (req) =>
        ai.models.generateContent(req as Parameters<typeof ai.models.generateContent>[0]) as Promise<GenAiResponse>,
    },
  };
}

describe('structured survey の下書きの実測（Issue #440）', () => {
  it('本番の通常生成と safe fallback を、offline eval gate・coverage・自然さの診断で測る', async () => {
    if (OUT !== '') assertOutsideRepo(OUT);
    expect(cases.length, `EVAL_CASES に該当するケースがありません（${ONLY_CASES.join(',')}）`).toBeGreaterThan(0);

    // 前提: 検出器が許す言い換えをすべて通すこと（壊れた物差しで測らない）。
    for (const c of cases) {
      for (const text of c.allowedParaphrases) {
        expect(evaluateStructuredDraft(c, text, lex, legacy).findings, `${c.id}: ${text}`).toEqual([]);
      }
    }

    const client = hasKey ? await realClient() : undefined;
    // 生成の失敗で safe fallback に落ちた本数（最終の下書きだけでは、キーやモデル名の誤りで全件 fallback になった実測と
    // 区別できない）。失格の種類は記録しない（本番のログと同じく、種類だけを集計に出す）。
    let generationFailures = 0;
    const generators = evalGenerators({
      ...(client ? { client } : {}),
      model: MODEL,
      realizerEvents: { onFailed: (reason) => (reason === 'generation' ? (generationFailures += 1) : undefined) },
    }).filter((g) => !g.requiresApi || hasKey);
    if (!hasKey) console.log('GEMINI_API_KEY が無いので、本番の通常生成（production）を skip し、safe fallback だけを流します。');

    const samples: StructuredEvalSample[] = [];
    for (const generator of generators) {
      for (const c of cases) {
        // safe fallback は決定的なので 1 回で足りる。
        const runs = generator.id === 'safe-fallback' ? 1 : RUNS;
        for (let run = 0; run < runs; run++) {
          let generated: GeneratedDraft;
          try {
            generated = await generator.generate(c, run);
          } catch {
            generated = { draft: null, source: null, attempts: 0 };
          }
          samples.push(recordSample(c, generator.id, run, generated, lex, legacy));
        }
      }
    }

    const summary = summarize(cases, samples);
    console.log(`\n## structured survey の下書きの実測（model=${MODEL}・runs=${RUNS}・key=${hasKey ? 'あり' : 'なし'}）\n`);
    console.log(formatSummary(summary));

    const production = summary.generators.find((g) => g.generator === 'production');
    if (production) {
      const made = production.samples - production.missing;
      console.log(`\n通常生成の経路: ${made} 本中、作り直し ${production.retried}・safe fallback ${production.fallback}（うち生成の失敗 ${generationFailures}）`);
      // 生成が 1 本も成功しない実測は、safe fallback の文だけで測ったことになる（キー・モデル名・通信の誤り）。
      expect(generationFailures, '通常生成が全件失敗しました（GEMINI_API_KEY・GEMINI_MODEL・通信を確認）').toBeLessThan(made);
    }

    // 対照: safe fallback は claim から決定的に作るので、hard gate を構造的にすべて通る。落ちたら検出器か fallback が壊れている。
    const fallback = summary.generators.find((g) => g.generator === 'safe-fallback');
    if (fallback) {
      expect(fallback.hardFailed, JSON.stringify(fallback.byCase)).toBe(0);
      expect(fallback.claimCoverage).toBe(1);
    }

    if (OUT !== '') {
      mkdirSync(dirname(resolve(OUT)), { recursive: true });
      const meta = {
        model: MODEL,
        runs: RUNS,
        cases: cases.map((c) => c.id),
        generators: generators.map((g) => g.id),
        generationFailures,
        successChecks: production ? successChecks(production) : [],
        styleWarnings: production ? styleWarnings(production) : [],
        measuredAt: new Date().toISOString(),
      };
      writeFileSync(OUT, JSON.stringify({ meta, summary, samples }, null, 2));
      // 人手の採点は本番の通常生成の最終の下書きだけ（LLM の文か safe fallback の文かは評価者に見せない）。
      const packet = buildRatingPacket(
        samples.filter((s) => s.generator === 'production' && s.draft !== null).map((s) => ({ caseId: s.caseId, run: s.run, draft: s.draft! })),
        {
          caseContext: Object.fromEntries(
            cases.map((c) => [
              c.id,
              `★${c.star}・${claimsOf(c).map((cl) => `${cl.polarity === 'positive' ? '良' : '気'}:${[cl.targetLabel, cl.facetLabel].filter(Boolean).join('/')}`).join('、')}${c.comment ? `・一言「${c.comment}」` : ''}`,
            ]),
          ),
        },
      );
      if (production) {
        writeFileSync(`${OUT}.rating.md`, packet.sheet);
        writeFileSync(`${OUT}.ratings.csv`, packet.ratingsTemplate);
        console.log(`\n書き出し: ${OUT}（.rating.md / .ratings.csv）`);
      } else {
        console.log(`\n書き出し: ${OUT}`);
      }
    }
    // 実 Gemini では 13 ケース × 3 回 × 最大 2 リクエストを逐次に呼ぶ。設定の既定 10 分では足りないことがある。
  }, 30 * 60 * 1000);
});
