import { splitSentences, type StructuredGateLexicon } from './gate';

// structured の下書きの style check（自然さ）。**診断用（評価・単体テスト）で、本番の作り直しの引き金にはしない**（2026-10-11 の大幅簡素化）。
//
// hard gate（gate.ts）は「事実として言ってはいけないこと」を止める。ここは事実としては安全だが不自然な言い方
// （「満足できる内容でした」・同じ文末の羅列）を拾う。本番は style では作り直さず、事実として安全な LLM の文をそのまま
// 返す（日本語として多少好みでない文でも、Gemini 自身の文章を優先する）。
//
// 種類（頭に `style:` を付けて、作り直し・結果の記録に載せる。本文は載せない）:
//   abstractEvaluation  「満足できる内容」「満足できるもの」「良い内容」（語彙は lexicon.json の aiish.naiyou・診断と同じ）
//   repetitiveEnding    同じ文末（末尾 3 字）が 3 文以上続く（「Xでした。Yでした。Zでした。」）
//   awkwardPhrase       「〜があればと思いました」「嬉しいと感じました」・体言止めの断片（「料理の量も十分。」）（aiish.awkward）

export type StyleIssue = 'style:abstractEvaluation' | 'style:repetitiveEnding' | 'style:awkwardPhrase';

function ending(sentence: string): string {
  return sentence.replace(/[。！!？?\s]+$/u, '').slice(-3);
}

/** 下書きの style の問題を返す（無ければ空）。一言に同じ言い方があれば数えない（客の言葉である）。 */
export function detectStyleIssues(draft: string, lex: StructuredGateLexicon, comment?: string): StyleIssue[] {
  const issues: StyleIssue[] = [];
  const abstract = lex.aiish.naiyou ?? [];
  if (abstract.some((p) => p.test(draft) && !(comment !== undefined && p.test(comment)))) issues.push('style:abstractEvaluation');
  const awkward = lex.aiish.awkward ?? [];
  if (awkward.some((p) => p.test(draft) && !(comment !== undefined && p.test(comment)))) issues.push('style:awkwardPhrase');
  let run = 0;
  let prev = '';
  for (const s of splitSentences(draft)) {
    const e = ending(s);
    run = e !== '' && e === prev ? run + 1 : 1;
    prev = e;
    if (run >= 3) {
      issues.push('style:repetitiveEnding');
      break;
    }
  }
  return issues;
}
