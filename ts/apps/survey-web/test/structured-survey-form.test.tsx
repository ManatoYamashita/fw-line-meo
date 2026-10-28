// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { StructuredSurveyDefinition } from '@fwlm/db';
import { StructuredSurveyForm } from '../src/app/s/[storeId]/structured-survey-form';

// structured survey の回答フォーム（Issue #438）。開くことと回答を混同しないこと・送信の形・要約・対称性を確かめる。
// Base UI の Checkbox は PointerEvent でクリックを転送するので、jsdom に互換実装を入れる（survey-form.test.tsx と同じ）。
if (!('PointerEvent' in window)) {
  class PointerEventPolyfill extends MouseEvent {}
  Object.defineProperty(window, 'PointerEvent', { value: PointerEventPolyfill, configurable: true, writable: true });
}

const SASHIMI = 'a4380000-0000-4000-8000-0000000000a1';
const YAKITORI = 'a4380000-0000-4000-8000-0000000000a2';

function definition(overrides: { foodTargets?: { id: string; label: string; sortOrder: number }[] } = {}): StructuredSurveyDefinition {
  return {
    mode: 'structured',
    revision: 1,
    categories: [
      {
        code: 'food',
        label: '料理',
        sortOrder: 10,
        allowsTargets: true,
        categoryFacets: [
          { code: 'taste', label: '味', sortOrder: 10 },
          { code: 'volume', label: '量', sortOrder: 20 },
        ],
        targetFacets: [
          { code: 'taste', label: '味', sortOrder: 10 },
          { code: 'temperature_condition', label: '温度・状態', sortOrder: 40 },
        ],
        targets: overrides.foodTargets ?? [
          { id: SASHIMI, label: '刺身盛り合わせ', sortOrder: 0 },
          { id: YAKITORI, label: '焼き鳥5種盛り', sortOrder: 1 },
        ],
      },
      {
        code: 'service_delivery',
        label: '接客・提供',
        sortOrder: 30,
        allowsTargets: false,
        categoryFacets: [
          { code: 'service_courtesy', label: '接客の丁寧さ', sortOrder: 10 },
          { code: 'serving', label: '料理・ドリンクの提供', sortOrder: 40 },
        ],
        targetFacets: [],
        targets: [],
      },
    ],
  };
}

afterEach(cleanup);

function setup(def = definition()) {
  const onSubmit = vi.fn();
  render(<StructuredSurveyForm definition={def} onSubmit={onSubmit} submitting={false} />);
  return { onSubmit };
}

const POSITIVE_TITLE = '良かったところ（任意）';
const CONCERN_TITLE = '気になったところ（任意）';
const POLARITY_HINT = '当てはまるものがあれば選んでください';
const POLARITY_NOTE = '良かったところ・気になったところの、どちらからでも選べます。両方を埋める必要はありません。';
const COMMENT_TOGGLE = /^その他の感想（任意）/;
const COMMENT_LABEL = 'その他に伝えたいことがあれば入力してください';
const SUBMIT = '口コミ文を作る';
const SUBMITTING = '口コミ文を作成しています…';

const section = (name: string) => within(screen.getByRole('region', { name }));
const positive = () => section(POSITIVE_TITLE);
const concern = () => section(CONCERN_TITLE);
/** 領域の中のカテゴリの押しボタン（両側とも、極性そのものを開閉する押しボタンは持たない）。 */
const categoryButtons = (where: ReturnType<typeof within>): HTMLElement[] => where.getAllByRole('button');
const commentToggle = () => screen.getByRole('button', { name: COMMENT_TOGGLE });

function star(n: number): void {
  fireEvent.click(screen.getByRole('button', { name: `星${n}` }));
}
function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: SUBMIT }));
}
const SERVICE_BOTH = { categoryCode: 'service_delivery', facetCodes: ['service_courtesy', 'serving'] };
/** 良かったところで「接客・提供」の facet を 2 つ選ぶ（口コミ文を作れる最小の材料）。 */
function pickTwo(): void {
  openCategory(positive(), '接客・提供');
  fireEvent.click(positive().getByRole('checkbox', { name: '接客の丁寧さ' }));
  fireEvent.click(positive().getByRole('checkbox', { name: '料理・ドリンクの提供' }));
}
const submitButton = () => screen.getByRole('button', { name: SUBMIT }) as HTMLButtonElement;
const note = () => screen.getByRole('status').textContent;
const COUNTING_NOTE =
  '料理の名前は、詳細と合わせて1件と数えます（詳細が2つ以上ならその数）。その他の感想は件数に含まれません。';

/** カテゴリの開閉の押しボタン。選択済みの読み上げ名は「料理（選択あり）」なので、名前の先頭で掴む。 */
function openCategory(where: ReturnType<typeof within>, label: string): void {
  fireEvent.click(where.getByRole('button', { name: new RegExp(`^${label}(\\s*（選択あり）)?$`) }));
}

describe('StructuredSurveyForm', () => {
  it('初期表示: 星・良かったところ・気になったところ・一言。カテゴリは定義の順に、どちらの極性にも同じものを出す', () => {
    setup();
    expect(screen.getByRole('group', { name: '今回の満足度（必須）' })).toBeDefined();
    // 両側とも最初からカテゴリの札を出す（どちらの極性も畳まない・Issue #460）。
    for (const where of [positive(), concern()]) {
      const names = categoryButtons(where).map((b) => b.textContent);
      expect(names).toEqual(['料理', '接客・提供']);
      for (const b of categoryButtons(where)) expect(b.getAttribute('aria-expanded')).toBe('false');
    }
    // 開く前は facet を 1 つも出さない（初期状態で全 facet を縦に展開しない）。
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    // 一言欄は最初は閉じている（タップだけで回答できることを優先する）。
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(commentToggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('星は必須のまま: 材料が 2 件あっても星が無ければ送信を止める', () => {
    const { onSubmit } = setup();
    pickTwo();
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('満足度を選択してください')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
    star(2);
    submit();
    expect(onSubmit).toHaveBeenCalledWith({ star: 2, positiveSelections: [SERVICE_BOTH], concernSelections: [] });
  });

  it('カテゴリを開いて閉じただけでは数えず、口コミ文を作る押しボタンは押せない（開くことは回答ではない）', () => {
    const { onSubmit } = setup();
    star(4);
    openCategory(positive(), '料理');
    expect(positive().getByRole('button', { name: '料理' }).getAttribute('aria-expanded')).toBe('true');
    openCategory(positive(), '接客・提供');
    openCategory(concern(), '料理');
    openCategory(concern(), '料理');
    expect(submitButton().disabled).toBe(true);
    expect(note()).toBe('感想を2つ以上選ぶと口コミ文を作れます');
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('カテゴリ全体の facet・Target だけ・Target + facet・複数の Target を区別して送る', () => {
    const { onSubmit } = setup();
    star(5);
    openCategory(positive(), '料理');
    const panel = within(positive().getByRole('group', { name: '料理' }));
    expect(panel.getByText('料理全体について')).toBeDefined();
    expect(panel.getByText('具体的な料理')).toBeDefined();
    fireEvent.click(panel.getByRole('checkbox', { name: '味' }));
    fireEvent.click(panel.getByRole('checkbox', { name: '焼き鳥5種盛り' }));
    fireEvent.click(panel.getByRole('checkbox', { name: '刺身盛り合わせ' }));
    // 選んだ Target は詳しく開き、Target 用の facet を出す（カテゴリ全体の「味」とは別の札）。
    const sashimi = within(panel.getByText('刺身盛り合わせについて').parentElement!);
    fireEvent.click(sashimi.getByRole('checkbox', { name: '温度・状態' }));
    submit();
    expect(onSubmit).toHaveBeenCalledWith({
      star: 5,
      positiveSelections: [
        { categoryCode: 'food', facetCodes: ['taste'] },
        { categoryCode: 'food', targetId: SASHIMI, facetCodes: ['temperature_condition'] },
        { categoryCode: 'food', targetId: YAKITORI, facetCodes: [] },
      ],
      concernSelections: [],
    });
  });

  it('別のカテゴリを開いても選択は残り、折り畳んだカテゴリに選んだ内容の要約を出す', () => {
    const { onSubmit } = setup();
    star(3);
    openCategory(positive(), '料理');
    const panel = within(positive().getByRole('group', { name: '料理' }));
    fireEvent.click(panel.getByRole('checkbox', { name: '量' }));
    fireEvent.click(panel.getByRole('checkbox', { name: '刺身盛り合わせ' }));
    openCategory(positive(), '接客・提供');
    expect(positive().queryByRole('group', { name: '料理' })).toBeNull();
    const summary = positive().getByRole('list', { name: '良かったところで選んだ内容' });
    expect(summary.textContent).toBe('✓ 料理：料理全体：量／刺身盛り合わせ');
    expect(positive().getByRole('button', { name: /^料理\s*（選択あり）$/ }).textContent).toContain('✓');
    // 開き直すと選択は残っている。
    openCategory(positive(), '料理');
    expect(
      within(positive().getByRole('group', { name: '料理' })).getByRole('checkbox', { name: '量' }).getAttribute('aria-checked'),
    ).toBe('true');
    submit();
    expect(onSubmit.mock.calls[0]![0].positiveSelections).toEqual([
      { categoryCode: 'food', facetCodes: ['volume'] },
      { categoryCode: 'food', targetId: SASHIMI, facetCodes: [] },
    ]);
  });

  it('良かったところと気になったところで、同じ Target・facet を選べる（矛盾として扱わない）', () => {
    const { onSubmit } = setup();
    star(3);
    for (const where of [positive, concern]) {
      openCategory(where(), '料理');
      const panel = within(where().getByRole('group', { name: '料理' }));
      fireEvent.click(panel.getByRole('checkbox', { name: '刺身盛り合わせ' }));
      fireEvent.click(within(panel.getByText('刺身盛り合わせについて').parentElement!).getByRole('checkbox', { name: '味' }));
    }
    expect(screen.queryByRole('alert')).toBeNull();
    submit();
    const group = [{ categoryCode: 'food', targetId: SASHIMI, facetCodes: ['taste'] }];
    expect(onSubmit).toHaveBeenCalledWith({ star: 3, positiveSelections: group, concernSelections: group });
  });

  it('Target 0 件の店舗でも、料理全体の facet だけで回答できる（「具体的な料理」を出さない）', () => {
    const { onSubmit } = setup(definition({ foodTargets: [] }));
    star(4);
    openCategory(concern(), '料理');
    const panel = within(concern().getByRole('group', { name: '料理' }));
    expect(panel.queryByText('具体的な料理')).toBeNull();
    fireEvent.click(panel.getByRole('checkbox', { name: '味' }));
    fireEvent.click(panel.getByRole('checkbox', { name: '量' }));
    submit();
    expect(onSubmit).toHaveBeenCalledWith({
      star: 4,
      positiveSelections: [],
      concernSelections: [{ categoryCode: 'food', facetCodes: ['taste', 'volume'] }],
    });
  });

  it('非表示のカテゴリ・Target（定義に無いもの）は出さない', () => {
    const def = definition({ foodTargets: [{ id: SASHIMI, label: '刺身盛り合わせ', sortOrder: 0 }] });
    def.categories = def.categories.filter((c) => c.code !== 'service_delivery');
    setup(def);
    expect(positive().queryByRole('button', { name: '接客・提供' })).toBeNull();
    openCategory(positive(), '料理');
    expect(positive().queryByRole('checkbox', { name: '焼き鳥5種盛り' })).toBeNull();
  });

  it('Target 詳細は 1 件ずつ開き、他の選んだ Target は要約と「詳しく選ぶ」を出す', () => {
    setup();
    openCategory(positive(), '料理');
    const panel = within(positive().getByRole('group', { name: '料理' }));
    fireEvent.click(panel.getByRole('checkbox', { name: '刺身盛り合わせ' }));
    fireEvent.click(within(panel.getByText('刺身盛り合わせについて').parentElement!).getByRole('checkbox', { name: '味' }));
    fireEvent.click(panel.getByRole('checkbox', { name: '焼き鳥5種盛り' }));
    expect(panel.queryByText('刺身盛り合わせについて')).toBeNull();
    expect(panel.getByText('焼き鳥5種盛りについて')).toBeDefined();
    const more = panel.getByRole('button', { name: '刺身盛り合わせについて詳しく選ぶ' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(panel.getByText('刺身盛り合わせについて')).toBeDefined();
  });

  it('未選択を「なし」と読む文言を出さない', () => {
    setup();
    const text = document.body.textContent ?? '';
    for (const banned of ['問題なし', '特になし', '良いところなし', '気になる点なし']) expect(text).not.toContain(banned);
  });

  it('一言は空白だけなら送らず、書いたら送る', () => {
    const { onSubmit } = setup();
    star(5);
    pickTwo();
    fireEvent.click(commentToggle());
    const box = screen.getByRole('textbox', { name: COMMENT_LABEL });
    fireEvent.change(box, { target: { value: '   ' } });
    submit();
    expect(onSubmit.mock.calls[0]![0]).not.toHaveProperty('comment');
    fireEvent.change(box, { target: { value: '窓側の席が落ち着いた' } });
    submit();
    expect(onSubmit.mock.calls[1]![0].comment).toBe('窓側の席が落ち着いた');
  });

  it('良かったところと気になったところで、同じ札の id が衝突しない', () => {
    setup();
    openCategory(positive(), '料理');
    openCategory(concern(), '料理');
    const ids = Array.from(document.querySelectorAll('[id]')).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('良かったところと気になったところは、同じ要素・同じ class の見出しで、同じ補足を持つ（強弱を付けない・Issue #460）', () => {
    setup();
    const positiveHeading = screen.getByRole('heading', { name: POSITIVE_TITLE });
    const concernHeading = screen.getByRole('heading', { name: CONCERN_TITLE });
    expect(positiveHeading.tagName).toBe('H2');
    expect(concernHeading.tagName).toBe(positiveHeading.tagName);
    expect(concernHeading.className).toBe(positiveHeading.className);
    expect(concernHeading.className).not.toBe('');
    // 見出しの中に押しボタンを置かない（片側だけが開閉の入口になる形にしない）。
    expect(within(positiveHeading).queryByRole('button')).toBeNull();
    expect(within(concernHeading).queryByRole('button')).toBeNull();
    // 補足は両側とも同じ文言。
    expect(positive().getByText(POLARITY_HINT)).toBeDefined();
    expect(concern().getByText(POLARITY_HINT)).toBeDefined();
  });

  it('2 つの領域の直前に共通の案内を 1 つ出し、両方の領域が説明として指す', () => {
    setup();
    const notes = screen.getAllByText(POLARITY_NOTE);
    expect(notes).toHaveLength(1);
    const noteId = notes[0]!.id;
    expect(noteId).not.toBe('');
    for (const name of [POSITIVE_TITLE, CONCERN_TITLE]) {
      const region = screen.getByRole('region', { name });
      expect(region.getAttribute('aria-describedby')?.split(' ')).toContain(noteId);
    }
    // 案内は良かったところの前にある（並び: 案内 → 良かったところ → 気になったところ）。
    const positiveRegion = screen.getByRole('region', { name: POSITIVE_TITLE });
    expect(notes[0]!.compareDocumentPosition(positiveRegion) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 「選ばなくてもかまいません」とは書かない（送信には材料が 2 件要るので事実に反する）。
    expect(document.body.textContent).not.toContain('選ばなくてもかまいません');
  });

  it('並びは 星 → 良かったところ → 気になったところ → その他の感想 → 作る押しボタン', () => {
    setup();
    const order = [
      screen.getByRole('group', { name: '今回の満足度（必須）' }),
      screen.getByRole('region', { name: POSITIVE_TITLE }),
      screen.getByRole('region', { name: CONCERN_TITLE }),
      commentToggle(),
      submitButton(),
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('星の値で画面の構成を変えない（見出し・カテゴリの札・案内が星 1 と星 5 で同じ）', () => {
    const snapshot = () => ({
      headings: screen.getAllByRole('heading').map((h) => `${h.tagName}|${h.className}|${h.textContent}`),
      regions: screen.getAllByRole('region').map((r) => r.getAttribute('aria-describedby')),
      positive: categoryButtons(positive()).map((b) => b.textContent),
      concern: categoryButtons(concern()).map((b) => b.textContent),
      buttons: screen.getAllByRole('button').filter((b) => !/^星\d$/.test(b.getAttribute('aria-label') ?? '')).length,
    });
    setup();
    const initial = snapshot();
    star(1);
    const low = snapshot();
    star(5);
    const high = snapshot();
    expect(low).toEqual(initial);
    expect(high).toEqual(initial);
  });

  it('一言欄は押すと開き、閉じて開き直しても入力は消えず、閉じたままでも送信に載る', () => {
    const { onSubmit } = setup();
    star(4);
    pickTwo();
    const toggle = commentToggle();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const box = screen.getByRole('textbox', { name: COMMENT_LABEL });
    expect(toggle.getAttribute('aria-controls')).toBe(box.closest('label')!.id);
    fireEvent.change(box, { target: { value: '窓側の席が落ち着いた' } });

    fireEvent.click(commentToggle());
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(commentToggle().textContent).toContain('入力済み');

    fireEvent.click(commentToggle());
    expect((screen.getByRole('textbox', { name: COMMENT_LABEL }) as HTMLTextAreaElement).value).toBe('窓側の席が落ち着いた');

    fireEvent.click(commentToggle());
    submit();
    expect(onSubmit.mock.calls[0]![0].comment).toBe('窓側の席が落ち着いた');
  });

  it('選んだ札とカテゴリは、色以外の手掛かり（チェック印・✓）でも分かる', () => {
    setup();
    openCategory(positive(), '接客・提供');
    const chip = positive().getByRole('checkbox', { name: '接客の丁寧さ' });
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-checked')).toBe('true');
    openCategory(positive(), '料理');
    const category = positive().getByRole('button', { name: /^接客・提供\s*（選択あり）$/ });
    expect(category.textContent).toContain('✓');
  });

  it('送信中は押しボタンが「口コミ文を作成しています…」になり、無効・処理中で、補足を読み上げ領域に出す', () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<StructuredSurveyForm definition={definition()} onSubmit={onSubmit} submitting={false} />);
    pickTwo();
    const idle = submitButton();
    expect(idle.disabled).toBe(false);
    expect(idle.getAttribute('aria-busy')).toBe('false');
    expect(note()).toBe('回答内容をもとに文章を作成します');

    rerender(<StructuredSurveyForm definition={definition()} onSubmit={onSubmit} submitting />);
    const busy = screen.getByRole('button', { name: SUBMITTING }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.querySelector('[data-slot="spinner"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('回答内容をもとに文章を作成しています');

    // 送信中に form を送っても onSubmit を呼ばない（二重送信の防止）。
    star(5);
    fireEvent.submit(busy.closest('form')!);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('送信が長引くと、処理中であることを言い直す', () => {
    vi.useFakeTimers();
    try {
      render(<StructuredSurveyForm definition={definition()} onSubmit={vi.fn()} submitting />);
      expect(screen.getByRole('status').textContent).toBe('回答内容をもとに文章を作成しています');
      act(() => {
        vi.advanceTimersByTime(8000);
      });
      expect(screen.getByRole('status').textContent).toContain('このままお待ちください');
    } finally {
      vi.useRealTimers();
    }
  });

  it('客側の文言に「AI」を出さない（下書きパネルと揃える・Issue #179）', () => {
    const { rerender } = render(<StructuredSurveyForm definition={definition()} onSubmit={vi.fn()} submitting={false} />);
    pickTwo();
    expect(document.body.textContent).not.toMatch(/AI/);
    rerender(<StructuredSurveyForm definition={definition()} onSubmit={vi.fn()} submitting />);
    expect(document.body.textContent).not.toMatch(/AI/);
  });
});

describe('StructuredSurveyForm: 口コミ文を作るには感想が 2 件要る', () => {
  it('0 件: 押せず、2 つ以上選ぶよう案内する', () => {
    setup();
    star(5);
    expect(submitButton().disabled).toBe(true);
    expect(note()).toBe('感想を2つ以上選ぶと口コミ文を作れます');
    // 押しボタンが案内を説明として指す（押せない理由が支援技術にも伝わる）。数え方の補足も指す。
    const described = submitButton().getAttribute('aria-describedby')!.split(' ');
    expect(described.map((id) => document.getElementById(id)!.textContent)).toEqual([note(), COUNTING_NOTE]);
  });

  it('1 件: 押せず、「あと1つ」と案内する', () => {
    setup();
    star(5);
    openCategory(positive(), '接客・提供');
    fireEvent.click(positive().getByRole('checkbox', { name: '接客の丁寧さ' }));
    expect(submitButton().disabled).toBe(true);
    expect(note()).toBe('あと1つ選ぶと口コミ文を作れます');
  });

  it('良かったところ 2 件で押せ、不足の案内は消える', () => {
    const { onSubmit } = setup();
    star(5);
    pickTwo();
    expect(submitButton().disabled).toBe(false);
    expect(note()).not.toContain('あと');
    expect(note()).not.toContain('つ以上選ぶと');
    submit();
    expect(onSubmit).toHaveBeenCalledWith({ star: 5, positiveSelections: [SERVICE_BOTH], concernSelections: [] });
  });

  it('良かったところ 1 件 + 気になったところ 1 件で押せる', () => {
    setup();
    star(3);
    openCategory(positive(), '接客・提供');
    fireEvent.click(positive().getByRole('checkbox', { name: '接客の丁寧さ' }));
    openCategory(concern(), '接客・提供');
    fireEvent.click(concern().getByRole('checkbox', { name: '料理・ドリンクの提供' }));
    expect(submitButton().disabled).toBe(false);
  });

  it('気になったところ 2 件だけでも押せ、送信できる（件数の規則は極性に依らない）', () => {
    const { onSubmit } = setup();
    star(2);
    openCategory(concern(), '接客・提供');
    fireEvent.click(concern().getByRole('checkbox', { name: '接客の丁寧さ' }));
    expect(submitButton().disabled).toBe(true);
    expect(note()).toBe('あと1つ選ぶと口コミ文を作れます');
    fireEvent.click(concern().getByRole('checkbox', { name: '料理・ドリンクの提供' }));
    expect(submitButton().disabled).toBe(false);
    submit();
    expect(onSubmit).toHaveBeenCalledWith({ star: 2, positiveSelections: [], concernSelections: [SERVICE_BOTH] });
  });

  it('Target とその facet は 1 件として数える（二重に数えない）', () => {
    setup();
    star(4);
    openCategory(positive(), '料理');
    const panel = within(positive().getByRole('group', { name: '料理' }));
    fireEvent.click(panel.getByRole('checkbox', { name: '刺身盛り合わせ' }));
    const sashimi = within(panel.getByText('刺身盛り合わせについて').parentElement!);
    fireEvent.click(sashimi.getByRole('checkbox', { name: '味' }));
    expect(submitButton().disabled).toBe(true);
    expect(note()).toBe('あと1つ選ぶと口コミ文を作れます');
  });

  it('星と一言は感想の数に含めない', () => {
    setup();
    star(5);
    fireEvent.click(commentToggle());
    fireEvent.change(screen.getByRole('textbox', { name: COMMENT_LABEL }), { target: { value: '窓側の席が落ち着いた' } });
    expect(submitButton().disabled).toBe(true);
    expect(note()).toBe('感想を2つ以上選ぶと口コミ文を作れます');
  });

  it('選択を外して 1 件に戻ると、再び押せなくなる', () => {
    setup();
    star(5);
    pickTwo();
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(positive().getByRole('checkbox', { name: '料理・ドリンクの提供' }));
    expect(submitButton().disabled).toBe(true);
    expect(note()).toBe('あと1つ選ぶと口コミ文を作れます');
  });

  it('不足の間だけ数え方の補足を出し、料理名と詳細を合わせて 1 件と数えること・一言を数えないことを伝える', () => {
    setup();
    star(4);
    expect(screen.getByText(COUNTING_NOTE)).toBeDefined();
    // 料理名＋詳細 1 つ = 1 件のまま（補足が説明する状態）。
    openCategory(positive(), '料理');
    const panel = within(positive().getByRole('group', { name: '料理' }));
    fireEvent.click(panel.getByRole('checkbox', { name: '刺身盛り合わせ' }));
    const sashimi = within(panel.getByText('刺身盛り合わせについて').parentElement!);
    fireEvent.click(sashimi.getByRole('checkbox', { name: '味' }));
    expect(note()).toBe('あと1つ選ぶと口コミ文を作れます');
    expect(screen.getByText(COUNTING_NOTE)).toBeDefined();
    // 詳細が 2 つで 2 件（補足の「詳細が2つ以上ならその数」）。足りたら補足は消え、押しボタンも指さない。
    fireEvent.click(sashimi.getByRole('checkbox', { name: '温度・状態' }));
    expect(submitButton().disabled).toBe(false);
    expect(screen.queryByText(COUNTING_NOTE)).toBeNull();
    expect(submitButton().getAttribute('aria-describedby')!.split(' ')).toHaveLength(1);
  });

  it('料理名が 1 つも無い店では、料理名の数え方を出さず、一言を数えないことだけを伝える', () => {
    setup(definition({ foodTargets: [] }));
    star(4);
    expect(screen.getByText('その他の感想は件数に含まれません。')).toBeDefined();
    expect(screen.queryByText(/の名前は、詳細と合わせて/)).toBeNull();
  });

  it('件数の表示（「0 / 2 選択済み」など）は出さない', () => {
    setup();
    star(5);
    expect(document.body.textContent).not.toContain('選択済み');
    openCategory(positive(), '接客・提供');
    fireEvent.click(positive().getByRole('checkbox', { name: '接客の丁寧さ' }));
    expect(document.body.textContent).not.toContain('選択済み');
    fireEvent.click(positive().getByRole('checkbox', { name: '料理・ドリンクの提供' }));
    expect(document.body.textContent).not.toContain('選択済み');
  });
});

describe('StructuredSurveyForm: 開閉はその他の感想だけ', () => {
  it('良かったところ・気になったところは畳めない（開閉の押しボタンを持たない）', () => {
    setup();
    expect(screen.queryByRole('button', { name: /^良かったところ/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^気になったところ/ })).toBeNull();
    // 開閉の押しボタン（aria-expanded を持つもの）のうち、カテゴリの札以外は「その他の感想」だけ。
    const toggles = screen
      .getAllByRole('button')
      .filter((b) => b.hasAttribute('aria-expanded'))
      .filter((b) => !categoryButtons(positive()).includes(b) && !categoryButtons(concern()).includes(b));
    expect(toggles).toEqual([commentToggle()]);
  });

  it('気になったところで選んだ内容は、別のカテゴリを開いても残り、2 件の下限に数え、送信に載る', () => {
    const { onSubmit } = setup();
    star(3);
    openCategory(concern(), '接客・提供');
    fireEvent.click(concern().getByRole('checkbox', { name: '接客の丁寧さ' }));
    fireEvent.click(concern().getByRole('checkbox', { name: '料理・ドリンクの提供' }));
    openCategory(concern(), '料理');
    expect(concern().getByRole('list', { name: '気になったところで選んだ内容' }).textContent).toContain('接客・提供');
    expect(submitButton().disabled).toBe(false);
    submit();
    expect(onSubmit).toHaveBeenCalledWith({
      star: 3,
      positiveSelections: [],
      concernSelections: [{ categoryCode: 'service_delivery', facetCodes: ['service_courtesy', 'serving'] }],
    });
  });

  it('その他の感想は最初は畳まれ、入力して畳んでも残り「入力済み」を添え、開き直すと入力が見える', () => {
    setup();
    const toggle = commentToggle();
    expect(toggle.textContent).toContain('その他の感想（任意）');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('textbox')).toBeNull();

    fireEvent.click(toggle);
    fireEvent.change(screen.getByRole('textbox', { name: COMMENT_LABEL }), { target: { value: '窓側の席が落ち着いた' } });
    fireEvent.click(commentToggle());
    expect(commentToggle().getAttribute('aria-expanded')).toBe('false');
    expect(commentToggle().textContent).toContain('入力済み');

    fireEvent.click(commentToggle());
    expect((screen.getByRole('textbox', { name: COMMENT_LABEL }) as HTMLTextAreaElement).value).toBe('窓側の席が落ち着いた');
  });

  it('最初の画面は、星・良かったところと気になったところのカテゴリの札・その他の感想の入口・作る押しボタンだけ', () => {
    setup();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(categoryButtons(positive()).map((b) => b.textContent)).toEqual(['料理', '接客・提供']);
    expect(categoryButtons(concern()).map((b) => b.textContent)).toEqual(['料理', '接客・提供']);
    expect(submitButton()).toBeDefined();
  });
});
