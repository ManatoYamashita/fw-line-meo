import { describe, it, expect, vi } from 'vitest';
import type { GenAiClient, GenAiRequest } from '../src/lib/draft/generator';
import type { StructuredDraftMaterial } from '../src/lib/draft/structured-draft';
import { compileStructuredClaims, overlappingIdentities } from '../src/lib/draft/structured/claims';
import { structuredFallbackDraft } from '../src/lib/draft/structured/fallback';
import { availableCompositions, buildRealizerPrompt, COMMENT_TONE, COMPOSITIONS, overallImpression, REGENERATION_NOTE, RETRY_NOTES, TONES } from '../src/lib/draft/structured/prompt';
import { createNaturalRealizer } from '../src/lib/draft/structured/realizer';

// structured の通常生成（Natural LLM Realizer・Issue #439）。実 Gemini は呼ばず、偽のクライアントで生成の結果を決める。
// 事実の境界（claims と hard gate）がコードで守られることと、作り直し・safe fallback の制御を固定する。
// 自然さ重視への方針変更で、弱い主観（少し・やや・満足できた・印象に残った）は作り直しの引き金にしないことも固定する。

const SASHIMI = 'a4390000-0000-4000-8000-0000000000a1';
const DASHIMAKI = 'a4390000-0000-4000-8000-0000000000a2';

function material(over: Partial<StructuredDraftMaterial> = {}): StructuredDraftMaterial {
  return {
    storeName: '海鮮食堂 しおさい',
    surveyRevision: 3,
    star: 5,
    selections: [
      { polarity: 'positive', categoryCode: 'food', categoryLabel: '料理', targetId: SASHIMI, targetLabel: '刺身盛り合わせ', facets: [{ code: 'taste', label: '味' }] },
    ],
    ...over,
  };
}

const OVERLAP = material({
  star: 3,
  selections: [
    { polarity: 'positive', categoryCode: 'food', categoryLabel: '料理', targetId: SASHIMI, targetLabel: '刺身盛り合わせ', facets: [{ code: 'taste', label: '味' }] },
    { polarity: 'concern', categoryCode: 'food', categoryLabel: '料理', targetId: SASHIMI, targetLabel: '刺身盛り合わせ', facets: [{ code: 'taste', label: '味' }] },
  ],
});

/** 呼ばれた順に下書きを返す偽のクライアント。`Error` を渡すとその回は例外を投げる。 */
function fakeClient(...replies: (string | Error)[]) {
  const requests: GenAiRequest[] = [];
  const client: GenAiClient = {
    models: {
      generateContent: async (req) => {
        requests.push(req);
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        return { text: JSON.stringify({ draft: reply ?? '' }) };
      },
    },
  };
  return { client, requests };
}

const fixed = () => 0;

describe('compileStructuredClaims（決定的）', () => {
  it('Target だけ・Target + facet・カテゴリ全体の facet を区別し、素材の順に並べる', () => {
    const claims = compileStructuredClaims([
      { polarity: 'positive', categoryCode: 'food', categoryLabel: '料理', targetId: SASHIMI, targetLabel: '刺身盛り合わせ', facets: [] },
      { polarity: 'positive', categoryCode: 'food', categoryLabel: '料理', targetId: DASHIMAKI, targetLabel: 'だし巻き玉子', facets: [{ code: 'taste', label: '味' }, { code: 'appearance', label: '見た目' }] },
      { polarity: 'concern', categoryCode: 'service_delivery', categoryLabel: '接客・提供', facets: [{ code: 'serving', label: '料理・ドリンクの提供' }] },
    ]);
    expect(claims).toEqual([
      { polarity: 'positive', categoryCode: 'food', categoryLabel: '料理', kind: 'target', targetId: SASHIMI, targetLabel: '刺身盛り合わせ' },
      { polarity: 'positive', categoryCode: 'food', categoryLabel: '料理', kind: 'target_facet', targetId: DASHIMAKI, targetLabel: 'だし巻き玉子', facetCode: 'taste', facetLabel: '味' },
      { polarity: 'positive', categoryCode: 'food', categoryLabel: '料理', kind: 'target_facet', targetId: DASHIMAKI, targetLabel: 'だし巻き玉子', facetCode: 'appearance', facetLabel: '見た目' },
      { polarity: 'concern', categoryCode: 'service_delivery', categoryLabel: '接客・提供', kind: 'category_facet', facetCode: 'serving', facetLabel: '料理・ドリンクの提供' },
    ]);
  });

  it('同じ入力からは同じ並び（決定的）。一言は claim にしない', () => {
    const m = material({ comment: '店員さんが丁寧でした' });
    expect(compileStructuredClaims(m.selections)).toEqual(compileStructuredClaims(m.selections));
    expect(compileStructuredClaims(m.selections)).toHaveLength(1);
  });

  it('exact overlap の identity を見つける（同じ Target・同じ facet が両極性）', () => {
    expect(overlappingIdentities(compileStructuredClaims(OVERLAP.selections))).toEqual([`${SASHIMI}:taste`]);
    expect(overlappingIdentities(compileStructuredClaims(material().selections))).toEqual([]);
  });

  it('Target も facet も無い選択（開いただけ）は claim にならない', () => {
    expect(compileStructuredClaims([{ polarity: 'positive', categoryCode: 'food', categoryLabel: '料理', facets: [] }])).toEqual([]);
  });
});

describe('プロンプト', () => {
  it('claim の表示名と極性と一言を渡し、店名・code・星の数そのものは渡さない', () => {
    const claims = compileStructuredClaims(material().selections);
    const { systemInstruction, userContent } = buildRealizerPrompt({ claims, comment: 'おいしかった', star: 1, composition: COMPOSITIONS[0]!.text });
    expect(userContent).toContain('良かったところ:');
    expect(userContent).toContain('- 刺身盛り合わせ（料理）: 味');
    expect(userContent).toContain('一言: 「おいしかった」');
    expect(userContent).not.toContain('気になったところ:');
    expect(userContent).not.toMatch(/[★☆]|星|満足度|海鮮食堂|taste|food/);
    expect(userContent.slice(0, userContent.indexOf('文章の組み立て:'))).not.toMatch(/[0-9０-９]/);
    // 自然さを前面に出す（読み上げない・言い換えてよい・弱い主観はよい）。具体的な創作の型は短く名指す。
    expect(systemInstruction).toContain('アンケートの項目を順番に読み上げない');
    expect(systemInstruction).toContain('「少し」「やや」「満足できた」「印象に残った」「過ごしやすかった」');
    expect(systemInstruction).toContain('具体的な事実の創作');
  });

  it('星は全体の印象へ丸めて渡す（★4〜5 は満足・★1〜2 は不満が残った・★3 は渡さない）', () => {
    expect([1, 2, 3, 4, 5].map(overallImpression)).toEqual(['不満が残った', '不満が残った', null, '満足', '満足']);
    const claims = compileStructuredClaims(material().selections);
    const at = (star: number) => buildRealizerPrompt({ claims, star, composition: COMPOSITIONS[0]!.text }).userContent;
    expect(at(5)).toContain('全体の印象: 満足（書いても書かなくてもよい');
    expect(at(4)).toBe(at(5));
    expect(at(2)).toContain('全体の印象: 不満が残った');
    expect(at(3)).not.toContain('全体の印象');
  });

  it('文体は候補から選び、一言があるときは一言の口調に合わせる', () => {
    const claims = compileStructuredClaims(material().selections);
    expect(buildRealizerPrompt({ claims, composition: COMPOSITIONS[0]!.text, tone: TONES[1]! }).userContent).toContain(`文体: ${TONES[1]}`);
    const withComment = buildRealizerPrompt({ claims, comment: 'めっちゃよかった！', composition: COMPOSITIONS[0]!.text, tone: TONES[1]! }).userContent;
    expect(withComment).toContain(`文体: ${COMMENT_TONE}`);
    expect(withComment).not.toContain(TONES[1]!);
  });

  it('Target だけの claim は「料理そのもの（項目の指定なし）」として渡し、味などを補わない', () => {
    const { userContent } = buildRealizerPrompt({
      claims: compileStructuredClaims([{ polarity: 'positive', categoryCode: 'food', categoryLabel: '料理', targetId: SASHIMI, targetLabel: '刺身盛り合わせ', facets: [] }]),
      composition: COMPOSITIONS[0]!.text,
    });
    expect(userContent).toContain('- 刺身盛り合わせ（料理）: 料理・ドリンクそのもの（項目の指定なし）');
    expect(userContent).not.toContain('味');
  });

  it('exact overlap は、両方あったことだけを書くよう回答の側に添える', () => {
    const { userContent } = buildRealizerPrompt({ claims: compileStructuredClaims(OVERLAP.selections), composition: COMPOSITIONS[0]!.text });
    expect(userContent).toContain('同じ項目が良かったところと気になったところの両方にあります');
  });
});

describe('Natural LLM Realizer の通常の経路', () => {
  it('1 回目が hard gate を通れば、そのまま返す（LLM は 1 回）', async () => {
    const { client, requests } = fakeClient('刺身盛り合わせがおいしかったです。');
    const result = await createNaturalRealizer(client, { random: fixed }).prepare(material());
    expect(result).toEqual({ kind: 'draft', draft: '刺身盛り合わせがおいしかったです。', source: 'llm', attempts: 1 });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.config.temperature).toBe(1);
  });

  it('claim が無い回答（星だけ・一言だけ）は下書きを作らず、LLM も呼ばない', async () => {
    const { client, requests } = fakeClient('何か');
    const result = await createNaturalRealizer(client).prepare(material({ selections: [], comment: 'よかった' }));
    expect(result).toEqual({ kind: 'unavailable' });
    expect(requests).toHaveLength(0);
  });
});

describe('作り直しと safe fallback（Stage 3A の hard gate を使う）', () => {
  // fake LLM が意図的に出す違反と、hard gate が付ける種類。
  const violations: [string, string][] = [
    ['新鮮な刺身盛り合わせがおいしかったです。', 'newAttribute'],
    ['刺身盛り合わせがおいしかったです。料理が出るまで30分待ちました。', 'ungrounded'],
    ['友人と行きました。刺身盛り合わせがおいしかったです。', 'companion'],
    ['刺身盛り合わせがおいしかったです。また行きたいです。', 'revisit'],
    ['刺身盛り合わせがとてもおいしかったです。', 'intensity'],
    ['刺身盛り合わせがおいしかったです。店員さんが笑顔で迎えてくれました。', 'newAttribute'],
  ];

  for (const [bad, kind] of violations) {
    it(`1 回目「${bad}」→ ${kind} を検出して作り直し、2 回目が通れば LLM の下書きを返す`, async () => {
      const onRetry = vi.fn();
      const { client, requests } = fakeClient(bad, '刺身盛り合わせがおいしかったです。');
      const result = await createNaturalRealizer(client, { random: fixed, onRetry }).prepare(material());
      expect(result).toEqual({ kind: 'draft', draft: '刺身盛り合わせがおいしかったです。', source: 'llm', attempts: 2 });
      expect(requests).toHaveLength(2);
      expect(onRetry.mock.calls[0]![0]).toContain(kind);
      // 2 回目の指示には決まった注意だけを足し、1 回目の本文（違反の断片）を戻さない。
      expect(requests[1]!.contents).toContain(RETRY_NOTES[kind]!);
      expect(requests[1]!.contents).not.toContain(bad);
    });
  }

  it('回答から自然に導ける弱い主観（少し・やや・満足・印象に残った）は作り直さない', async () => {
    const m = material({
      selections: [
        { polarity: 'positive', categoryCode: 'food', categoryLabel: '料理', facets: [{ code: 'volume', label: '量' }] },
        { polarity: 'positive', categoryCode: 'service_delivery', categoryLabel: '接客・提供', facets: [{ code: 'service_courtesy', label: '接客の丁寧さ' }] },
        { polarity: 'concern', categoryCode: 'reservation_visit', categoryLabel: '予約・来店', facets: [{ code: 'entry_wait', label: '入店までの待ち時間' }] },
      ],
    });
    for (const draft of [
      '料理は満足感のある量で、丁寧に対応してもらえました。待ち時間だけ少し気になりました。',
      '入店までの待ち時間はやや気になったものの、料理の量にも満足できて、接客も丁寧でした。全体としては満足です。',
    ]) {
      const onRetry = vi.fn();
      const { client } = fakeClient(draft);
      expect(await createNaturalRealizer(client, { random: fixed, onRetry }).prepare(m), draft).toEqual({ kind: 'draft', draft, source: 'llm', attempts: 1 });
      expect(onRetry).not.toHaveBeenCalled();
    }
  });

  it('作り直しは意味を足さない: 2 回目の「回答」は 1 回目と同じで、注意だけが増える', async () => {
    const { client, requests } = fakeClient('新鮮な刺身盛り合わせ。', '刺身盛り合わせがおいしかったです。');
    await createNaturalRealizer(client, { random: fixed }).prepare(material());
    const answer = (contents: string) => contents.slice(0, contents.indexOf('文章の組み立て:'));
    expect(answer(requests[1]!.contents)).toBe(answer(requests[0]!.contents));
    expect(requests[1]!.config.systemInstruction).toBe(requests[0]!.config.systemInstruction);
  });

  it('2 回とも hard gate を通らなければ、safe fallback（決定的なテンプレート）を返す。LLM は 2 回まで', async () => {
    const onFallback = vi.fn();
    const { client, requests } = fakeClient('新鮮な刺身盛り合わせ。', '脂ののった刺身盛り合わせがおいしかった。また行きたい。', '呼ばれないはず');
    const result = await createNaturalRealizer(client, { random: fixed, onFallback }).prepare(material());
    expect(result).toEqual({ kind: 'draft', draft: '刺身盛り合わせは味が良かったです。', source: 'fallback', attempts: 2 });
    expect(requests).toHaveLength(2);
    expect(onFallback).toHaveBeenCalledWith('gate', expect.arrayContaining(['newAttribute', 'revisit']), expect.any(Number));
  });

  it('exact overlap で両面の理由を作ったら（Issue #418）、作り直し、それでも作れば fallback で理由の無い文を返す', async () => {
    const { client } = fakeClient(
      '刺身盛り合わせの味は、時間帯によって良いときと気になるときがありました。',
      '刺身盛り合わせの味は、部位によって良かったり気になったりしました。',
    );
    const result = await createNaturalRealizer(client, { random: fixed }).prepare(OVERLAP);
    expect(result).toEqual({
      kind: 'draft',
      draft: '刺身盛り合わせの味については、良かった点と気になる点の両方がありました。',
      source: 'fallback',
      attempts: 2,
    });
  });

  it('exact overlap で両面だけを書いた下書きは通す', async () => {
    const { client } = fakeClient('刺身盛り合わせの味は、良かったところもありつつ気になる点もありました。');
    expect(await createNaturalRealizer(client, { random: fixed }).prepare(OVERLAP)).toMatchObject({ source: 'llm', attempts: 1 });
  });

  it('positive / concern の片側を落とした下書きは作り直す', async () => {
    const onRetry = vi.fn();
    const { client } = fakeClient('刺身盛り合わせがおいしかったです。', '刺身盛り合わせの味は、良かったところもありつつ気になる点もありました。');
    await createNaturalRealizer(client, { random: fixed, onRetry }).prepare(OVERLAP);
    expect(onRetry.mock.calls[0]![0]).toContain('concernDropped');
  });

  it('生成そのものの失敗（API の例外・JSON でない・空）は作り直さず safe fallback へ', async () => {
    for (const reply of [new Error('503'), '']) {
      const onFallback = vi.fn();
      const { client, requests } = fakeClient(reply as string | Error);
      const result = await createNaturalRealizer(client, { random: fixed, onFallback }).prepare(material());
      expect(result).toEqual({ kind: 'draft', draft: '刺身盛り合わせは味が良かったです。', source: 'fallback', attempts: 1 });
      expect(requests).toHaveLength(1);
      // 匿名の metadata だけ（失格の種類と claim の件数）。
      expect(onFallback).toHaveBeenCalledWith('generation', [], 1);
    }
  });

  it('一言の内容・語調は使ってよい（一言にある意向は失格にしない）', async () => {
    const { client, requests } = fakeClient('刺身盛り合わせ、うまかった！また行きます。');
    const m = material({ comment: '刺身うまかった！また行く' });
    expect(await createNaturalRealizer(client, { random: fixed }).prepare(m)).toMatchObject({ source: 'llm', attempts: 1 });
    expect(requests[0]!.contents).toContain('一言: 「刺身うまかった！また行く」');
  });
});

describe('safe fallback', () => {
  it('部分的な overlap では、両極性の facet だけを両面の文にし、片側だけの facet は分けて書く', () => {
    const claims = compileStructuredClaims([
      { polarity: 'positive', categoryCode: 'food', categoryLabel: '料理', targetId: SASHIMI, targetLabel: '刺身盛り合わせ', facets: [{ code: 'taste', label: '味' }, { code: 'appearance', label: '見た目' }] },
      { polarity: 'concern', categoryCode: 'food', categoryLabel: '料理', targetId: SASHIMI, targetLabel: '刺身盛り合わせ', facets: [{ code: 'taste', label: '味' }] },
    ]);
    expect(structuredFallbackDraft(claims)).toBe(
      '刺身盛り合わせの味については、良かった点と気になる点の両方がありました。刺身盛り合わせは見た目が良かったです。',
    );
  });
});

describe('再生成のバリエーション（文章の組み立て・項目の並び・総評の有無をサーバーが選ぶ）', () => {
  // 実 Gemini で、同じ回答の再生成が語尾違いだけ（予約 → 接客 → 料理の量 → ドリンク → 総評）だったケース。
  const RESERVATION = material({
    star: 5,
    selections: [
      { polarity: 'positive', categoryCode: 'reservation_visit', categoryLabel: '予約・来店', facets: [{ code: 'reservation_ease', label: '予約のしやすさ' }] },
      { polarity: 'positive', categoryCode: 'service_delivery', categoryLabel: '接客・提供', facets: [{ code: 'service_courtesy', label: '接客の丁寧さ' }] },
      { polarity: 'positive', categoryCode: 'food', categoryLabel: '料理', facets: [{ code: 'volume', label: '量' }] },
      { polarity: 'concern', categoryCode: 'drink', categoryLabel: 'ドリンク', facets: [{ code: 'variety', label: '種類' }] },
    ],
  });
  /** 決まった値を順に返す乱数（尽きたら 0）。 */
  const seq = (...values: number[]) => () => values.shift() ?? 0;

  it('語順・文の数・項目の並びが違う下書きも、同じ事実なら hard gate を通る（作り直さない）', async () => {
    for (const draft of [
      '予約はスムーズで、接客も丁寧でした。料理の量にも満足できましたが、ドリンクの種類はもう少し多いと嬉しかったです。',
      '接客が丁寧で、料理の量にも満足できました。予約もスムーズでした。ドリンクはもう少し種類があると嬉しいです。',
      '予約から当日までスムーズで、接客も丁寧でした。料理の量は満足できましたが、ドリンクの種類は少し気になりました。',
      '料理の量に満足でき、接客も丁寧でした。予約もしやすかったです。一方で、ドリンクの種類はもう少しあると嬉しかったです。',
      'ドリンクの種類は少し気になりました。それでも予約はしやすく、接客も丁寧で、料理の量もしっかりありました。',
    ]) {
      const onRetry = vi.fn();
      const { client } = fakeClient(draft);
      expect(await createNaturalRealizer(client, { random: fixed, onRetry }).prepare(RESERVATION), draft).toEqual({ kind: 'draft', draft, source: 'llm', attempts: 1 });
      expect(onRetry).not.toHaveBeenCalled();
    }
  });

  it('組み立ては回答に対して成り立つ候補から選ぶ（両極性が無ければ対比・気になった先行を選ばない）', () => {
    const onlyPositive = availableCompositions(compileStructuredClaims(material().selections)).map((c) => c.id);
    expect(onlyPositive).toEqual(['plain', 'combined']);
    expect(availableCompositions(compileStructuredClaims(RESERVATION.selections)).map((c) => c.id)).toEqual(COMPOSITIONS.map((c) => c.id));
  });

  it('乱数に応じて、回答の行の並び・組み立て・総評の有無が変わる（回答の中身は同じ）', async () => {
    const contents = async (random: () => number) => {
      const { client, requests } = fakeClient('料理の量にも満足できました。接客も丁寧で、予約もしやすかったです。ドリンクの種類は少し気になりました。');
      await createNaturalRealizer(client, { random }).prepare(RESERVATION);
      return requests[0]!.contents;
    };
    const a = await contents(seq(0, 0, 0, 0.99, 0, 0, 0));
    const b = await contents(seq(0.99, 0.99, 0.99, 0, 0.5, 0.9));
    const lines = (s: string) => s.split('\n').filter((l) => l.startsWith('- '));
    expect(lines(a)).not.toEqual(lines(b));
    expect([...lines(a)].sort()).toEqual([...lines(b)].sort());
    expect(a.match(/文章の組み立て: .*/)![0]).not.toBe(b.match(/文章の組み立て: .*/)![0]);
    // 総評は任意の合図: 乱数が OVERALL_RATE 未満のときだけ渡す。
    expect(a.includes('全体の印象') !== b.includes('全体の印象')).toBe(true);
  });

  it('作り直しでは、回答の並び・組み立て・総評の有無を変えない（違反の注意だけが増える）', async () => {
    const { client, requests } = fakeClient('新鮮な料理の量に満足でした。', '料理の量にも満足できました。接客も丁寧で、予約もしやすかったです。ドリンクの種類は少し気になりました。');
    await createNaturalRealizer(client, { random: seq(0.7, 0.2, 0.9, 0.4, 0.5, 0.1, 0.3) }).prepare(RESERVATION);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.contents.startsWith(`${requests[0]!.contents}\n\n前回の文章は`)).toBe(true);
  });

  it('再生成のときだけ「前とは違う組み立て」の決まった指示を足す', async () => {
    const first = fakeClient('料理の量にも満足できました。接客も丁寧で、予約もしやすかったです。ドリンクの種類は少し気になりました。');
    await createNaturalRealizer(first.client, { random: fixed }).prepare(RESERVATION);
    expect(first.requests[0]!.contents).not.toContain(REGENERATION_NOTE);
    const regen = fakeClient('料理の量にも満足できました。接客も丁寧で、予約もしやすかったです。ドリンクの種類は少し気になりました。');
    await createNaturalRealizer(regen.client, { random: fixed }).prepare(RESERVATION, { regeneration: true });
    expect(regen.requests[0]!.contents).toContain(REGENERATION_NOTE);
  });

  it('前回の下書きは再生成へ渡さず、前回の下書きにあった未回答の事実も次の生成の事実の源にならない', async () => {
    // 1 回目の生成（客へ返った下書き）に、検査をすり抜けた創作が混ざっていたと仮定する。
    const previous = '友人と行きました。予約はしやすく、接客も丁寧でした。料理の量にも満足でした。ドリンクの種類は少し気になりました。';
    const realizer = createNaturalRealizer(fakeClient(previous).client, { random: fixed });
    await realizer.prepare(RESERVATION);
    // 再生成: プロンプトには前回の下書きが入らない。
    const clean = '料理の量にも満足でき、接客も丁寧でした。予約もしやすかったです。ドリンクの種類は少し気になりました。';
    const regen = fakeClient(`友人と行きました。${clean}`, clean);
    const onRetry = vi.fn();
    const result = await createNaturalRealizer(regen.client, { random: fixed, onRetry }).prepare(RESERVATION, { regeneration: true });
    for (const req of regen.requests) {
      expect(req.contents).not.toContain(previous);
      expect(req.contents).not.toContain('友人');
    }
    // 事後検証の素材は封入した回答だけ: 前回の文の事実（友人と）を繰り返した下書きは、作り直しになる。
    expect(onRetry.mock.calls[0]![0]).toContain('companion');
    expect(result).toEqual({ kind: 'draft', draft: clean, source: 'llm', attempts: 2 });
  });
});

describe('factuality と style の分離（style の問題だけでは safe fallback へ落とさない）', () => {
  // 実 Gemini で safe fallback へ落ちた回答（全体と Target の量・入店の待ち時間・接客の丁寧さが両面・料理の価格）。
  const YAKITORI = 'a4390000-0000-4000-8000-0000000000b5';
  const MIXED = material({
    star: 4,
    selections: [
      { polarity: 'positive', categoryCode: 'food', categoryLabel: '料理', facets: [{ code: 'volume', label: '量' }] },
      { polarity: 'positive', categoryCode: 'food', categoryLabel: '料理', targetId: YAKITORI, targetLabel: '焼き鳥5種盛り', facets: [{ code: 'volume', label: '量' }] },
      { polarity: 'positive', categoryCode: 'service_delivery', categoryLabel: '接客・提供', facets: [{ code: 'service_courtesy', label: '接客の丁寧さ' }] },
      { polarity: 'positive', categoryCode: 'reservation_visit', categoryLabel: '予約・来店', facets: [{ code: 'entry_wait', label: '入店までの待ち時間' }] },
      { polarity: 'concern', categoryCode: 'service_delivery', categoryLabel: '接客・提供', facets: [{ code: 'service_courtesy', label: '接客の丁寧さ' }] },
      { polarity: 'concern', categoryCode: 'price', categoryLabel: '価格', facets: [{ code: 'food_price', label: '料理の価格' }] },
    ],
  });
  const GOOD = '入店までの待ち時間も少なく、焼き鳥5種盛りもしっかりした量で満足できました。ただ、接客の丁寧さや料理の価格については少し気になるところもありました。';
  const STYLE_ONLY = '入店までの待ち時間も少なく、焼き鳥5種盛りを含め量もしっかりあって満足できる内容でした。接客の丁寧さや料理の価格については、良い部分もあれば気になる点もありました。';
  const CAUSE = '予約のおかげか待ち時間も少なく、焼き鳥5種盛りを含め量もしっかりあって満足できました。接客の丁寧さや料理の価格については、良い部分もあれば気になる点もありました。';

  it('実 Gemini の 2 本目の文（自然・事実として安全）は、そのまま 1 回で通る', async () => {
    const onResult = vi.fn();
    const { client } = fakeClient(GOOD);
    expect(await createNaturalRealizer(client, { random: fixed, onResult }).prepare(MIXED)).toEqual({ kind: 'draft', draft: GOOD, source: 'llm', attempts: 1 });
    expect(onResult).toHaveBeenCalledWith({ source: 'llm', attempts: 1, retried: false, styleOnlyRetry: false, residualKinds: [] }, 6);
  });

  it('「満足できる内容」だけの問題は style として作り直し、2 回目も style だけなら LLM の文を返す（fallback にしない）', async () => {
    const onRetry = vi.fn();
    const onFallback = vi.fn();
    const onResult = vi.fn();
    const { client, requests } = fakeClient(STYLE_ONLY, STYLE_ONLY);
    const result = await createNaturalRealizer(client, { random: fixed, onRetry, onFallback, onResult }).prepare(MIXED);
    expect(result).toEqual({ kind: 'draft', draft: STYLE_ONLY, source: 'llm', attempts: 2 });
    expect(onRetry).toHaveBeenCalledWith(['style:abstractEvaluation'], 6);
    expect(requests[1]!.contents).toContain(RETRY_NOTES['style:abstractEvaluation']!);
    expect(onFallback).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith(
      { source: 'llm', attempts: 2, retried: true, styleOnlyRetry: true, residualKinds: ['style:abstractEvaluation'] },
      6,
    );
  });

  it('1 回目が style だけの問題なら、2 回目が factuality 違反・生成の失敗でも 1 回目の LLM の文を返す', async () => {
    for (const second of [CAUSE, new Error('503')]) {
      const { client } = fakeClient(STYLE_ONLY, second);
      expect(await createNaturalRealizer(client, { random: fixed }).prepare(MIXED)).toEqual({ kind: 'draft', draft: STYLE_ONLY, source: 'llm', attempts: 2 });
    }
  });

  it('同じ文末の羅列（「Xでした。Yでした。Zでした。」）も style の問題で、事実として安全なら fallback にしない', async () => {
    const listy =
      '入店まではスムーズでした。焼き鳥5種盛りの量も満足でした。料理全体の量も満足でした。接客の丁寧さは良い点も気になる点もありました。料理の価格は気になりました。';
    const onRetry = vi.fn();
    const { client } = fakeClient(listy, listy);
    expect(await createNaturalRealizer(client, { random: fixed, onRetry }).prepare(MIXED)).toMatchObject({ source: 'llm', attempts: 2 });
    expect(onRetry.mock.calls[0]![0]).toEqual(['style:repetitiveEnding']);
  });

  it('原因の創作（予約のおかげか）は factuality 違反: 作り直し、2 回続けば safe fallback', async () => {
    const onFallback = vi.fn();
    const onResult = vi.fn();
    const { client } = fakeClient(CAUSE, CAUSE);
    const result = await createNaturalRealizer(client, { random: fixed, onFallback, onResult }).prepare(MIXED);
    expect(result).toMatchObject({ source: 'fallback', attempts: 2 });
    expect(onFallback).toHaveBeenCalledWith('gate', ['cause'], 6);
    expect(onResult).toHaveBeenCalledWith({ source: 'fallback', attempts: 2, retried: true, styleOnlyRetry: false, residualKinds: ['cause'] }, 6);
  });

  it('safe fallback は最低限自然な定型: 待ち時間の positive・量の重複のまとめ・exact overlap の両面', () => {
    expect(structuredFallbackDraft(compileStructuredClaims(MIXED.selections))).toBe(
      '料理全体の量に満足でき、焼き鳥5種盛りの量も良かったです。' +
        '接客の丁寧さについては、良かった点と気になる点の両方がありました。' +
        '入店まではスムーズでした。' +
        '料理の価格が気になりました。',
    );
  });

  it('量のまとめは並びに依らず、同じ claim を 2 回書かない（Target が先でも）', () => {
    const reversed = compileStructuredClaims([MIXED.selections[1]!, MIXED.selections[0]!]);
    expect(structuredFallbackDraft(reversed)).toBe('料理全体の量に満足でき、焼き鳥5種盛りの量も良かったです。');
    // Target に別の facet があれば、その facet だけを Target の文に残す。
    const withTaste = compileStructuredClaims([
      MIXED.selections[0]!,
      { ...MIXED.selections[1]!, facets: [{ code: 'volume', label: '量' }, { code: 'taste', label: '味' }] },
    ]);
    expect(structuredFallbackDraft(withTaste)).toBe('料理全体の量に満足でき、焼き鳥5種盛りの量も良かったです。焼き鳥5種盛りは味が良かったです。');
  });
});
