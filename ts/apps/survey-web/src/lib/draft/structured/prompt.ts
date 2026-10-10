import { claimSubjectKey, overlappingIdentities, type StructuredClaim } from './claims';

// Natural LLM Realizer のプロンプト（Issue #439）。**事実の境界はコード（claims と hard gate）が主で、プロンプトは補助である。**
// LLM に任せるのは、claim の意味を保った言い換え・統合・語順・文の分け方・接続だけ。巨大な規則の一覧にすると文が
// 硬直するので、禁止は「足しがちなもの」に絞って短く書く。
//
// 素材に入れないもの:
//   - 星評価: 星から具体的な理由や程度を作らせない（Issue #439 の 8・requirements で星の意味が確定するまで）
//   - 店名: 店名から書き始める定型を避ける（Google の口コミは店のページに載るので、店名は要らない）
// 一言は内容としても、文章の硬さの参考としても使ってよい（人物像は推測しない）。

export const REALIZER_MARKER = '[structured-review-realizer]';

const SYSTEM_INSTRUCTION = `${REALIZER_MARKER}
あなたは飲食店を利用したお客さん本人として、Google の口コミに投稿する文章を日本語で書きます。
書いてよいのは「回答」にある内容だけです。

- 回答の良かったところ・気になったところは、どちらも漏らさず書き、良い / 気になるの向きを変えない。
- 料理名・ドリンク名は回答の表記のまま書く。同じ料理の項目は 1 文にまとめてよい。
- 回答に無いことは書かない。特に、味・見た目・量・温度などの具体的な描写、理由や原因、時間帯、一緒に行った人、来店の目的、待ち時間の長さ、また行きたい・おすすめしたい・期待していた、といった内容を足さない。
- 「とても」「少し」など程度を表す言葉を足さない。
- 同じ項目が良かったところと気になったところの両方にあるときは、両方あったことだけを書き、理由や条件（時間・部位・最初と後半・好み など）は書かない。
- 一言があれば、その内容を含めてよく、文章の硬さや口調の参考にしてよい。一言の内容を他の項目の理由として結びつけない。書き手の年齢や性別を推測しない。

文章は、普通の利用者が自分で書いた口コミのように自然にしてください。アンケートの項目を順番に読み上げない。「全体として」「一方で」「好印象」のようなまとめの言い方で整えない。項目が少なければ短くてかまいません。
JSON {"draft": "..."} の形で返してください。`;

/** 文章の形だけを変える候補（内容は変えない）。再生成のたびにサーバーが選ぶ。 */
export const STRUCTURE_HINTS: readonly string[] = [
  '1〜2 文にまとめる。',
  '短い文を 2〜3 つに分ける。',
  '書く順番は回答の順でなくてよい。印象に残った項目から書いてよい。',
  '気になったところがあれば、良かったところと 1 文の中でつないでよい。',
];

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
  /** STRUCTURE_HINTS から選んだ文章の形。 */
  readonly structureHint: string;
  /** 2 回目の生成で足す注意（RETRY_NOTES の値だけ・検出器の出力そのものは入れない）。 */
  readonly retryNotes?: readonly string[];
}

export function buildRealizerPrompt(input: RealizerPromptInput): { systemInstruction: string; userContent: string } {
  const positive = answerLines(input.claims, 'positive');
  const concern = answerLines(input.claims, 'concern');
  const overlap = overlappingIdentities(input.claims).length > 0;
  const lines = [
    '回答:',
    ...(positive.length > 0 ? ['良かったところ:', ...positive] : []),
    ...(concern.length > 0 ? ['気になったところ:', ...concern] : []),
    ...(overlap ? ['（同じ項目が良かったところと気になったところの両方にあります。両方あったことだけを書いてください）'] : []),
    ...(input.comment !== undefined && input.comment.trim() !== '' ? [`一言: 「${input.comment}」`] : []),
    '',
    `文章の形: ${input.structureHint}`,
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
  newAttribute: '新鮮・香り・食感などの具体的な描写を足さない。回答の項目名の範囲で書く。',
  cause: '理由や原因（混雑・忙しさなど）を書かない。',
  timing: '時間帯や日時（昼・夜・週末など）を書かない。',
  companion: '誰と行ったか・来店の目的を書かない。',
  visitContext: '来店のきっかけや経緯を書かない。',
  expectation: '来店前の期待を書かない。',
  revisit: 'また行きたい・次回なども書かない。',
  recommendation: 'おすすめ・ぜひ行ってみて、などを書かない。',
  intensity: '「とても」「少し」など程度を表す言葉を使わない。',
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
