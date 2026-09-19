// リッチメニューの定義の試験（design.md「RichMenuDefinitions と RichMenuScripts」の区画表・
// Requirements 2.1, 2.2, 2.4, 2.6, 2.7）。
//
// 区画表は design.md の値をここへ書き写して固定する。実装の定数をそのまま読むと、定義と試験が
// 同じ向きへ一緒にずれた状態（区画を 1 つ落としたまま両方を直す等）を受理してしまう。
// postback の data だけは書き写さず、符号器（@fwlm/line-report の encodeReportPostback）の出力と
// 突き合わせる。data の形式は符号器が唯一の正典であり、メニューは配布後に直せないためである。

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPORT_LABELS, encodeReportPostback, exposesAllReportActions } from '@fwlm/line-report';
import type { ReportKind } from '@fwlm/line-report';
import {
  COMPLETED_MENU_SIZE,
  ONBOARDING_MENU_SIZE,
  buildCompletedRichMenu,
  buildOnboardingRichMenu,
  type RichMenuArea,
  type RichMenuObject,
} from '../../scripts/rich-menu-definitions.js';
import { decodePostback } from '../../src/onboarding/stages.js';
import { codePointLength } from '../../src/report/format.js';

/** 区画の action のラベルの上限（references/action-objects.md「Label Specifications」の Rich Menu）。 */
const RICH_MENU_LABEL_MAX_LENGTH = 20;
/** チャットバーの文字数の上限（references/rich-menu.md「Rich Menu Object」）。 */
const CHAT_BAR_TEXT_MAX_LENGTH = 14;

const LIFF_STORE_DETAIL_URL = 'https://liff.line.me/2000000000-c9detail';

// design.md の区画表（完了後メニュー・Full 2500×1686）をそのまま書き写したもの。
const EXPECTED_COMPLETED_BOUNDS: ReadonlyArray<{
  readonly place: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}> = [
  { place: '上段左', x: 0, y: 0, width: 833, height: 843 },
  { place: '上段中', x: 833, y: 0, width: 834, height: 843 },
  { place: '上段右', x: 1667, y: 0, width: 833, height: 843 },
  { place: '下段左', x: 0, y: 843, width: 1250, height: 843 },
  { place: '下段右', x: 1250, y: 843, width: 1250, height: 843 },
];

/** 上段 3 区画のレポートの種類（design.md の区画表の並び）。 */
const EXPECTED_REPORT_KINDS: readonly ReportKind[] = ['new_reviews', 'comparison', 'trend'];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPngSize(image: Buffer): { width: number; height: number } {
  if (!image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('PNG 署名が一致しない（assets に PNG 以外が置かれている）');
  }
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

function overlaps(a: RichMenuArea['bounds'], b: RichMenuArea['bounds']): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  );
}

function assertAreasFitWithoutOverlap(menu: RichMenuObject): void {
  for (const area of menu.areas) {
    expect(area.bounds.width, `幅は正でなければならない: ${JSON.stringify(area.bounds)}`).toBeGreaterThan(0);
    expect(area.bounds.height, `高さは正でなければならない: ${JSON.stringify(area.bounds)}`).toBeGreaterThan(0);
    expect(area.bounds.x).toBeGreaterThanOrEqual(0);
    expect(area.bounds.y).toBeGreaterThanOrEqual(0);
    expect(area.bounds.x + area.bounds.width).toBeLessThanOrEqual(menu.size.width);
    expect(area.bounds.y + area.bounds.height).toBeLessThanOrEqual(menu.size.height);
  }

  for (let i = 0; i < menu.areas.length; i += 1) {
    for (let j = i + 1; j < menu.areas.length; j += 1) {
      const left = menu.areas[i]!;
      const right = menu.areas[j]!;
      expect(
        overlaps(left.bounds, right.bounds),
        `区画 ${i} と ${j} が重なっている: ${JSON.stringify(left.bounds)} / ${JSON.stringify(right.bounds)}`,
      ).toBe(false);
    }
  }
}

describe('buildCompletedRichMenu', () => {
  it('区画が寸法の中に収まり、重ならず、面を余さず覆う', () => {
    const menu = buildCompletedRichMenu(LIFF_STORE_DETAIL_URL);

    expect(menu.size).toEqual({ width: 2500, height: 1686 });
    assertAreasFitWithoutOverlap(menu);

    // 重なりが無いことと合わせて、面積の合計が寸法の面積に等しければ、隙間も無い
    // （押せない帯が絵の上に残らない）。
    const covered = menu.areas.reduce((sum, area) => sum + area.bounds.width * area.bounds.height, 0);
    expect(covered).toBe(menu.size.width * menu.size.height);

    expect(
      menu.areas.map((area) => ({ x: area.bounds.x, y: area.bounds.y, width: area.bounds.width, height: area.bounds.height })),
    ).toEqual(
      EXPECTED_COMPLETED_BOUNDS.map(({ x, y, width, height }) => ({ x, y, width, height })),
    );
  });

  it('上段 3 区画の postback が符号器の出力と一致し、文言を発言として表示する', () => {
    const menu = buildCompletedRichMenu(LIFF_STORE_DETAIL_URL);

    for (const [index, kind] of EXPECTED_REPORT_KINDS.entries()) {
      const area = menu.areas[index];
      expect(area, `${index} 番目の区画が無い`).toBeDefined();
      const action = area!.action;
      expect(action.type).toBe('postback');
      if (action.type !== 'postback') return;

      // 店舗も頁も持たない形（design.md「メニューの区画は店舗も頁も持たない形だけを使う」）。
      expect(action.data).toBe(encodeReportPostback({ kind, storeId: null, page: 0 }));
      // Requirement 2.3: タップした導線の文言をオーナー自身の発言として表示してから回答する。
      expect(action.displayText).toBe(REPORT_LABELS[kind]);
      expect(action.label).toBe(REPORT_LABELS[kind]);
    }

    // Requirement 1.10 / 2.1: 3 導線がそろっていること自体を、通知側と同じ判定で確かめる。
    expect(exposesAllReportActions(menu.areas.map((area) => area.action))).toBe(true);
  });

  it('下段左が詳細画面の LIFF URL を開き、下段右が既存のステータス確認を送る', () => {
    const menu = buildCompletedRichMenu(LIFF_STORE_DETAIL_URL);

    const detail = menu.areas[3];
    expect(detail).toBeDefined();
    expect(detail!.action).toEqual({ type: 'uri', label: '詳細を見る', uri: LIFF_STORE_DETAIL_URL });

    const status = menu.areas[4];
    expect(status).toBeDefined();
    expect(status!.action).toEqual({ type: 'message', label: 'ステータス確認', text: 'ステータス確認' });
  });

  it('ラベルとチャットバーが LINE の上限に収まり、既定で開いた状態にする', () => {
    const menu = buildCompletedRichMenu(LIFF_STORE_DETAIL_URL);

    for (const area of menu.areas) {
      // 文字数は書記素ではなくコードポイントで数える（選択肢のラベルと同じ数え方）。
      expect(codePointLength(area.action.label)).toBeLessThanOrEqual(RICH_MENU_LABEL_MAX_LENGTH);
      expect(area.action.label.length).toBeGreaterThan(0);
    }

    // Requirement 2.1/2.2: 5 導線を常設するので、既定で開いた状態にする。
    expect(menu.selected).toBe(true);
    expect(menu.chatBarText).toBe('メニュー');
    expect(codePointLength(menu.chatBarText)).toBeLessThanOrEqual(CHAT_BAR_TEXT_MAX_LENGTH);
  });

  it('詳細画面の URL が空なら組み立てを拒否する', () => {
    expect(() => buildCompletedRichMenu('')).toThrow(/LIFF_STORE_DETAIL_URL/);
  });
});

describe('buildOnboardingRichMenu', () => {
  // Requirement 2.6: 店舗特定済みでないオーナーには、オンボーディング用メニューを引き続き表示する。
  // 完了後メニューの作り直しで、この面を変えてはならない。
  it('Half の 1 区画に再開の postback を割り当てたまま変えない', () => {
    const menu = buildOnboardingRichMenu();

    expect(menu.size).toEqual({ width: 2500, height: 843 });
    expect(menu.selected).toBe(false);
    expect(menu.chatBarText).toBe('登録を再開');
    expect(menu.areas).toHaveLength(1);
    assertAreasFitWithoutOverlap(menu);

    const area = menu.areas[0]!;
    expect(area.bounds).toEqual({ x: 0, y: 0, width: 2500, height: 843 });
    expect(area.action.type).toBe('postback');
    if (area.action.type !== 'postback') return;
    expect(decodePostback(area.action.data)).toEqual({ kind: 'resume' });
    // 発言として残す挙動を足していないこと（この面の見え方を変えない）。
    expect(area.action.displayText).toBeUndefined();
    expect(codePointLength(area.action.label)).toBeLessThanOrEqual(RICH_MENU_LABEL_MAX_LENGTH);
  });
});

describe('メニューごとの寸法の宣言', () => {
  // 宣言した寸法と、その面に貼る PNG の実寸法の一致（Issue #195 と同じ主眼を、定義の側でも固定する）。
  it('assets の実 PNG の寸法と一致する', async () => {
    const assetsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets');
    const [onboardingImage, completedImage] = await Promise.all([
      readFile(path.join(assetsDir, 'richmenu-onboarding.png')),
      readFile(path.join(assetsDir, 'richmenu-completed.png')),
    ]);

    expect(readPngSize(onboardingImage)).toEqual({
      width: ONBOARDING_MENU_SIZE.width,
      height: ONBOARDING_MENU_SIZE.height,
    });
    expect(readPngSize(completedImage)).toEqual({
      width: COMPLETED_MENU_SIZE.width,
      height: COMPLETED_MENU_SIZE.height,
    });
  });
});
