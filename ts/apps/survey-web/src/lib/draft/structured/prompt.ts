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
//   - 星の数そのもの: 星は「全体の印象」（★4〜5 は満足・★1〜2 は不満が残った・★3 は渡さない）へ丸める。しかも
//     **任意の締めの合図** で、生成ごとにサーバーが渡すかどうかを決める（OVERALL_RATE）。毎回渡すと「全体として満足です」
//     が毎回最後に付いた（実 Gemini・2026-10-11）。星から具体的な理由・強い言葉を作らせない
// 一言は内容としても、口調の参考としても使ってよい（人物像は推測しない）。
//
// 再生成のバリエーション: 同じ回答から作り直しても語尾だけが変わり、項目の順番と文の組み立てが固定だった。そこで
// 生成ごとにサーバーが「文章の組み立て」（COMPOSITIONS）・項目の並び（回答の行の順）・文体・総評の有無を選ぶ。
// 再生成では「前とは違う組み立てにする」決まった指示だけを足す。**前回の下書きはモデルへ渡さない。** 前回の文は
// 客の端末から戻ってくる値で、渡せば指示やまだ検査していない事実の持ち込み口になる。組み立てをサーバー側で
// 変えれば、事実の源（回答）を一切増やさずに構成を変えられる。

export const REALIZER_MARKER = '[structured-review-realizer]';

const SYSTEM_INSTRUCTION = `${REALIZER_MARKER}
あなたは飲食店を利用したお客さん本人です。アンケートで答えた内容をもとに、Google の口コミ欄に自分で書き込むような感想を日本語で書きます。

自然に書くために:
- アンケートの項目を順番に読み上げない。思い出しながら話すように、近い内容は 1 文にまとめ、順番や文のつなぎは自由に変えてよい。同じ主語や同じ文末（「〜が良かったです。」など）を続けない。
- 項目名をそのまま使わなくてよい。意味が変わらない範囲で、「味」→「おいしかった」、「接客の丁寧さ」→「丁寧に対応してもらえた」、「量」→「満足できる量だった」、「居心地」→「居心地よく過ごせた」のように普段の言葉にする。
- 「少し」「やや」「満足できた」「印象に残った」「過ごしやすかった」くらいの控えめな気持ちの言葉は使ってよい。
- 良かったことと気になったことの両方があれば、どちらも伝わるように書く（良い / 気になるの向きは変えない）。項目を 1 つずつ書き並べる必要はなく、同じ料理の項目はまとめてよい。料理名・ドリンク名は回答の表記のまま、すべて入れる。
- 「満足できる内容でした」「満足できるものでした」「良い内容でした」のように、「内容」「もの」でまとめる言い方をしない。「量にも満足できました」「量もしっかりあって満足でした」のように直接言う。
- 「全体として満足」のような総評は必須ではない。良かったこと・気になったことだけで自然に終わってよい。
- 気になったことが 2 つ以上あるときは「〜だけ気になった」と書かない。
- 一言があれば、内容も口調（くだけた言い方・「！」など）も活かしてよい。書き手の年齢・性別・人柄は推測しない。
- 長さは内容に合わせる。項目が少なければ 1〜2 文の短い感想でよい。

書かないこと（回答や一言に無い限り）:
- 具体的な事実の創作: 数字や時間（「20分」など）、理由や原因（混んでいた・人手が足りない など）、味や見た目の具体的な描写（新鮮・香ばしい・柔らかい など）、店員の様子（笑顔・忙しそう など）、いつ・誰と・何のために来たか
- 回答に無い料理・ドリンクや項目。項目の指定が無い料理は「良かった」「印象に残った」くらいにとどめ、味・量・見た目を補わない
- 「とても」「最高」「絶対」のような強い言葉、「また行きたい」「おすすめ」、来店前の期待
- 同じ項目が良かったと気になったの両方にあるときの理由や条件（最初と後半・部位・時間帯 など）。両方あったことだけを書く
- 一言の内容を、他の項目の理由として結びつけること。回答の項目どうしも「〜のおかげで」「〜のおかげか」のような因果で結ばない

JSON {"draft": "..."} の形で返してください。`;

/**
 * 文章の組み立ての候補（内容は変えない）。生成ごとにサーバーが、回答に対して成り立つ候補から選ぶ。
 * needs: any＝いつでも／both＝良かったことと気になったことの両方がある／multi＝主題が 2 つ以上。
 * 語尾や同義語ではなく、情報の順番・文の分け方・まとめ方そのものを変える候補だけを置く。
 */
export interface Composition {
  readonly id: string;
  readonly text: string;
  readonly needs: 'any' | 'both' | 'multi';
}

export const COMPOSITIONS: readonly Composition[] = [
  { id: 'plain', text: '2〜3 文で、思いついた順に素直に書く。', needs: 'any' },
  { id: 'combined', text: '近い項目を 1 文にまとめ、全体を 1〜2 文で書く。', needs: 'any' },
  { id: 'contrast', text: '良かったことを先にまとめて書き、気になったことは後半で「〜ましたが」などでつなぐ。', needs: 'both' },
  { id: 'split', text: '3〜4 の短めの文に分ける。気になったことは独立した文にする。', needs: 'both' },
  { id: 'concernFirst', text: '気になったことから書き始め、良かったことを後に書く。', needs: 'both' },
  { id: 'highlight', text: '一番印象に残った良かったことから書き始め、残りの項目は 1 文にまとめる。', needs: 'multi' },
];

/** 回答に対して成り立つ組み立ての候補（素材の有無だけを見る）。 */
export function availableCompositions(claims: readonly StructuredClaim[]): Composition[] {
  const hasBoth = claims.some((c) => c.polarity === 'positive') && claims.some((c) => c.polarity === 'concern');
  const subjects = new Set(claims.map((c) => `${c.polarity}:${claimSubjectKey(c)}`)).size;
  return COMPOSITIONS.filter((c) => c.needs === 'any' || (c.needs === 'both' ? hasBoth : subjects >= 2));
}

/**
 * 文体の候補（legacy の TONES から、文の形だけを変えるものを取り込んだ）。一言があるときは一言の口調に合わせる
 * （COMMENT_TONE）。感情の強さを変える候補（「明るい」など）と、会話調（「〜だったよ」）を呼んだ常体は置かない。
 */
export const TONES: readonly string[] = ['丁寧すぎない敬体', '簡潔な敬体', '体言止めを少し交えた敬体'];
export const COMMENT_TONE = '一言の口調に合わせる（くだけた一言なら、くだけた書き方でよい）';

/** 星由来の総評を渡す割合（任意の締めの合図・渡さない生成の方が多い）。 */
export const OVERALL_RATE = 0.35;

/** 再生成のときだけ足す決まった指示（前回の下書きそのものは渡さない）。 */
export const REGENERATION_NOTE =
  '作り直し: 前に作った文章とは違う組み立てにする。語尾や同義語の置き換えではなく、情報の順番・文の分け方・まとめ方を変える。';

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
  /** 回答の星（全体の印象へ丸めて渡す）。省略したとき・includeOverall が false のときは全体の印象を渡さない。 */
  readonly star?: number;
  /** 星由来の総評を渡すか（任意の締めの合図・サーバーが生成ごとに決める）。既定 true。 */
  readonly includeOverall?: boolean;
  /** COMPOSITIONS から選んだ文章の組み立て。 */
  readonly composition: string;
  /** 再生成（「別の文章を生成」）か。true なら REGENERATION_NOTE を足す。 */
  readonly regeneration?: boolean;
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
  const overall = input.star === undefined || input.includeOverall === false ? null : overallImpression(input.star);
  const tone = comment !== undefined ? COMMENT_TONE : input.tone;
  const lines = [
    '回答:',
    ...(positive.length > 0 ? ['良かったところ:', ...positive] : []),
    ...(concern.length > 0 ? ['気になったところ:', ...concern] : []),
    ...(overlap ? ['（同じ項目が良かったところと気になったところの両方にあります。両方あったことだけを書いてください）'] : []),
    ...(comment !== undefined ? [`一言: 「${comment}」`] : []),
    ...(overall !== null
      ? [`全体の印象: ${overall}（書いても書かなくてもよい。書くなら短く、言い方も置く場所も自由。理由や強い言葉は足さない）`]
      : []),
    '',
    `文章の組み立て: ${input.composition}`,
    ...(tone !== undefined ? [`文体: ${tone}`] : []),
    ...(input.regeneration === true ? [REGENERATION_NOTE] : []),
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
  cause: '理由や原因（混雑・忙しさ・「〜のおかげで」「〜のおかげか」など）を書かない。回答の項目どうしも原因と結果で結ばない。',
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
  // style（事実としては安全な不自然さ）。2 回目にこれだけが残っても safe fallback へは落とさない（style.ts）。
  'style:abstractEvaluation': '「満足できる内容」「満足できるもの」のようにまとめず、「量にも満足できました」のように直接書く。',
  'style:repetitiveEnding': '同じ文末を続けない。文の長さとつなぎ方を変える。',
};
