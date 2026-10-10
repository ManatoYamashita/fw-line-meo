import { claimSubjectKey, overlappingIdentities, type StructuredClaim } from './claims';

// structured の通常生成のプロンプト（Issue #439）。**事実の境界はコード（claims と hard gate）が主で、プロンプトは自然な
// 口コミを書かせることだけに集中する。**
//
// 方針（2026-10-11 の最終調整）: 初回の生成も「別の文章を生成」も、**同じプロンプトで独立にもう一度生成するだけ** である。
// 以前は再生成のバリエーションのために、文体・文章の組み立て・項目の並び・総評の有無をサーバーが抽選し、再生成では
// 「前と違う構成にする」指示を足していた。実 Gemini でこれが品質のばらつき（体言止めの断片・不自然な言い回し）を生んだ
// ので、すべて外した。文章が多少似ても、品質が安定している方を優先する（Gemini 自身の生成の揺らぎに任せる）。
//
// 素材に入れないもの:
//   - 店名: 店名から書き始める定型を避ける（Google の口コミは店のページに載るので、店名は要らない）
//   - 星: 星から総評・理由・強い言葉を作らせない（総評の定型「全体として満足です」が毎回付いた）
// 一言は内容として使ってよい（人物像は推測しない）。前回の下書きはモデルへ渡さない（客の端末から戻る値を事実の源に
// しない）。

export const REALIZER_MARKER = '[structured-review-realizer]';

const SYSTEM_INSTRUCTION = `${REALIZER_MARKER}
あなたは飲食店を利用したお客さん本人です。
回答内容をもとに、一般の利用者が Google 口コミにそのまま投稿するような自然な日本語の文章を書いてください。

- 自然なです・ます調で書き、回答項目を箇条書きのようにそのまま並べず、必要に応じて自然にまとめてください。
- 良かったことと気になったことの両方があれば、どちらも伝わるように書いてください（良い / 気になるの向きは変えない）。料理名・ドリンク名は回答の表記のまま入れてください。
- 回答から自然に導ける言い換えは構いません（例:「味」→「おいしかった」、「量」→「量にも満足できました」、「入店までの待ち時間」→「入店までスムーズでした」）。
- 新しい具体的事実、数量、原因、来店状況（いつ・誰と・何のために）、料理の具体的な描写や店員の様子は作らないでください。「待ち時間がなかった」「すぐ入れた」のように回答より強く言い切らないでください。「とても」「最高」のような強い言葉、「また行きたい」「おすすめ」も書かないでください。
- 独立した回答同士を、勝手に因果関係として結ばないでください（例:「予約していたので待たずに入れた」は書かない）。
- 同じ項目が良かったと気になったの両方にあるときは、両方あったことだけを書き、理由や条件は付けないでください。
- 「満足できる内容でした」「〜があればと思いました」「嬉しいと感じました」のような不自然な言い方や、「料理の量も十分。」のような体言止めは使わず、「満足できました」「もう少し多いと嬉しかったです」「嬉しかったです」のように普通に書いてください。

JSON {"draft": "..."} の形で返してください。`;

/** 回答の 1 行（主題ごと）。claim の表示名だけを使い、code は出さない。並びは回答の検証が正規化した定義の順。 */
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
  /** 作り直しで足す注意（RETRY_NOTES の値だけ・検出器の出力そのものは入れない）。 */
  readonly retryNotes?: readonly string[];
}

export function buildRealizerPrompt(input: RealizerPromptInput): { systemInstruction: string; userContent: string } {
  const positive = answerLines(input.claims, 'positive');
  const concern = answerLines(input.claims, 'concern');
  const overlap = overlappingIdentities(input.claims).length > 0;
  const comment = input.comment !== undefined && input.comment.trim() !== '' ? input.comment : undefined;
  const lines = [
    '回答:',
    ...(positive.length > 0 ? ['良かったところ:', ...positive] : []),
    ...(concern.length > 0 ? ['気になったところ:', ...concern] : []),
    ...(overlap ? ['（同じ項目が良かったところと気になったところの両方にあります。両方あったことだけを書いてください）'] : []),
    ...(comment !== undefined ? [`一言: 「${comment}」`] : []),
    ...(input.retryNotes !== undefined && input.retryNotes.length > 0
      ? ['', '前回の文章は次の点を守れていませんでした。意味は変えずに書き直してください:', ...input.retryNotes.map((n) => `- ${n}`)]
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
  cause: '理由や原因（混雑・忙しさ・「〜のおかげで」など）を書かない。回答の項目どうしも「〜ので」「〜のおかげで」のように原因と結果で結ばない。',
  timing: '時間帯や日時（昼・夜・週末など）を書かない。',
  companion: '誰と行ったか・来店の目的を書かない。',
  visitContext: '来店のきっかけや経緯を書かない。',
  expectation: '来店前の期待を書かない。',
  revisit: 'また行きたい・次回なども書かない。',
  recommendation: 'おすすめ・ぜひ行ってみて、などを書かない。',
  intensity: '「とても」「最高」のような強い言葉を足さない（「少し」「やや」程度はよい）。',
  overstatement: '「待ち時間がなかった」「すぐ入れた」のように回答より強く言い切らない（「入店までスムーズでした」程度にする）。',
  polarityReversal: '良かったところは良く、気になったところは気になったこととして、向きを変えずに書く。',
  positiveDropped: '良かったところを必ず書く。',
  concernDropped: '気になったところを必ず書く。',
  targetDropped: '回答にある料理・ドリンクの名前をすべて、回答の表記のまま書く。',
  overlapReason: '良かったところと気になったところが両方あったことだけを書き、その理由や条件を書かない。',
  commentLinkage: '一言の内容を、他の項目の理由として結びつけない。',
  absence: '回答に無いことを「無かった」「特にない」と書かない。',
  ungrounded: '回答に無い固有名詞・数字・日付を書かない。',
  caseForbidden: '回答に無い事情を書かない。',
  // style（事実としては安全な不自然さ）。最後の試行にこれだけが残っても、その LLM の文を返す（style.ts）。
  'style:abstractEvaluation': '「満足できる内容」「満足できるもの」のようにまとめず、「量にも満足できました」のように直接書く。',
  'style:repetitiveEnding': '同じ文末を続けない。文の長さとつなぎ方を変える。',
  'style:awkwardPhrase': '「〜があればと思いました」「嬉しいと感じました」や体言止めを使わず、「もう少し多いと嬉しかったです」「満足できました」のように普通のです・ます調で書く。',
};
