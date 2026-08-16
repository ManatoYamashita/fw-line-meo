import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { createDefaultDraftGenerator } from '../src/lib/draft/generator';
import { pickVariation } from '../src/lib/draft/prompt';
import type { DraftMaterial, Star } from '../src/lib/domain';
import { detectUnselectedAspectMentions, readLexicon } from './detect';
import lexiconRaw from './aspect-lexicon.json';
import aspectsRaw from './aspects.json';
import datasetRaw from './dataset.json';

// 事実性の実測（Issue #132）。**実 Gemini を実際に叩く**ため、既定では skip される。
//
//   GEMINI_API_KEY=... pnpm --filter @fwlm/survey-web run eval:factuality
//
// 本番と同一の生成経路（createDefaultDraftGenerator + pickVariation）を通す。ここを自前の
// 呼び出しに置き換えると「本番とは違うものを測って安心する」ことになるため、必ず実装を経由させる。
// 手順とコストは eval/README.md を参照。

const lexicon = readLexicon(lexiconRaw);
const labels = aspectsRaw.labels as Record<string, string>;
const RUNS = Number.parseInt(process.env.EVAL_RUNS ?? '3', 10);
const OUT = process.env.EVAL_OUT ?? '';
const hasKey = (process.env.GEMINI_API_KEY ?? '').length > 0;

interface Sample {
  readonly materialId: string;
  readonly storeNameKind: string;
  readonly selected: readonly string[];
  readonly draft: string;
  readonly violations: readonly { aspectCode: string; matchedTerm: string }[];
}

function toDraftMaterial(m: (typeof datasetRaw.materials)[number]): DraftMaterial {
  const selected = new Set<string>(m.aspectCodes);
  const aspectLabels = m.aspectCodes.map((c: string) => labels[c] ?? c);
  // 本番の /api/responses と同じく、選ばれなかった観点も渡す（Issue #132・案 A）。
  // ここを渡さないと「本番とは違うプロンプト」を測ることになり、比較が成立しない。
  const unselectedAspectLabels = Object.entries(labels)
    .filter(([code]) => !selected.has(code))
    .map(([, label]) => label);
  const base = {
    storeName: m.storeName,
    star: m.star as Star,
    aspectLabels,
    unselectedAspectLabels,
  };
  return m.comment === null ? base : { ...base, comment: m.comment };
}

function pct(numerator: number, denominator: number): string {
  return denominator === 0 ? 'n/a' : `${((numerator / denominator) * 100).toFixed(1)}%`;
}

describe.skipIf(!hasKey)('AI 下書きの事実性（実 Gemini・Requirement 3.2）', () => {
  const samples: Sample[] = [];
  const failures: string[] = [];

  it(
    `データセット ${datasetRaw.materials.length} 件 × ${RUNS} 回を生成して逸脱を測る`,
    async () => {
      const generator = await createDefaultDraftGenerator();

      for (const material of datasetRaw.materials) {
        for (let run = 0; run < RUNS; run++) {
          const result = await generator.generate(toDraftMaterial(material), pickVariation());
          if (!result.ok) {
            // 生成失敗はサンプルとして数えない。多発する場合は測定自体が成立していない。
            failures.push(`${material.id}#${run}: ${result.error.kind}`);
            continue;
          }
          samples.push({
            materialId: material.id,
            storeNameKind: material.storeNameKind,
            selected: material.aspectCodes,
            draft: result.value,
            violations: detectUnselectedAspectMentions(result.value, material.aspectCodes, lexicon),
          });
        }
      }

      // ---- レポート ----
      const violating = samples.filter((s) => s.violations.length > 0);
      console.log('\n===== 事実性評価レポート（Issue #132） =====');
      console.log(`生成成功 ${samples.length} / 試行 ${datasetRaw.materials.length * RUNS}（失敗 ${failures.length}）`);
      console.log(`未選択軸への言及を含むサンプル: ${violating.length} / ${samples.length}（${pct(violating.length, samples.length)}）\n`);

      console.log('--- 素材別 ---');
      for (const m of datasetRaw.materials) {
        const mine = samples.filter((s) => s.materialId === m.id);
        const bad = mine.filter((s) => s.violations.length > 0);
        const detail = [...new Set(bad.flatMap((s) => s.violations.map((v) => v.aspectCode)))];
        console.log(
          `  ${m.id.padEnd(36)} ${String(bad.length).padStart(2)}/${String(mine.length).padStart(2)} (${pct(bad.length, mine.length).padStart(6)})` +
            (detail.length > 0 ? `  創作された軸: ${detail.join(', ')}` : ''),
        );
      }

      console.log('\n--- 創作された評価軸ごとの件数 ---');
      const byAspect = new Map<string, number>();
      for (const s of samples) {
        for (const v of s.violations) byAspect.set(v.aspectCode, (byAspect.get(v.aspectCode) ?? 0) + 1);
      }
      for (const [code, n] of [...byAspect.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${code.padEnd(14)} ${n} 件`);
      }

      console.log('\n--- 店名の種類別 ---');
      for (const kind of ['fictional', 'real']) {
        const mine = samples.filter((s) => s.storeNameKind === kind);
        const bad = mine.filter((s) => s.violations.length > 0);
        console.log(`  ${kind.padEnd(12)} ${bad.length}/${mine.length} (${pct(bad.length, mine.length)})`);
      }

      if (violating.length > 0) {
        console.log('\n--- 逸脱サンプルの実例（先頭 3 件）---');
        for (const s of violating.slice(0, 3)) {
          console.log(`  [${s.materialId}] 選択=${s.selected.join('/') || 'なし'} 創作=${s.violations.map((v) => `${v.aspectCode}(${v.matchedTerm})`).join(', ')}`);
          console.log(`    ${s.draft}`);
        }
      }
      console.log('==========================================\n');

      if (OUT.length > 0) {
        writeFileSync(OUT, JSON.stringify({ runs: RUNS, samples, failures }, null, 2), 'utf8');
        console.log(`結果を ${OUT} へ書き出しました。`);
      }

      // 閾値は未合意（Issue #132 の求めること 3）。ここでは測定が成立したことだけを固定する。
      expect(samples.length, `生成が成功したサンプルがありません: ${failures.join(', ')}`).toBeGreaterThan(0);

      // 対照群: 全軸を選んだ素材は「選ばれなかった軸」が無いので構造的に 0 件でなければならない。
      // ここが 0 でなければ検出器か実行経路が壊れている（測定結果全体が信用できない）。
      const control = samples.filter((s) => s.materialId === 'all-selected-star5');
      expect(control.flatMap((s) => s.violations), '対照群で逸脱が検出されました').toEqual([]);
    },
    // 12 素材 × 3 回 × 約 2 秒 + 再試行の余裕。
    10 * 60 * 1000,
  );
});
