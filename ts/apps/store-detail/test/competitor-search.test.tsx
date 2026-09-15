// @vitest-environment jsdom
// store-detail-trend-dashboard task 3.3（Issue #265）: 競合の検索欄と件数の文言の部品（app/store/competitor-search.tsx）を
// 検証する。
//
// 検索欄は、縦に積む Field に、見えるラベル「店名で絞り込む」と検索の種類の入力欄を置く形で組む
// （docs/design/design-language.md §7.18）。
// - 入力欄の名前は、見えるラベルを for と id で結んで付ける（要件 5.7）。id は useId の値だけを使う。
// - 入力欄は自動補完を切り、name を渡さない。name を持つ入力は、構造契約（store-page.test.tsx）の
//   「name を持つ input」の検査に当たる（要件 7.2）。
// - 件数の文言は、常に置いた状態通知の要素に「競合{総数}店のうち{表示数}店を表示」と出す（要件 4.7・4.8）。
//   要素を常に置くのは、読み上げ領域が文字の変わる前から存在していないと、変化が読み上げられないためである。
// - 入力された検索語は、画面のどこにも表示し直さない。長い英字列が 320px で溢れる経路を作らないため（要件 6.4）。
// - 面は色を書かない。検索欄の色は部品の側がトークンから解決し、件数の文言は本文色を継承する（§7.18）。
//
// 部品は検索語を自分で持たず、絞り込みもしない（検索語は競合の節が持つ・research.md の決定 D8。
// 絞り込みは lib/competitor-filter.ts）。そこで、検索語を状態として持ち、同じ絞り込みで件数を導く小さな親の
// 中でも描き、通知・件数・要素の同一性を確かめる。
//
// このファイルは部品単体の検査だけを持つ。ページ全体での検索の検査は、タスク 4.2 以降のページ全体の
// テストファイルが持つ。
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Field, FieldLabel } from '@fwlm/ui/components/field';
import { Input } from '@fwlm/ui/components/input';

import { CompetitorSearch } from '../app/store/competitor-search';
import { filterCompetitors } from '../lib/competitor-filter';
import { announcedText, ownText } from './live-region';

afterEach(() => {
  cleanup();
});

/** 検索欄の見えるラベル。 */
const LABEL = '店名で絞り込む';

/** 構造契約（store-page.test.tsx）が許す、検索欄の形。 */
const SEARCH_INPUT_SELECTOR = 'input[type="search"][data-slot="input"]';

/** 書込の手段になる要素と、許可リストの外の入力の役割（構造契約の「0 件を保つもの」の写し）。 */
const FORBIDDEN_SELECTOR = [
  'form',
  'button',
  'textarea',
  'select',
  '[contenteditable]',
  '[form]',
  'input[name]',
  '[role="button"]',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="searchbox"]',
  '[role="listbox"]',
  '[role="option"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="tab"]',
  '[role="treeitem"]',
].join(', ');

/** 読み上げ領域になる要素（明示の役割・aria-live・暗黙に status の役割を持つ output）。 */
const LIVE_REGION_SELECTOR = '[role="status"], [role="alert"], [role="log"], [role="marquee"], [role="timer"], [aria-live], output';

/**
 * 親の中で使う架空の競合（公開リポジトリなので実在の店名を使わない）。
 * 「サ」で始まる検索語は「サンプル食堂」だけに当たり、「店」は 2 店に当たる。
 */
const COMPETITORS: readonly { readonly name: string }[] = [
  { name: 'テスト珈琲 本店' },
  { name: 'サンプル食堂' },
  { name: 'ためし軒 駅前店' },
  { name: 'Example Bistro' },
  { name: 'かりそめ亭' },
];

/** どの競合にも当たらない、長い英字列の検索語（e2e の「検索 0 件」の状態と同じ種類の入力）。 */
const NO_MATCH_QUERY = 'nomatchingcompetitornamewhatsoeverzzzzzzzzzzzzzzzz';

// --- 描画 ----------------------------------------------------------------------------------

function noop(): void {}

/** 渡した値のまま部品を描く（親の状態を持たない）。 */
function renderPlain(props: { readonly query?: string; readonly total: number; readonly visibleCount: number }) {
  return render(
    <CompetitorSearch
      query={props.query ?? ''}
      onQueryChange={noop}
      total={props.total}
      visibleCount={props.visibleCount}
    />,
  );
}

/**
 * 検索語を状態として持ち、競合の節と同じ絞り込みで件数を導く親の中で部品を描く。通知は、受け取った値を
 * そのまま記録してから状態へ入れる。
 */
function renderWithFilter() {
  const notifications = vi.fn<(query: string) => void>();

  function Harness(): React.JSX.Element {
    const [query, setQuery] = useState('');
    const { visible, total } = filterCompetitors(COMPETITORS, query);
    return (
      <CompetitorSearch
        query={query}
        onQueryChange={(next) => {
          notifications(next);
          setQuery(next);
        }}
        total={total}
        visibleCount={visible.length}
      />
    );
  }

  const result = render(<Harness />);
  return { ...result, notifications };
}

function searchbox(): HTMLInputElement {
  const input = screen.getByRole('searchbox', { name: LABEL });
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('検索欄が input 要素ではありません');
  }
  return input;
}

function classTokens(element: Element): readonly string[] {
  return (element.getAttribute('class') ?? '').split(/\s+/).filter((token) => token.length > 0);
}

/** 見える要素であること（sr-only・aria-hidden の部分木・hidden 属性のいずれにも落ちていない）。 */
function expectVisible(element: HTMLElement, what: string): void {
  expect(classTokens(element), what).not.toContain('sr-only');
  expect(element.closest('[aria-hidden="true"]'), what).toBeNull();
  expect(element.closest('[hidden]'), what).toBeNull();
}

// --- 検索欄 --------------------------------------------------------------------------------

describe('CompetitorSearch の検索欄（Issue #265）', () => {
  it('見えるラベル「店名で絞り込む」から、検索の種類の入力欄を名前で取れる（要件 4.1・5.7）', () => {
    const { container } = renderPlain({ total: 5, visibleCount: 5 });

    const input = searchbox();
    // 名前は、見えるラベルを for と id で結んで付ける。aria-label の文字列で付けると、見えている名前と
    // 食い違いうる。for と id で結ぶと、ラベルの行を押しても入力欄へ焦点が移る（44px をラベルと入力欄の
    // 合計で満たす前提・要件 5.6）。
    expect(input.hasAttribute('aria-label')).toBe(false);
    expect(input.id.length).toBeGreaterThan(0);

    const labels = Array.from(container.querySelectorAll('label'));
    expect(labels).toHaveLength(1);
    const label = labels[0]!;
    expect(label.matches('label[data-slot="field-label"]')).toBe(true);
    expect(label.htmlFor).toBe(input.id);
    expect(Array.from(input.labels ?? [])).toEqual([label]);
    // ラベルは見える文字である。
    expect(ownText(label)).toBe(LABEL);
    expectVisible(label, 'ラベル');
  });

  it('縦に積む Field の中に、ラベル・入力欄の順で置く（§7.18）', () => {
    const { container } = renderPlain({ total: 5, visibleCount: 5 });

    const fields = Array.from(container.querySelectorAll('[data-slot="field"]'));
    expect(fields).toHaveLength(1);
    const field = fields[0]!;
    expect(field.getAttribute('data-orientation')).toBe('vertical');
    expect(Array.from(field.children).map((child) => child.getAttribute('data-slot'))).toEqual(['field-label', 'input']);
    expect(field.lastElementChild).toBe(searchbox());
  });

  it('入力欄は検索の種類で、自動補完を切り、name を持たず、書込の手段になる要素を描かない（要件 7.1・7.2）', () => {
    const { container } = renderPlain({ total: 5, visibleCount: 5 });

    const inputs = Array.from(container.querySelectorAll('input'));
    expect(inputs).toHaveLength(1);
    const input = inputs[0]!;
    expect(input.matches(SEARCH_INPUT_SELECTOR)).toBe(true);
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.hasAttribute('name')).toBe(false);
    // list を持つと、選択の一覧を伴う入力（combobox の役割）になる。
    expect(input.hasAttribute('list')).toBe(false);

    // 走査の対象（入力欄を含む部品の要素）が 1 件以上あることを確かめてから、0 件を確かめる。
    expect(container.querySelectorAll('*').length).toBeGreaterThan(0);
    expect(container.querySelectorAll(FORBIDDEN_SELECTOR)).toHaveLength(0);
    // search 要素は使わない（jsdom 25 が未知の要素として扱う・research.md「部品と環境の制約」）。
    expect(container.getElementsByTagName('search')).toHaveLength(0);
  });

  it('2 つ描いても、ラベルと入力欄の結びつきが混ざらない（id を手書きしない）', () => {
    const { container } = render(
      <>
        <CompetitorSearch query="" onQueryChange={noop} total={5} visibleCount={5} />
        <CompetitorSearch query="" onQueryChange={noop} total={5} visibleCount={5} />
      </>,
    );

    const inputs = screen.getAllByRole('searchbox', { name: LABEL });
    expect(inputs).toHaveLength(2);
    const labels = Array.from(container.querySelectorAll('label'));
    expect(labels).toHaveLength(2);
    labels.forEach((label, index) => {
      const input = inputs[index];
      expect(input).toBeDefined();
      expect(label.htmlFor, `${index}`).toBe(input!.id);
    });
    const ids = inputs.map((input) => input.id);
    expect(ids.every((id) => id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// --- 入力 ------------------------------------------------------------------------------------

describe('CompetitorSearch の入力（Issue #265）', () => {
  it('入力は、打った文字列のまま変更の通知として届き、欄の値になる（要件 4.3）', () => {
    const { notifications } = renderWithFilter();

    // 正規化（大小・全半角・かなの種類・前後の空白）は絞り込みの側が行う。部品が打つたびに前後の空白を
    // 落とすと、「A B」の内側の空白を打った瞬間に消え、語を区切って打てなくなる。
    const typed = ['ｻﾝﾌﾟﾙ', '  テスト  ', 'Ｅｘａｍｐｌｅ ', 'Example Bistro', ''];
    typed.forEach((value, index) => {
      fireEvent.change(searchbox(), { target: { value } });

      expect(notifications, JSON.stringify(value)).toHaveBeenCalledTimes(index + 1);
      expect(notifications, JSON.stringify(value)).toHaveBeenLastCalledWith(value);
      expect(searchbox().value, JSON.stringify(value)).toBe(value);
    });
  });

  it('欄の値は、渡された検索語に従う（部品は検索語を自分で持たない）', () => {
    const { rerender } = render(<CompetitorSearch query="テスト" onQueryChange={noop} total={5} visibleCount={1} />);
    expect(searchbox().value).toBe('テスト');

    rerender(<CompetitorSearch query="" onQueryChange={noop} total={5} visibleCount={5} />);
    expect(searchbox().value).toBe('');
  });
});

// --- 件数の文言 ------------------------------------------------------------------------------

interface CountCase {
  readonly total: number;
  readonly visibleCount: number;
  readonly text: string;
}

/**
 * 件数の文言の書式。総数と表示数が食い違う行と、表示数が 0 の行を必ず含める（取り違えや固定値の変異を
 * 緑のまま通さないため）。
 */
const COUNT_CASES: readonly CountCase[] = [
  { total: 5, visibleCount: 5, text: '競合5店のうち5店を表示' },
  { total: 5, visibleCount: 2, text: '競合5店のうち2店を表示' },
  { total: 5, visibleCount: 0, text: '競合5店のうち0店を表示' },
  { total: 2, visibleCount: 1, text: '競合2店のうち1店を表示' },
];

describe('CompetitorSearch の件数の文言（Issue #265）', () => {
  for (const countCase of COUNT_CASES) {
    it(`総数 ${countCase.total}・表示数 ${countCase.visibleCount}: 状態通知の要素に「${countCase.text}」と、見える文字で出す（要件 4.7）`, () => {
      renderPlain({ total: countCase.total, visibleCount: countCase.visibleCount });

      const status = screen.getByRole('status');
      expect(status.tagName).toBe('P');
      // 文言は要素の直下の文字で、読み上げられる文字とも一致する（sr-only の子や aria-hidden の部分に
      // 落ちていない）。
      expect(ownText(status)).toBe(countCase.text);
      expect(announcedText(status)).toBe(countCase.text);
      expectVisible(status, '件数の文言');
    });
  }

  it('状態通知の役割はちょうど 1 つで、ほかに読み上げ領域を持たず、Field の下に置く（要件 4.8）', () => {
    const { container } = renderPlain({ total: 5, visibleCount: 2 });

    const statuses = screen.getAllByRole('status');
    expect(statuses).toHaveLength(1);
    const status = statuses[0]!;
    // 読み上げ領域は、この 1 つだけである（件数の文言が二重に読み上げられない）。
    expect(Array.from(container.querySelectorAll(LIVE_REGION_SELECTOR))).toEqual([status]);
    // 通知の強さと範囲は、status の役割の既定（割り込まずに読み、文言の全体を読む）に任せる。
    // aria-live を明示すると、割り込み（assertive）や無音（off）へ変えられてしまう。
    expect(status.hasAttribute('aria-live')).toBe(false);
    expect(status.hasAttribute('aria-atomic')).toBe(false);

    // Field の下に置く（Field の中には入れない）。部品の直下は、Field と件数の文言の 2 つだけである。
    const field = container.querySelector('[data-slot="field"]');
    expect(field).not.toBeNull();
    expect(field!.contains(status)).toBe(false);
    const root = container.firstElementChild;
    expect(root).not.toBeNull();
    expect(Array.from(root!.children)).toEqual([field, status]);
  });

  it('件数が変わっても、状態通知の要素は同じまま、文字だけが変わる（常に置いた要素・要件 4.8）', () => {
    const { rerender } = renderPlain({ total: 5, visibleCount: 5 });
    const status = screen.getByRole('status');

    rerender(<CompetitorSearch query="店" onQueryChange={noop} total={5} visibleCount={2} />);
    expect(screen.getByRole('status')).toBe(status);
    expect(ownText(status)).toBe('競合5店のうち2店を表示');

    rerender(<CompetitorSearch query={NO_MATCH_QUERY} onQueryChange={noop} total={5} visibleCount={0} />);
    expect(screen.getByRole('status')).toBe(status);
    expect(ownText(status)).toBe('競合5店のうち0店を表示');
  });

  it('打つたびには読み上げず、件数が変わったときだけ文言が変わる（要件 4.8）', () => {
    renderWithFilter();
    const status = screen.getByRole('status');
    expect(ownText(status)).toBe('競合5店のうち5店を表示');

    const observer = new MutationObserver(() => {});
    observer.observe(status, { subtree: true, childList: true, characterData: true, attributes: true });

    /** 打った後の、状態通知の要素の文言と、その要素の部分木に起きた変化の件数。 */
    const type = (value: string): { readonly text: string; readonly mutations: number } => {
      fireEvent.change(searchbox(), { target: { value } });
      expect(screen.getByRole('status'), JSON.stringify(value)).toBe(status);
      return { text: ownText(status), mutations: observer.takeRecords().length };
    };

    // 件数が変わる入力では、文言が変わる（下の「変わらない」が空振りでないことの対照）。
    const first = type('サ');
    expect(first.text).toBe('競合5店のうち1店を表示');
    expect(first.mutations).toBeGreaterThan(0);

    // 件数が変わらない入力では、文言も要素も変わらない。
    for (const value of ['サン', 'サンプ', 'ｻﾝﾌﾟﾙ']) {
      const next = type(value);
      expect(next.text, value).toBe('競合5店のうち1店を表示');
      expect(next.mutations, value).toBe(0);
    }

    const cleared = type('');
    expect(cleared.text).toBe('競合5店のうち5店を表示');
    expect(cleared.mutations).toBeGreaterThan(0);

    const none = type(NO_MATCH_QUERY);
    expect(none.text).toBe('競合5店のうち0店を表示');
    expect(none.mutations).toBeGreaterThan(0);

    observer.disconnect();
  });

  it('入力された検索語を、画面のどこにも表示し直さない（§7.18・要件 6.4）', () => {
    renderWithFilter();

    fireEvent.change(searchbox(), { target: { value: NO_MATCH_QUERY } });
    // 対照: 入力は届いていて、0 件になっている（下の「無い」が空振りでないこと）。
    expect(searchbox().value).toBe(NO_MATCH_QUERY);
    expect(ownText(screen.getByRole('status'))).toBe('競合5店のうち0店を表示');

    // 文字としても、入力欄の値の属性を除くどの属性にも、検索語が現れない。
    expect(document.body.textContent ?? '').not.toContain(NO_MATCH_QUERY);
    const input = searchbox();
    const scanned = Array.from(document.body.querySelectorAll('*'));
    expect(scanned.length).toBeGreaterThan(0);
    const echoed = scanned.flatMap((element) =>
      Array.from(element.attributes)
        .filter((attribute) => !(element === input && attribute.name === 'value'))
        .filter((attribute) => attribute.value.includes(NO_MATCH_QUERY))
        .map((attribute) => `${element.tagName.toLowerCase()}[${attribute.name}]`),
    );
    expect(echoed).toEqual([]);
  });
});

// --- 色 ------------------------------------------------------------------------------------

describe('CompetitorSearch の色（Issue #265）', () => {
  it('面が足すクラスは、並べ方と件数の文言の文字の段だけで、部品に色を足さない（§7.18）', () => {
    const { container } = renderPlain({ total: 5, visibleCount: 2 });

    // 部品の既定のクラスを、面が何も渡していない同じ部品の描画から取る。部品の内部クラスをテストへ
    // 書き写さずに、面が足した分と消した分だけを完全一致で固定するためである。
    const baseline = render(
      <Field>
        <FieldLabel>対照のラベル</FieldLabel>
        <Input type="search" />
      </Field>,
    ).container;

    const slotKey = (element: Element): string =>
      `${element.tagName.toLowerCase()}[data-slot=${element.getAttribute('data-slot') ?? ''}]`;
    const baselineTokens = new Map<string, ReadonlySet<string>>();
    for (const element of Array.from(baseline.querySelectorAll('[data-slot]'))) {
      baselineTokens.set(slotKey(element), new Set(classTokens(element)));
    }

    const scanned = Array.from(container.querySelectorAll('[data-slot]'));
    expect(scanned.length).toBeGreaterThan(0);
    const diffs: Record<string, string> = {};
    for (const element of scanned) {
      const key = slotKey(element);
      const base = baselineTokens.get(key);
      expect(base, `対照に無い部品: ${key}`).toBeDefined();
      const tokens = classTokens(element);
      diffs[key] = JSON.stringify({
        added: tokens.filter((token) => !base!.has(token)),
        removed: Array.from(base!).filter((token) => !tokens.includes(token)),
      });
    }
    const none = JSON.stringify({ added: [], removed: [] });
    expect(diffs).toEqual({
      'div[data-slot=field]': none,
      'label[data-slot=field-label]': none,
      'input[data-slot=input]': none,
    });

    // 部品の外で面が自分で class を書く要素は、並べ方（部品の直下の容器）と、件数の文言の文字の段だけを
    // 持つ。件数の文言は本文色を継承し、色を書かない。
    const own = Array.from(container.querySelectorAll('[class]:not([data-slot])')).filter(
      (element) => element.parentElement?.closest('[data-slot]') == null,
    );
    expect(own.map((element) => `${element.tagName.toLowerCase()}: ${classTokens(element).join(' ')}`)).toEqual([
      'div: flex flex-col gap-2',
      'p: text-sm',
    ]);
  });
});
