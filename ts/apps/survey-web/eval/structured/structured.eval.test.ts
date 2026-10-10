import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { dirname, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GenAiClient, GenAiResponse } from '../../src/lib/draft/generator';
import casesRaw from './cases.json';
import lexiconRaw from '../../src/lib/draft/structured/lexicon.json';
import { buildBlindPacket } from './blind';
import { evaluateStructuredDraft, readLegacyLexicons, readStructuredCases, readStructuredEvalLexicon, claimsOf } from './gates';
import { evalMethods } from './methods';
import { formatSummary, recordSample, summarize, type StructuredEvalSample } from './report';

// structured survey の下書きの実測（Issue #440）。**実 Gemini を叩く方式（A・B・C）は GEMINI_API_KEY が無ければ skip** し、
// API の要らない D（決定的なテンプレート）だけを流す。通常の `pnpm test` では走らない（vitest.eval.config.ts）。
//
//   GEMINI_API_KEY=... GEMINI_MODEL=gemini-3.1-flash-lite EVAL_OUT=/tmp/structured-eval.json \
//     pnpm --filter @fwlm/survey-web run eval:structured
//
// 手順・環境変数・結果の読み方は eval/README.md の「structured survey の評価」を参照。

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../../../../..');
const RUNS = Number.parseInt(process.env.EVAL_RUNS ?? '3', 10);
const SEED = Number.parseInt(process.env.EVAL_SEED ?? '440', 10);
const OUT = process.env.EVAL_OUT ?? '';
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-lite';
const ONLY = (process.env.EVAL_METHODS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const hasKey = (process.env.GEMINI_API_KEY ?? '').length > 0;

const cases = readStructuredCases(casesRaw);
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
  it('同じケース・同じモデル・同じ回数で方式を並べ、hard gate・coverage・AI っぽさの診断を出す', async () => {
    if (OUT !== '') assertOutsideRepo(OUT);

    // 前提: 検出器が許す言い換えをすべて通すこと（壊れた物差しで測らない）。
    for (const c of cases) {
      for (const text of c.allowedParaphrases) {
        expect(evaluateStructuredDraft(c, text, lex, legacy).findings, `${c.id}: ${text}`).toEqual([]);
      }
    }

    const client = hasKey ? await realClient() : undefined;
    const methods = evalMethods({ ...(client ? { client } : {}), model: MODEL }).filter(
      (m) => (ONLY.length === 0 || ONLY.includes(m.id)) && (!m.requiresApi || hasKey),
    );
    if (!hasKey) console.log('GEMINI_API_KEY が無いので、実 API を呼ぶ方式（A・B・C）を skip し、D だけを流します。');

    const samples: StructuredEvalSample[] = [];
    for (const method of methods) {
      for (const c of cases) {
        for (let run = 0; run < RUNS; run++) {
          let draft: string | null = null;
          try {
            draft = await method.generate(c, run);
          } catch {
            draft = null;
          }
          samples.push(recordSample(c, method.id, run, draft, lex, legacy));
        }
      }
    }

    const summary = summarize(cases, samples);
    console.log(`\n## structured survey の下書きの実測（model=${MODEL}・runs=${RUNS}・key=${hasKey ? 'あり' : 'なし'}）\n`);
    console.log(formatSummary(summary));

    // 対照: D は claim から決定的に作るので、hard gate を構造的にすべて通る。落ちたら検出器か D が壊れている。
    const fallback = summary.methods.find((m) => m.method === 'safe-fallback');
    if (fallback) {
      expect(fallback.hardFailed, JSON.stringify(fallback.byCase)).toBe(0);
      expect(fallback.claimCoverage).toBe(1);
    }

    if (OUT !== '') {
      const meta = { model: MODEL, runs: RUNS, seed: SEED, methods: methods.map((m) => m.id), measuredAt: new Date().toISOString() };
      writeFileSync(OUT, JSON.stringify({ meta, summary, samples }, null, 2));
      const packet = buildBlindPacket(
        samples.filter((s) => s.draft !== null).map((s) => ({
          caseId: s.caseId,
          caseTitle: cases.find((c) => c.id === s.caseId)!.title,
          method: s.method,
          run: s.run,
          draft: s.draft!,
        })),
        {
          seed: SEED,
          caseContext: Object.fromEntries(
            cases.map((c) => [
              c.id,
              `★${c.star}・${claimsOf(c).map((cl) => `${cl.polarity === 'positive' ? '良' : '気'}:${[cl.targetLabel, cl.facetLabel].filter(Boolean).join('/')}`).join('、')}${c.comment ? `・一言「${c.comment}」` : ''}`,
            ]),
          ),
        },
      );
      writeFileSync(`${OUT}.blind.md`, packet.sheet);
      writeFileSync(`${OUT}.blind-key.json`, JSON.stringify(packet.key, null, 2));
      writeFileSync(`${OUT}.ratings.csv`, packet.ratingsTemplate);
      writeFileSync(`${OUT}.pairwise.csv`, packet.pairwiseTemplate);
      console.log(`\n書き出し: ${OUT}（.blind.md / .blind-key.json / .ratings.csv / .pairwise.csv）`);
    }
  });
});
