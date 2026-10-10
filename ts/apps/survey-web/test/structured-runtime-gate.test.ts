import { describe, it, expect, vi } from 'vitest';
import type { StructuredSurveyDefinition } from '@fwlm/db';
import type { GenAiClient } from '../src/lib/draft/generator';
import type { StructuredDraftMaterial } from '../src/lib/draft/structured-draft';
import { evaluateStructuredDraft, gateFamily, readLegacyLexicons, readStructuredGateLexicon } from '../src/lib/draft/structured/gate';
import { createNaturalRealizer, gateInputOf } from '../src/lib/draft/structured/realizer';
import { detectStyleIssues } from '../src/lib/draft/structured/style';
import { unselectedTargetsOf } from '../src/lib/structured-answer';
import lexiconRaw from '../src/lib/draft/structured/lexicon.json';

// 本番の runtime hard gate（Issue #439 の runtime / eval の揃え）。本番の素材（gateInputOf）から作った入力で、
// 評価だけが拾っていた 2 つ（未回答の Target の混入・一言の因果づけ）を本番でも高 precision に拾うことを固定する。
// 拾うのは完全一致・決まった形だけで、言い換えや主題を省いた因果は評価（eval/structured）の側に残す。

const LEX = readStructuredGateLexicon(lexiconRaw);
const LEGACY = readLegacyLexicons();

const SASHIMI = 'a4390000-0000-4000-8000-0000000000a1';
const YAKITORI = 'a4390000-0000-4000-8000-0000000000a2';
const MOTSUNI = 'a4390000-0000-4000-8000-0000000000a3';
const SASHIMI_SHORT = 'a4390000-0000-4000-8000-0000000000a4';

const DEFINITION: StructuredSurveyDefinition = {
  mode: 'structured',
  revision: 4,
  categories: [
    {
      code: 'food',
      label: '料理',
      sortOrder: 10,
      allowsTargets: true,
      categoryFacets: [{ code: 'volume', label: '量', sortOrder: 10 }],
      targetFacets: [{ code: 'taste', label: '味', sortOrder: 10 }],
      targets: [
        { id: SASHIMI, label: '刺身盛り合わせ', sortOrder: 0 },
        { id: YAKITORI, label: '焼き鳥5種盛り', sortOrder: 1 },
        { id: MOTSUNI, label: '名物もつ煮', sortOrder: 2 },
      ],
    },
  ],
};

const sashimiTaste = { polarity: 'positive' as const, categoryCode: 'food', categoryLabel: '料理', targetId: SASHIMI, targetLabel: '刺身盛り合わせ', facets: [{ code: 'taste', label: '味' }] };

function material(over: Partial<StructuredDraftMaterial> = {}): StructuredDraftMaterial {
  const base: StructuredDraftMaterial = {
    storeName: '居酒屋 テスト',
    surveyRevision: 4,
    star: 4,
    selections: [sashimiTaste],
    unselectedTargets: unselectedTargetsOf(
      { star: 4, positiveSelections: [{ categoryCode: 'food', targetId: SASHIMI, facetCodes: ['taste'] }], concernSelections: [] },
      DEFINITION,
    ),
  };
  return { ...base, ...over };
}

const families = (m: StructuredDraftMaterial, draft: string) =>
  [...new Set(evaluateStructuredDraft(gateInputOf(m), draft, LEX, LEGACY).findings.map((f) => gateFamily(f.kind)))];

describe('未回答の Target（runtime）', () => {
  it('回答の検証と同じ定義から、選ばれなかった active な Target を作る', () => {
    expect(material().unselectedTargets).toEqual([
      { id: YAKITORI, label: '焼き鳥5種盛り', categoryCode: 'food' },
      { id: MOTSUNI, label: '名物もつ煮', categoryCode: 'food' },
    ]);
  });

  it('選んだ Target だけを書いた下書きは通す', () => {
    expect(families(material(), '刺身盛り合わせがおいしかったです。')).toEqual([]);
  });

  it('店舗の別の active な Target の名前を足したら失格（「焼き鳥5種盛りも良かった」）', () => {
    expect(families(material(), '刺身盛り合わせがおいしく、焼き鳥5種盛りも良かったです。')).toContain('unselectedTarget');
    // 名前の中の空白・全角半角の違いは同じ名前として扱う（NFKC）。
    expect(families(material(), '刺身盛り合わせがおいしく、焼き鳥５種盛りも良かったです。')).toContain('unselectedTarget');
  });

  it('選んだ Target が複数でも、選んだものだけなら通す', () => {
    const m = material({
      selections: [sashimiTaste, { polarity: 'positive', categoryCode: 'food', categoryLabel: '料理', targetId: YAKITORI, targetLabel: '焼き鳥5種盛り', facets: [] }],
      unselectedTargets: [{ id: MOTSUNI, label: '名物もつ煮', categoryCode: 'food' }],
    });
    expect(families(m, '刺身盛り合わせがおいしく、焼き鳥5種盛りも良かったです。')).toEqual([]);
    expect(families(m, '刺身盛り合わせがおいしく、焼き鳥5種盛りも名物もつ煮も良かったです。')).toContain('unselectedTarget');
  });

  it('回答の後に店舗が名前を変えても、素材の snapshot の名前で照合する（選んだ Target を未回答と数えない）', () => {
    // 回答時点の名前「刺身盛り合わせ」の snapshot。店舗はその後「本日の刺身」へ変えたが、素材は変わらない。
    const m = material({ selections: [{ ...sashimiTaste, targetLabel: '刺身盛り合わせ' }] });
    expect(families(m, '刺身盛り合わせがおいしかったです。')).toEqual([]);
  });

  it('選んだ Target の名前に含まれる未回答の名前（選んだ「刺身盛り合わせ」と未回答の「刺身」）は、選んだ名前の中では数えない', () => {
    const m = material({ unselectedTargets: [{ id: SASHIMI_SHORT, label: '刺身', categoryCode: 'food' }] });
    expect(families(m, '刺身盛り合わせがおいしかったです。')).toEqual([]);
    expect(families(m, '刺身盛り合わせがおいしかったです。刺身も良かったです。')).toContain('unselectedTarget');
  });

  it('関係の無い普通名詞・言い換えは推測しない（高 precision）', () => {
    // 「もつ」「焼き鳥」は未回答の Target の名前と一致しない（名前の一部・言い換えは拾わない）。
    expect(families(material(), '刺身盛り合わせがおいしかったです。')).not.toContain('unselectedTarget');
    expect(families(material(), '刺身盛り合わせの味が良かったです。焼き鳥の店らしい雰囲気でした。')).not.toContain('unselectedTarget');
    // 1 文字の名前は照合しない（普通名詞の一部に当たりやすい）。
    const m = material({ unselectedTargets: [{ id: SASHIMI_SHORT, label: '鍋', categoryCode: 'food' }] });
    expect(families(m, '刺身盛り合わせがおいしかったです。')).not.toContain('unselectedTarget');
  });

  it('一言に書かれた未回答の Target の名前は客の素材なので数えない', () => {
    const m = material({ comment: '名物もつ煮も食べました' });
    expect(families(m, '刺身盛り合わせがおいしかったです。名物もつ煮も食べました。')).not.toContain('unselectedTarget');
  });

  it('Issue #439 より前の sessionToken の素材（unselectedTargets 無し）は照合しない', () => {
    const old: StructuredDraftMaterial = { ...material() };
    delete old.unselectedTargets;
    expect(families(old, '刺身盛り合わせがおいしく、焼き鳥5種盛りも良かったです。')).not.toContain('unselectedTarget');
  });
});

describe('一言の因果づけ（runtime）', () => {
  const comfort = { polarity: 'positive' as const, categoryCode: 'atmosphere', categoryLabel: '店内・雰囲気', facets: [{ code: 'comfort', label: '居心地' }] };
  const withWindow = (over: Partial<StructuredDraftMaterial> = {}) => material({ selections: [comfort], comment: '窓側の席でした', ...over });

  it('一言を独立した内容として並べるのは通す', () => {
    expect(families(withWindow(), '居心地が良かったです。窓側の席でした。')).toEqual([]);
    expect(families(withWindow(), '窓側の席で、居心地が良かったです。')).not.toContain('commentLinkage');
  });

  it('一言の内容を別の claim の理由として結ぶと失格（「窓側の席だったので居心地が良かった」）', () => {
    expect(families(withWindow(), '窓側の席だったので居心地が良かったです。')).toContain('commentLinkage');
    expect(families(withWindow(), '窓側の席だったため、居心地が良かったです。')).toContain('commentLinkage');
    // 主題が接続の前にあっても、一言の語が理由の側にあれば拾う。
    expect(families(withWindow(), '居心地は、窓側の席だったので良かったです。')).toContain('commentLinkage');
  });

  it('Target の claim への因果づけも拾う（「店員さんの対応が丁寧だったから、刺身盛り合わせもおいしく感じた」）', () => {
    const m = material({ comment: '店員さんの対応が丁寧でした' });
    expect(families(m, '店員さんの対応が丁寧だったから、刺身盛り合わせもおいしく感じました。')).toContain('commentLinkage');
    expect(families(m, '刺身盛り合わせがおいしかったです。店員さんの対応も丁寧でした。')).not.toContain('commentLinkage');
  });

  it('claim 同士の自然な接続・起点の「から」は数えない（一言の語が理由の側に無い）', () => {
    const m = material({ selections: [sashimiTaste, comfort], comment: '窓側の席でした' });
    expect(families(m, '刺身盛り合わせがおいしかったので、居心地も良かったです。窓側の席でした。')).not.toContain('commentLinkage');
    const staff = material({ comment: '店員さんが説明してくれた' });
    expect(families(staff, '店員さんから説明があり、刺身盛り合わせがおいしかったです。')).not.toContain('commentLinkage');
  });

  it('一言そのものが因果を述べていれば、客の素材なので数えない', () => {
    const m = withWindow({ comment: '窓側の席だったので居心地が良かった' });
    expect(families(m, '窓側の席だったので居心地が良かったです。')).not.toContain('commentLinkage');
  });

  it('一言が無ければ従来どおり判定しない', () => {
    const m = material({ selections: [sashimiTaste, comfort] });
    expect(families(m, '刺身盛り合わせがおいしかったので、居心地も良かったです。')).not.toContain('commentLinkage');
  });
});

describe('既存の境界を壊さない（runtime）', () => {
  it('Target だけの claim は「良かった」までで、味・量・鮮度を足すと失格', () => {
    const m = material({ selections: [{ polarity: 'positive', categoryCode: 'food', categoryLabel: '料理', targetId: SASHIMI, targetLabel: '刺身盛り合わせ', facets: [] }] });
    expect(families(m, '刺身盛り合わせが良かったです。')).toEqual([]);
    expect(families(m, '刺身盛り合わせがおいしかったです。')).toContain('unselectedFacet');
    expect(families(m, '刺身盛り合わせは量が多かったです。')).toContain('unselectedFacet');
    expect(families(m, '刺身盛り合わせが新鮮でした。')).toContain('newAttribute');
  });

  it('exact overlap は両面だけなら通し、時間帯・部位などの理由を足すと失格', () => {
    const m = material({ selections: [sashimiTaste, { ...sashimiTaste, polarity: 'concern' }] });
    expect(families(m, '刺身盛り合わせの味は、良かったところも、気になるところもありました。')).toEqual([]);
    expect(families(m, '刺身盛り合わせの味は、時間帯によって良いときと気になるときがありました。')).toContain('overlapReason');
    expect(families(m, '刺身盛り合わせの味は、部位によって良かったり気になったりしました。')).toContain('overlapReason');
  });

  it('カテゴリ全体の facet の claim は、その facet で述べれば通す', () => {
    const m = material({ selections: [{ polarity: 'positive', categoryCode: 'food', categoryLabel: '料理', facets: [{ code: 'volume', label: '量' }] }] });
    expect(families(m, '料理の量が良かったです。')).toEqual([]);
  });
});

describe('Realizer の作り直し（未回答の Target・一言の因果づけ）', () => {
  function fakeClient(...replies: string[]) {
    const contents: string[] = [];
    const client: GenAiClient = {
      models: {
        generateContent: async (req) => {
          contents.push(req.contents);
          return { text: JSON.stringify({ draft: replies.shift() ?? '' }) };
        },
      },
    };
    return { client, contents };
  }

  it('未回答の Target を足した 1 回目は作り直し、2 回目が通れば LLM の下書き。未回答の Target 一覧は LLM へ渡さない', async () => {
    const onRetry = vi.fn();
    const { client, contents } = fakeClient('刺身盛り合わせがおいしく、焼き鳥5種盛りも良かったです。', '刺身盛り合わせがおいしかったです。');
    const result = await createNaturalRealizer(client, { onRetry }).prepare(material());
    expect(result).toEqual({ kind: 'draft', draft: '刺身盛り合わせがおいしかったです。', source: 'llm', attempts: 2 });
    // 「5種」の数字も素材に無い数値として当たる（ungrounded）。種類と claim の件数だけを渡す。
    expect(onRetry.mock.calls[0]![0]).toContain('unselectedTarget');
    expect(onRetry.mock.calls[0]![1]).toBe(1);
    for (const c of contents) expect(c).not.toMatch(/焼き鳥5種盛り|名物もつ煮/);
  });

  it('3 回とも一言を理由に結べば generation error（safe fallback の文は返さない）', async () => {
    const onFailed = vi.fn();
    const comfort = { polarity: 'positive' as const, categoryCode: 'atmosphere', categoryLabel: '店内・雰囲気', facets: [{ code: 'comfort', label: '居心地' }] };
    const { client } = fakeClient('窓側の席だったので居心地が良かったです。', '窓側の席だったため、居心地が良かったです。', '窓側の席だったので、居心地よく過ごせました。');
    const result = await createNaturalRealizer(client, { onFailed }).prepare(
      material({ selections: [comfort], comment: '窓側の席でした' }),
    );
    expect(result).toEqual({ kind: 'failed', attempts: 3 });
    expect(onFailed).toHaveBeenCalledWith('gate', ['commentLinkage'], 1);
  });
});

describe('自然さ重視の境界（controlled inference）: 本番の runtime hard gate', () => {
  // 回答から自然に導ける主観的・意味を保った言い換えは通し、新しい具体的事実は止める。
  const volume = { polarity: 'positive' as const, categoryCode: 'food', categoryLabel: '料理', facets: [{ code: 'volume', label: '量' }] };
  const courtesy = { polarity: 'positive' as const, categoryCode: 'service_delivery', categoryLabel: '接客・提供', facets: [{ code: 'service_courtesy', label: '接客の丁寧さ' }] };
  const entryWait = { polarity: 'concern' as const, categoryCode: 'reservation_visit', categoryLabel: '予約・来店', facets: [{ code: 'entry_wait', label: '入店までの待ち時間' }] };
  const serving = { polarity: 'concern' as const, categoryCode: 'service_delivery', categoryLabel: '接客・提供', facets: [{ code: 'serving', label: '料理・ドリンクの提供' }] };
  const sashimiTasteLook = { ...sashimiTaste, facets: [{ code: 'taste', label: '味' }, { code: 'appearance', label: '見た目' }] };
  const sashimiTasteConcern = { ...sashimiTaste, polarity: 'concern' as const };
  const sashimiOnly = { ...sashimiTaste, facets: [] };

  const everyday = material({ star: 5, selections: [volume, courtesy, entryWait] });
  const cases: [string, StructuredDraftMaterial, string[], [string, string][]][] = [
    [
      'ケース1: 量・接客 positive / 入店の待ち時間 concern',
      everyday,
      [
        '入店までの待ち時間は少し気になりましたが、料理は満足感のある量で、接客も丁寧でした。',
        '料理は量にも満足できて、丁寧に対応してもらえました。待ち時間の部分だけ、やや気になりました。全体としては満足です。',
      ],
      [
        ['入店まで20分待ちましたが、料理の量に満足で、接客も丁寧でした。', 'ungrounded'],
        ['予約客が多かったので入店まで待ちましたが、料理の量に満足で、接客も丁寧でした。', 'commentLinkage|cause'],
        ['料理の量に満足で、店員さんが笑顔で対応してくれました。待ち時間は気になりました。', 'newAttribute'],
        ['友人と行きました。料理の量に満足で、接客も丁寧でした。待ち時間は気になりました。', 'companion'],
        ['料理の量に満足で、接客も丁寧でした。待ち時間は気になりましたが、また行きたいです。', 'revisit'],
        ['料理の量にとても満足で、接客も丁寧でした。待ち時間は気になりました。', 'intensity'],
      ],
    ],
    [
      'ケース2: 刺身盛り合わせ / 味 positive',
      material({ star: 5 }),
      ['刺身盛り合わせ、おいしかったです！', '刺身盛り合わせの味が印象に残りました。全体的に満足です。'],
      [
        ['新鮮な刺身盛り合わせがおいしかったです。', 'newAttribute'],
        ['刺身盛り合わせがおいしくて、絶対おすすめです。', 'intensity'],
      ],
    ],
    [
      'ケース3: 刺身盛り合わせ / 味・見た目 positive',
      material({ selections: [sashimiTasteLook] }),
      ['刺身盛り合わせは見た目もきれいで、味も満足でした。', '刺身盛り合わせ、盛り付けが印象に残りました。おいしかったです。'],
      [['刺身盛り合わせは香ばしくて見た目も良かったです。', 'newAttribute']],
    ],
    [
      'ケース4: 刺身盛り合わせ / 味 positive・提供 concern',
      material({ star: 3, selections: [sashimiTaste, serving] }),
      ['刺身盛り合わせはおいしかったです。提供の部分は少し気になりました。', '提供までの待ち時間がやや気になりましたが、刺身盛り合わせはおいしかったです。'],
      [
        ['刺身盛り合わせはおいしかったですが、提供まで30分かかりました。', 'ungrounded'],
        ['刺身盛り合わせはおいしかったですが、混雑していて提供が気になりました。', 'cause'],
      ],
    ],
    [
      'ケース5: exact overlap（刺身盛り合わせ / 味 が両方）',
      material({ star: 3, selections: [sashimiTaste, sashimiTasteConcern] }),
      ['刺身盛り合わせの味について、良かった点もあり、気になる点もありました。'],
      [['刺身盛り合わせは、最初は美味しかったが後半は味が落ちた。', 'overlapReason']],
    ],
    [
      'Target だけ（項目の指定なし）は厳しいまま',
      material({ selections: [sashimiOnly] }),
      ['刺身盛り合わせが印象に残りました。', '刺身盛り合わせが良かったです。'],
      [
        ['刺身盛り合わせがおいしかったです。', 'unselectedFacet'],
        ['刺身盛り合わせは新鮮でした。', 'newAttribute'],
      ],
    ],
  ];

  for (const [name, m, allowed, forbidden] of cases) {
    describe(name, () => {
      for (const draft of allowed) {
        it(`通す: ${draft}`, () => expect(families(m, draft)).toEqual([]));
      }
      for (const [draft, kinds] of forbidden) {
        it(`止める（${kinds}）: ${draft}`, () => {
          const got = families(m, draft);
          expect(got.some((k) => kinds.split('|').includes(k)), JSON.stringify(got)).toBe(true);
        });
      }
    });
  }

  it('全体の印象の文は、直前の料理を主題として引き継がない（★の抽象的な不満を、料理の極性の反転と数えない）', () => {
    const m = material({ star: 2 });
    expect(families(m, '刺身盛り合わせはおいしかったです。全体としては不満が残りました。')).toEqual([]);
    expect(families(m, '刺身盛り合わせはおいしかったです。でも残念でした。')).toContain('polarityReversal');
  });
});

describe('safe fallback へ落ちた実例の誤検出と、回答の項目どうしの因果（実 Gemini・2026-10-11）', () => {
  const volume = { polarity: 'positive' as const, categoryCode: 'food', categoryLabel: '料理', facets: [{ code: 'volume', label: '量' }] };
  const courtesy = (polarity: 'positive' | 'concern') => ({
    polarity,
    categoryCode: 'service_delivery',
    categoryLabel: '接客・提供',
    facets: [{ code: 'service_courtesy', label: '接客の丁寧さ' }],
  });
  const entryWait = { polarity: 'positive' as const, categoryCode: 'reservation_visit', categoryLabel: '予約・来店', facets: [{ code: 'entry_wait', label: '入店までの待ち時間' }] };
  const reservation = { polarity: 'positive' as const, categoryCode: 'reservation_visit', categoryLabel: '予約・来店', facets: [{ code: 'reservation_ease', label: '予約のしやすさ' }] };
  const price = { polarity: 'concern' as const, categoryCode: 'price', categoryLabel: '価格', facets: [{ code: 'food_price', label: '料理の価格' }] };
  const mixed = material({ selections: [volume, courtesy('positive'), entryWait, courtesy('concern'), price] });

  it('「〜は気になりませんでした」は positive の言い方で、極性の反転に数えない', () => {
    expect(families(mixed, '入店までの待ち時間は気になりませんでした。料理の量にも満足できました。接客の丁寧さは良い点も気になる点もあり、料理の価格は気になりました。')).toEqual([]);
    // 否定でない「気になりました」は concern のまま（positive の claim の反転）。
    expect(families(material({ selections: [entryWait] }), '入店までの待ち時間が気になりました。')).toContain('polarityReversal');
  });

  it('exact overlap の理由は overlap の主題の文でだけ数える（無関係な文の「〜ものの」では数えない）', () => {
    expect(families(mixed, '料理の量に満足できたものの、料理の価格は気になりました。接客の丁寧さは良い面も気になる面もありました。入店までスムーズでした。')).toEqual([]);
    expect(families(mixed, '接客の丁寧さは、時間帯によって良いときと気になるときがありました。料理の量に満足できました。入店までスムーズで、料理の価格は気になりました。')).toContain('overlapReason');
    // overlap の文の直後の、主題を名指さない文の理由も数える。
    expect(families(mixed, '接客の丁寧さは良い点も気になる点もありました。その時々で違うのだと思います。料理の量に満足できました。入店までスムーズで、料理の価格は気になりました。')).toContain('overlapReason');
  });

  it('「〜のおかげか」「〜のおかげで」「〜からか」は原因の創作', () => {
    for (const draft of [
      '予約のおかげか待ち時間も少なく、料理の量にも満足できました。接客の丁寧さは良い点も気になる点もあり、料理の価格は気になりました。',
      'スタッフのおかげで入店までスムーズで、料理の量にも満足できました。接客の丁寧さは良い点も気になる点もあり、料理の価格は気になりました。',
      '空いていたからか入店までスムーズで、料理の量にも満足できました。接客の丁寧さは良い点も気になる点もあり、料理の価格は気になりました。',
    ]) {
      expect(families(mixed, draft), draft).toContain('cause');
    }
  });

  it('予約と待ち時間を両方回答していても、因果で結ばない（「予約のおかげで待ち時間が短かった」は失格）', () => {
    const both = material({ selections: [reservation, entryWait] });
    expect(families(both, '予約がしやすく、入店までの待ち時間も短く済みました。')).toEqual([]);
    expect(families(both, '予約のおかげで、入店までの待ち時間も短く済みました。')).toContain('cause');
    // 一言に客が書いた因果は、客の素材として数えない（既存の意味論）。
    const commented = material({ selections: [reservation, entryWait], comment: '予約していたおかげですぐ入れた' });
    expect(families(commented, '予約していたおかげで、入店までスムーズでした。')).not.toContain('cause');
  });

  it('exact overlap の両面だけの言い方は通す（原因や時間の順を足さなければよい）', () => {
    expect(families(mixed, '接客の丁寧さについては、良い部分もあれば気になる点もありました。料理の量に満足でき、入店までスムーズでした。料理の価格は気になりました。')).toEqual([]);
  });
});

describe('最終調整: 回答の項目どうしの因果・待ち時間の強め・不自然な日本語（実 Gemini・2026-10-11）', () => {
  const reservation = { polarity: 'positive' as const, categoryCode: 'reservation_visit', categoryLabel: '予約・来店', facets: [{ code: 'reservation_ease', label: '予約のしやすさ' }] };
  const entryWait = { polarity: 'positive' as const, categoryCode: 'reservation_visit', categoryLabel: '予約・来店', facets: [{ code: 'entry_wait', label: '入店までの待ち時間' }] };
  const courtesy = { polarity: 'positive' as const, categoryCode: 'service_delivery', categoryLabel: '接客・提供', facets: [{ code: 'service_courtesy', label: '接客の丁寧さ' }] };
  const volume = { polarity: 'positive' as const, categoryCode: 'food', categoryLabel: '料理', facets: [{ code: 'volume', label: '量' }] };
  const both = material({ selections: [reservation, entryWait] });

  it('独立した回答同士を因果で結んだら失格（予約していたので / 予約のおかげで）', () => {
    expect(families(both, '予約していたので、入店までスムーズでした。')).toContain('cause');
    expect(families(both, '予約していたので待ち時間なく入れました。')).toEqual(expect.arrayContaining(['cause', 'overstatement']));
    expect(families(both, '予約のおかげで待たずに入れました。')).toEqual(expect.arrayContaining(['cause', 'overstatement']));
    expect(families(material({ selections: [courtesy, volume] }), '接客が丁寧だったので、料理の量にも満足できました。')).toContain('cause');
  });

  it('因果でない並べ方・同じ主題の中の「ので」・「〜のですが」は数えない', () => {
    expect(families(both, '予約がしやすく、入店までスムーズでした。')).toEqual([]);
    expect(families(material({ selections: [volume] }), '料理の量が多めだったので、満足できました。')).toEqual([]);
    expect(families(material({ selections: [courtesy, volume] }), '接客は丁寧だったのですが、料理の量にも満足できました。')).not.toContain('cause');
  });

  it('入店までの待ち時間の positive は「スムーズ」「気になりませんでした」まで。待ち時間ゼロへの強めは失格', () => {
    const wait = material({ selections: [entryWait] });
    for (const ok of ['入店までスムーズでした。', '入店までの待ち時間は気になりませんでした。']) expect(families(wait, ok), ok).toEqual([]);
    for (const ng of ['入店までの待ち時間がなかったのが良かったです。', '待たずに入れて良かったです。', 'すぐ入れて良かったです。', '入店まで待つことなく入れて良かったです。']) {
      expect(families(wait, ng), ng).toContain('overstatement');
    }
    // 一言に客が書いた言い方は数えない。
    expect(families(material({ selections: [entryWait], comment: 'すぐ入れた' }), 'すぐ入れて良かったです。')).not.toContain('overstatement');
  });

  it('不自然な日本語は style の問題（factuality は通る）', () => {
    const m = material({ selections: [volume, { polarity: 'concern' as const, categoryCode: 'drink', categoryLabel: 'ドリンク', facets: [{ code: 'variety', label: '種類' }] }] });
    for (const text of [
      '料理の量にも満足できました。ドリンクの種類がもう少しあればと思いました。',
      '料理の量に満足できました。ドリンクの種類はもう少し多いと嬉しいと感じました。',
      '料理の量も十分。ドリンクの種類は少し気になりました。',
    ]) {
      expect(families(m, text), text).toEqual([]);
      expect(detectStyleIssues(text, LEX), text).toContain('style:awkwardPhrase');
    }
    expect(detectStyleIssues('料理の量にも満足できました。ドリンクの種類はもう少し多いと嬉しかったです。', LEX)).toEqual([]);
  });
});
