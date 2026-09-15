// 期間と指標の選択肢（store-detail-trend-dashboard task 3.2・Issue #265）。
//
// 推移の節で、期間と、グラフに描く指標を選ぶ札の並びを描く。判断の正典は docs/design/design-language.md
// §7.18 であり、ここでは結論も数値も転記せず参照する。部品の選び方の審議は、同 spec の research.md
// （「部品と環境の制約」と「design 検証での実測」）にある。
//
// 並びと名前:
// - 期間の群を先に、指標の群を後に置く。期間は節の表示のすべてに効き、指標はグラフだけに効くためである。
// - 群ごとに見える名前（「期間」「グラフの指標」）を置き、RadioGroup の aria-labelledby から参照させる
//   （要件 5.7）。id は useId の値だけを使う。手書きの id を参照する記法は、直書きの色と誤検出される。
//
// 札:
// - 札は TREND_PERIODS / TREND_METRICS から作る。構成は、ラベル（FieldLabel）の中に横向きの Field を置き、
//   その中に radio と題を置く形である。操作領域の最小高は、ラベルの行が部品の側で持つ（§7.10）。
// - 札は折り返す 1 行に並べ、幅は内容に従わせる。FieldLabel の既定の全幅は、同じ変種の幅指定で上書きする
//   （tailwind-merge は、既定の側の同じ変種の幅指定だけを落とす）。FieldLabel は data-slot を持つ部品の
//   要素なので、面の側の任意値の禁止（test/store-page.test.tsx）にはかからない。
// - 指標の札の「クチコミ」は、既存の指標の項目名にそろえる。グラフの題の「クチコミ数」より、札の幅も抑えられる。
//
// 値:
// - RadioGroup の値の型は any である。値の変化は unknown として受け、isTrendPeriod / isTrendMetric で絞る。
//   当てはまらない値は無視し、型の強制変換はしない。値を書き違えた札は型検査で止まらず、押しても
//   変わらない札になる。test/trend-controls.test.tsx が、札ごとにクリックして確かめる。
// - radio に name を渡さない。隠し input が name を持つと、構造契約の検査に当たる（要件 7.2）。
// - 選択は持たない。期間と指標の状態は、推移の節が持つ（同 spec の research.md の決定 D8）。
//
// 色: 札に色を書かない（§7.18）。選択状態の枠・面・印は、部品の側がトークンから解決する。
//
// この部品は、page.tsx（Client Component）の中で描く。

import { useId } from 'react';
import { Field, FieldLabel, FieldTitle } from '@fwlm/ui/components/field';
import { RadioGroup, RadioGroupItem } from '@fwlm/ui/components/radio-group';

import {
  TREND_METRICS,
  TREND_PERIODS,
  isTrendMetric,
  isTrendPeriod,
  type TrendMetric,
  type TrendPeriodDays,
} from '../../lib/trend-view';

export interface TrendControlsProps {
  readonly period: TrendPeriodDays;
  readonly onPeriodChange: (period: TrendPeriodDays) => void;
  readonly metric: TrendMetric;
  readonly onMetricChange: (metric: TrendMetric) => void;
}

/** 札を折り返す 1 行に並べる（RadioGroup の既定の grid を置き換える）。 */
const CHIP_ROW_CLASS = 'flex flex-wrap';
/** 札の幅を内容に従わせる。FieldLabel の既定の全幅（同じ変種の幅指定）だけを置き換える。 */
const CHIP_WIDTH_CLASS = 'has-[>[data-slot=field]]:w-fit';

/** 指標の札の文言。 */
const METRIC_CHIP_LABELS: Readonly<Record<TrendMetric, string>> = {
  rank: '順位',
  rating: '評価',
  reviewCount: 'クチコミ',
};

function periodChipLabel(period: TrendPeriodDays): string {
  return `${period}日`;
}

function metricChipLabel(metric: TrendMetric): string {
  return METRIC_CHIP_LABELS[metric];
}

interface ChoiceGroupProps<T extends TrendPeriodDays | TrendMetric> {
  /** 群の見える名前。選択肢の群の名前として読み上げられる。 */
  readonly title: string;
  readonly options: readonly T[];
  readonly value: T;
  readonly labelOf: (option: T) => string;
  /** 選択肢の値の型ガード。当てはまらない値は、通知せずに捨てる。 */
  readonly accepts: (value: unknown) => value is T;
  readonly onChange: (value: T) => void;
}

/** 1 つの群（見える名前と、札の並び）。 */
function ChoiceGroup<T extends TrendPeriodDays | TrendMetric>({
  title,
  options,
  value,
  labelOf,
  accepts,
  onChange,
}: ChoiceGroupProps<T>): React.JSX.Element {
  const titleId = useId();

  return (
    <div className="flex flex-col gap-2">
      <FieldTitle id={titleId}>{title}</FieldTitle>
      <RadioGroup
        aria-labelledby={titleId}
        value={value}
        onValueChange={(next: unknown) => {
          if (accepts(next)) {
            onChange(next);
          }
        }}
        className={CHIP_ROW_CLASS}
      >
        {options.map((option) => (
          <FieldLabel key={option} className={CHIP_WIDTH_CLASS}>
            <Field orientation="horizontal">
              <RadioGroupItem value={option} />
              <FieldTitle>{labelOf(option)}</FieldTitle>
            </Field>
          </FieldLabel>
        ))}
      </RadioGroup>
    </div>
  );
}

export function TrendControls({ period, onPeriodChange, metric, onMetricChange }: TrendControlsProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <ChoiceGroup
        title="期間"
        options={TREND_PERIODS}
        value={period}
        labelOf={periodChipLabel}
        accepts={isTrendPeriod}
        onChange={onPeriodChange}
      />
      <ChoiceGroup
        title="グラフの指標"
        options={TREND_METRICS}
        value={metric}
        labelOf={metricChipLabel}
        accepts={isTrendMetric}
        onChange={onMetricChange}
      />
    </div>
  );
}
