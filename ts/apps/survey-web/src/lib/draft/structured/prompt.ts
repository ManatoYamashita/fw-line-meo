import { claimSubjectKey, overlappingIdentities, type StructuredClaim } from './claims';

// structured の通常生成のプロンプト（Issue #439・自然さ重視への方針変更）。**事実の境界はコード（claims と hard gate）が
// 主で、プロンプトは自然な口コミを書かせることを前面に出す。**
//
// 方針: 新しい具体的事実は創作させない。ただし、回答から自然に導ける主観的・意味を保った膨らませ方は許す
// （「味」→「おいしかった」・「量」→「満足できる量だった」・「少し気になった」・「印象に残った」）。
// 禁止事項を大量に並べるとモデルが萎縮し、項目の読み上げ（「Xが気になりましたが、Yは満足できました。Zは丁寧でした。」）
// になる。禁止は「足しがちな具体的事実」の型に絞り、書き方の自由（統合・並べ替え・省略・語順・口調）を先に書く。
//
// legacy の生成器（src/lib/draft/prompt.ts）の文章が自然に見えるのは、文体をサーバーが候補から選び（敬体・常体・
// 体言止め）、満足の度合いで締める自由があり、項目名を項目名のまま書けとは言っていないからである。そのうち事実を
// 増やさないもの（文体の候補・抽象的な全体の満足）だけを取り込んだ。字数の下限（100〜200 字）は創作を呼ぶので
// 取り込まない（legacy の Issue #132 の実測）。
//
// 素材に入れないもの:
//   - 店名: 店名から書き始める定型を避ける（Google の口コミは店のページに載るので、店名は要らない）
//   - 星の数そのもの: 星は「全体の印象」（★4〜5 は満足・★1〜2 は不満が残った・★3 は渡さない）へ丸めて、書くなら
//     最後に短く添える程度にとどめる。星から具体的な理由・強い言葉を作らせない
// 一言は内容としても、口調の参考としても使ってよい（人物像は推測しない）。

export const REALIZER_MARKER = '[structured-review-realizer]';

const SYSTEM_INSTRUCTION = `${REALIZER_MARKER}
あなたは飲食店を利用したお客さん本人です。アンケートで答えた内容をもとに、Google の口コミ欄に自分で書き込むような感想を日本語で書きます。

自然に書くために:
- アンケートの項目を順番に読み上げない。思い出しながら話すように、近い内容は 1 文にまとめ、順番や文のつなぎは自由に変えてよい。同じ主語や同じ文末（「〜が良かったです。」など）を続けない。
- 項目名をそのまま使わなくてよい。意味が変わらない範囲で、「味」→「おいしかった」、「接客の丁寧さ」→「丁寧に対応してもらえた」、「量」→「満足できる量だった」、「居心地」→「居心地よく過ごせた」のように普段の言葉にする。
- 「少し」「やや」「満足できた」「印象に残った」「過ごしやすかった」くらいの控えめな気持ちの言葉は使ってよい。
- 良かったことと気になったことの両方があれば、どちらも伝わるように書く（良い / 気になるの向きは変えない）。項目を 1 つずつ書き並べる必要はなく、同じ料理の項目はまとめてよい。料理名・ドリンク名は回答の表記のまま、すべて入れる。
- 一言があれば、内容も口調（くだけた言い方・「！」など）も活かしてよい。書き手の年齢・性別・人柄は推測しない。
- 長さは内容に合わせる。項目が少なければ 1〜2 文の短い感想でよい。

書かないこと（回答や一言に無い限り）:
- 具体的な事実の創作: 数字や時間（「20分」など）、理由や原因（混んでいた・人手が足りない など）、味や見た目の具体的な描写（新鮮・香ばしい・柔らかい など）、店員の様子（笑顔・忙しそう など）、いつ・誰と・何のために来たか
- 回答に無い料理・ドリンクや項目。項目の指定が無い料理は「良かった」「印象に残った」くらいにとどめ、味・量・見た目を補わない
- 「とても」「最高」「絶対」のような強い言葉、「また行きたい」「おすすめ」、来店前の期待
- 同じ項目が良かったと気になったの両方にあるときの理由や条件（最初と後半・部位・時間帯 など）。両方あったことだけを書く
- 一言の内容を、他の項目の理由として結びつけること

JSON {"draft": "..."} の形で返してください。`;

/** 文章の形の候補（内容は変えない）。再生成のたびにサーバーが選ぶ。 */
export const STRUCTURE_HINTS: readonly string[] = [
  '1〜2 文で短くまとめる。',
  '2〜3 文に分け、文の長さに変化をつける。',
  '一番印象に残ったことから書き始める。',
  '良かったことと気になったことがあれば、1 文の中でつないでもよい。',
];

/**
 * 文体の候補（legacy の TONES から、文の形だけを変えるものを取り込んだ）。一言があるときは一言の口調に合わせる
 * （COMMENT_TONE）。感情の強さを変える候補（「明るい」など）は置かない。
 */
export const TONES: readonly string[] = ['話し言葉に近い敬体', '体言止めを交えた敬体', '親しみやすい常体', '簡潔で落ち着いた敬体'];
export const COMMENT_TONE = '一言の口調に合わせる（くだけた一言なら、くだけた書き方でよい）';

/** 星を全体の印象へ丸める（★3 は渡さない）。具体的な理由や強度は作らせない。 */
export function overallImpression(star: number): string | null {
  if (star >= 4) return '満足';
  if (star <= 2) return '不満が残った';
  return null;
}

/** 回答の 1 行（主題ごと）。claim の表示名だけを使い、code は出さない。 */
function answerLines(claims: readonly StructuredClaim[], polarity: StructuredClaim['polarity']): string[] {
  const lines: string[] = [];
  const done = new Set<string>();
  for (const claim of claims.filter((c) => c.polarity === polarity)) {
    const key = claimSubjectKey(claim);
    if (done.has(key)) continue;
    done.add(key);
    const same = claims.filter((c) => c.polarity === polarity && claimSubjectKey(c) === key);
    if (claim.kind === 'category_facet') {
      lines.push(`- ${claim.facetLabel}（${claim.categoryLabel}）`);
      continue;
    }
    const facets = same.flatMap((c) => (c.kind === 'target_facet' ? [c.facetLabel] : []));
    lines.push(
      facets.length > 0
        ? `- ${claim.targetLabel}（${claim.categoryLabel}）: ${facets.join('、')}`
        : `- ${claim.targetLabel}（${claim.categoryLabel}）: 料理・ドリンクそのもの（項目の指定なし）`,
    );
  }
  return lines;
}

export interface RealizerPromptInput {
  readonly claims: readonly StructuredClaim[];
  readonly comment?: string;
  /** 回答の星（全体の印象へ丸めて渡す）。省略したときは全体の印象を渡さない。 */
  readonly star?: number;
  /** STRUCTURE_HINTS から選んだ文章の形。 */
  readonly structureHint: string;
  /** TONES から選んだ文体（一言があるときは COMMENT_TONE が優先）。 */
  readonly tone?: string;
  /** 2 回目の生成で足す注意（RETRY_NOTES の値だけ・検出器の出力そのものは入れない）。 */
  readonly retryNotes?: readonly string[];
}

export function buildRealizerPrompt(input: RealizerPromptInput): { systemInstruction: string; userContent: string } {
  const positive = answerLines(input.claims, 'positive');
  const concern = answerLines(input.claims, 'concern');
  const overlap = overlappingIdentities(input.claims).length > 0;
  const comment = input.comment !== undefined && input.comment.trim() !== '' ? input.comment : undefined;
  const overall = input.star === undefined ? null : overallImpression(input.star);
  const tone = comment !== undefined ? COMMENT_TONE : input.tone;
  const lines = [
    '回答:',
    ...(positive.length > 0 ? ['良かったところ:', ...positive] : []),
    ...(concern.length > 0 ? ['気になったところ:', ...concern] : []),
    ...(overlap ? ['（同じ項目が良かったところと気になったところの両方にあります。両方あったことだけを書いてください）'] : []),
    ...(comment !== undefined ? [`一言: 「${comment}」`] : []),
    ...(overall !== null ? [`全体の印象: ${overall}（書くなら最後に短く添える程度。理由や強い言葉は足さない）`] : []),
    '',
    `文章の形: ${input.structureHint}`,
    ...(tone !== undefined ? [`文体: ${tone}`] : []),
    ...(input.retryNotes !== undefined && input.retryNotes.length > 0
      ? ['', '前回の文章は次の点を守れていませんでした。意味は変えずに、言い回し・順番・文の分け方を変えて書き直してください:', ...input.retryNotes.map((n) => `- ${n}`)]
      : []),
  ];
  return { systemInstruction: SYSTEM_INSTRUCTION, userContent: lines.join('\n') };
}

/**
 * hard gate の種類（頭の名前）→ 2 回目の生成に足す注意。**決まった文だけ** を使い、検出した本文の断片
 * （下書きや一言に由来する文字列）はプロンプトへ戻さない（モデルの出力をそのまま指示として再投入しない）。
 */
export const RETRY_NOTES: Readonly<Record<string, string>> = {
  unselectedTarget: '回答に無い料理・ドリンクを書かない。',
  unselectedFacet: '回答に無い項目（味・量・見た目・温度・接客・雰囲気・価格など）に触れない。',
  unselectedCategory: '回答に無い項目（接客・雰囲気・価格・予約など）に触れない。',
  newAttribute: '新鮮・香り・食感・店員の様子などの具体的な描写を足さない。',
  cause: '理由や原因（混雑・忙しさなど）を書かない。',
  timing: '時間帯や日時（昼・夜・週末など）を書かない。',
  companion: '誰と行ったか・来店の目的を書かない。',
  visitContext: '来店のきっかけや経緯を書かない。',
  expectation: '来店前の期待を書かない。',
  revisit: 'また行きたい・次回なども書かない。',
  recommendation: 'おすすめ・ぜひ行ってみて、などを書かない。',
  intensity: '「とても」「最高」のような強い言葉を足さない（「少し」「やや」程度はよい）。',
  polarityReversal: '良かったところは良く、気になったところは気になったこととして、向きを変えずに書く。',
  positiveDropped: '良かったところを必ず書く。',
  concernDropped: '気になったところを必ず書く。',
  targetDropped: '回答にある料理・ドリンクの名前をすべて、回答の表記のまま書く。',
  overlapReason: '良かったところと気になったところが両方あったことだけを書き、その理由や条件を書かない。',
  commentLinkage: '一言の内容を、他の項目の理由として結びつけない。',
  absence: '回答に無いことを「無かった」「特にない」と書かない。',
  ungrounded: '回答に無い固有名詞・数字・日付を書かない。',
  caseForbidden: '回答に無い事情を書かない。',
};
