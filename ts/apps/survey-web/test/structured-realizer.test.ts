import { describe, it, expect, vi } from 'vitest';
import type { GenAiClient, GenAiRequest } from '../src/lib/draft/generator';
import type { StructuredDraftMaterial } from '../src/lib/draft/structured-draft';
import { compileStructuredClaims, overlappingIdentities } from '../src/lib/draft/structured/claims';
import { structuredFallbackDraft } from '../src/lib/draft/structured/fallback';
import { buildRealizerPrompt, COMMENT_TONE, overallImpression, RETRY_NOTES, STRUCTURE_HINTS, TONES } from '../src/lib/draft/structured/prompt';
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
    const { systemInstruction, userContent } = buildRealizerPrompt({ claims, comment: 'おいしかった', star: 1, structureHint: STRUCTURE_HINTS[0]! });
    expect(userContent).toContain('良かったところ:');
    expect(userContent).toContain('- 刺身盛り合わせ（料理）: 味');
    expect(userContent).toContain('一言: 「おいしかった」');
    expect(userContent).not.toContain('気になったところ:');
    expect(userContent).not.toMatch(/[★☆]|星|満足度|海鮮食堂|taste|food/);
    expect(userContent.slice(0, userContent.indexOf('文章の形:'))).not.toMatch(/[0-9０-９]/);
    // 自然さを前面に出す（読み上げない・言い換えてよい・弱い主観はよい）。具体的な創作の型は短く名指す。
    expect(systemInstruction).toContain('アンケートの項目を順番に読み上げない');
    expect(systemInstruction).toContain('「少し」「やや」「満足できた」「印象に残った」「過ごしやすかった」');
    expect(systemInstruction).toContain('具体的な事実の創作');
  });

  it('星は全体の印象へ丸めて渡す（★4〜5 は満足・★1〜2 は不満が残った・★3 は渡さない）', () => {
    expect([1, 2, 3, 4, 5].map(overallImpression)).toEqual(['不満が残った', '不満が残った', null, '満足', '満足']);
    const claims = compileStructuredClaims(material().selections);
    const at = (star: number) => buildRealizerPrompt({ claims, star, structureHint: STRUCTURE_HINTS[0]! }).userContent;
    expect(at(5)).toContain('全体の印象: 満足（書くなら最後に短く添える程度');
    expect(at(4)).toBe(at(5));
    expect(at(2)).toContain('全体の印象: 不満が残った');
    expect(at(3)).not.toContain('全体の印象');
  });

  it('文体は候補から選び、一言があるときは一言の口調に合わせる', () => {
    const claims = compileStructuredClaims(material().selections);
    expect(buildRealizerPrompt({ claims, structureHint: STRUCTURE_HINTS[0]!, tone: TONES[1]! }).userContent).toContain(`文体: ${TONES[1]}`);
    const withComment = buildRealizerPrompt({ claims, comment: 'めっちゃよかった！', structureHint: STRUCTURE_HINTS[0]!, tone: TONES[1]! }).userContent;
    expect(withComment).toContain(`文体: ${COMMENT_TONE}`);
    expect(withComment).not.toContain(TONES[1]!);
  });

  it('Target だけの claim は「料理そのもの（項目の指定なし）」として渡し、味などを補わない', () => {
    const { userContent } = buildRealizerPrompt({
      claims: compileStructuredClaims([{ polarity: 'positive', categoryCode: 'food', categoryLabel: '料理', targetId: SASHIMI, targetLabel: '刺身盛り合わせ', facets: [] }]),
      structureHint: STRUCTURE_HINTS[0]!,
    });
    expect(userContent).toContain('- 刺身盛り合わせ（料理）: 料理・ドリンクそのもの（項目の指定なし）');
    expect(userContent).not.toContain('味');
  });

  it('exact overlap は、両方あったことだけを書くよう回答の側に添える', () => {
    const { userContent } = buildRealizerPrompt({ claims: compileStructuredClaims(OVERLAP.selections), structureHint: STRUCTURE_HINTS[0]! });
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
    const answer = (contents: string) => contents.slice(0, contents.indexOf('文章の形:'));
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
      draft: '刺身盛り合わせの味は、良かったところもあり、気になるところもありました。',
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
      '刺身盛り合わせの味は、良かったところもあり、気になるところもありました。刺身盛り合わせは見た目が良かったです。',
    );
  });
});
