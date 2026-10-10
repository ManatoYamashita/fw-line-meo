// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
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

const section = (name: string) => within(screen.getByRole('region', { name }));
const positive = () => section('良かったところ（任意）');
const concern = () => section('気になったところ（任意）');

function star(n: number): void {
  fireEvent.click(screen.getByRole('button', { name: `星${n}` }));
}
function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: '送信する' }));
}
/** カテゴリの開閉の押しボタン。選択済みの読み上げ名は「料理（選択あり）」なので、名前の先頭で掴む。 */
function openCategory(where: ReturnType<typeof within>, label: string): void {
  fireEvent.click(where.getByRole('button', { name: new RegExp(`^${label}(\\s*（選択あり）)?$`) }));
}

describe('StructuredSurveyForm', () => {
  it('初期表示: 星・良かったところ・気になったところ・一言。カテゴリは定義の順に、どちらの極性にも同じものを出す', () => {
    setup();
    expect(screen.getByRole('group', { name: '今回の満足度（必須）' })).toBeDefined();
    for (const where of [positive(), concern()]) {
      const names = where.getAllByRole('button').map((b) => b.textContent);
      expect(names).toEqual(['料理', '接客・提供']);
      for (const b of where.getAllByRole('button')) expect(b.getAttribute('aria-expanded')).toBe('false');
    }
    // 開く前は facet を 1 つも出さない（初期状態で全 facet を縦に展開しない）。
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getByRole('textbox', { name: /その他、伝えたいこと（任意）/ })).toBeDefined();
  });

  it('星だけで送信でき、選択は空の配列になる。星が無ければ送信を止める', () => {
    const { onSubmit } = setup();
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('満足度');
    star(2);
    submit();
    expect(onSubmit).toHaveBeenCalledWith({ star: 2, positiveSelections: [], concernSelections: [] });
  });

  it('カテゴリを開いて閉じただけでは、何も送らない（開くことは回答ではない）', () => {
    const { onSubmit } = setup();
    star(4);
    openCategory(positive(), '料理');
    expect(positive().getByRole('button', { name: '料理' }).getAttribute('aria-expanded')).toBe('true');
    openCategory(positive(), '接客・提供');
    openCategory(concern(), '料理');
    openCategory(concern(), '料理');
    submit();
    expect(onSubmit).toHaveBeenCalledWith({ star: 4, positiveSelections: [], concernSelections: [] });
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
    submit();
    expect(onSubmit).toHaveBeenCalledWith({
      star: 4,
      positiveSelections: [],
      concernSelections: [{ categoryCode: 'food', facetCodes: ['taste'] }],
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
    const box = screen.getByRole('textbox');
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
});
