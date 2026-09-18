// @vitest-environment jsdom
// store-detail-trend-dashboard task 3.2（Issue #265）: 期間と指標の選択肢の部品（app/store/trend-controls.tsx）を
// 検証する。
//
// 選択肢は、期間の群と指標の群の 2 つの RadioGroup で描く（docs/design/design-language.md §7.18）。
// - 期間の群を先に、指標の群を後に置く。群には見える名前を付け、選択肢の群の名前として参照させる（要件 5.7）。
// - 札は TREND_PERIODS / TREND_METRICS から作る。構成は、ラベルの中に横向きの Field を置き、その中に
//   radio と題を置く形である。
// - RadioGroup の値の型は any なので、値の書き違いは型検査で止まらない。書き違えた札は型ガードに黙って
//   捨てられ、「押しても変わらない札」になる。そこで、札ごとにクリックして確かめる。
// - radio に name を渡さない。隠し input が name を持つと、構造契約（store-page.test.tsx）の「name を持つ
//   input」の検査に当たる（要件 7.2）。
// - 札に色を書かない。色は部品の側がトークンから解決する（§7.18）。
//
// Base UI の Radio は、印のクリックを隠し input へ PointerEvent で転送する。jsdom 25 は PointerEvent を
// 持たないので、test/pointer-event.ts の互換実装を入れてから描く。
//
// 部品は選択を自分で持たない（期間と指標の状態は推移の節が持つ・research.md の決定 D8）。そこで、選択を状態として
// 持つ小さな親の中で描き、選択が移ることと、親へ届く通知の両方を確かめる。
//
// このファイルは部品単体の検査だけを持つ。ページ全体での切替・一貫性の検査は、タスク 4.1 以降のページ全体の
// テストファイルが持つ。
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Field, FieldLabel, FieldTitle } from '@fwlm/ui/components/field';
import { RadioGroup, RadioGroupItem } from '@fwlm/ui/components/radio-group';

import { TrendControls } from '../app/store/trend-controls';
import {
  DEFAULT_METRIC,
  DEFAULT_PERIOD,
  TREND_METRICS,
  TREND_PERIODS,
  type TrendMetric,
  type TrendPeriodDays,
} from '../lib/trend-view';
import { ownText } from './live-region';
import { installPointerEventPolyfill } from './pointer-event';

installPointerEventPolyfill();

afterEach(() => {
  cleanup();
});

// --- 期待する札 --------------------------------------------------------------------------

interface Chip {
  readonly label: string;
  readonly value: TrendPeriodDays | TrendMetric;
}

/** 期間の札（この並びで描く）。 */
const PERIOD_CHIPS: readonly Chip[] = [
  { label: '7日', value: 7 },
  { label: '30日', value: 30 },
];

/** 指標の札（この並びで描く）。「クチコミ」は、既存の指標の項目名にそろえる。 */
const METRIC_CHIPS: readonly Chip[] = [
  { label: '順位', value: 'rank' },
  { label: '評価', value: 'rating' },
  { label: 'クチコミ数', value: 'reviewCount' },
];

type NotificationKey = 'period' | 'metric';

interface GroupCase {
  readonly name: string;
  readonly chips: readonly Chip[];
  readonly defaultValue: TrendPeriodDays | TrendMetric;
  /** 変更の通知が届く先。 */
  readonly notification: NotificationKey;
  /** 通知の値の typeof。期間は数値、指標は文字列で届く（型ガードが受け付ける型）。 */
  readonly valueType: 'number' | 'string';
}

/** 群（この並びで描く）。 */
const GROUPS: readonly GroupCase[] = [
  { name: '期間', chips: PERIOD_CHIPS, defaultValue: DEFAULT_PERIOD, notification: 'period', valueType: 'number' },
  { name: 'グラフに表示する項目', chips: METRIC_CHIPS, defaultValue: DEFAULT_METRIC, notification: 'metric', valueType: 'string' },
];

const OTHER_NOTIFICATION: Readonly<Record<NotificationKey, NotificationKey>> = { period: 'metric', metric: 'period' };

/** 構造契約（store-page.test.tsx）が許す、選択肢の隠し radio の形。 */
const HIDDEN_RADIO_SELECTOR = 'input[type="radio"][aria-hidden="true"][tabindex="-1"]';

// --- 描画 ----------------------------------------------------------------------------------

type Controls = typeof TrendControls;

/**
 * 選択を状態として持つ親の中で部品を描く。通知は、受け取った値をそのまま記録してから状態へ入れる。
 * 通知の記録を unknown で受けるのは、届いた値の型を実行時に確かめるためである。
 */
function renderStateful(Component: Controls = TrendControls) {
  const notifications = {
    period: vi.fn<(value: unknown) => void>(),
    metric: vi.fn<(value: unknown) => void>(),
  } as const;

  function Harness(): React.JSX.Element {
    const [period, setPeriod] = useState<TrendPeriodDays>(DEFAULT_PERIOD);
    const [metric, setMetric] = useState<TrendMetric>(DEFAULT_METRIC);
    return (
      <Component
        period={period}
        onPeriodChange={(next) => {
          notifications.period(next);
          setPeriod(next);
        }}
        metric={metric}
        onMetricChange={(next) => {
          notifications.metric(next);
          setMetric(next);
        }}
      />
    );
  }

  const result = render(<Harness />);
  return { ...result, notifications };
}

function groupNamed(name: string): HTMLElement {
  return screen.getByRole('radiogroup', { name });
}

/** 群の中の radio を並び順で取り、それぞれを読み上げ名で取り直して照合する。 */
function expectRadioNames(group: HTMLElement, names: readonly string[]): void {
  const radios = within(group).getAllByRole('radio');
  expect(radios).toHaveLength(names.length);
  names.forEach((name, index) => {
    expect(within(group).getByRole('radio', { name }), name).toBe(radios[index]);
  });
}

/** 群の中で選択状態の radio の読み上げ名。選択状態がちょうど 1 つであることも確かめる。 */
function expectSoleChecked(group: HTMLElement, name: string): void {
  const checked = within(group).getAllByRole('radio', { checked: true });
  expect(checked).toHaveLength(1);
  expect(checked[0]).toBe(within(group).getByRole('radio', { name }));
}

/** radio を包む札の部品（ラベル・横向きの Field・題）。 */
function chipParts(radio: HTMLElement): { readonly label: Element; readonly field: Element; readonly title: Element } {
  const field = radio.parentElement;
  const label = field?.parentElement;
  const title = field?.querySelector(':scope > [data-slot="field-label"]');
  if (field == null || label == null || title == null) {
    throw new Error('radio を包む札の部品が見つかりません');
  }
  return { label, field, title };
}

function classTokens(element: Element): readonly string[] {
  return (element.getAttribute('class') ?? '').split(/\s+/).filter((token) => token.length > 0);
}

// --- 群 ------------------------------------------------------------------------------------

describe('TrendControls の群（Issue #265）', () => {
  it('期間の群を先に、指標の群を後に置き、見える群の名前を読み上げ名として参照させる（要件 5.7）', () => {
    renderStateful();

    const groups = screen.getAllByRole('radiogroup');
    expect(groups).toHaveLength(GROUPS.length);
    GROUPS.forEach((group, index) => {
      expect(groupNamed(group.name), group.name).toBe(groups[index]);
    });

    for (const group of GROUPS) {
      const element = groupNamed(group.name);
      // 名前は、見える文字を参照して付ける。aria-label の文字列で付けると、見えている名前と食い違いうる。
      expect(element.hasAttribute('aria-label'), group.name).toBe(false);
      const title = document.getElementById(element.getAttribute('aria-labelledby') ?? '');
      expect(title, group.name).not.toBeNull();
      // 群の名前は、群の外（札の並びの前）に置いた見える文字である。
      expect(ownText(title!), group.name).toBe(group.name);
      expect(element.contains(title), group.name).toBe(false);
      expect(title!.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING, group.name).not.toBe(0);
      expect(title!.closest('[aria-hidden="true"]'), group.name).toBeNull();
      expect(classTokens(title!), group.name).not.toContain('sr-only');
    }
  });

  it('2 つ描いても、群の名前の参照が混ざらない（id を手書きしない）', () => {
    render(
      <>
        <TrendControls period={DEFAULT_PERIOD} onPeriodChange={() => {}} metric={DEFAULT_METRIC} onMetricChange={() => {}} />
        <TrendControls period={DEFAULT_PERIOD} onPeriodChange={() => {}} metric={DEFAULT_METRIC} onMetricChange={() => {}} />
      </>,
    );

    const groups = screen.getAllByRole('radiogroup');
    expect(groups).toHaveLength(GROUPS.length * 2);
    const ids = groups.map((group) => group.getAttribute('aria-labelledby'));
    expect(ids.every((id) => id !== null && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// --- 札 ------------------------------------------------------------------------------------

describe('TrendControls の札（Issue #265）', () => {
  it('期待する札の表は、期間と指標の定数と同じ並びである', () => {
    // 表を定数に結びつけておく。定数に選択肢を足したのに、ここを直し忘れると赤になる。
    expect(PERIOD_CHIPS.map((chip) => chip.value)).toEqual(TREND_PERIODS);
    expect(METRIC_CHIPS.map((chip) => chip.value)).toEqual(TREND_METRICS);
  });

  it('札の文言と並びは定数どおりで、既定の札だけが選択状態になり、印も焦点の入口もその札だけが持つ（要件 2.1・2.2・2.6・2.7）', () => {
    renderStateful();

    for (const group of GROUPS) {
      const element = groupNamed(group.name);
      expectRadioNames(
        element,
        group.chips.map((chip) => chip.label),
      );

      const defaultChip = group.chips.find((chip) => chip.value === group.defaultValue);
      expect(defaultChip, group.name).toBeDefined();
      expectSoleChecked(element, defaultChip!.label);

      const checked = within(element).getByRole('radio', { checked: true });
      // 選択の印の形（丸い印）は、選択状態の札だけが描く。色だけに頼らない（要件 2.6）。
      const indicators = element.querySelectorAll('[data-slot="radio-group-indicator"]');
      expect(indicators, group.name).toHaveLength(1);
      expect(checked.contains(indicators[0]!), group.name).toBe(true);
      // Tab で入る札は、群ごとに選択状態の札 1 つだけで、ほかの札は矢印キーで選ぶ（要件 2.7）。
      const tabStops = within(element)
        .getAllByRole('radio')
        .filter((radio) => radio.getAttribute('tabindex') === '0');
      expect(tabStops, group.name).toHaveLength(1);
      expect(tabStops[0], group.name).toBe(checked);
    }
  });

  it('札は「ラベル > 横向きの Field > radio ＋題」で組み、群の直下に並べる（§7.18）', () => {
    renderStateful();

    for (const group of GROUPS) {
      const element = groupNamed(group.name);
      const radios = within(element).getAllByRole('radio');
      const labels = radios.map((radio) => {
        const { label, field, title } = chipParts(radio);
        expect(label.matches('label[data-slot="field-label"]'), group.name).toBe(true);
        expect(field.matches('[data-slot="field"][data-orientation="horizontal"]'), group.name).toBe(true);
        // 並べの箱は役割を名乗らない（2026-09-18 の画面レビュー）。部品の既定は role="group" だが、
        // 制御 1 つだけを囲む名前の無い境界を radiogroup の内側へ 5 つ増やすだけなので打ち消してある。
        // axe は名前の無い group を違反にしないので、この検査を外すと戻す改変がどこからも赤くならない。
        expect(field.getAttribute('role'), group.name).toBe('presentation');
        // Field の中身は、radio・その隠し input・題の 3 つだけである。
        expect(
          Array.from(field.children).map((child) => child.getAttribute('data-slot') ?? child.tagName.toLowerCase()),
          group.name,
        ).toEqual(['radio-group-item', 'input', 'field-label']);
        expect(radio.getAttribute('data-slot'), group.name).toBe('radio-group-item');
        expect(ownText(title), group.name).not.toBe('');
        return label;
      });
      // 札のラベルが群の直下の子のすべてで、並びも radio と同じである（同じ要素であることを同一性で確かめる）。
      const children = Array.from(element.children);
      expect(children, group.name).toHaveLength(labels.length);
      children.forEach((child, index) => {
        expect(child, group.name).toBe(labels[index]);
      });
    }
  });

  it('面が足すクラスは、札の幅と群の並び方だけで、色を書かない（§7.18）', () => {
    const { container } = renderStateful();

    // 部品の既定のクラスを、面が何も渡していない同じ部品の描画から取る。部品の内部クラスをテストへ
    // 書き写さずに、面が足した分と消した分だけを完全一致で固定するためである。
    const baseline = render(
      <>
        <FieldTitle>対照の題</FieldTitle>
        <RadioGroup aria-label="対照" defaultValue="対照の値">
          <FieldLabel>
            <Field orientation="horizontal">
              <RadioGroupItem value="対照の値" />
              <FieldTitle>対照の札</FieldTitle>
            </Field>
          </FieldLabel>
        </RadioGroup>
      </>,
    ).container;

    const slotKey = (element: Element): string =>
      `${element.tagName.toLowerCase()}[data-slot=${element.getAttribute('data-slot') ?? ''}]`;
    const baselineTokens = new Map<string, ReadonlySet<string>>();
    for (const element of Array.from(baseline.querySelectorAll('[data-slot]'))) {
      baselineTokens.set(slotKey(element), new Set(classTokens(element)));
    }

    // 部品が描く要素ごとに、既定との差を取る。同じ種類の要素は、どれも同じ差でなければならない。
    const diffs = new Map<string, string>();
    const scanned = Array.from(container.querySelectorAll('[data-slot]'));
    for (const element of scanned) {
      const key = slotKey(element);
      const base = baselineTokens.get(key);
      expect(base, `対照に無い部品: ${key}`).toBeDefined();
      const tokens = classTokens(element);
      const diff = JSON.stringify({
        added: tokens.filter((token) => !base!.has(token)),
        removed: Array.from(base!).filter((token) => !tokens.includes(token)),
      });
      expect(diffs.get(key) ?? diff, key).toBe(diff);
      diffs.set(key, diff);
    }
    expect(scanned.length).toBeGreaterThan(0);

    const none = JSON.stringify({ added: [], removed: [] });
    expect(Object.fromEntries(diffs)).toEqual({
      // 札を折り返す 1 行に並べる（部品の既定は grid）。
      'div[data-slot=radio-group]': JSON.stringify({ added: ['flex', 'flex-wrap'], removed: ['grid'] }),
      // 札の幅を内容に従わせる。同じ変種の幅指定だけを置き換え、44px の最小高などは部品の既定のまま残す。
      'label[data-slot=field-label]': JSON.stringify({
        added: ['has-[>[data-slot=field]]:w-fit'],
        removed: ['has-[>[data-slot=field]]:w-full'],
      }),
      'div[data-slot=field]': none,
      'div[data-slot=field-label]': none,
      'span[data-slot=radio-group-item]': none,
      'span[data-slot=radio-group-indicator]': none,
    });

    // 部品の外で面が自分で class を書く要素（群をまとめる容器）は、レイアウトのクラスだけを持つ。
    const own = Array.from(container.querySelectorAll('[class]:not([data-slot])')).filter(
      (element) => element.parentElement?.closest('[data-slot]') == null,
    );
    expect(own.map((element) => classTokens(element))).toEqual([
      ['flex', 'flex-col', 'gap-4'],
      ['flex', 'flex-col', 'gap-2'],
      ['flex', 'flex-col', 'gap-2'],
    ]);
  });
});

// --- 操作 ------------------------------------------------------------------------------------

/** 札のどこをクリックするか。印（radio）は Base UI が隠し input へ転送し、題はラベルが転送する。 */
const CLICK_TARGETS = [
  { name: '印', pick: (radio: HTMLElement): Element => radio },
  { name: '題', pick: (radio: HTMLElement): Element => chipParts(radio).title },
] as const;

describe('TrendControls の操作（Issue #265）', () => {
  for (const target of CLICK_TARGETS) {
    for (const group of GROUPS) {
      it(`${group.name}: 札ごとに${target.name}をクリックすると、選択状態がその札へ移り、通知が型の合った値で届く（要件 2.1・2.2・2.6）`, () => {
        const { notifications } = renderStateful();
        const notified = notifications[group.notification];
        const other = notifications[OTHER_NOTIFICATION[group.notification]];

        // 選択中の札を押しても選択は変わらないので、既定の札は最後に押す。どの札も 1 回ずつ押す。
        const order = [
          ...group.chips.filter((chip) => chip.value !== group.defaultValue),
          ...group.chips.filter((chip) => chip.value === group.defaultValue),
        ];
        expect(order).toHaveLength(group.chips.length);

        order.forEach((chip, index) => {
          const element = groupNamed(group.name);
          fireEvent.click(target.pick(within(element).getByRole('radio', { name: chip.label })));

          expectSoleChecked(groupNamed(group.name), chip.label);
          expect(notified, chip.label).toHaveBeenCalledTimes(index + 1);
          expect(notified, chip.label).toHaveBeenLastCalledWith(chip.value);
          expect(typeof notified.mock.lastCall?.[0], chip.label).toBe(group.valueType);
        });

        // もう一方の群は、通知も選択状態も変わらない。
        expect(other).not.toHaveBeenCalled();
        const otherGroup = GROUPS.find((candidate) => candidate.notification !== group.notification)!;
        expectSoleChecked(
          groupNamed(otherGroup.name),
          otherGroup.chips.find((chip) => chip.value === otherGroup.defaultValue)!.label,
        );
      });
    }
  }

  it('矢印キーで、同じ群の隣の札へ焦点と選択状態が移る（要件 2.7）', async () => {
    const { notifications } = renderStateful();

    const period = groupNamed('期間');
    const thirty = within(period).getByRole('radio', { name: '30日' });
    thirty.focus();
    expect(document.activeElement).toBe(thirty);
    // Base UI は、矢印キーで次の札へ焦点を移す処理を queueMicrotask で後に回す。act の中でその処理まで
    // 流してから確かめる。
    await act(async () => {
      fireEvent.keyDown(thirty, { key: 'ArrowLeft' });
    });

    const seven = within(groupNamed('期間')).getByRole('radio', { name: '7日' });
    expect(document.activeElement).toBe(seven);
    expectSoleChecked(groupNamed('期間'), '7日');
    expect(notifications.period).toHaveBeenLastCalledWith(7);
    expect(notifications.metric).not.toHaveBeenCalled();
  });

  it('隠し input は札の数だけあり、どれも構造契約の許す形で、name を持たない（要件 7.2）', () => {
    const { container } = renderStateful();

    const inputs = Array.from(container.querySelectorAll('input'));
    expect(inputs).toHaveLength(PERIOD_CHIPS.length + METRIC_CHIPS.length);
    expect(inputs.filter((input) => input.matches(HIDDEN_RADIO_SELECTOR))).toHaveLength(inputs.length);
    expect(inputs.filter((input) => input.hasAttribute('name'))).toEqual([]);
    // 入力は隠し radio だけで、書込の手段になる要素を描かない。
    expect(container.querySelectorAll('form, button, select, textarea, [form], [contenteditable]')).toHaveLength(0);
  });
});

// --- 定数との結びつき ------------------------------------------------------------------------
//
// 札を定数から作っていること、型ガードで値を絞っていることは、今の定数のままでは外から見分けられない
// （手で並べた札も同じ DOM を描く）。そこで lib/trend-view の定数だけを差し替えた部品を読み直して確かめる。
// 型ガード（isTrendPeriod / isTrendMetric）は差し替えないので、元の定数に無い値は受け付けない。

describe('TrendControls と定数の結びつき（Issue #265）', () => {
  afterEach(() => {
    vi.doUnmock('../lib/trend-view');
    vi.resetModules();
  });

  async function importWithConstants(periods: readonly unknown[], metrics: readonly unknown[]): Promise<Controls> {
    vi.resetModules();
    vi.doMock('../lib/trend-view', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../lib/trend-view')>()),
      TREND_PERIODS: periods,
      TREND_METRICS: metrics,
    }));
    return (await import('../app/store/trend-controls')).TrendControls;
  }

  it('札の数と並びは、期間と指標の定数に従う（札を手で並べない）', async () => {
    const Reordered = await importWithConstants([30, 7], ['reviewCount', 'rank']);
    const { container, notifications } = renderStateful(Reordered);

    expectRadioNames(groupNamed('期間'), ['30日', '7日']);
    expectRadioNames(groupNamed('グラフに表示する項目'), ['クチコミ数', '順位']);
    expect(container.querySelectorAll(HIDDEN_RADIO_SELECTOR)).toHaveLength(4);

    // 差し替えた部品も、札の値で通知する。
    fireEvent.click(within(groupNamed('グラフに表示する項目')).getByRole('radio', { name: 'クチコミ数' }));
    expect(notifications.metric).toHaveBeenLastCalledWith('reviewCount');
  });

  it('型ガードに当てはまらない値の札は、通知も選択状態も変えない', async () => {
    const WithUnknown = await importWithConstants([7, 14, 30], [...TREND_METRICS, 'visits']);
    const { notifications } = renderStateful(WithUnknown);

    fireEvent.click(within(groupNamed('期間')).getByRole('radio', { name: '14日' }));
    // 元の定数に無い指標は札の文言も持たないので、並びの位置で取る。
    const unknownMetric = within(groupNamed('グラフに表示する項目')).getAllByRole('radio')[TREND_METRICS.length];
    expect(unknownMetric).toBeDefined();
    fireEvent.click(unknownMetric!);

    expect(notifications.period).not.toHaveBeenCalled();
    expect(notifications.metric).not.toHaveBeenCalled();
    expectSoleChecked(groupNamed('期間'), '30日');
    expectSoleChecked(groupNamed('グラフに表示する項目'), '順位');

    // 対照: 同じ描画で、当てはまる値の札は通知が届く（上の「届かない」が空振りでないこと）。
    fireEvent.click(within(groupNamed('期間')).getByRole('radio', { name: '7日' }));
    fireEvent.click(within(groupNamed('グラフに表示する項目')).getByRole('radio', { name: '評価' }));
    expect(notifications.period).toHaveBeenLastCalledWith(7);
    expect(notifications.metric).toHaveBeenLastCalledWith('rating');
  });
});
