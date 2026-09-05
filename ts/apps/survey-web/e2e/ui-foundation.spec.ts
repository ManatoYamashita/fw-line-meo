import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect, devices, type Locator, type Page } from '@playwright/test';
import { colors, compositeOver, contrastRatio } from '@fwlm/design-tokens';
import {
  deviceWidthOf,
  expectNoHorizontalScroll,
  readOverflowMetrics,
  type OverflowMetrics,
} from '@fwlm/e2e-support/viewport';

import { openComponentCatalog, openSurveySurface } from './fixtures/surfaces';

// UI デザイン基盤（ui-design-foundation）の非後退 E2E。
// requirements 5.3（キーボードフォーカス時に視認可能なフォーカス表示）と
// requirements 3.3（モバイル端末で横スクロールを発生させない）を検証する。
// クラス名の有無ではなく getComputedStyle とレイアウト実測（実描画）で判定する。

// alpha = 0 のアウトラインは描画されないため「見えている」とは扱わない。
const TRANSPARENT = /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)$/;

// Tab でたどる上限回数。フォーカスが body へ抜けた時点でループは自然に終了するため、
// 余裕を持たせても実行時間は増えない。
//
// **この値は安全弁であって設計値ではない。** 上限に達して打ち切られると、その先の要素は
// フォーカス可視性を一度も検査されないまま緑になる。検証面の操作可能要素は Issue #52 と #57 の
// 双方が追加しており、実測の巡回数は `/ui-check` が 21・回答画面が 13（従来の上限 24 に対し
// 余裕は 3 しかなかった）。打ち切りが起きていないこと自体を各テストの末尾で assert し、
// 部品を足し続けたときに静かに検査対象が減る事故を防ぐ。
//
// 注意: 巡回数を DOM の tabbable 要素数から見積もってはならない。Base UI の RadioGroup は
// roving tabindex で群全体が 1 停止になり、Checkbox が内部に持つ隠し input は巡回に乗らない。
// 素朴に数えると 30 になるが実際は 21 である（この見積もり違いを実際に踏んだ）。
const MAX_TAB_STEPS = 48;

/** 通常文字の WCAG 2.1 AA 基準（Requirements 5.2）。 */
const AA_NORMAL_TEXT_RATIO = 4.5;

// 非テキスト（部品の輪郭・状態表示）の WCAG 2.1 SC 1.4.11 基準。
// spec form-non-text-contrast の Requirements 1.1 / 2.1 / 3.4 が課すしきい値。
const NON_TEXT_RATIO = 3;

// color-mix() の合成後の実効色は @fwlm/ui の許可リストを正典にする（PR #56 レビュー指摘2）。
// 同じファイルを ui の contrast-usage.test.ts が静的な数値検証に使う。実測値を両側へ手書きすると、
// それ自体が drift の発生源になるため、値は 1 箇所にしか置かない。
interface ColorMixEntry {
  readonly file: string;
  readonly expression: string;
  readonly measuredHex: string;
  readonly foreground: string;
  readonly kind: string;
  readonly reason: string;
}

const colorMixAllowlist = (
  JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'packages',
        'ui',
        'test',
        'color-mix-allowlist.json',
      ),
      'utf8',
    ),
  ) as { readonly entries: readonly ColorMixEntry[] }
).entries;

/** 実測した 1 レイヤ分の色。`alpha` は 0..1（1 が不透明）。 */
interface MeasuredColor {
  /** 不透明度を戻した色（6桁大文字 hex・`compositeOver` にそのまま渡せる形式）。 */
  readonly hex: string;
  /** そのレイヤ自身の不透明度（0..1）。 */
  readonly alpha: number;
}

interface RenderedLayers {
  color: MeasuredColor;
  backgroundColor: MeasuredColor;
  /** 上・右・下・左の順。 */
  borderColors: readonly MeasuredColor[];
  /** 枠の描画幅（px・上辺）。0 は「枠が描かれていない」ことを意味する。 */
  borderWidth: number;
  /** 要素全体（枠も面も子孫も）に掛かる不透明度（0..1）。計算値の色には合成されていない。 */
  opacity: number;
  /** 測定時点でこの要素がフォーカスされていたか（Requirements 1.2 の前提確認用）。 */
  focused: boolean;
}

// 要素に実際に描画される色を、合成前のレイヤ単位で読む。
//
// getComputedStyle は color-mix() を `oklch(…)` や `oklab(…)` の書式のまま返しうるため、
// 文字列の突き合わせでは書式に依存してしまう。canvas の fillStyle にその値をそのまま流して
// 1px 描き、描かれたピクセルの sRGB を読むことで書式非依存の実測値にする。
// alpha も同時に返すのは、半透明の指定（`bg-input/50` など）を上位で下地へ合成できるように
// するため（タスク 4.3）。**ここでは合成しない**。合成は下地が何かを知る呼び出し側の責務であり、
// 演算そのものは design-tokens の `compositeOver` に委ねる。
//
// 要素の `opacity` を併せて返す理由: `opacity` は要素の描画結果全体に掛かるが、計算値の色には
// 一切反映されない。無効化状態のように `opacity` が 1 未満の要素では、利用者が見る色は
// 計算値そのものではない（design.md D8 / Open Questions #4）。
function readRenderedLayers(locator: Locator): Promise<RenderedLayers> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const context = document.createElement('canvas').getContext('2d');
    if (context === null) throw new Error('canvas の 2d コンテキストを取得できません');

    const measure = (value: string): MeasuredColor => {
      context.clearRect(0, 0, 1, 1);
      // 解釈できない書式が来た場合に前の値が残らないよう、毎回 sentinel を置いてから代入する。
      context.fillStyle = '#000000';
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
      return {
        hex: `#${[red, green, blue]
          .map((channel) => (channel ?? 0).toString(16).padStart(2, '0'))
          .join('')}`.toUpperCase(),
        alpha: (alpha ?? 0) / 255,
      };
    };

    return {
      color: measure(style.color),
      backgroundColor: measure(style.backgroundColor),
      borderColors: [
        style.borderTopColor,
        style.borderRightColor,
        style.borderBottomColor,
        style.borderLeftColor,
      ].map(measure),
      borderWidth: Number.parseFloat(style.borderTopWidth),
      opacity: Number.parseFloat(style.opacity),
      focused: element.matches(':focus'),
    };
  });
}

interface RenderedColors {
  /** 実際に描画される文字色（6桁 hex）。 */
  color: string | null;
  /** 実際に描画される背景色（6桁 hex）。透明なら null。 */
  backgroundColor: string | null;
  /** 実際に描画される枠色（6桁 hex）。四辺で色が食い違う場合と半透明なら null。 */
  borderColor: string | null;
  /** 枠の描画幅（px・上辺）。0 は「枠が描かれていない」ことを意味する。 */
  borderWidth: number;
  /** 測定時点でこの要素がフォーカスされていたか（Requirements 1.2 の前提確認用）。 */
  focused: boolean;
}

// 「その要素だけを見て色が決まる」場合の実描画色。
// 半透明（alpha < 1）は「その要素では色が決まらない」ことを意味するので null を返し、
// 呼び出し側に下地の要素を測らせる（無音で 0 と比較して緑になるのを防ぐ）。
// この思想は維持する。半透明を織り込んだ実効色が要る場合は effectiveColorOver を使うこと。
//
// 枠色（Issue #57 / spec form-non-text-contrast タスク 4.2）:
// 枠は意味論変数（--input など）を経由してトークンへ解決されるため、クラス集合（border-input）
// を読んでも実際に描かれる色は分からない。変数の付け替えを誤れば、クラス名は無傷のまま色だけが
// 薄い装飾用へ戻る。枠色まで実測することでその経路を塞ぐ。上辺だけを代表値にすると四辺で色が
// 食い違う要素の他の辺を見逃すため、四辺が一致したときのみ値を返す（半透明の扱いと同じ思想で、
// 「決められないときは null を返して呼び出し側に落とさせる」）。
async function readRenderedColors(locator: Locator): Promise<RenderedColors> {
  const layers = await readRenderedLayers(locator);
  const opaqueHex = (measured: MeasuredColor): string | null =>
    measured.alpha === 1 ? measured.hex : null;

  const sides = layers.borderColors.map(opaqueHex);
  const [top] = sides;

  return {
    color: opaqueHex(layers.color),
    backgroundColor: opaqueHex(layers.backgroundColor),
    borderColor: top != null && sides.every((side) => side === top) ? top : null,
    borderWidth: layers.borderWidth,
    focused: layers.focused,
  };
}

// 利用者が実際に見る色（実効色）を導く。
//
// 2 段の合成が要る。(1) レイヤ自身の半透明（`bg-input/50`）を下地へ合成し、
// (2) 要素全体に掛かる不透明度（`opacity-50`）でさらに下地へ合成する。
// どちらか一方でも欠けると、計算値と実際の見た目が食い違ったまま検証が緑になる。
//
// 合成の演算は design-tokens の compositeOver（正典の実装）にのみ委ねる。ここで自前の
// アルファブレンドを書くと、検証側だけが持つ第 2 の実装になり、まさに本プロジェクトのガードが
// 防ごうとしている実装ドリフトを自分で作ることになる（contrast.ts の冒頭コメント）。
function effectiveColorOver(
  layer: MeasuredColor,
  backdrop: string,
  elementOpacity: number,
): string {
  return compositeOver(
    compositeOver(layer.hex, backdrop, layer.alpha),
    backdrop,
    elementOpacity,
  );
}

// 枠色を「空振りしていないこと」を確かめたうえで返す。
//
// 枠の指定が発火していない要素でも計算値としての枠色は返る（Tailwind の preflight が
// `border: 0 solid` を敷き、theme.css の base レイヤが色だけを与えているため）。色だけを見ると
// 枠が一切描かれていなくても assert が通ってしまうので、幅が 0 でないことを先に要求する
// （tasks.md Implementation Notes「空振りしているかどうかは色ではなく枠幅を見ると一発で分かる」）。
async function readRenderedBorder(locator: Locator, where: string): Promise<RenderedColors> {
  const rendered = await readRenderedColors(locator);
  expect(
    rendered.borderWidth,
    `${where}: 枠が描画されていない（幅 0）。枠の指定が発火していない可能性がある`,
  ).toBeGreaterThan(0);
  expect(
    rendered.borderColor,
    `${where}: 枠色を実測できない（四辺の色が食い違うか半透明）`,
  ).not.toBeNull();
  return rendered;
}

// 頁の下地の色を実測する。
// フォーム部品は bg-transparent で描かれるため、枠が識別すべき相手は自分の背景ではなく
// 隣接する頁背景になる（design.md「エラー状態と選択状態の優先順位」の決定事項）。
async function readPageBackground(page: Page): Promise<string> {
  const { backgroundColor } = await readRenderedColors(page.locator('body'));
  expect(backgroundColor, '頁の下地の色を実測できない').not.toBeNull();
  return backgroundColor as string;
}

/** 実測した枠色と頁背景の比が非テキスト基準（3:1）を満たすことを要求する。 */
function expectNonTextContrast(border: string, background: string, where: string): void {
  const ratio = contrastRatio(border, background);
  expect(
    ratio,
    `${where}: 枠 ${border} on 背景 ${background} → ${ratio.toFixed(3)}:1（要求 ${NON_TEXT_RATIO}:1）`,
  ).toBeGreaterThanOrEqual(NON_TEXT_RATIO);
}

// --- 実描画の計測基盤（ui-a11y-gaps・要件 5.1 / 5.3） ----------------------------------
//
// タッチ操作領域も動きの抑制も、クラス名の有無では判定できない。前者は疑似要素の幾何と
// レイアウトの相互作用で決まり、後者はカスケードレイヤの優先順位で決まるため、いずれも
// 「そう書いてあるのに効いていない」が起こりうる。ここでは実描画から直接測る。

interface Box {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

interface TouchGeometry {
  slot: string | null;
  /** 押しボタンの寸法区分（data-size）。持たない部品は null。 */
  size: string | null;
  /** 失敗メッセージで対象を特定するための呼び名。 */
  name: string;
  /** 利用者に見えている矩形（border box）。 */
  visual: Box;
  /** 見えている矩形と拡張面の和 ＝ 実際に指で押せる領域。 */
  effective: Box;
  /** 拡張面によって領域が実際に広がっているか。 */
  hasExpansion: boolean;
}

/**
 * セレクタに一致する要素の実効的な操作領域を、実描画からまとめて求める。
 *
 * `::after` による拡張はレイアウトフローから外れるので `getBoundingClientRect` には現れない。
 * 疑似要素の矩形は API から直接取れないため、計算済みスタイルの inset から幾何的に求める。
 * `::after` の含有ブロックは本体の **padding box** なので、border 幅の分だけ内側から測る。
 *
 * 拡張量を数値として主張できない場合（`auto` 等）は本体の矩形へ倒す。不明を「広い」と
 * 読み替えると、拡張が消えた実装をそのまま緑で通してしまうため。
 *
 * 要素ごとに個別へ問い合わせず一括で返すのは、隣接部品どうしの位置関係（要件 4.5）を
 * 同一時点の座標で比較する必要があるためでもある。
 */
function readTouchGeometries(
  page: Page,
  selector: string,
): Promise<readonly TouchGeometry[]> {
  return page.evaluate((query) => {
    const toBox = (top: number, right: number, bottom: number, left: number) => ({
      top,
      right,
      bottom,
      left,
      width: right - left,
      height: bottom - top,
    });

    return Array.from(document.querySelectorAll(query)).map((element) => {
      const rect = element.getBoundingClientRect();
      const visual = toBox(rect.top, rect.right, rect.bottom, rect.left);
      const identity = {
        slot: element.getAttribute('data-slot'),
        size: element.getAttribute('data-size'),
        name:
          element.getAttribute('aria-label') ??
          ((element.textContent ?? '').trim().slice(0, 20) ||
            (element.getAttribute('data-slot') ?? '要素')),
      };
      const withoutExpansion = { ...identity, visual, effective: visual, hasExpansion: false };

      const after = getComputedStyle(element, '::after');
      // 疑似要素が生成されない／レイアウトに参加しない／当たり判定を持たない場合は拡張なし。
      if (
        after.content === 'none' ||
        after.position !== 'absolute' ||
        after.pointerEvents === 'none'
      ) {
        return withoutExpansion;
      }

      const px = (value: string): number => Number.parseFloat(value);
      const own = getComputedStyle(element);
      const padTop = rect.top + px(own.borderTopWidth);
      const padLeft = rect.left + px(own.borderLeftWidth);
      const padRight = rect.right - px(own.borderRightWidth);
      const padBottom = rect.bottom - px(own.borderBottomWidth);

      const insets = [after.top, after.right, after.bottom, after.left].map(px);
      if (insets.some((value) => !Number.isFinite(value))) return withoutExpansion;
      const [insetTop, insetRight, insetBottom, insetLeft] = insets as [
        number,
        number,
        number,
        number,
      ];

      // inset は含有ブロックの各辺からの距離。負の値が外側へのはみ出しになる。
      const overlay = toBox(
        padTop + insetTop,
        padRight - insetRight,
        padBottom - insetBottom,
        padLeft + insetLeft,
      );
      // 実際に押せるのは本体と拡張面の和。拡張面が本体より内側でも領域は縮まない。
      const effective = toBox(
        Math.min(visual.top, overlay.top),
        Math.max(visual.right, overlay.right),
        Math.max(visual.bottom, overlay.bottom),
        Math.min(visual.left, overlay.left),
      );
      return {
        ...identity,
        visual,
        effective,
        hasExpansion: effective.width > visual.width || effective.height > visual.height,
      };
    });
  }, selector);
}

/** 2 つの矩形が面積を持って重なるか（辺で接するだけは重なりとみなさない）。 */
function intersects(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

interface HitTarget {
  slot: string | null;
  name: string;
}

/**
 * 指定した座標で実際に反応する部品を返す。
 *
 * 幾何の計算だけでは「その矩形が本当に当たり判定を持つか」を主張できない。座標を撃って
 * 返ってきた要素を見ることで、幾何と実際の反応先を結びつける（この紐が無いと、
 * `pointer-events` の欠落や他要素による被覆を素通ししてしまう）。
 */
function readHitTarget(page: Page, x: number, y: number): Promise<HitTarget | null> {
  return page.evaluate(
    ([pointX, pointY]) => {
      const element = document.elementFromPoint(pointX as number, pointY as number);
      if (element === null) return null;
      const owner = element.closest('[data-slot]');
      const named = owner ?? element;
      return {
        slot: owner === null ? null : owner.getAttribute('data-slot'),
        name:
          named.getAttribute('aria-label') ?? (named.textContent ?? '').trim().slice(0, 24),
      };
    },
    [x, y],
  );
}

/** 動きが「知覚されない」とみなす上限（秒）。research.md R-1 の実測では 1e-05s へ解決される。 */
const IMPERCEPTIBLE_SECONDS = 0.001;

/** 客向け主動線で用いる既定寸法に要求する操作領域（ui-a11y-gaps 要件 4.1）。 */
const TOUCH_TARGET_DEFAULT_PX = 44;
/** 高密度配置向けの縮小寸法と選択部品単体の下限（WCAG 2.2 SC 2.5.8・要件 4.2）。 */
const TOUCH_TARGET_COMPACT_PX = 24;

/**
 * 押しボタンの寸法区分 → 要求値。
 * 区分が増えたらここへ必ず追記する。宣言の無い区分を実描画で見つけたら失敗させる（要件 5.4）。
 * 区分の一覧そのものが部品ソースと一致しているかは @fwlm/ui 側の分類ガードが担う。
 */
const BUTTON_TOUCH_REQUIREMENT: Readonly<Record<string, number>> = {
  default: TOUCH_TARGET_DEFAULT_PX,
  lg: TOUCH_TARGET_DEFAULT_PX,
  icon: TOUCH_TARGET_DEFAULT_PX,
  'icon-lg': TOUCH_TARGET_DEFAULT_PX,
  xs: TOUCH_TARGET_COMPACT_PX,
  sm: TOUCH_TARGET_COMPACT_PX,
  'icon-xs': TOUCH_TARGET_COMPACT_PX,
  'icon-sm': TOUCH_TARGET_COMPACT_PX,
};

/**
 * 指で操作する部品の `data-slot`。**判定の射程はこの 1 箇所から導く。**
 *
 * 要件 4.5（隣接時の被覆）と要件 4.7（ラベルを伴う行）の対象条件を 2 箇所に書くと、
 * 部品を足したときに片方だけ追随して、判定の射程が静かに縮む。実際 PR #180 では
 * 選択部品を 4.7 側だけへ足し、4.5 側は元のままだった（レビュー指摘 1）。
 * 縮んだことはどの検査にも現れない（覆う側が居なければ 4.5 は自明に成立するため）。
 *
 * 下の 2 つの部分集合を `satisfies` でこの集合へ束縛することで、**ラベルを伴う構成として
 * 数えた部品が 4.5 の対象から漏れると型検査が落ちる**。追随を人間の注意力に委ねない。
 */
const OPERABLE_SLOTS = [
  'button',
  'checkbox',
  'radio-group-item',
  'input',
  'textarea',
  'select',
] as const;

type OperableSlot = (typeof OPERABLE_SLOTS)[number];

/** `data-slot` の並びを CSS のセレクタリストへ変換する。 */
function slotSelector(slots: readonly string[]): string {
  return slots.map((slot) => `[data-slot="${slot}"]`).join(', ');
}

/** 指で操作する部品。隣接時の被覆判定（要件 4.5）はこの集合の全組み合わせで見る。 */
const OPERABLE_SELECTOR = slotSelector(OPERABLE_SLOTS);

/** ラベルが制御を包む構成をとる部品（要件 4.7 の前者）。 */
const LABEL_WRAPPING_SLOTS = [
  'checkbox',
  'radio-group-item',
] as const satisfies readonly OperableSlot[];

/** ラベルが制御の上へ積まれる構成をとる部品（要件 4.7 の後者）。 */
const LABEL_STACKED_SLOTS = ['input', 'select'] as const satisfies readonly OperableSlot[];

/**
 * ラベルを伴う構成の「行」。要件 4.7 の 44px はこの行全体で満たす。
 *
 * テキスト入力は指で押した位置に文字カーソルを置く性質上、選択部品は部品自身が規定する
 * 項目間隔（ピッチ 24px）の制約上、どちらも不可視面で操作領域を広げられない。
 * 2 つの形をとる: ラベルが制御を包む構成と、ラベルが制御の上に積まれる構成。
 *
 * **後者は「ラベルを持つこと」を明示的に要求する。** 要件 4.7 が対象とするのは
 * *ラベルを伴う* 構成であり、ラベルのない Field（例: 入力とエラー文言だけを並べた行）は
 * 44px の保証範囲外である（要件の Boundary Context「ラベルを伴わない裸の入力」）。
 * 条件を `input を含む Field` とだけ書くと、Issue #57 が検証面へ追加したエラー状態の行
 * （ラベルを持たない・実測 40px）まで巻き込んで、満たしようのない要求を課すことになる。
 *
 * 選択部品（Issue #174）も同じ扱いにする。高さは一行入力と揃えてあり、単体では要求寸法に
 * 届かないため、ラベルを含む行で満たす。
 */
const LABELLED_ROW_SELECTOR =
  `[data-slot="field-label"]:has(${slotSelector(LABEL_WRAPPING_SLOTS)}), ` +
  `[data-slot="field"]:has([data-slot="field-label"]):has(${slotSelector(LABEL_STACKED_SLOTS)})`;

interface TextCue {
  /** テキストを持つ子孫が存在するか。 */
  present: boolean;
  text: string;
  /** 実際に描画された幅。読み上げ専用（sr-only）なら 1px 程度に潰れる。 */
  width: number;
}

/**
 * 処理中表示が提示している「動きに依存しない手掛かり」を実描画から読む。
 *
 * 「見えているか」をクラス名で判定してはならない。`sr-only` と `not-sr-only` はどちらも
 * `@layer utilities` に生成され、どちらが勝つかは生成順で決まる。クラスが付いていることと
 * 見えていることは別問題なので、**描画された幅**で判定する。
 */
function readSpinnerTextCue(page: Page): Promise<TextCue> {
  return page.locator('[data-slot="spinner"]').first().evaluate((element) => {
    const withText = [element, ...Array.from(element.querySelectorAll('*'))].filter(
      (node) => (node.textContent ?? '').trim().length > 0,
    );
    // 最も内側（テキストを直接持つ要素）を測る。
    const target = withText[withText.length - 1];
    if (target === undefined) return { present: false, text: '', width: 0 };
    return {
      present: true,
      text: (target.textContent ?? '').trim(),
      width: target.getBoundingClientRect().width,
    };
  });
}

interface MotionValues {
  animationName: string;
  animationDurationSeconds: number;
  animationIterationCount: string;
  transitionDurationSeconds: number;
}

interface AnimatedElement {
  slot: string | null;
  animationName: string;
  animationDurationSeconds: number;
  animationIterationCount: string;
}

/**
 * 画面上でアニメーションを持つ要素を**すべて**実描画から探す。
 *
 * 特定の部品を名指しで測ると、部品の DOM 構造が変わったときに静かに対象を失う。また要件 1.1 が
 * 求めるのは「その部品が止まること」ではなく「無限に繰り返すアニメーションが再生されないこと」
 * なので、面全体を走査して 1 つでも生き残っていれば落とす方が要件に忠実である。
 */
function readAnimatedElements(page: Page): Promise<readonly AnimatedElement[]> {
  return page.evaluate(() => {
    const maxSeconds = (value: string): number =>
      value.split(',').reduce((longest, part) => {
        const text = part.trim();
        const amount = Number.parseFloat(text);
        if (!Number.isFinite(amount)) return longest;
        return Math.max(longest, text.endsWith('ms') ? amount / 1000 : amount);
      }, 0);

    const found: AnimatedElement[] = [];
    for (const element of Array.from(document.querySelectorAll('*'))) {
      const style = getComputedStyle(element);
      if (style.animationName === 'none' || style.animationName === '') continue;
      found.push({
        slot: element.getAttribute('data-slot'),
        animationName: style.animationName,
        animationDurationSeconds: maxSeconds(style.animationDuration),
        animationIterationCount: style.animationIterationCount,
      });
    }
    return found;
  });
}

/**
 * 押下を保持したときに到達する見た目を、**実際に描画された位置の差**として測る。
 *
 * 要件 1.4 が守るのは「動きの経過」と「到達する状態」の区別である。抑制の対象を誤って
 * 到達状態まで広げると、押下フィードバックのような **動きではなく状態** が失われる。
 *
 * 計算済みスタイルの特定プロパティを読んではならない。Tailwind v4 の `translate-y-px` は
 * `transform` ではなく独立した `translate` プロパティへ出力されるため、`transform` を読むと
 * 押下の有無によらず常に `none` が返り、**何も測らずに緑になる**（実際にこの罠を踏んだ）。
 * 位置そのものを測れば、どのプロパティで実現されていても、また将来別の手段へ変わっても、
 * 「到達する見た目」を直接見ていることになる。
 */
async function readPressedShift(page: Page, name: string): Promise<number> {
  const button = page.getByRole('button', { name });
  await expect(button).toBeVisible();
  const readTop = (): Promise<number> =>
    button.evaluate((element) => element.getBoundingClientRect().top);

  const idle = await readTop();
  const box = await button.boundingBox();
  if (box === null) throw new Error(`${name} の矩形を取得できません`);

  // 測るのは「到達した状態」なので、遷移が走り切るまで待つ必要がある。待たずに読むと
  // 遷移の途中の値（実測 0.92px）を最終値（1px）と比べることになり、抑制の有無ではなく
  // 遷移速度の差を検出してしまう。待ち時間は実測した遷移時間から導く（固定の勘に頼らない）。
  const settleMs = (await readMotion(button)).transitionDurationSeconds * 1000 + 150;

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  try {
    await page.waitForTimeout(settleMs);
    const shift = (await readTop()) - idle;
    // 空振り防止: 両文脈とも 0 なら「同一」は成立してしまう。到達状態の存在自体を要求する。
    expect(
      shift,
      `${name}: 押下しても描画位置が変わらない（${shift}px）。押下フィードバック（到達状態）が` +
        '失われている（抑制の対象が動きの「経過」を超えている疑い）',
    ).toBeGreaterThan(0);
    return shift;
  } finally {
    await page.mouse.up();
  }
}

/**
 * 動きの実効値を計算済みスタイルから読む。
 *
 * カンマ区切りで複数指定されうるため代表値には最大を採る。1 つでも知覚できる長さが
 * 残っていれば抑制は成立していないので、平均や先頭では甘くなる。
 */
function readMotion(locator: Locator): Promise<MotionValues> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const maxSeconds = (value: string): number =>
      value.split(',').reduce((longest, part) => {
        const text = part.trim();
        const amount = Number.parseFloat(text);
        if (!Number.isFinite(amount)) return longest;
        return Math.max(longest, text.endsWith('ms') ? amount / 1000 : amount);
      }, 0);
    return {
      animationName: style.animationName,
      animationDurationSeconds: maxSeconds(style.animationDuration),
      animationIterationCount: style.animationIterationCount,
      transitionDurationSeconds: maxSeconds(style.transitionDuration),
    };
  });
}

/**
 * 検証面のレイアウトが degenerate になっていないことを、寸法の検証より **先に** 確かめる。
 *
 * これが無いと、検証面が潰れたときに寸法の検証は失敗側へ倒れるものの、原因が部品ではなく
 * 検証面にあることに気づけない（design「失敗モードと観測性」）。
 */
async function expectVerificationSurfaceSane(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport === null) {
    throw new Error('Playwright の viewport が未設定（モバイル幅の project で実行すること）');
  }
  const width = await page
    .locator('main')
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(
    width,
    `検証面の main の実幅が ${width}px しかない（端末幅 ${viewport.width}px）。` +
      'これは部品の欠陥ではなく検証面のレイアウトが壊れている状態で、この幅で測った' +
      'タッチ操作領域は実態を表さない。検証面のコンテナ幅の指定と、トークンスケールの' +
      '解決先を検証する @fwlm/ui の token-scales を確認すること',
  ).toBeGreaterThanOrEqual(viewport.width * 0.8);
}

interface FocusIndicator {
  tag: string;
  name: string;
  focusVisible: boolean;
  outlineStyle: string;
  outlineWidth: number;
  outlineColor: string;
  boxShadow: string;
}

// 現在フォーカスされている要素の可視表示を計算済みスタイルから読み取る。
// フォーカスが body / html へ抜けた（＝たどれる要素が尽きた）場合は null を返す。
function readFocusIndicator(page: Page): Promise<FocusIndicator | null> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (el === null || el === document.body || el === document.documentElement) return null;
    const style = getComputedStyle(el);
    return {
      tag: el.tagName,
      name: el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 24),
      focusVisible: el.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      outlineColor: style.outlineColor,
      boxShadow: style.boxShadow,
    };
  });
}

// requirements 5.3: キーボードフォーカス時に視認可能なフォーカス表示を提示する。
test('キーボードでたどった操作可能要素すべてに可視フォーカス表示が出る', async ({ page }) => {
  await openSurveySurface(page);
  const firstStar = page.getByRole('button', { name: '星1' });
  await expect(firstStar).toBeVisible();

  // 先頭の操作可能要素へキーボードで入る（プログラム的 focus では :focus-visible が付かない）。
  await page.keyboard.press('Tab');
  await expect(firstStar).toBeFocused();

  const checked: string[] = [];
  for (let i = 0; i < MAX_TAB_STEPS; i += 1) {
    const indicator = await readFocusIndicator(page);
    if (indicator === null) break; // たどれる要素が尽きた
    const where = `${indicator.tag}(${indicator.name})`;

    expect(indicator.focusVisible, `${where} が :focus-visible に一致しない`).toBe(true);
    const outlineVisible =
      indicator.outlineStyle !== 'none' &&
      indicator.outlineWidth > 0 &&
      !TRANSPARENT.test(indicator.outlineColor);
    expect(
      outlineVisible || indicator.boxShadow !== 'none',
      `${where} に可視フォーカス表示が無い: ${JSON.stringify(indicator)}`,
    ).toBe(true);

    checked.push(where);
    await page.keyboard.press('Tab');
  }

  // 空振り緑の防止: 星5個＋一言 textarea＋送信ボタンまで実際にたどれていること。
  const trail = `たどれた操作可能要素: ${checked.join(', ')}`;
  expect(checked.length, trail).toBeGreaterThanOrEqual(7);
  expect(
    checked.some((w) => w.includes('送信する')),
    trail,
  ).toBe(true);
});

// requirements 5.3 / Issue #49: @fwlm/ui の部品そのものに可視フォーカス表示が出る。
//
// 上のテストが走査する回答画面は素の <button> / <textarea> / <input> で構成されており、
// @fwlm/ui の部品を一度も通っていない。そのため「部品が base レイヤのフォーカス既定を
// outline を打ち消すユーティリティで無効化していた」欠陥（Issue #49）を検出できなかった。
// ここでは部品を実描画する検証面（/ui-check）を的にして、同じ実測ロジックを部品経路へ通す。
test('@fwlm/ui の対話的部品すべてに可視フォーカス表示が出る', async ({ page }) => {
  await openComponentCatalog(page);
  const firstButton = page.getByRole('button', { name: '既定のボタン' });
  await expect(firstButton).toBeVisible();

  await page.keyboard.press('Tab');
  await expect(firstButton).toBeFocused();

  const checked: string[] = [];
  for (let i = 0; i < MAX_TAB_STEPS; i += 1) {
    const indicator = await readFocusIndicator(page);
    if (indicator === null) break;
    const where = `${indicator.tag}(${indicator.name})`;

    expect(indicator.focusVisible, `${where} が :focus-visible に一致しない`).toBe(true);
    // フォーカス表示は theme.css の base レイヤの outline に一本化されているため、
    // box-shadow による代替は認めず outline が実際に描画されていることを要求する
    // （リングでの代替を許すと、2.08:1 の薄いリングでも緑になってしまう）。
    expect(
      indicator.outlineStyle !== 'none',
      `${where} の outline が無効化されている: ${JSON.stringify(indicator)}`,
    ).toBe(true);
    expect(
      indicator.outlineWidth,
      `${where} の outline 幅が 0: ${JSON.stringify(indicator)}`,
    ).toBeGreaterThan(0);
    expect(
      TRANSPARENT.test(indicator.outlineColor),
      `${where} の outline が透明: ${JSON.stringify(indicator)}`,
    ).toBe(false);

    checked.push(where);
    await page.keyboard.press('Tab');
  }

  // 空振り緑の防止: ボタン 6 種＋入力 2 種＋チェックボックス＋ラジオまでたどれていること。
  const trail = `たどれた操作可能要素: ${checked.join(', ')}`;
  expect(checked.length, trail).toBeGreaterThanOrEqual(10);
  // 打ち切りの検出: 上限で止まった場合、その先の要素は一度も検査されないまま緑になる。
  // 検証面へ部品を足し続けると静かに起こるので、上限に触れたこと自体を失敗として扱う。
  expect(
    checked.length,
    `巡回が上限（${MAX_TAB_STEPS}）で打ち切られた。上限より先の操作可能要素は` +
      `フォーカス可視性を検査されていない。${trail}`,
  ).toBeLessThan(MAX_TAB_STEPS);
  expect(
    checked.some((w) => w.includes('破壊的なボタン')),
    `destructive variant に到達していない。${trail}`,
  ).toBe(true);
  expect(
    checked.some((w) => w.includes('複数行入力')),
    `Textarea に到達していない。${trail}`,
  ).toBe(true);
});

// Requirements 5.2 / PR #56 レビュー指摘1: 変種の状態色が説明文まで実描画で届く。
//
// なぜクラス名の検証では足りないか:
// AlertDescription は自身に text-muted-foreground を持つため、親 variant が子孫指定で色を
// 渡さない限り説明文は灰色で描画される。それでも親のクラス集合は壊れないので、jsdom での
// クラス assert も含めた既存の静的検証は全て緑のまま通る。ここでは実際に描かれた色を測る。
test('Alert の説明文に変種の状態色が実描画で届いている', async ({ page }) => {
  await openComponentCatalog(page);
  // role で引かないこと。読み上げ強度は変種ごとに変わる（destructive のみ alert・それ以外は
  // status）ため、role で引くと variant によって取れたり取れなかったりする（ui-a11y-gaps 要件 3.1）。
  const alerts = page.locator('[data-slot="alert"]');
  await expect(alerts.filter({ hasText: '成功の通知' })).toBeVisible();

  const partOf = (heading: string, slot: string): Locator =>
    alerts.filter({ hasText: heading }).locator(`[data-slot="alert-${slot}"]`);

  // 既定の変種の説明文＝状態色が届いていないときに出るはずの色。基準として先に測る。
  const baseline = await readRenderedColors(partOf('お知らせ', 'description'));
  expect(baseline.color, '既定の説明文の色を実測できない').not.toBeNull();

  for (const heading of ['成功の通知', 'エラーの通知']) {
    const container = await readRenderedColors(alerts.filter({ hasText: heading }));
    const title = await readRenderedColors(partOf(heading, 'title'));
    const description = await readRenderedColors(partOf(heading, 'description'));

    expect(description.color, `${heading}: 説明文の色を実測できない`).not.toBeNull();
    expect(container.backgroundColor, `${heading}: 下地の色を実測できない`).not.toBeNull();

    expect(
      description.color,
      `${heading}: 説明文が既定の色（${baseline.color ?? '不明'}）のまま描画されている。` +
        '変種の状態色が説明文へ届いていない',
    ).not.toBe(baseline.color);
    expect(
      description.color,
      `${heading}: 説明文（${description.color ?? '不明'}）が見出し（${title.color ?? '不明'}）と別色で描画されている`,
    ).toBe(title.color);

    const ratio = contrastRatio(description.color ?? '#000000', container.backgroundColor ?? '#000000');
    expect(
      ratio,
      `${heading}: 説明文 ${description.color ?? '不明'} on ${container.backgroundColor ?? '不明'} → ` +
        `${ratio.toFixed(3)}:1（要求 ${AA_NORMAL_TEXT_RATIO}:1）`,
    ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_RATIO);
  }
});

// Requirements 5.2 / PR #56 レビュー指摘2: color-mix() の合成後の実効色を実ブラウザで測る。
//
// color-mix は oklab / oklch 等の色空間で合成されるため hex ベースの静的計算ができない。
// ui 側の許可リストは「実測した実効色」を持ち、その値でコントラストを数値検証している。
// ここでその実測値が今も実描画と一致することを確かめ、トークンや式の変更で許可リストの値が
// 古くなった場合に必ず赤化させる（誰も検証していない自由記述に戻さない）。
test.describe('color-mix の実効色（ポインタのある環境）', () => {
  // Tailwind の hover: は `@media (hover: hover)` に展開されるため、タッチ端末を模した
  // 既定の project（Pixel 5）では hover のスタイルが一切適用されない（実測で確認済み）。
  // hover の色を測るにはポインタのある文脈が要るので、このテストだけ touch 模擬を外す。
  // 裏を返せば、この hover 色は実機のスマートフォンでは描画されない。
  test.use({ isMobile: false, hasTouch: false });

  test('secondary ボタン hover の色が許可リストの実測値と一致する', async ({ page }) => {
    const entry = colorMixAllowlist.find((candidate) => candidate.file === 'button.tsx');
    expect(entry, 'button.tsx の color-mix が許可リストにない').toBeDefined();

    await openComponentCatalog(page);
    const secondary = page.getByRole('button', { name: '副次のボタン' });
    await expect(secondary).toBeVisible();
    expect(
      await page.evaluate(() => matchMedia('(hover: hover)').matches),
      'ポインタのない文脈で実行されている（hover のスタイルが適用されず空振りする）',
    ).toBe(true);

    await secondary.hover();

    // 部品は transition-all を持つため hover 直後は遷移の途中の色が読める。
    // 遷移が終わって色が落ち着くまで待つ（失敗時は最後に読めた実測値がメッセージに出る）。
    await expect
      .poll(async () => (await readRenderedColors(secondary)).backgroundColor, {
        message:
          'hover 後の背景（color-mix の合成後）が許可リストの measuredHex と一致しない。' +
          'トークンか式を変えたなら、実測した値を color-mix-allowlist.json へ反映すること',
        timeout: 5_000,
      })
      .toBe(entry!.measuredHex);

    const rendered = await readRenderedColors(secondary);
    const ratio = contrastRatio(rendered.color ?? '#000000', rendered.backgroundColor ?? '#000000');
    expect(
      ratio,
      `hover 中の secondary ボタン: 文字 ${rendered.color ?? '不明'} on ${rendered.backgroundColor ?? '不明'} → ` +
        `${ratio.toFixed(3)}:1（要求 ${AA_NORMAL_TEXT_RATIO}:1）`,
    ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_RATIO);
  });
});

// ui-a11y-gaps 要件 5.3: 実測の前提そのものを検証する。
//
// 以降のタッチ操作領域・動きの検証は、いずれもこの計測基盤の上に立つ。基盤が壊れたまま
// 「部品が要求を満たしていない」と報告すると原因の切り分けを誤らせるため、基盤の健全性を
// 独立したテストとして固定する。
test('実描画の計測基盤と検証面が実測の前提を満たしている', async ({ page }) => {
  await openComponentCatalog(page);

  // 前提 1: 検証面が端末幅どおりに描かれている。
  await expectVerificationSurfaceSane(page);

  // 前提 2: 拡張面を持つ部品で、見えている矩形と実効領域を区別して読める。
  // Checkbox は `::after` で操作領域だけを広げている既存例（要件 4.8 により現状維持）。
  const geometry = (await readTouchGeometries(page, '[data-slot="checkbox"]'))[0]!;
  expect(
    geometry.hasExpansion,
    `Checkbox の拡張面を読み取れていない: ${JSON.stringify(geometry)}`,
  ).toBe(true);
  expect(
    geometry.effective.height,
    `実効領域(${geometry.effective.height}px)が視覚領域(${geometry.visual.height}px)を超えていない`,
  ).toBeGreaterThan(geometry.visual.height);

  // 前提 3: 求めた幾何が実際に当たり判定を持つ（pointer-events の欠落・被覆を落とす）。
  // 拡張領域の左上の内側 1px を撃つ。本体の外側なので、拡張が効いていなければ別要素が返る。
  const corner = await readHitTarget(
    page,
    geometry.effective.left + 1,
    geometry.effective.top + 1,
  );
  expect(
    corner?.slot,
    `拡張領域の隅(${geometry.effective.left + 1}, ${geometry.effective.top + 1})で ` +
      `${JSON.stringify(corner)} が反応した。幾何は広いが当たり判定が無い`,
  ).toBe('checkbox');

  // 前提 4: 動きの実効値が読める。かつ「無いものを有ると言わない」。
  const button = page.getByRole('button', { name: '既定のボタン' });
  const motion = await readMotion(button);
  expect(
    motion.transitionDurationSeconds,
    `既定のボタンの遷移時間を読み取れていない: ${JSON.stringify(motion)}`,
  ).toBeGreaterThan(0);
  expect(
    motion.animationDurationSeconds,
    `アニメーションを持たない部品に時間が現れている: ${JSON.stringify(motion)}`,
  ).toBe(0);
});

// ui-a11y-gaps 要件 1.1 / 1.2 / 5.1: 動き低減設定を有効にした環境で動きが抑制される。
//
// この検証は生成 CSS の AST 検証（@fwlm/ui の app-integration.test.ts）と対になる。前者は
// 「抑制規則が base レイヤに important 付きで存在する」ことしか言えない。実際にレイヤ順が
// 逆転して utilities の animate-* / transition-* に勝っているかは実描画でしか確かめられない。
test.describe('動き低減設定が有効な環境', () => {
  // 動き低減の模擬は contextOptions 経由でしか渡せない（Playwright 1.61）。
  // `test.use({ reducedMotion: 'reduce' })` と書くと **黙って無視される**。未知のキーは
  // 素通りするうえ、e2e は tsconfig の exclude に入っており型検査もされないため、
  // 「設定したつもりで通常の文脈を測り、抑制が無くても緑」という空振りになる。
  // 下の matchMedia の assert はこの罠を実際に検出した安全網である。
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('無限アニメーションが停止し、状態遷移が知覚できない水準まで抑制される', async ({ page }) => {
    await openComponentCatalog(page);

    // 空振り防止その1: 動き低減が実際に模擬されている文脈で測っていること。
    // これが偽なら抑制規則は最初から適用対象外であり、以降の assert は実装ではなく
    // テスト環境を測っていることになる（hover の検証で同じ罠を踏んだ前例がある）。
    expect(
      await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
      '動き低減が模擬されていない文脈で実行されている（抑制規則が適用対象外になり空振りする）',
    ).toBe(true);

    const animated = await readAnimatedElements(page);
    // 空振り防止その2: そもそもアニメーションを持つ要素が面から消えていたら検証は無意味。
    expect(
      animated.length,
      'アニメーションを持つ要素が検証面に 1 つも無い。抑制が効いたのではなく検証対象が' +
        '失われている可能性がある（Spinner が検証面から消えていないか確認すること）',
    ).toBeGreaterThan(0);

    for (const element of animated) {
      expect(
        element.animationIterationCount,
        `${element.slot ?? element.animationName}: 反復回数が ${element.animationIterationCount} のまま。` +
          '無限に繰り返すアニメーションが停止していない',
      ).toBe('1');
      expect(
        element.animationDurationSeconds,
        `${element.slot ?? element.animationName}: アニメーション時間が ` +
          `${element.animationDurationSeconds}s（要求 ${IMPERCEPTIBLE_SECONDS}s 以下）`,
      ).toBeLessThanOrEqual(IMPERCEPTIBLE_SECONDS);
    }

    // 状態遷移（transition）も同様に抑制されていること。
    const transitioning = ['既定のボタン', '副次のボタン'];
    for (const name of transitioning) {
      const motion = await readMotion(page.getByRole('button', { name }));
      expect(
        motion.transitionDurationSeconds,
        `${name}: 遷移時間が ${motion.transitionDurationSeconds}s のまま` +
          `（要求 ${IMPERCEPTIBLE_SECONDS}s 以下）。base レイヤの抑制が utilities に負けている`,
      ).toBeLessThanOrEqual(IMPERCEPTIBLE_SECONDS);
    }
  });

  // 要件 2.1: 動きを止めたなら、動きに依存しない手段で処理中であることを伝える。
  // 止めただけでは「画面が固まったのか処理中なのか」が判断できなくなる。
  test('処理中表示が動きに依存しない可視の手掛かりを提示する', async ({ page }) => {
    await openComponentCatalog(page);
    await expect(page.locator('[data-slot="spinner"]').first()).toBeVisible();
    expect(
      await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
      '動き低減が模擬されていない文脈で実行されている',
    ).toBe(true);

    const cue = await readSpinnerTextCue(page);
    expect(
      cue.present,
      '処理中表示に文言が無く、静止した図形だけになっている。動きを止めた環境では' +
        '「処理中」なのか「画面が固まった」のかを判別できない',
    ).toBe(true);
    expect(
      cue.width,
      `処理中の文言「${cue.text}」が実描画で ${cue.width}px しかない（読み上げ専用のまま可視化されていない）`,
    ).toBeGreaterThan(8);
  });
});

// 要件 1.3: 設定が無効な環境では現在の動きの表現を変更しない（非後退）。
test.describe('動き低減設定が無効な環境', () => {
  test.use({ contextOptions: { reducedMotion: 'no-preference' } });

  test('従来どおりの動きが維持される', async ({ page }) => {
    await openComponentCatalog(page);

    // 対照側でも文脈を確かめる。両側が同じ文脈で走っていたら比較は無意味になる。
    expect(
      await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
      '動き低減が模擬された文脈で「無効時」の検証を実行している',
    ).toBe(false);

    const animated = await readAnimatedElements(page);
    expect(
      animated.some(
        (element) =>
          element.animationIterationCount === 'infinite' &&
          element.animationDurationSeconds > IMPERCEPTIBLE_SECONDS,
      ),
      `無限アニメーションが失われている: ${JSON.stringify(animated)}。` +
        '抑制が動き低減設定と無関係に適用されている疑いがある',
    ).toBe(true);

    const motion = await readMotion(page.getByRole('button', { name: '既定のボタン' }));
    expect(
      motion.transitionDurationSeconds,
      `既定のボタンの遷移時間が ${motion.transitionDurationSeconds}s まで縮んでいる`,
    ).toBeGreaterThan(IMPERCEPTIBLE_SECONDS);
  });

  // 要件 1.3 / 2.1 の裏側: 代替表現は動き低減時にだけ現れること。
  // 常時露出すると、動きが十分な環境でも表示が変わってしまう（非後退の違反）。
  test('処理中表示の代替文言が露出しない', async ({ page }) => {
    await openComponentCatalog(page);
    await expect(page.locator('[data-slot="spinner"]').first()).toBeVisible();

    const cue = await readSpinnerTextCue(page);
    expect(
      cue.width,
      `動き低減が無効な環境で処理中の文言「${cue.text}」が ${cue.width}px 描画されている。` +
        '代替表現は動き低減時にだけ現れること',
    ).toBeLessThanOrEqual(2);
  });
});

// 要件 1.4: 動き低減設定の有無にかかわらず、状態変化の結果として到達する見た目を同一に保つ。
//
// 動きを消すことと状態を消すことは別である。抑制の対象を transition-property や transform まで
// 広げると、押下時の沈み込みという「動きではなく状態」が失われ、押した手応えが消える。
// 1 つのテストの中で両設定の文脈を作って突き合わせる（describe をまたぐと比較できないため）。
test('押下時に到達する見た目が動き低減の有無で変わらない', async ({ browser }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;

  const pressedShiftUnder = async (
    reducedMotion: 'reduce' | 'no-preference',
  ): Promise<number> => {
    const context = await browser.newContext({
      ...devices['Pixel 5'],
      baseURL,
      reducedMotion,
    });
    try {
      const page = await context.newPage();
      await openComponentCatalog(page);
      // 文脈が本当に切り替わっていることを確かめる（両側が同じ文脈なら比較は無意味）。
      expect(
        await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
        `${reducedMotion} の文脈を作れていない`,
      ).toBe(reducedMotion === 'reduce');
      return await readPressedShift(page, '既定のボタン');
    } finally {
      await context.close();
    }
  };

  const suppressed = await pressedShiftUnder('reduce');
  const normal = await pressedShiftUnder('no-preference');

  expect(
    suppressed,
    `押下時の到達位置が設定で変わっている（動き低減時 ${suppressed}px / 通常時 ${normal}px）。` +
      '抑制の対象が動きの「経過」を超えて「到達状態」まで及んでいる',
  ).toBeCloseTo(normal, 1);
});

// ui-a11y-gaps 要件 4.1 / 4.2 / 5.3: 指で押せる大きさを実描画で保証する。
//
// 本プロダクトの主動線は QR → モバイル → LIFF であり、利用者は IT に不慣れであることが前提
// （steering product.md）。押し損ねは離脱に直結するが、押しにくさは誰も報告しないため、
// 実測でしか守れない。
test('押しボタンの操作領域が寸法区分ごとの要求値を満たす', async ({ page }) => {
  await openComponentCatalog(page);
  // 検証面が潰れていると寸法の検証は「部品の欠陥」に見える失敗をする。先に切り分ける。
  await expectVerificationSurfaceSane(page);

  const buttons = await readTouchGeometries(page, '[data-slot="button"]');
  expect(
    buttons.length,
    '押しボタンを 1 つも実測できていない（検証面から部品が消えている）',
  ).toBeGreaterThan(0);

  // 空振り防止: 既定寸法と縮小寸法の **両方** が検証面に実在していること。
  // 片方しか無いと、もう片方の要求値は誰にも試されないまま緑になる。
  const measured = buttons.map((button) => BUTTON_TOUCH_REQUIREMENT[button.size ?? '']);
  expect(
    measured.includes(TOUCH_TARGET_DEFAULT_PX),
    `既定寸法の押しボタンが検証面に無い（実測できた区分: ${buttons.map((b) => b.size).join(', ')}）`,
  ).toBe(true);
  expect(
    measured.includes(TOUCH_TARGET_COMPACT_PX),
    `縮小寸法の押しボタンが検証面に無い（実測できた区分: ${buttons.map((b) => b.size).join(', ')}）`,
  ).toBe(true);

  for (const button of buttons) {
    const required = BUTTON_TOUCH_REQUIREMENT[button.size ?? ''];
    expect(
      required,
      `寸法区分 ${button.size ?? '（無し）'}（${button.name}）に要求値の宣言がありません。` +
        'BUTTON_TOUCH_REQUIREMENT へ追記してください',
    ).toBeDefined();
    expect(
      button.effective.height,
      `${button.name}（区分 ${button.size ?? '不明'}）の操作領域の高さが ` +
        `${button.effective.height}px（要求 ${required}px・視覚寸法は ${button.visual.height}px）`,
    ).toBeGreaterThanOrEqual(required!);
    expect(
      button.effective.width,
      `${button.name}（区分 ${button.size ?? '不明'}）の操作領域の幅が ` +
        `${button.effective.width}px（要求 ${required}px・視覚寸法は ${button.visual.width}px）`,
    ).toBeGreaterThanOrEqual(required!);
  }
});

// 要件 4.5: 拡張した操作領域が隣接部品の視覚領域を覆わない。
//
// 「まったく重ならない」ことは要求しない。部品間の余白の中で拡張どうしが接することは、
// そこに利用者の意図が定義できない以上あってよい。**害があるのは、見えている部品を指したのに
// 別の部品が反応する場合だけ**であり、それは「拡張が隣の視覚領域を覆う」ことと同値である。
test('拡張した操作領域が隣接部品の視覚領域を覆わない', async ({ page }) => {
  await openComponentCatalog(page);
  await expectVerificationSurfaceSane(page);

  const operables = await readTouchGeometries(page, OPERABLE_SELECTOR);
  const expanded = operables.filter((item) => item.hasExpansion);
  // 空振り防止 1: 宣言した種別がすべて検証面に実在すること。選択子へ足しても検証面へ
  // 置き忘れると、その部品は一度も測られないまま緑になる（PR #180 レビュー指摘 1）。
  // 型検査は「宣言から漏れた部品」を捕まえるが、「宣言はあるが実在しない部品」は捕まえない。
  const measuredSlots = new Set(operables.map((item) => item.slot));
  const absentSlots = OPERABLE_SLOTS.filter((slot) => !measuredSlots.has(slot));
  expect(
    absentSlots,
    `指で操作する部品が検証面に無い（${absentSlots.join(', ')}）。この判定の射程が宣言より狭い`,
  ).toEqual([]);

  // 空振り防止 2: 拡張を持つ部品がゼロなら「覆っていない」は自明に成立する。
  expect(
    expanded.length,
    '操作領域を拡張している部品が 1 つも無い。この判定は拡張が存在して初めて意味を持つ',
  ).toBeGreaterThan(0);

  for (const source of expanded) {
    for (const other of operables) {
      if (other === source) continue;
      expect(
        intersects(source.effective, other.visual),
        `${source.name} の操作領域 ${JSON.stringify(source.effective)} が ` +
          `${other.name} の見えている領域 ${JSON.stringify(other.visual)} を覆っています。` +
          '見えている部品を指したのに別の部品が反応する状態です',
      ).toBe(false);
    }
  }
});

// 要件 4.2 / 4.6 / 4.8: 拡張を掛けない側が下限を割っていないこと（現状維持の非後退）。
test('選択部品と複数行入力の操作領域が下限を維持している', async ({ page }) => {
  await openComponentCatalog(page);
  await expectVerificationSurfaceSane(page);

  const selectables = await readTouchGeometries(
    page,
    '[data-slot="checkbox"], [data-slot="radio-group-item"]',
  );
  expect(selectables.length, '選択部品を実測できていない').toBeGreaterThan(0);
  for (const item of selectables) {
    for (const [axis, value] of [
      ['高さ', item.effective.height],
      ['幅', item.effective.width],
    ] as const) {
      expect(
        value,
        `${item.slot ?? '選択部品'}（${item.name}）の操作領域の${axis}が ${value}px` +
          `（下限 ${TOUCH_TARGET_COMPACT_PX}px）`,
      ).toBeGreaterThanOrEqual(TOUCH_TARGET_COMPACT_PX);
    }
  }

  // 複数行入力は変更を加えずに要求値を満たし続けること（要件 4.6）。
  const textareas = await readTouchGeometries(page, '[data-slot="textarea"]');
  expect(textareas.length, '複数行入力を実測できていない').toBeGreaterThan(0);
  for (const item of textareas) {
    expect(
      item.effective.height,
      `複数行入力の操作領域の高さが ${item.effective.height}px へ縮んでいる` +
        `（要求 ${TOUCH_TARGET_DEFAULT_PX}px・本部品は変更対象外）`,
    ).toBeGreaterThanOrEqual(TOUCH_TARGET_DEFAULT_PX);
  }
});

// 要件 4.7: ラベルを伴う構成では、ラベルを含む行全体で 44px を満たす。
test('ラベルを伴う行が要求寸法を満たす', async ({ page }) => {
  await openComponentCatalog(page);
  await expectVerificationSurfaceSane(page);

  const rows = await readTouchGeometries(page, LABELLED_ROW_SELECTOR);
  // 空振り防止: 内容が短い構成が実在すること。内容が長ければ行は自然に 44px を超えるため、
  // 「最小高が効いているか」は短い構成でしか試されない。
  expect(
    rows.length,
    'ラベルを伴う構成が検証面に無い（要件 4.7 の検証対象が存在しない）',
  ).toBeGreaterThanOrEqual(3);

  for (const row of rows) {
    expect(
      row.effective.height,
      `ラベルを含む行「${row.name}」の高さが ${row.effective.height}px` +
        `（要求 ${TOUCH_TARGET_DEFAULT_PX}px）。テキスト入力と選択部品の 44px は` +
        'この行で満たす前提になっている',
    ).toBeGreaterThanOrEqual(TOUCH_TARGET_DEFAULT_PX);
  }
});

// 要件 4.7 の後半: 行を指した結果、対応する部品が実際に反応すること。
// 高さだけを満たしても、押して何も起きなければ「操作領域」とは呼べない。
test('ラベル領域の指定で対応する部品が反応する', async ({ page }) => {
  await openComponentCatalog(page);

  // テキスト入力: ラベル文字の指定でフォーカスが移る。
  await page.getByText('ラベル付き入力', { exact: true }).click();
  expect(
    await page.evaluate(() => document.activeElement?.getAttribute('data-slot') ?? null),
    'ラベル文字を指してもテキスト入力へフォーカスが移らない',
  ).toBe('input');

  // チェックボックス: ラベル文字の指定で選択状態が変わる。
  const checkRow = page.locator('[data-slot="field-label"]', { hasText: 'ラベル付きチェック' });
  const checkbox = checkRow.locator('[data-slot="checkbox"]');
  expect(await checkbox.getAttribute('aria-checked')).toBe('false');
  await checkRow.getByText('ラベル付きチェック').click();
  expect(
    await checkbox.getAttribute('aria-checked'),
    'ラベル文字を指してもチェックボックスが反応しない',
  ).toBe('true');

  // ラジオ: ラベル文字の指定で当該項目が選ばれる。
  const betaRow = page.locator('[data-slot="field-label"]', { hasText: '選択肢ベータ' });
  const beta = betaRow.locator('[data-slot="radio-group-item"]');
  expect(await beta.getAttribute('aria-checked')).toBe('false');
  await betaRow.getByText('選択肢ベータ').click();
  expect(
    await beta.getAttribute('aria-checked'),
    'ラベル文字を指してもラジオが当該項目へ反応しない',
  ).toBe('true');
});

// ---------------------------------------------------------------------------
// 非テキストコントラスト（WCAG 2.1 SC 1.4.11）の実描画検証。
// spec form-non-text-contrast タスク 4.2 / design.md「Testing Strategy — E2E Tests」1〜4。
//
// なぜ実描画でなければならないか:
// 枠色は「クラス名 → 意味論変数 → 役割トークン」の 3 段を経て決まり、状態依存の指定
// （aria-invalid / data-checked / has-data-checked）は**詳細度の勝敗で最終的な色が決まる**。
// クラス集合の検証はどのクラスが付いているかしか見ないため、どれが実際に勝ったかを証明できない。
// ここでの実測がその唯一の実証手段である。
// ---------------------------------------------------------------------------

// Requirements 1.1 / 1.2: 既定状態のフォーム部品の枠が、フォーカスを当てずに 3:1 以上で識別できる。
test('既定状態のフォーム部品の枠がフォーカスなしで 3:1 以上で描画される', async ({ page }) => {
  await openComponentCatalog(page);
  await expect(page.getByRole('textbox', { name: '一行入力' })).toBeVisible();

  const pageBackground = await readPageBackground(page);

  // 要件 1.2 は「フォーカス指標に依存せずに識別可能」を課す。この test は測定対象を一度も
  // クリック・フォーカスしない。前提が崩れていないことを頁全体でも確認する
  // （何かがフォーカスされていれば、測っているのはフォーカス時の色かもしれない）。
  expect(
    await page.evaluate(() => document.activeElement === document.body),
    '測定前に何かがフォーカスされている。要件 1.2 の「フォーカスを当てずに」が成立していない',
  ).toBe(true);

  const targets: ReadonlyArray<readonly [string, Locator]> = [
    ['一行入力（Input）', page.getByRole('textbox', { name: '一行入力' })],
    ['複数行入力（Textarea）', page.getByRole('textbox', { name: '複数行入力' })],
    ['チェックボックス（Checkbox）', page.getByRole('checkbox', { name: 'チェックボックス' })],
    // ラジオ1 は defaultValue で選択済みのため、既定状態の枠を測る的にはならない。
    ['ラジオ2（RadioGroupItem・未選択）', page.getByRole('radio', { name: 'ラジオ2' })],
    // 選択部品は一行入力と同じ枠色を使う（Issue #174 / spec ui-airbnb-foundation 6.3）。
    // 同じ変数を読んでいるという理由で検証を省くと、包む要素の追加や上書きで枠色が
    // 変わったときに誰も気づけない。実描画で測る対象として並べる。
    ['表示順の指定（Select）', page.getByRole('combobox', { name: '表示順の指定' })],
  ];

  for (const [where, locator] of targets) {
    const rendered = await readRenderedBorder(locator, where);
    expect(rendered.focused, `${where}: 測定対象がフォーカスされている`).toBe(false);
    expectNonTextContrast(rendered.borderColor as string, pageBackground, where);
  }
});

// Requirements 2.1 / 2.3: 選択状態の表示が 3:1 以上で、かつ未選択とは別色で描画される。
test('選択状態の枠が 3:1 以上かつ未選択と別色で描画される', async ({ page }) => {
  await openComponentCatalog(page);
  const selected = page.getByTestId('wrapped-choice-checked');
  const unselected = page.getByTestId('wrapped-choice-unchecked');
  await expect(selected).toBeAttached();
  await expect(unselected).toBeAttached();

  const pageBackground = await readPageBackground(page);

  // 選択枠の指定（has-data-checked:）は「ラベル領域が選択肢を直下に内包する」構造でしか
  // 発火しない。平坦化すると色が変わるのではなく枠幅が 0 になって消えるため、
  // readRenderedBorder の幅の assert が空振りを捕まえる。
  const selectedBorder = await readRenderedBorder(selected, '囲み枠の選択済み');
  expectNonTextContrast(selectedBorder.borderColor as string, pageBackground, '囲み枠の選択済み');

  // 未選択側は装飾用の枠のままであり、要件が 3:1 を課すのは選択状態のみ（Requirements 2.1）。
  // ここでは「選択状態を示す視覚情報が未選択では出ていない」ことの相手として使う（要件 2.3）。
  const unselectedBorder = await readRenderedBorder(unselected, '囲み枠の未選択');
  expect(
    selectedBorder.borderColor,
    `選択済み（${selectedBorder.borderColor ?? '不明'}）と未選択（${unselectedBorder.borderColor ?? '不明'}）が` +
      '同色で描画されている。選択状態が枠で識別できない',
  ).not.toBe(unselectedBorder.borderColor);
});

// Requirements 3.4: エラー状態の枠が隣接背景に対し 3:1 以上で描画される。
test('エラー状態の枠が 3:1 以上で描画される', async ({ page }) => {
  await openComponentCatalog(page);
  await expect(page.getByRole('textbox', { name: 'エラーの記入欄' })).toBeVisible();

  const pageBackground = await readPageBackground(page);

  const targets: ReadonlyArray<readonly [string, Locator]> = [
    ['エラーの記入欄（Input）', page.getByRole('textbox', { name: 'エラーの記入欄' })],
    ['エラーの確認欄（Checkbox）', page.getByRole('checkbox', { name: 'エラーの確認欄' })],
  ];

  for (const [where, locator] of targets) {
    const rendered = await readRenderedBorder(locator, where);
    // 3:1 だけを見ると、エラー枠が識別用の枠色（4.542:1）へ黙って戻っても緑になる。
    // 測っている枠が確かにエラーの視覚情報であることをトークンの値で固定する。
    expect(
      rendered.borderColor,
      `${where}: 枠がエラー色で描画されていない（実測 ${rendered.borderColor ?? '不明'}）`,
    ).toBe(colors.destructive);
    expectNonTextContrast(rendered.borderColor as string, pageBackground, where);
  }
});

// Requirements 3.4（および 3.1〜3.3）: エラーかつチェック済みの枠がエラー色を保つ。
//
// 本仕様の是正の核心。複合指定（属性セレクタ 2 個分の詳細度）が、選択状態を条件にする単一指定に
// 実描画で実際に勝つことを示す。クラス集合の検証では「どちらのクラスも付いている」ことまでしか
// 分からず、詳細度の破綻はここでしか捕捉できない（tasks.md「3.3 → 4.2 への申し送り」）。
test('エラーかつチェック済みの枠がエラー色で描画され選択色でない', async ({ page }) => {
  await openComponentCatalog(page);

  // 対照: エラーでないチェック済みの枠は選択色である。これが選択色でなければ、
  // 下の「エラー色である」は詳細度の勝敗と無関係に成立してしまい実証にならない。
  const checkedOnly = await readRenderedBorder(
    page.getByRole('checkbox', { name: 'チェック済みの確認欄' }),
    'チェック済みの確認欄',
  );
  expect(
    checkedOnly.borderColor,
    `対照が成立していない: エラーでないチェック済みの枠が選択色で描画されていない（実測 ${checkedOnly.borderColor ?? '不明'}）`,
  ).toBe(colors.primary);

  const composite = await readRenderedBorder(
    page.getByRole('checkbox', { name: 'エラー重畳の確認欄' }),
    'エラー重畳の確認欄',
  );
  expect(
    composite.borderColor,
    `エラーかつチェック済みの枠がエラー色で描画されていない（実測 ${composite.borderColor ?? '不明'}）。` +
      '選択状態の指定が詳細度で勝っており、目で見ている利用者にだけエラーが伝わらない',
  ).toBe(colors.destructive);
  expect(
    composite.borderColor,
    'エラーかつチェック済みの枠が選択色で描画されている（是正前の症状）',
  ).not.toBe(colors.primary);

  // 空振り防止: 対象が実際にチェック済みでなければ、上の assert は aria-invalid 単独の指定でも
  // 通ってしまい「複合指定が勝った」ことの証明にならない。選択済みであることを担う面塗り
  // （要件 3.3: 選択済みは面塗りと印、エラーは枠が担う）を同時に実測する。
  expect(
    composite.backgroundColor,
    `エラー重畳の確認欄が選択色で塗られていない（実測 ${composite.backgroundColor ?? '不明'}）。` +
      'チェック済みになっておらず、枠色の測定が複合指定を通っていない',
  ).toBe(colors.primary);
});

// Requirements 4.2: 装飾用の罫線が識別用へ巻き込まれず現在の値のまま描画される。
// Issue #174 / spec ui-airbnb-foundation タスク 8.1: 追加した共通部品の意匠を実描画で固定する。
//
// クラス名の照合で代替しない。余白も罫線も「そう書いてあるのに効いていない」が起こりうる
// （余白は名前付きスケールが別スケールに覆われれば静かに潰れ、罫線は色だけが装飾用から
// 識別用へ振り替わっても集合は無傷である）。
test('表のセル余白と行の区切りが意匠のとおりに実描画される', async ({ page }) => {
  await openComponentCatalog(page);
  // 検証面には表が 2 つある（意匠を測る的と、横溢れを発火させる的）。**測る側を名前で選ぶ。**
  // `.first()` に頼ると、面へ表を足した順序が変わっただけで測る対象が黙って入れ替わる。
  const catalogue = page.getByRole('region', { name: '区分ごとの個数' });
  await expect(catalogue.getByRole('table')).toBeVisible();

  const cell = catalogue.locator('[data-slot="table-cell"]').first();
  const padding = await cell.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      top: style.paddingTop,
      right: style.paddingRight,
      bottom: style.paddingBottom,
      left: style.paddingLeft,
    };
  });
  expect(
    padding,
    `セル余白が意匠の 16px と食い違う（実測 ${JSON.stringify(padding)}）`,
  ).toEqual({ top: '16px', right: '16px', bottom: '16px', left: '16px' });

  // 区切りは 1px の罫線のみ。最終行は罫線を持たないので、本体の先頭行で測る。
  const row = catalogue.locator('[data-slot="table-body"] > [data-slot="table-row"]').first();
  const stroke = await row.evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: Number.parseFloat(style.borderBottomWidth), style: style.borderBottomStyle };
  });
  expect(stroke.style, '行の区切りが実線で描かれていない').toBe('solid');
  expect(stroke.width, '行の区切りが描画されていない（幅 0）').toBeGreaterThan(0);
  expect(stroke.width, '行の区切りが 1px の罫線より太い').toBeLessThanOrEqual(1);

  const rendered = await readRenderedColors(row);
  expect(
    rendered.borderColor,
    `行の区切りが装飾用の値で描画されていない（実測 ${rendered.borderColor ?? '不明'}）`,
  ).toBe(colors.border);
  expect(
    rendered.borderColor,
    '行の区切りが識別用の枠色へ巻き込まれている（区切りは情報を持たない装飾である）',
  ).not.toBe(colors.borderInteractive);

  // 交互の背景も行の面塗りも使わない。
  //
  // **`readRenderedColors` の null を「塗られていない」の証明に使わない**（PR #180 レビュー指摘 2）。
  // あの関数は alpha < 1 を一律 null で返す契約であり（「その要素では色が決まらない」の意）、
  // `odd:bg-muted/50` のような半透明の縞模様まで null になって緑で通る（実測で対照を取った）。
  // しかも `bg-muted/50` は CardFooter 由来で USAGE_PAIRS に登録済みのため、色ユーティリティの
  // 網羅ガード（ユーティリティ単位）にも掛からない。不在を主張する側は、合成前の alpha を直接見る。
  const rowFill = (await readRenderedLayers(row)).backgroundColor;
  expect(
    rowFill.alpha,
    `行に面塗りが入っている（縞模様・可動感の誤提示・実測 ${rowFill.hex} / alpha ${rowFill.alpha}）`,
  ).toBe(0);

  // 横溢れの捲りを担う容器がキーボードで焦点を得られること（WCAG 2.1.1・レビュー指摘 3）。
  // 焦点を取れないスクロール領域は、走査領域を自動で焦点可能にしないブラウザで
  // キーボードのみの利用者から隠れた列を奪う。セルに焦点可能な要素があるとは限らないため、
  // 容器そのものが到達点でなければならない。宣言（tabindex）ではなく実際に焦点が載ることを見る。
  await catalogue.focus();
  expect(
    await page.evaluate(() => document.activeElement?.getAttribute('data-slot') ?? null),
    '横溢れの捲りを担う容器へ焦点が載らない（キーボードのみの利用者が隠れた列へ到達できない）',
  ).toBe('table-container');
});

test('ページ枠の版面が名前付きスケールで解決され、実効内容幅が狭く潰れていない', async ({
  page,
}) => {
  await openComponentCatalog(page);
  await expectVerificationSurfaceSane(page);

  const shell = page.locator('[data-slot="page-shell"]');
  await expect(shell).toHaveCount(1);
  expect(
    await shell.evaluate((element) => element.tagName),
    '検証面のルートがページ枠の部品になっていない（主要領域が二重になっている疑い）',
  ).toBe('MAIN');

  const viewport = page.viewportSize();
  if (viewport === null) {
    throw new Error('Playwright の viewport が未設定（モバイル幅の project で実行すること）');
  }
  const metrics = await shell.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      maxWidth: style.maxWidth,
      paddingLeft: Number.parseFloat(style.paddingLeft),
      paddingRight: Number.parseFloat(style.paddingRight),
      width: element.getBoundingClientRect().width,
    };
  });

  // 狭い側の版面の記録値（Tailwind の名前付きコンテナ寸法スケール）。
  // ここを実測で固定する理由は Issue #54 にある。余白の名前付きキーを宣言すると
  // 寸法系ユーティリティの解決先が余白スケールへ覆われ、**版面が数 px へ潰れたまま
  // クラス名は無傷**になる。クラス名の照合ではこの経路を検出できない。
  expect(
    metrics.maxWidth,
    `版面が名前付きスケールへ解決されていない（実測 ${metrics.maxWidth}）。` +
      '寸法系の解決先が別スケールに覆われている疑いがある',
  ).toBe('576px');

  const content = metrics.width - metrics.paddingLeft - metrics.paddingRight;
  expect(
    content,
    `ページ枠の実効内容幅が ${content}px しかない（端末幅 ${viewport.width}px）`,
  ).toBeGreaterThanOrEqual(viewport.width * 0.8);
});

test('区切り線が装飾用の値のまま描画される', async ({ page }) => {
  await openComponentCatalog(page);
  const separator = page.locator('[data-slot="separator"]');
  await expect(separator).toHaveCount(1);

  // 可視性でゲートしないこと: 検証面のコンテナ幅が既存の欠陥で極端に狭く解決されるため、
  // 区切り線の矩形は 0×0 になり toBeVisible() は false を返す。枠色・面色の計算値を読む経路は
  // 成立するのでそちらを使う（tasks.md「4.1 → 4.2 への申し送り」）。
  const rendered = await readRenderedColors(separator);
  expect(
    rendered.backgroundColor,
    `区切り線が装飾用の値で描画されていない（実測 ${rendered.backgroundColor ?? '不明'}）`,
  ).toBe(colors.border);
  expect(
    rendered.backgroundColor,
    '区切り線が識別用の枠色へ巻き込まれている。装飾用の意匠を維持する要件 4.2 に反する',
  ).not.toBe(colors.borderInteractive);
});

// Requirements 6.3 / 6.4: 枠色の変更が無効化状態の見た目を巻き添えにした結果を、
// design.md D8 が記録した値として固定する。
//
// D8 が記録する実効色（利用者が実際に見る、合成後の色）。是正前は枠 #EEEEEE / 面 #F7F7F7 で、
// `--input` を識別用役割へ向け直したことで下の値へ変化した。要件 6.4 は「変化するなら意図として
// 記録する」ことを条件に許容しており、D8 がその記録である。ここはその記録の**写し**であり、
// 実描画がこの値から動いたら、意匠判断をやり直して D8 を更新するまで緑にしてはならない。
//
// なぜトークンから再計算しないか: トークンや不透明度から導出した値と突き合わせると、
// 値が変わったときに期待値も一緒に動いてしまい「意図せぬ変化」を検出できない。
// 記録値は固定の literal でなければ番人にならない。
const DISABLED_EFFECTIVE_BORDER = '#BBBBBB';
const DISABLED_EFFECTIVE_SURFACE = '#DDDDDD';

test('無効化された記入欄の枠と面が D8 の記録値どおりの実効色で描画される', async ({ page }) => {
  await openComponentCatalog(page);
  const disabled = page.getByRole('textbox', { name: '無効化の記入欄' });
  await expect(disabled).toBeVisible();
  await expect(disabled).toBeDisabled();

  const pageBackground = await readPageBackground(page);
  const layers = await readRenderedLayers(disabled);

  // 枠の計算値は不透明で四辺一致（readRenderedBorder が幅 0 と食い違いを弾く）。
  // ただしこの値は**利用者が見る色ではない**。要素の不透明度がまだ掛かっていない。
  const rendered = await readRenderedBorder(disabled, '無効化の記入欄');
  expect(
    rendered.borderColor,
    `無効化の記入欄: 枠が識別用の枠色で描画されていない（実測 ${rendered.borderColor ?? '不明'}）`,
  ).toBe(colors.borderInteractive);

  // 空振り防止 1: 面が半透明であること。不透明なら既存の測定手段だけで足り、
  // 本 test が確立した「半透明を織り込む」経路を一度も通らないまま緑になる。
  expect(
    layers.backgroundColor.alpha,
    `無効化の記入欄: 面が半透明で描画されていない（alpha=${layers.backgroundColor.alpha}）`,
  ).toBeLessThan(1);
  expect(layers.backgroundColor.alpha, '無効化の記入欄: 面が完全に透明').toBeGreaterThan(0);

  // 空振り防止 2: 要素全体の不透明度が 1 未満であること。1 なら 2 段目の合成が恒等写像になり、
  // 「要素の不透明度を織り込む」という本 test の主張が検証されないまま緑になる。
  expect(
    layers.opacity,
    `無効化の記入欄に要素の不透明度が掛かっていない（opacity=${layers.opacity}）`,
  ).toBeLessThan(1);
  expect(layers.opacity, '無効化の記入欄の要素の不透明度が 0（描画されていない）').toBeGreaterThan(0);

  // 既存の測定手段は半透明に対して値を返さない。その設計思想（無音で 0 と比較して緑にしない）を
  // 保ったまま実効色を導けることが本 test の主張であり、前提としてここで固定する。
  expect(
    rendered.backgroundColor,
    '半透明の面に対して既存の測定手段が値を返している。' +
      '「決められないときは null」の規律が崩れると、下地を無視した色で無音の緑が出る',
  ).toBeNull();

  // 面の生値も枠と同じ識別用の枠色である（`--input` が枠色と面塗りの双方に使われている
  // 既知の構造。design.md「ui / theme.css 層」で明示的に引き受けている）。
  expect(
    layers.backgroundColor.hex,
    `無効化の記入欄: 面が識別用の枠色で塗られていない（実測 ${layers.backgroundColor.hex}）`,
  ).toBe(colors.borderInteractive);

  const [borderLayer] = layers.borderColors; // 四辺一致は readRenderedBorder が保証済み
  const effectiveBorder = effectiveColorOver(borderLayer!, pageBackground, layers.opacity);
  const effectiveSurface = effectiveColorOver(
    layers.backgroundColor,
    pageBackground,
    layers.opacity,
  );
  const measured =
    `枠 生値 ${borderLayer!.hex}(alpha=${borderLayer!.alpha}) → ${effectiveBorder} / ` +
    `面 生値 ${layers.backgroundColor.hex}(alpha=${layers.backgroundColor.alpha}) → ${effectiveSurface} / ` +
    `要素の不透明度 ${layers.opacity} / 下地 ${pageBackground}`;

  expect(
    effectiveBorder,
    `無効化の記入欄の枠の実効色が design.md D8 の記録値と一致しない。${measured}。` +
      '意図した意匠変更なら D8 を更新すること',
  ).toBe(DISABLED_EFFECTIVE_BORDER);
  expect(
    effectiveSurface,
    `無効化の記入欄の面の実効色が design.md D8 の記録値と一致しない。${measured}。` +
      '意図した意匠変更なら D8 を更新すること',
  ).toBe(DISABLED_EFFECTIVE_SURFACE);

  // 要素の不透明度を織り込まなければ実効色は計算値そのものになる。両者が異なることを固定して、
  // 「不透明度を無視した実装でも通る」検証へ退化しないようにする。
  expect(
    effectiveBorder,
    `枠の実効色が計算値（${rendered.borderColor ?? '不明'}）と同じ。` +
      '要素の不透明度が実効色に効いておらず、利用者が見る色を測れていない',
  ).not.toBe(rendered.borderColor);
});

// requirements 3.3: モバイル端末で横スクロールを発生させずに閲覧・操作できる（回答画面）。
test('モバイルビューポートの回答画面で横スクロールが発生しない', async ({ page }) => {
  await openSurveySurface(page);
  // 捲れる領域は一言の `<textarea>` の 1 つ（textarea の既定の overflow は auto）。
  await expectNoHorizontalScroll(page, '回答画面', 1);
});

// requirements 3.3: 下書き画面（生成テキスト・投稿導線を含む主要画面）でも同様。
test('モバイルビューポートの下書き画面で横スクロールが発生しない', async ({ page }) => {
  await openSurveySurface(page);
  await page.getByRole('button', { name: '星5' }).click();
  await page.getByRole('button', { name: '送信する' }).click();
  await expect(page.getByLabel('口コミ下書き')).toBeVisible();
  // 捲れる領域は下書きの `<textarea>` の 1 つ。
  await expectNoHorizontalScroll(page, '下書き画面', 1);
});

// Issue #53: 捲れる領域（overflow-x-auto）を持つ面で、要件 3.3 の検証が成立することを固定する。
//
// 面の側の `overflow-x: clip` により `docScrollWidth <= docClientWidth` は構造的に常に真であり、
// **面の溢れを捕らえる網は `maxRight` 1 本だけ**である。そこへ除外を入れる以上、除外が広すぎれば
// 網は消え、狭すぎれば偽陽性が出る。以下は「広さがちょうどよいこと」を両方向で固定する対照群で、
// 全部が緑になることではなく、**表のとおりに緑と赤へ分かれること**が証拠である。
test.describe('スクロール領域の除外', () => {
  /** 意図的に端末幅を超える表を抱えた容器。検証面における唯一の発火場所。 */
  const PANNING_REGION = '横に捲る領域の見本';
  /** 意匠を測る側の容器。溢れない。 */
  const CATALOGUE_REGION = '区分ごとの個数';

  /**
   * 検証面を開き、対照の前提（発火場所が実際に溢れていること）を確かめる。
   *
   * これを置かないと、fixture が何かの拍子に溢れなくなったとき、以下の対照は
   * すべて「溢れが無いので緑」という無意味な緑を返す。
   */
  async function openSurfaceWithPanning(page: Page): Promise<OverflowMetrics> {
    await openComponentCatalog(page);
    await expect(page.getByRole('region', { name: PANNING_REGION })).toBeVisible();
    const metrics = await readOverflowMetrics(page, 'scroll-container');
    const region = metrics.scrollRegions.find((candidate) => candidate.label === PANNING_REGION);
    expect(region, `検証面に「${PANNING_REGION}」が捲れる領域として現れていない`).toBeDefined();
    expect(
      region!.scrollWidth,
      `対照の前提が崩れている: 「${PANNING_REGION}」の中身が溢れていない` +
        `（scrollWidth=${region!.scrollWidth} <= clientWidth=${region!.clientWidth}）。` +
        'この状態では以下の対照はすべて空振りの緑になる',
    ).toBeGreaterThan(region!.clientWidth);
    return metrics;
  }

  /** 容器から捲りを奪う（実行時の注入対照。製品コードは書き換えない）。 */
  async function stripPanning(page: Page, label: string): Promise<void> {
    const before = await page.evaluate((name) => {
      const region = document.querySelector(`[data-slot="table-container"][aria-label="${name}"]`);
      if (region === null) throw new Error(`容器「${name}」が見つからない`);
      const previous = getComputedStyle(region).overflowX;
      (region as HTMLElement).style.overflowX = 'visible';
      return previous;
    }, label);
    // 変異が当たったことを確かめる。当たっていない変異は無改変のガードを検査することになる。
    expect(before, `容器「${label}」はもともと捲れる領域ではなかった（変異が空振りしている）`).toBe(
      'auto',
    );
  }

  /** `overflow-hidden` を持つ Card の内側へ、端末幅を超える要素を注入する。 */
  async function injectOverflowInsideCard(page: Page, position: 'first' | 'last'): Promise<void> {
    const cardOverflowX = await page.evaluate((where) => {
      const card = document.querySelector('[data-slot="card"]');
      if (card === null) throw new Error('検証面に Card が無い（対照の前提が崩れている）');
      const probe = document.createElement('div');
      probe.setAttribute('data-testid', 'overflow-probe');
      probe.style.width = '2000px';
      probe.style.height = '8px';
      if (where === 'first') card.prepend(probe);
      else card.append(probe);
      return getComputedStyle(card).overflowX;
    }, position);
    // 前提の確認: Card が `visible` 以外であることが、この対照の成立条件そのものである。
    expect(
      cardOverflowX,
      'Card が overflow を持たなくなっている（「visible 以外を免除する」対照が空振りする）',
    ).toBe('hidden');
  }

  // 本番の検証。
  //
  // 検証面が持つ捲れる領域は **3 つ**である。表の容器 2 つ（意匠を測る側と溢れを発火させる側）に
  // 加えて `<textarea>` が入る。textarea の既定の `overflow` は `auto` であり、これは
  // 「利用者が捲れる領域」の定義に素直に当てはまる（子要素を持たないので免除の効果は無いが、
  // 領域そのものの右端は測る対象である）。**この 3 件目は実測で見つけた**。宣言を実測へ
  // 合わせているのであって、逆ではない。
  test('捲れる領域を 3 つ持つ検証面で、面そのものは横スクロールしない', async ({ page }) => {
    const metrics = await openSurfaceWithPanning(page);
    await expectVerificationSurfaceSane(page);

    // 免除が実際に発火していること。0 件なら規則は空振りしており、以下は何も証明しない。
    expect(
      metrics.excludedCount,
      `捲れる領域の内側として免除された要素が 1 件も無い（規則が空振りしている）`,
    ).toBeGreaterThan(0);

    await expectNoHorizontalScroll(page, '検証面', 3);
  });

  // 対照 1: 免除しなければ、この面は赤い。是正前の挙動が偽陽性であることの実証。
  test('対照: 免除しない規則では、捲れる領域の内側の溢れで赤くなる', async ({ page }) => {
    await openSurfaceWithPanning(page);
    const deviceWidth = deviceWidthOf(page);
    const metrics = await readOverflowMetrics(page, 'none');

    expect(metrics.excludedCount, '免除しない規則なのに免除が発生している').toBe(0);
    expect(
      metrics.maxRight,
      `免除しない規則で緑になっている（${metrics.widest} の右端 ${metrics.maxRight}px）。` +
        'この対照が赤くならないなら、fixture が溢れていないか走査が届いていない',
    ).toBeGreaterThan(deviceWidth + 1);
  });

  // 対照 3: 容器が捲りを失った瞬間、内側は除外から外れて赤くなる（fail-closed の中核）。
  test('対照: 容器が捲りを失うと、除外から外れて赤くなる', async ({ page }) => {
    await openSurfaceWithPanning(page);
    const deviceWidth = deviceWidthOf(page);
    await stripPanning(page, PANNING_REGION);

    // 網 1: 面の溢れ。
    const metrics = await readOverflowMetrics(page, 'scroll-container');
    expect(
      metrics.maxRight,
      '捲りを失った容器の内側が依然として免除されている（fail-open）',
    ).toBeGreaterThan(deviceWidth + 1);

    // 網 2: 宣言した件数との一致。捲りを失った容器は領域として数えられなくなる。
    const labels = metrics.scrollRegions.map((region) => region.label);
    expect(labels, '捲りを失った容器が、まだ捲れる領域として数えられている').not.toContain(
      PANNING_REGION,
    );
    // 意匠を測る側は捲りを保っているので、件数は 3 から 1 つだけ減る。
    expect(labels, '捲りを失った容器以外まで数から消えている').toContain(CATALOGUE_REGION);
    expect(metrics.scrollRegions).toHaveLength(2);

    // 呼び出し側から見ても赤いこと。
    const failure = await expectNoHorizontalScroll(page, '検証面', 3).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure, '捲りを失った面が緑のまま通っている').not.toBeNull();
  });

  // 対照 4: 名前で判定すると、上の赤が緑に化ける（fail-open の実証）。
  test('対照: 名前で判定する規則では、捲りを失っても緑のまま通る', async ({ page }) => {
    await openSurfaceWithPanning(page);
    const deviceWidth = deviceWidthOf(page);
    await stripPanning(page, PANNING_REGION);

    const metrics = await readOverflowMetrics(page, 'data-slot');
    expect(
      metrics.maxRight,
      '名前で判定する規則が赤くなっている。この対照は「名前で判定すると見逃す」ことを' +
        '固定するためのもので、緑にならないなら対照そのものが的を外している',
    ).toBeLessThanOrEqual(deviceWidth + 1);
    // 名前は残っているので、件数の網も同時に無力化される（名前で数える規則は表の容器だけを数える）。
    expect(metrics.scrollRegions.map((region) => region.label)).toContain(PANNING_REGION);
  });

  // 対照 5 と 6: 除外の広さ。`visible` 以外をすべて免除すると Card 配下が母数から消える。
  //
  // 注入位置を先頭と末尾の 2 通りで試す。1 箇所での検証は位置依存の穴を隠す。
  for (const position of ['first', 'last'] as const) {
    test(`対照: 除外の広さを Card 配下の溢れで測る（注入位置 ${position}）`, async ({ page }) => {
      await openSurfaceWithPanning(page);
      const deviceWidth = deviceWidthOf(page);
      await injectOverflowInsideCard(page, position);

      // 対照 5: 「visible 以外」で免除すると、網は弱まるのではなく **消滅する**。
      //
      // 面の側の `globals.css` が `html, body { overflow-x: clip }` を持つため、`body` 自身が
      // 免除の根拠になる。走査は `body` 配下から始まるので、**全要素が「領域の内側」に落ちる**。
      // 実測では 145 要素すべてが免除され、`maxRight` は 0 のまま、測られた要素は 1 つも無い。
      // Card の `overflow-hidden` はその一段手前にある同じ型の穴である。
      const broad = await readOverflowMetrics(page, 'any-non-visible');
      expect(
        broad.maxRight,
        `「visible 以外を免除」で赤くなっている（${broad.widest}）。この対照は除外が広すぎると` +
          '網が消えることを固定するためのもので、緑にならないなら対照が的を外している',
      ).toBeLessThanOrEqual(deviceWidth + 1);
      expect(
        broad.widest,
        '「visible 以外を免除」でも測られた要素が残っている。' +
          'body の overflow-x: clip が免除の根拠にならなくなった可能性があり、' +
          'この対照が示すはずの「網の消滅」を示せていない',
      ).toBe('(none)');

      // 対照 6: 捲れる値だけを免除すれば、同じ溢れを捕らえる。
      const narrow = await readOverflowMetrics(page, 'scroll-container');
      expect(
        narrow.maxRight,
        'Card 配下（overflow-hidden の内側）の溢れを見逃している。' +
          '`hidden` は捲れる領域ではなく、中身は到達不能なまま失われる',
      ).toBeGreaterThan(deviceWidth + 1);
    });
  }
});
