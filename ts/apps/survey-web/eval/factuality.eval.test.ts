import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { createDefaultDraftGenerator } from '../src/lib/draft/generator';
import {
  pickVariation,
  materialThickness,
  LENGTH_RULE,
  VARIATION_CANDIDATES,
  type MaterialThickness,
  type VariationSeed,
} from '../src/lib/draft/prompt';
import type { DraftMaterial, Star } from '../src/lib/domain';
import { detectAspectMentions, readLexicon } from '../src/lib/draft/factuality';
import { detectVisitContextClaims, readVisitContextLexicon } from '../src/lib/draft/visit-context';
import lexiconRaw from '../src/lib/draft/aspect-lexicon.json';
import visitLexiconRaw from '../src/lib/draft/visit-context-lexicon.json';
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
const visitLexicon = readVisitContextLexicon(visitLexiconRaw);
const labels = aspectsRaw.labels as Record<string, string>;
const RUNS = Number.parseInt(process.env.EVAL_RUNS ?? '3', 10);
// 書き出しを 1 つに固定して流す（Issue #254: 候補ごとの創作率を同じ素材で比べるため）。
// 未指定なら本番と同じく pickVariation に任せる。候補に無い値は測定を始める前に止める
// （打ち間違いのまま流すと、存在しない書き出しの指示を測って結果を読み違える）。
// 固定は候補の成立条件（needs）を無視する。素材に無い情報を求める候補が何を起こすかを測るための
// 切り分け用であり、本番の構成を測るときは指定しない。
const FORCED_OPENING = process.env.EVAL_OPENING ?? '';
const OPENING_TEXTS = VARIATION_CANDIDATES.openings.map((c) => c.text);
if (FORCED_OPENING !== '' && !OPENING_TEXTS.includes(FORCED_OPENING)) {
  throw new Error(
    `EVAL_OPENING は書き出しの候補のいずれかである必要があります: ${OPENING_TEXTS.join(' / ')}`,
  );
}
function variationFor(material: DraftMaterial): VariationSeed {
  const picked = pickVariation(material);
  return FORCED_OPENING === '' ? picked : { ...picked, opening: FORCED_OPENING };
}
// 既定は本番と同じ構成（案A + 案B）。EVAL_POSTCHECK=0 で事後検証だけを外し、
// 案A（プロンプトでの禁止）単体の効果を測れるようにする。前後比較の意味を保つために要る。
const POST_CHECK = (process.env.EVAL_POSTCHECK ?? '1') !== '0';
const OUT = process.env.EVAL_OUT ?? '';
const hasKey = (process.env.GEMINI_API_KEY ?? '').length > 0;

interface Sample {
  readonly materialId: string;
  readonly storeNameKind: string;
  readonly selected: readonly string[];
  /** 選ばれた気になった点の code（Issue #221）。 */
  readonly concerns: readonly string[];
  /** 字数の指示を切り替える素材の厚み。**本番と同じ関数で判定する**（Issue #137 段階2）。 */
  readonly thickness: MaterialThickness;
  readonly draft: string;
  readonly violations: readonly { aspectCode: string; matchedTerm: string }[];
  /** この下書きを生成したときの変動要素（Issue #254: 候補ごとの内訳を取るため）。 */
  readonly variation: VariationSeed;
  /** 来店の経緯・動機などの創作（Issue #254）。未選択の観点への言及とは別の軸として数える。 */
  readonly visitClaims: readonly { category: string; matchedText: string }[];
}

/** 気になった点の code。省略した素材は「選ばなかった」として扱う（本番の validate と同じ）。 */
function concernCodesOf(m: (typeof datasetRaw.materials)[number]): string[] {
  return m.concernCodes ?? [];
}

function toDraftMaterial(m: (typeof datasetRaw.materials)[number]): DraftMaterial {
  const concernCodes = concernCodesOf(m);
  // 「選ばれた」は良かった点と気になった点の **どちらかに入っている** こと（Issue #221）。
  // 本番の /api/responses と同じ和集合から差集合を取る。良かった点だけから導くと、客が選んだ不満の
  // 観点を禁止句へ入れた「本番とは違うプロンプト」を測り、その観点への言及を逸脱と数えてしまう。
  const selected = new Set<string>([...m.aspectCodes, ...concernCodes]);
  const aspectLabels = m.aspectCodes.map((c: string) => labels[c] ?? c);
  const concernLabels = concernCodes.map((c) => labels[c] ?? c);
  // 本番の /api/responses と同じく、選ばれなかった観点も渡す（Issue #132・案 A）。
  // ここを渡さないと「本番とは違うプロンプト」を測ることになり、比較が成立しない。
  const unselectedEntries = Object.entries(labels).filter(([code]) => !selected.has(code));
  const base = {
    storeName: m.storeName,
    star: m.star as Star,
    aspectLabels,
    concernLabels,
    unselectedAspectLabels: unselectedEntries.map(([, label]) => label),
    unselectedAspectCodes: unselectedEntries.map(([code]) => code),
  };
  return m.comment === null ? base : { ...base, comment: m.comment };
}

function pct(numerator: number, denominator: number): string {
  return denominator === 0 ? 'n/a' : `${((numerator / denominator) * 100).toFixed(1)}%`;
}

/**
 * 見出しに出す字数帯を **LENGTH_RULE から導く**（PR #143 レビュー指摘）。
 *
 * ここを手書きすると、規則を変えたときに見出しだけが古い規則を名乗る。分割条件を
 * materialThickness へ寄せても、見出しの文字列が別の出所を持てば同じずれが再発する。
 * 字数帯を書かない規則へ変えたときは規則本文をそのまま出す（要約できないものを要約しない）。
 */
function lengthLabel(kind: MaterialThickness): string {
  const rule = LENGTH_RULE[kind];
  return /[0-9]+〜[0-9]+ 字/.exec(rule)?.[0] ?? rule.replace(/^- /, '');
}

describe.skipIf(!hasKey)('AI 下書きの事実性（実 Gemini・Requirement 3.2）', () => {
  const samples: Sample[] = [];
  const failures: string[] = [];

  it(
    `データセット ${datasetRaw.materials.length} 件 × ${RUNS} 回を生成して逸脱を測る`,
    async () => {
      const generator = await createDefaultDraftGenerator({ factualityCheck: POST_CHECK });

      for (const material of datasetRaw.materials) {
        const dm = toDraftMaterial(material);
        for (let run = 0; run < RUNS; run++) {
          const variation = variationFor(dm);
          const result = await generator.generate(dm, variation);
          if (!result.ok) {
            // 生成失敗はサンプルとして数えない。多発する場合は測定自体が成立していない。
            failures.push(`${material.id}#${run}: ${result.error.kind}`);
            continue;
          }
          samples.push({
            materialId: material.id,
            storeNameKind: material.storeNameKind,
            selected: material.aspectCodes,
            concerns: concernCodesOf(material),
            thickness: materialThickness(dm),
            draft: result.value,
            // 検証対象は本番と同じく「素材が持つ未選択 code」。プロンプトで禁止した集合と一致する。
            violations: detectAspectMentions(result.value, dm.unselectedAspectCodes ?? [], lexicon),
            variation,
            visitClaims: detectVisitContextClaims(result.value, dm.comment, visitLexicon),
          });
        }
      }

      // ---- レポート ----
      const violating = samples.filter((s) => s.violations.length > 0);
      console.log('\n===== 事実性評価レポート（Issue #132） =====');
      console.log(`構成: 案A（プロンプト禁止）+ 案B（事後検証）= ${POST_CHECK ? '有効' : '案A のみ'}`);
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

      // 来店の経緯・動機の創作（Issue #254）。未選択の観点への言及とは別の軸として数える。
      // アンケートは来店の事情を尋ねないので、一言に書かれていない限り、下書きに現れたら創作である。
      const visitClaiming = samples.filter((s) => s.visitClaims.length > 0);
      console.log('\n--- 来店の経緯・動機の創作（Issue #254）---');
      console.log(
        `  創作を含むサンプル: ${visitClaiming.length} / ${samples.length}（${pct(visitClaiming.length, samples.length)}）`,
      );
      const byCategory = new Map<string, number>();
      for (const s of samples) {
        for (const c of s.visitClaims) byCategory.set(c.category, (byCategory.get(c.category) ?? 0) + 1);
      }
      for (const [category, n] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${category.padEnd(14)} ${n} 件`);
      }

      // 変動要素の候補ごとの内訳（Issue #254）。候補の指示が素材に無い情報を求めていれば、
      // その候補だけ創作率が跳ねる。全体の率だけでは、どの候補が原因かを言えない。
      for (const [title, key, candidates] of [
        ['書き出し', 'opening', OPENING_TEXTS],
        ['切り口', 'angle', VARIATION_CANDIDATES.angles.map((c) => c.text)],
      ] as const) {
        console.log(`\n--- ${title}の候補ごと（未選択の観点への言及 / 来店の経緯・動機の創作）---`);
        for (const candidate of candidates) {
          const mine = samples.filter((s) => s.variation[key] === candidate);
          if (mine.length === 0) continue;
          const aspectBad = mine.filter((s) => s.violations.length > 0).length;
          const visitBad = mine.filter((s) => s.visitClaims.length > 0).length;
          const aspects = new Map<string, number>();
          for (const s of mine) for (const v of s.violations) aspects.set(v.aspectCode, (aspects.get(v.aspectCode) ?? 0) + 1);
          const top = [...aspects.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}×${n}`).join(' ');
          console.log(
            `  ${candidate}  n=${mine.length}  観点 ${aspectBad} (${pct(aspectBad, mine.length)})  経緯 ${visitBad} (${pct(visitBad, mine.length)})` +
              (top.length > 0 ? `  言及された観点: ${top}` : ''),
          );
        }
      }

      if (visitClaiming.length > 0) {
        console.log('\n--- 来店の経緯・動機の創作の実例（先頭 3 件）---');
        for (const s of visitClaiming.slice(0, 3)) {
          console.log(`  [${s.materialId}] 書き出し=${s.variation.opening} 創作=${s.visitClaims.map((c) => `${c.category}(${c.matchedText})`).join(', ')}`);
          console.log(`    ${s.draft}`);
        }
      }

      // 案C（素材が乏しいときは字数より事実性を優先）の副作用を見る。逸脱率だけを追うと
      // 「短く書けば逸脱しない」方向へ寄せた結果、口コミとして使えない下書きになっても気づけない。
      console.log('\n--- 下書きの字数 ---');
      const lengths = samples.map((s) => [...s.draft].length).sort((a, b) => a - b);
      const at = (q: number) => lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * q))];
      const inRange = lengths.filter((l) => l >= 100 && l <= 200).length;
      console.log(
        `  min=${lengths[0]} p10=${at(0.1)} 中央=${at(0.5)} p90=${at(0.9)} max=${lengths[lengths.length - 1]}`,
      );
      console.log(
        `  100〜200 字: ${inRange}/${lengths.length} (${pct(inRange, lengths.length)})` +
          `  100 字未満: ${lengths.filter((l) => l < 100).length} 件` +
          `  200 字超: ${lengths.filter((l) => l > 200).length} 件`,
      );
      // 分割は本番の materialThickness で、字数帯は本番の LENGTH_RULE で書く。どちらも自前で
      // 持つと、規則を変えたときに見出しと中身が静かにずれ、前後比較が読めなくなる。
      // 中間層と一言なしが同じ字数帯を出すなら、それは規則を共有しているという事実そのものである。
      for (const [label, kind] of [
        ['観点あり', 'aspects'],
        ['観点ゼロ＋一言あり', 'comment-only'],
        ['観点ゼロ＋一言なし', 'bare'],
      ] as const) {
        const mine = samples
          .filter((s) => s.thickness === kind)
          .map((s) => [...s.draft].length)
          .sort((a, b) => a - b);
        if (mine.length === 0) continue;
        console.log(
          `  ${`${label}（${lengthLabel(kind)}）`.padEnd(24)} n=${String(mine.length).padStart(3)}  中央=${mine[Math.floor(mine.length / 2)]}  min=${mine[0]}  max=${mine[mine.length - 1]}`,
        );
      }

      // 素材別の字数（段階2 の狙いは「中間層だけが伸びる」こと。全体の中央値では見えない）。
      console.log('\n--- 素材別の字数 ---');
      for (const material of datasetRaw.materials) {
        const mine = samples
          .filter((s) => s.materialId === material.id)
          .map((s) => [...s.draft].length)
          .sort((a, b) => a - b);
        if (mine.length === 0) continue;
        const kind = materialThickness(toDraftMaterial(material));
        console.log(
          `  ${material.id.padEnd(36)} ${kind.padEnd(12)} n=${String(mine.length).padStart(3)}  中央=${mine[Math.floor(mine.length / 2)]}  min=${mine[0]}  max=${mine[mine.length - 1]}`,
        );
      }

      if (violating.length > 0) {
        console.log('\n--- 逸脱サンプルの実例（先頭 3 件）---');
        for (const s of violating.slice(0, 3)) {
          console.log(`  [${s.materialId}] 選択=${s.selected.join('/') || 'なし'} 気になった点=${s.concerns.join('/') || 'なし'} 創作=${s.violations.map((v) => `${v.aspectCode}(${v.matchedTerm})`).join(', ')}`);
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

      // 書き出しを固定したときは、固定が実際に効いたことを確かめる（効いていなければ、別の条件を測っている）。
      if (FORCED_OPENING !== '') {
        expect(
          samples.filter((s) => s.variation.opening !== FORCED_OPENING),
          `EVAL_OPENING=${FORCED_OPENING} が効いていないサンプルがあります`,
        ).toEqual([]);
      }
    },
    // 20 素材 × 3 回 × 約 2 秒 + 再試行の余裕。
    10 * 60 * 1000,
  );
});
