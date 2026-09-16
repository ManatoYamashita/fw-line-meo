// 行の直下に開くパネルが、捲り容器の**見えている矩形**に収まっていることを測る道具。
//
// もとは dashboard-surfaces.spec.ts のモジュール private だった（dashboard-user-edit tasks 3.5・
// Issue #259）。Issue #283 で店舗一覧の表も捲れるようになり、QR パネルが同じ経路を持つように
// なったため、パネルの種類を引数に取る形で切り出した。**規則・しきい値・文言は変えていない**
// （利用者の編集パネルの 2 本が件数も文言も変えずに緑であることが、切り出しの完了条件である）。
//
// spec から spec は import できない（Playwright が test file の相互 import を拒む）ので、
// 共有する関数は spec ではなくこの場所に置く。
import { expect, type Locator, type Page } from '@playwright/test';

import { DASHBOARD_USERS, STORES } from '../fixtures/api';

/** 画面上の左右の端（CSS px・ビューポート基準）。 */
export interface HorizontalExtent {
  readonly name: string;
  readonly left: number;
  readonly right: number;
}

export interface PanelPlacement {
  readonly scrollLeft: number;
  readonly clientWidth: number;
  readonly scrollWidth: number;
  /** 捲り容器の見えている矩形（スクロールポート）の左右の端。 */
  readonly scrollport: { readonly left: number; readonly right: number };
  /**
   * パネルのカードと、その中の見出し・操作要素。見出しは描かれた文字列の範囲、入力部品は
   * ラベルの文言、押しボタンとリンクは文言で名指す。
   */
  readonly parts: readonly HorizontalExtent[];
  /** カードの縁を越えた子孫（要素の箱と、描かれた文字列の範囲）。 */
  readonly escapedFromCard: readonly HorizontalExtent[];
  /** カードの子孫として調べた要素と文字列の件数（空振りの検出用）。 */
  readonly cardDescendantsChecked: number;
}

/**
 * 測る対象のパネル。
 *
 * `parts` は**完全一致で照合する**。1 件も拾えない、または一部を取りこぼした計測を
 * 「すべて内側にある」と読まないための前置きである。
 */
export interface PanelProbe {
  readonly where: string;
  /** パネルを開いた押しボタン（`aria-controls` でパネルのセルを指している）。 */
  readonly trigger: (page: Page) => Locator;
  /** パネルが置かれている捲り容器（名前付きの領域）。 */
  readonly region: (page: Page) => Locator;
  readonly parts: readonly string[];
  /** カードの子孫として最低限調べているはずの件数（**literal で持つ**・空振りの検出用）。 */
  readonly minCardDescendants: number;
  /**
   * Tab で焦点を載せて、見えていることを確かめる操作要素。
   *
   * **文言と読み上げ名は別に持つ。** QR パネルの「閉じる」は、どの店舗の QR を閉じるのかを
   * 読み上げ名に含めており（WCAG 2.5.3 を満たすための設計）、文言だけでは引けない。
   */
  readonly focusTarget: {
    /** `parts` に現れる文言。 */
    readonly part: string;
    /** 捲り容器の中からの引き方。 */
    readonly locate: (region: Locator) => Locator;
  };
}

/**
 * 利用者の編集パネル（dashboard-user-edit Req 6.8, 6.9）。
 *
 * 所属代理店の選択は代理店ロールのときだけ出る。fixture の開く手順が代理店ロールの利用者を開く
 * （最も横に広い状態）ので、ここにも含まれる。
 */
export const USER_EDIT_PANEL: PanelProbe = {
  where: '利用者管理の編集パネル',
  trigger: (page) =>
    page.getByRole('button', { name: `${DASHBOARD_USERS[1].email} を編集`, exact: true }),
  region: (page) => page.getByRole('region', { name: '利用者一覧', exact: true }),
  parts: ['カード', '見出し', 'ロール', '所属代理店', '表示名', '保存', 'キャンセル'],
  minCardDescendants: 6,
  focusTarget: {
    part: '保存',
    locate: (region) => region.getByRole('button', { name: '保存', exact: true }),
  },
};

/**
 * 店舗の QR パネル（store-qr-issuance-ui Req 1.1・Issue #283 で対象に加えた）。
 *
 * Issue #283 の前は店舗一覧の表が容器に収まっており、この経路を持たなかった。折り返しの規則を
 * 当てて表が捲れるようになったので、編集パネルと同じ網を張る。保存は `<a download>` であり
 * 押しボタンではない（要素の種類そのものに意味がある）ので、操作要素の走査はリンクも拾う。
 */
export const STORE_QR_PANEL: PanelProbe = {
  where: '店舗一覧の QR パネル',
  trigger: (page) =>
    page.getByRole('button', { name: `${STORES[0].name} の QR 発行`, exact: true }),
  region: (page) => page.getByRole('region', { name: '店舗一覧', exact: true }),
  parts: ['カード', '見出し', '画像を保存', '掲示物を印刷', '閉じる'],
  minCardDescendants: 12,
  focusTarget: {
    part: '閉じる',
    locate: (region) =>
      region.getByRole('button', { name: `${STORES[0].name} の QR を閉じる`, exact: true }),
  },
};

/**
 * カードの子孫がカードの縁を越えたと見なす幅の下限（CSS px）。
 *
 * 箱の端と文字列の範囲は小数で得られ、カードの縁と接する子孫（見出しの帯・本文の帯）は縁と同じ値に
 * なる。丸めの差で縁と接するものを越えたと読まないための幅であり、実際に切れる文字（1 字で数 px）より
 * 十分に小さい。
 */
const CARD_EDGE_TOLERANCE = 0.5;

/**
 * カードの左右の余白（見えている矩形の左端 → カードの左端、カードの右端 → 見えている矩形の右端）の
 * 差の上限（CSS px）。
 *
 * 包みの幅（`100cqi - 2rem`）は、sticky の左端（`left-4`）と、`@fwlm/ui` の `TableCell` の左右の余白
 * （`px-4`）の両方と結び付いている。引く値だけがずれると（例: `1.5rem`）、ここでは収まったまま、
 * 表が容器に収まる広い版面で包みがセルの内容より広くなり、容器が捲れるようになる（tasks 3.5 の
 * 独立レビューで 768px・1280px 幅に実測）。E2E は携帯端末の幅だけで走るので、左右の余白が揃っている
 * ことでこのずれを捕まえる。最大まで捲ると、sticky の包みがセルの内容の右端に当たって 1px 未満ずれる
 * （表の幅が小数のため）ので、その分を許す。
 */
const CARD_GAP_TOLERANCE = 1;

/**
 * 捲り容器と、開いているパネルの左右の端を 1 回の評価で読む。
 *
 * パネルは押しボタンの `aria-controls` が指すセルとして引く（押しボタンとパネルの結び付きを
 * そのまま辿る）。そのセルが捲り容器の中に無ければ、測る対象を取り違えているので例外にする。
 */
export async function readPanelPlacement(
  page: Page,
  probe: PanelProbe,
): Promise<PanelPlacement> {
  const panelId = await probe.trigger(page).getAttribute('aria-controls');
  expect(
    panelId,
    `${probe.where}: 押しボタンが開いているパネルを指していません（パネルが開いていません）`,
  ).not.toBeNull();
  return probe.region(page).evaluate(
    (container, { id, tolerance }) => {
      const cell = document.getElementById(id);
      if (cell === null || !container.contains(cell)) {
        throw new Error(`パネル #${id} が捲り容器の中にありません`);
      }
      const card = cell.querySelector('[data-slot="card"]');
      if (card === null) {
        throw new Error(`パネル #${id} の中にカードがありません`);
      }
      const extent = (name: string, rect: DOMRect): HorizontalExtent => ({
        name,
        left: rect.left,
        right: rect.right,
      });
      // 描かれた文字列の範囲。要素の箱が縁の内側にあっても、文字列が箱から溢れていれば読めないので、
      // 見出しと文字列は箱ではなく文字列そのものの範囲で測る。
      const textRect = (node: Node): DOMRect => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getBoundingClientRect();
      };

      const parts: HorizontalExtent[] = [extent('カード', card.getBoundingClientRect())];
      const heading = card.querySelector('h2');
      if (heading !== null) parts.push(extent('見出し', textRect(heading)));
      for (const control of Array.from(
        cell.querySelectorAll('select, input, button, a[href]'),
      )) {
        const name =
          control instanceof HTMLButtonElement || control instanceof HTMLAnchorElement
            ? control.textContent?.trim() ?? ''
            : (control as HTMLInputElement | HTMLSelectElement).labels?.[0]?.textContent?.trim() ??
              '';
        parts.push(extent(name, control.getBoundingClientRect()));
      }

      // カードの子孫。大きさの無いもの（閉じた選択の中の選択肢など）は描かれていないので除く。
      const cardBox = card.getBoundingClientRect();
      const escapedFromCard: HorizontalExtent[] = [];
      let cardDescendantsChecked = 0;
      const inspect = (name: string, rect: DOMRect) => {
        if (rect.width === 0 && rect.height === 0) return;
        cardDescendantsChecked += 1;
        if (rect.left < cardBox.left - tolerance || rect.right > cardBox.right + tolerance) {
          escapedFromCard.push(extent(name, rect));
        }
      };
      for (const element of Array.from(card.querySelectorAll('*'))) {
        inspect(`<${element.tagName.toLowerCase()}>`, element.getBoundingClientRect());
      }
      const texts = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
      for (let node = texts.nextNode(); node !== null; node = texts.nextNode()) {
        const text = node.textContent?.trim() ?? '';
        if (text !== '') inspect(`「${text}」`, textRect(node));
      }

      // 見えている矩形は、枠線（clientLeft）の内側から clientWidth の幅である。getBoundingClientRect の
      // 幅は、縦の捲り棒が出る場合にその幅まで含むので使わない。
      const box = container.getBoundingClientRect();
      const left = box.left + container.clientLeft;
      return {
        scrollLeft: container.scrollLeft,
        clientWidth: container.clientWidth,
        scrollWidth: container.scrollWidth,
        scrollport: { left, right: left + container.clientWidth },
        parts,
        escapedFromCard,
        cardDescendantsChecked,
      };
    },
    { id: panelId!, tolerance: CARD_EDGE_TOLERANCE },
  );
}

/** 数値を小数第 2 位で丸めた表記（失敗の文言用。比較は丸める前の値で行う）。 */
function px(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** 失敗の文言用の表記（`名前 [左端, 右端]`）。 */
function describeExtent(part: HorizontalExtent): string {
  return `${part.name} [${px(part.left)}, ${px(part.right)}]`;
}

/**
 * パネルの各部が見えている矩形の内側にあり、カードの中身がカードの縁を越えず、カードの左右の余白が
 * 揃っていること。
 *
 * 判定は `expect.soft` にし、1 つの状態で外れても後続の状態を測り続ける。どの状態で外れるかは
 * 壊れ方で変わる（sticky だけを外すと、捲れた状態でだけ外れる）ので、1 回の実行で全状態の結果を
 * 読めるようにする。取りこぼしと空振りの判定は、それ以降の判定の前提なので通常の `expect` のまま止める。
 */
export function expectPanelInsideScrollport(
  placement: PanelPlacement,
  state: string,
  probe: PanelProbe,
): void {
  expect(
    placement.parts.map((part) => part.name),
    `${state}: 測る部分を取りこぼしています（パネルの構成が変わったか、パネルが開いていません）`,
  ).toEqual([...probe.parts]);
  // カードの中の見出しと操作要素は、少なくとも子孫として調べているはずである。下回るなら
  // 子孫の走査が空振りしている（件数は literal で持つ）。
  expect(
    placement.cardDescendantsChecked,
    `${state}: カードの子孫をほとんど調べていません（走査が空振りしています。実測 ${placement.cardDescendantsChecked} 件）`,
  ).toBeGreaterThanOrEqual(probe.minCardDescendants);

  const { left, right } = placement.scrollport;
  const where = `${state}（scrollLeft=${px(placement.scrollLeft)}）`;
  const outside = placement.parts
    .filter((part) => part.left < left || part.right > right)
    .map(describeExtent);
  expect
    .soft(
      outside,
      `${where}: 捲り容器の見えている矩形 [${px(left)}, ${px(right)}] の外へ出た部分があります`,
    )
    .toEqual([]);

  const card = placement.parts[0]!;
  expect
    .soft(
      placement.escapedFromCard.map(describeExtent),
      `${where}: カード [${px(card.left)}, ${px(card.right)}] の縁を越えた中身があります` +
        '（カードは溢れを切り取るので、越えた分は読めません）',
    )
    .toEqual([]);

  const leftGap = card.left - left;
  const rightGap = right - card.right;
  expect
    .soft(
      Math.abs(leftGap - rightGap),
      `${where}: カードの左右の余白が揃っていません（左 ${px(leftGap)} / 右 ${px(rightGap)}）。` +
        '包みの幅から引く値が、sticky の左端やセルの左右の余白とずれています',
    )
    .toBeLessThanOrEqual(CARD_GAP_TOLERANCE);
}
