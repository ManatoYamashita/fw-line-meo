import { claimSubjectKey, overlappingIdentities, type StructuredClaim } from './claims';

// structured の通常生成のプロンプト（Issue #439）。**事実の境界はコード（claims と hard gate）が主で、プロンプトは自然な
// 口コミを書かせることだけに集中する。**
//
// 目的（2026-10-11 の見直し）: 「アンケート回答を自然な日本語に変換した文章」ではなく、**実際に利用した本人が自分の体験を
// 振り返って Google 口コミに書いたような文章** を作る。以前の指示（「回答を参考に」「読み上げる必要はない」と、項目を
// 見出しで並べた入力・末尾の「一言」）では、モデルが項目ごとに 1 文を作り、一言を補足として扱った（項目の読み上げ・
// 「満足できる内容でした」への抽象化）。そこで次のように変えた:
//   - 選んだ項目は「1 つずつ文章にする材料」ではなく「何についてどう感じたかの手がかり」と位置づける
//   - 本人が書いた感想（一言）があれば **口コミの中心** にし、誤字・語順・重複を整えつつ本人の言葉を残させる
//   - 自然に言える主観の言い換えは自由・素材に無い具体的な様子だけは足さない、の 1 本に絞る
// 明確な捏造はコード（runtimeViolations）が止める。プロンプトへ禁止事項を積み増さない。
//
// 初回の生成も「別の文章を生成」も、**同じプロンプトで独立にもう一度生成するだけ** である。
// 以前は再生成のバリエーションのために、文体・文章の組み立て・項目の並び・総評の有無をサーバーが抽選し、再生成では
// 「前と違う構成にする」指示を足していた。実 Gemini でこれが品質のばらつき（体言止めの断片・不自然な言い回し）を生んだ
// ので、すべて外した（Gemini 自身の生成の揺らぎに任せる）。
//
// 素材に入れないもの:
//   - 店名: 店名から書き始める定型を避ける（Google の口コミは店のページに載るので、店名は要らない）
//   - 星: 星から総評・理由・強い言葉を作らせない（総評の定型「全体として満足です」が毎回付いた）
// 前回の下書きはモデルへ渡さない（客の端末から戻る値を事実の源にしない）。

export const REALIZER_MARKER = '[structured-review-realizer]';

const SYSTEM_INSTRUCTION = `${REALIZER_MARKER}
実際にこの店を利用した本人として、Google 口コミ欄に投稿する口コミを書いてください。
入力は、本人がアンケートで選んだ項目と、本人が書いた感想（ある場合）です。

選んだ項目は、1 つずつ文章にするための材料ではなく、本人が何についてどう感じたかを知る手がかりです。
入力全体から「この人がこの店でどんな印象を持ったか」をつかみ、1 つの口コミとして書いてください。
項目を順番に並べたり、1 項目を 1 文にしたりしないでください。意味が近いものはまとめてよく、すべてを均等に書く必要もありません。

本人が書いた感想がある場合は、それを口コミの中心にしてください。
誤字・脱字・話し言葉・語順の乱れ・重複は直して読みやすく整えてください。ただし要約や抽象的な言い換え（「満足度の高い内容でした」など）にはせず、本人が使った具体的な言葉や感覚をできるだけ残してください。

「ボリュームに満足した」「気持ちよく利用できた」「もう少し選べると嬉しい」のような、選んだ項目から自然に言える主観的な言い換えは自由です。
本人が選んでも書いてもいない具体的な様子（新鮮だった・サクサクだった・店員が笑顔だった・5 分で入れた など）は足さないでください。

目標は、本人が自分で書いた口コミを少し上手に整えたような文章です。アンケートの要約・レポート・広告のような文章、褒めすぎ、かしこまりすぎた言い方、「〜だよ」「〜かな」のようなくだけすぎた言い方、付け足しの総評は避けてください。材料が少なければ 1〜2 文で構いません。

JSON {"draft": "..."} の形で返してください。`;

/** 選んだ項目の 1 行（主題ごと）。claim の表示名だけを使い、code は出さない。並びは回答の検証が正規化した定義の順。 */
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
    // Target だけの選択は名前だけを渡す（味・量などを補わせない）。
    const facets = same.flatMap((c) => (c.kind === 'target_facet' ? [c.facetLabel] : []));
    lines.push(facets.length > 0 ? `- ${claim.targetLabel}（${claim.categoryLabel}）: ${facets.join('、')}` : `- ${claim.targetLabel}（${claim.categoryLabel}）`);
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
  // 感想があれば先に置く（口コミの中心）。選んだ項目はその後ろに「手がかり」として置く。
  const lines = [
    ...(comment !== undefined ? ['本人が書いた感想（口コミの中心にする）:', `「${comment}」`, ''] : []),
    '本人が選んだ項目（どう感じたかの手がかり）:',
    ...(positive.length > 0 ? ['良かったところ:', ...positive] : []),
    ...(concern.length > 0 ? ['気になったところ:', ...concern] : []),
    ...(overlap ? ['（同じ項目が良かったところと気になったところの両方にあります。両方あったことだけを書いてください）'] : []),
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
  commentLinkage: '本人の感想に無い因果で、感想の内容を他の項目の理由として結びつけない。',
  absence: '回答に無いことを「無かった」「特にない」と書かない。',
  ungrounded: '回答に無い固有名詞・数字・日付を書かない。',
  caseForbidden: '回答に無い事情を書かない。',
  // style（事実としては安全な不自然さ）。最後の試行にこれだけが残っても、その LLM の文を返す（style.ts）。
  'style:abstractEvaluation': '「満足できる内容」「満足できるもの」のようにまとめず、「量にも満足できました」のように直接書く。',
  'style:repetitiveEnding': '同じ文末を続けない。文の長さとつなぎ方を変える。',
  'style:awkwardPhrase': '「〜があればと思いました」「嬉しいと感じました」や体言止めを使わず、「もう少し多いと嬉しかったです」「満足できました」のように普通のです・ます調で書く。',
};
