import { splitSentences, type StructuredGateLexicon } from './gate';

// structured の下書きの style check（自然さ）。**factuality の hard gate とは分ける。**
//
// hard gate（gate.ts）は「事実として言ってはいけないこと」を止める。ここは事実としては安全だが不自然な言い方
// （「満足できる内容でした」・同じ文末の羅列）を拾う。扱いの違い:
//   1 回目: factuality NG でも style NG でも作り直す（style の注意だけを足すこともある）
//   2 回目: factuality NG なら safe fallback。style NG だけなら、その LLM の文をそのまま返す
// 「少し不自然だが事実として安全な LLM の文」は、決定的な safe fallback の文より自然なことが多い。style だけを理由に
// safe fallback へ落とさない。
//
// 種類（頭に `style:` を付けて、作り直し・結果の記録に載せる。本文は載せない）:
//   abstractEvaluation  「満足できる内容」「満足できるもの」「良い内容」（語彙は lexicon.json の aiish.naiyou・診断と同じ）
//   repetitiveEnding    同じ文末（末尾 3 字）が 3 文以上続く（「Xでした。Yでした。Zでした。」）

export type StyleIssue = 'style:abstractEvaluation' | 'style:repetitiveEnding';

function ending(sentence: string): string {
  return sentence.replace(/[。！!？?\s]+$/u, '').slice(-3);
}

/** 下書きの style の問題を返す（無ければ空）。一言に同じ言い方があれば数えない（客の言葉である）。 */
export function detectStyleIssues(draft: string, lex: StructuredGateLexicon, comment?: string): StyleIssue[] {
  const issues: StyleIssue[] = [];
  const abstract = lex.aiish.naiyou ?? [];
  if (abstract.some((p) => p.test(draft) && !(comment !== undefined && p.test(comment)))) issues.push('style:abstractEvaluation');
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
