import { describe, it, expect, vi } from 'vitest';
import type { GenAiClient, GenAiRequest } from '../src/lib/draft/generator';
import type { StructuredDraftMaterial } from '../src/lib/draft/structured-draft';
import { compileStructuredClaims, overlappingIdentities } from '../src/lib/draft/structured/claims';
import { structuredFallbackDraft } from '../src/lib/draft/structured/fallback';
import { buildRealizerPrompt, RETRY_NOTES } from '../src/lib/draft/structured/prompt';
import { createNaturalRealizer, MAX_ATTEMPTS } from '../src/lib/draft/structured/realizer';

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
  it('claim の表示名と極性と一言だけを渡し、店名・code・星は渡さない', () => {
    const claims = compileStructuredClaims(material({ star: 1 }).selections);
    const { systemInstruction, userContent } = buildRealizerPrompt({ claims, comment: 'おいしかった' });
    expect(userContent).toContain('良かったところ:');
    expect(userContent).toContain('- 刺身盛り合わせ（料理）: 味');
    expect(userContent).toContain('一言: 「おいしかった」');
    expect(userContent).not.toContain('気になったところ:');
    expect(userContent).not.toMatch(/[★☆]|星|満足度|全体の印象|海鮮食堂|taste|food|[0-9０-９]/);
    // 中心の指示: 自然なです・ます調・箇条書きのように並べない・新しい具体的事実と因果を作らない。
    expect(systemInstruction).toContain('一般の利用者が Google 口コミにそのまま投稿するような自然な日本語');
    expect(systemInstruction).toContain('自然なです・ます調で書き、回答項目を箇条書きのようにそのまま並べず');
    expect(systemInstruction).toContain('独立した回答同士を、勝手に因果関係として結ばないでください');
  });

  it('文体・組み立て・総評の抽選や、再生成で構成を変える指示は渡さない', () => {
    const claims = compileStructuredClaims(material().selections);
    const { systemInstruction, userContent } = buildRealizerPrompt({ claims });
    expect(userContent).not.toMatch(/文体:|文章の組み立て:|文章の形:|作り直し:|全体の印象/);
    expect(systemInstruction).not.toMatch(/体言止めを交え|常体/);
  });

  it('Target だけの claim は「料理そのもの（項目の指定なし）」として渡し、味などを補わない', () => {
    const { userContent } = buildRealizerPrompt({
      claims: compileStructuredClaims([{ polarity: 'positive', categoryCode: 'food', categoryLabel: '料理', targetId: SASHIMI, targetLabel: '刺身盛り合わせ', facets: [] }]),
    });
    expect(userContent).toContain('- 刺身盛り合わせ（料理）: 料理・ドリンクそのもの（項目の指定なし）');
    expect(userContent).not.toContain('味');
  });

  it('exact overlap は、両方あったことだけを書くよう回答の側に添える', () => {
    const { userContent } = buildRealizerPrompt({ claims: compileStructuredClaims(OVERLAP.selections) });
    expect(userContent).toContain('同じ項目が良かったところと気になったところの両方にあります');
  });
});

describe('Natural LLM Realizer の通常の経路', () => {
  it('1 回目が hard gate を通れば、そのまま返す（LLM は 1 回）', async () => {
    const { client, requests } = fakeClient('刺身盛り合わせがおいしかったです。');
    const result = await createNaturalRealizer(client, {}).prepare(material());
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
      const result = await createNaturalRealizer(client, { onRetry }).prepare(material());
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
      expect(await createNaturalRealizer(client, { onRetry }).prepare(m), draft).toEqual({ kind: 'draft', draft, source: 'llm', attempts: 1 });
      expect(onRetry).not.toHaveBeenCalled();
    }
  });

  it('作り直しは意味を足さない: 2 回目の「回答」は 1 回目と同じで、注意だけが増える', async () => {
    const { client, requests } = fakeClient('新鮮な刺身盛り合わせ。', '刺身盛り合わせがおいしかったです。');
    await createNaturalRealizer(client, {}).prepare(material());
    expect(requests[1]!.contents.startsWith(`${requests[0]!.contents}\n\n前回の文章は`)).toBe(true);
    expect(requests[1]!.config.systemInstruction).toBe(requests[0]!.config.systemInstruction);
  });

  it('1 回目・2 回目が factuality 違反でも、3 回目が通れば 3 回目の LLM の文を返す', async () => {
    const onRetry = vi.fn();
    const { client, requests } = fakeClient('新鮮な刺身盛り合わせ。', '刺身盛り合わせがおいしく、また行きたいです。', '刺身盛り合わせがおいしかったです。', '呼ばれないはず');
    const result = await createNaturalRealizer(client, { onRetry }).prepare(material());
    expect(result).toEqual({ kind: 'draft', draft: '刺身盛り合わせがおいしかったです。', source: 'llm', attempts: 3 });
    expect(requests).toHaveLength(MAX_ATTEMPTS);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]![0]).toContain('newAttribute');
    expect(onRetry.mock.calls[1]![0]).toContain('revisit');
    // 3 回目の注意は 2 回目の違反に応じたもの。
    expect(requests[2]!.contents).toContain(RETRY_NOTES.revisit!);
  });

  it('3 回とも factuality 違反なら、safe fallback の文ではなく generation error（下書きなし）', async () => {
    const onFailed = vi.fn();
    const { client, requests } = fakeClient('新鮮な刺身盛り合わせ。', '脂ののった刺身盛り合わせ。', '刺身盛り合わせ、また行きたい。', '呼ばれないはず');
    const result = await createNaturalRealizer(client, { onFailed }).prepare(material());
    expect(result).toEqual({ kind: 'failed', attempts: 3 });
    expect(requests).toHaveLength(3);
    expect(onFailed).toHaveBeenCalledWith('gate', expect.arrayContaining(['revisit']), 1);
  });

  it('exact overlap で両面の理由を作り続けたら generation error（理由の文も定型の文も返さない）', async () => {
    const { client } = fakeClient(
      '刺身盛り合わせの味は、時間帯によって良いときと気になるときがありました。',
      '刺身盛り合わせの味は、部位によって良かったり気になったりしました。',
      '刺身盛り合わせの味は、最初は良かったのですが後半は気になりました。',
    );
    expect(await createNaturalRealizer(client, {}).prepare(OVERLAP)).toEqual({ kind: 'failed', attempts: 3 });
  });

  it('exact overlap で両面だけを書いた下書きは通す', async () => {
    const { client } = fakeClient('刺身盛り合わせの味は、良かったところもありつつ気になる点もありました。');
    expect(await createNaturalRealizer(client, {}).prepare(OVERLAP)).toMatchObject({ source: 'llm', attempts: 1 });
  });

  it('positive / concern の片側を落とした下書きは作り直す', async () => {
    const onRetry = vi.fn();
    const { client } = fakeClient('刺身盛り合わせがおいしかったです。', '刺身盛り合わせの味は、良かったところもありつつ気になる点もありました。');
    await createNaturalRealizer(client, { onRetry }).prepare(OVERLAP);
    expect(onRetry.mock.calls[0]![0]).toContain('concernDropped');
  });

  it('生成そのものの失敗（API の例外・JSON でない・空）は作り直し、3 回とも失敗なら generation error', async () => {
    const onFailed = vi.fn();
    const onRetry = vi.fn();
    const { client, requests } = fakeClient(new Error('503'), '', new Error('timeout'));
    const result = await createNaturalRealizer(client, { onFailed, onRetry }).prepare(material());
    expect(result).toEqual({ kind: 'failed', attempts: 3 });
    expect(requests).toHaveLength(3);
    expect(onRetry.mock.calls.map((c) => c[0])).toEqual([['generation'], ['generation']]);
    // 匿名の metadata だけ（失格の種類と claim の件数）。
    expect(onFailed).toHaveBeenCalledWith('generation', [], 1);
  });

  it('生成の失敗のあとに通れば、その LLM の文を返す', async () => {
    const { client } = fakeClient(new Error('503'), '刺身盛り合わせがおいしかったです。');
    expect(await createNaturalRealizer(client, {}).prepare(material())).toEqual({
      kind: 'draft',
      draft: '刺身盛り合わせがおいしかったです。',
      source: 'llm',
      attempts: 2,
    });
  });

  it('一言の内容・語調は使ってよい（一言にある意向は失格にしない）', async () => {
    const { client, requests } = fakeClient('刺身盛り合わせ、うまかった！また行きます。');
    const m = material({ comment: '刺身うまかった！また行く' });
    expect(await createNaturalRealizer(client, {}).prepare(m)).toMatchObject({ source: 'llm', attempts: 1 });
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

describe('再生成は初回と同じ生成をもう一度行う（抽選も構成の指示も無い）', () => {
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
      expect(await createNaturalRealizer(client, { onRetry }).prepare(RESERVATION), draft).toEqual({ kind: 'draft', draft, source: 'llm', attempts: 1 });
      expect(onRetry).not.toHaveBeenCalled();
    }
  });

  it('初回も再生成も、同じ回答なら同じプロンプト（並びは定義の順・positive → concern）', async () => {
    const a = fakeClient('料理の量にも満足できました。接客も丁寧で、予約もしやすかったです。ドリンクの種類は少し気になりました。');
    const b = fakeClient('予約もしやすく、接客も丁寧でした。料理の量にも満足できましたが、ドリンクの種類は少し気になりました。');
    await createNaturalRealizer(a.client).prepare(RESERVATION);
    await createNaturalRealizer(b.client).prepare(RESERVATION);
    expect(b.requests[0]!.contents).toBe(a.requests[0]!.contents);
    expect(b.requests[0]!.config.systemInstruction).toBe(a.requests[0]!.config.systemInstruction);
    const lines = a.requests[0]!.contents.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toEqual(['- 予約のしやすさ（予約・来店）', '- 接客の丁寧さ（接客・提供）', '- 量（料理）', '- 種類（ドリンク）']);
  });

  it('作り直しでは回答は変えず、違反の注意だけが増える', async () => {
    const { client, requests } = fakeClient('新鮮な料理の量に満足でした。', '料理の量にも満足できました。接客も丁寧で、予約もしやすかったです。ドリンクの種類は少し気になりました。');
    await createNaturalRealizer(client).prepare(RESERVATION);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.contents.startsWith(`${requests[0]!.contents}\n\n前回の文章は`)).toBe(true);
  });

  it('前回の下書きは再生成へ渡さず、前回の下書きにあった未回答の事実も次の生成の事実の源にならない', async () => {
    // 1 回目の生成（客へ返った下書き）に、検査をすり抜けた創作が混ざっていたと仮定する。
    const previous = '友人と行きました。予約はしやすく、接客も丁寧でした。料理の量にも満足でした。ドリンクの種類は少し気になりました。';
    const realizer = createNaturalRealizer(fakeClient(previous).client, {});
    await realizer.prepare(RESERVATION);
    // 再生成: プロンプトには前回の下書きが入らない。
    const clean = '料理の量にも満足でき、接客も丁寧でした。予約もしやすかったです。ドリンクの種類は少し気になりました。';
    const regen = fakeClient(`友人と行きました。${clean}`, clean);
    const onRetry = vi.fn();
    const result = await createNaturalRealizer(regen.client, { onRetry }).prepare(RESERVATION);
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
    expect(await createNaturalRealizer(client, { onResult }).prepare(MIXED)).toEqual({ kind: 'draft', draft: GOOD, source: 'llm', attempts: 1 });
    expect(onResult).toHaveBeenCalledWith(
      { result: 'llm', attempts: 1, acceptedAttempt: 1, history: [{ attempt: 1, generationFailed: false, factuality: [], style: [] }] },
      6,
    );
  });

  it('「満足できる内容」だけの問題は style として作り直し、3 回目も style だけなら 3 回目の LLM の文を返す（generation error にしない）', async () => {
    const onRetry = vi.fn();
    const onFailed = vi.fn();
    const onResult = vi.fn();
    const third = STYLE_ONLY.replace('入店までの待ち時間も少なく、', '待ち時間も少なく、');
    const { client, requests } = fakeClient(STYLE_ONLY, STYLE_ONLY, third);
    const result = await createNaturalRealizer(client, { onRetry, onFailed, onResult }).prepare(MIXED);
    expect(result).toEqual({ kind: 'draft', draft: third, source: 'llm', attempts: 3 });
    expect(onRetry).toHaveBeenCalledWith(['style:abstractEvaluation'], 6);
    expect(requests[1]!.contents).toContain(RETRY_NOTES['style:abstractEvaluation']!);
    expect(onFailed).not.toHaveBeenCalled();
    expect(onResult.mock.calls[0]![0]).toMatchObject({ result: 'llm', attempts: 3, acceptedAttempt: 3 });
  });

  it('style だけの問題の文があれば、後の試行が factuality 違反・生成の失敗でも、その LLM の文を返す', async () => {
    const { client } = fakeClient(STYLE_ONLY, CAUSE, new Error('503'));
    expect(await createNaturalRealizer(client, {}).prepare(MIXED)).toEqual({ kind: 'draft', draft: STYLE_ONLY, source: 'llm', attempts: 3 });
  });

  it('同じ文末の羅列（「Xでした。Yでした。Zでした。」）も style の問題で、事実として安全なら fallback にしない', async () => {
    const listy =
      '入店まではスムーズでした。焼き鳥5種盛りの量も満足でした。料理全体の量も満足でした。接客の丁寧さは良い点も気になる点もありました。料理の価格は気になりました。';
    const onRetry = vi.fn();
    const { client } = fakeClient(listy, listy, listy);
    expect(await createNaturalRealizer(client, { onRetry }).prepare(MIXED)).toMatchObject({ source: 'llm', attempts: 3 });
    expect(onRetry.mock.calls[0]![0]).toEqual(['style:repetitiveEnding']);
  });

  it('原因の創作（予約のおかげか）は factuality 違反: 作り直し、3 回続けば generation error（fallback の文は返さない）', async () => {
    const onFailed = vi.fn();
    const onResult = vi.fn();
    const { client } = fakeClient(CAUSE, CAUSE, CAUSE);
    expect(await createNaturalRealizer(client, { onFailed, onResult }).prepare(MIXED)).toEqual({ kind: 'failed', attempts: 3 });
    expect(onFailed).toHaveBeenCalledWith('gate', ['cause'], 6);
    expect(onResult.mock.calls[0]![0]).toMatchObject({ result: 'generation_error', attempts: 3, acceptedAttempt: null });
  });

  it('最終の結果は llm か generation_error だけ（本番の経路で fallback は出ない）', async () => {
    const results = new Set<string>();
    const onResult = (o: { result: string }) => results.add(o.result);
    const scripts: (string | Error)[][] = [[GOOD], [CAUSE, GOOD], [STYLE_ONLY, CAUSE, CAUSE], [CAUSE, CAUSE, CAUSE], [new Error('x'), '', new Error('y')]];
    for (const replies of scripts) {
      const { client } = fakeClient(...replies);
      const r = await createNaturalRealizer(client, { onResult }).prepare(MIXED);
      if (r.kind === 'draft') expect(r.source).toBe('llm');
    }
    expect([...results].sort()).toEqual(['generation_error', 'llm']);
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
