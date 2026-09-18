// 2 つのリッチメニューの寸法・区画・action の定義（design.md「RichMenuDefinitions と RichMenuScripts」の
// 区画表・Requirements 2.1, 2.2, 2.4, 2.6, 2.7）。
//
// 作成（setup-rich-menus.ts）と張り替え（relink-completed-menu.ts）が同じ定義を読むために、
// 定義だけをここへ切り出す。LINE にも DB にも触れない純関数で、記録（ログ）も出さない。
//
// LINE のリッチメニューは、一度作った面の画像も区画も差し替えられない（references/rich-menu.md
// 「Cannot replace an image once uploaded」）。変更はメニューの作り直しと張り替えになるので、
// 区画と action の正典をコードの 1 か所に持ち、試験で design.md の区画表に対して固定する。
//
// 契約の根拠（.claude/skills/messaging-api/references/）:
//   - rich-menu.md「Rich Menu Object」: size の幅 800-2500・高さ 250 以上・比 1.45 以上、
//     chatBarText は 14 文字以内、areas は 20 区画以内、bounds の原点は左上
//   - action-objects.md「Label Specifications」: リッチメニューの label は 20 文字以内（任意・読み上げが使う）
//   - action-objects.md「Postback Action」「URI Action」「Message Action」: postback は data（と displayText）、
//     uri は uri、message は text を持つ

import { REPORT_LABELS, encodeReportPostback, type ReportKind } from '@fwlm/line-report';
import { encodePostback } from '../src/onboarding/stages.js';

// メニューごとの寸法。**assets/richmenu-*.png の実寸法と必ず一致させること。** 区画の bounds は
// この寸法の中に置かれるので、食い違いはそのまま「押せる範囲と絵の食い違い」になる
// （test/scripts/rich-menu-definitions.test.ts と test/scripts/setup-rich-menus.test.ts が
// 実 PNG の IHDR に対して機械的に強制する）。
//
// 幅を 2 面とも 2500 にしているのは解像度の問題である（Issue #195）。原寸 800px は幅 390pt の
// 端末で約 1.46 倍に引き伸ばされ、文字が眠る。平面塗りなので 2500 幅でも実測 70-80KB であり、
// 1MB の上限には遠く届かない。

/** オンボーディング用は Half (HD) 2500x843（比 2.965 >= 1.45 要件）。再開の 1 タップだけの面である。 */
export const ONBOARDING_MENU_SIZE = { width: 2500, height: 843 } as const;

/**
 * 完了後メニューは Full (HD) 2500x1686（比 約 1.483 >= 1.45 要件・Issue #256）。上段 3 区画の
 * レポートと下段 2 区画（詳細・ステータス）の 2 段を持つため、Half では区画が縦に潰れる。
 * 占有高さは幅 390pt の端末で約 263pt になるが、これは導線を 5 つ常設することの対価である。
 */
export const COMPLETED_MENU_SIZE = { width: 2500, height: 1686 } as const;

/** 上段の 3 区画の高さ（= 下段の高さ）。2 段を等分する。 */
const COMPLETED_ROW_HEIGHT = COMPLETED_MENU_SIZE.height / 2;

export interface RichMenuBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * 区画の action。label はどの型でも必ず持たせる（読み上げが読む唯一の手がかりであり、
 * 区画には文字が描かれていないため）。
 */
export type RichMenuAction =
  // displayText は「タップを発言として残すか」の選択であり、面ごとに異なる（レポートの 3 導線だけが持つ）。
  | { readonly type: 'postback'; readonly label: string; readonly data: string; readonly displayText?: string }
  | { readonly type: 'message'; readonly label: string; readonly text: string }
  | { readonly type: 'uri'; readonly label: string; readonly uri: string };

export interface RichMenuArea {
  readonly bounds: RichMenuBounds;
  readonly action: RichMenuAction;
}

export interface RichMenuObject {
  readonly size: { readonly width: number; readonly height: number };
  readonly selected: boolean;
  readonly name: string;
  readonly chatBarText: string;
  readonly areas: readonly RichMenuArea[];
}

/** 上段 3 区画の並び（左・中・右）と、その x 座標・幅。中央だけ 1px 広いのは 2500 を 3 等分できないためである。 */
const REPORT_COLUMNS: ReadonlyArray<{ readonly kind: ReportKind; readonly x: number; readonly width: number }> = [
  { kind: 'new_reviews', x: 0, width: 833 },
  { kind: 'comparison', x: 833, width: 834 },
  { kind: 'trend', x: 1667, width: 833 },
];

/** 下段の 2 区画の幅（左右で等分）。 */
const COMPLETED_BOTTOM_WIDTH = COMPLETED_MENU_SIZE.width / 2;

/**
 * オンボーディング用メニュー（Requirement 2.6・line-onboarding Req 6.1/6.2）。
 * 店舗特定済みでないオーナーの既定メニューであり、本 spec では変えない。
 */
export function buildOnboardingRichMenu(): RichMenuObject {
  return {
    size: { width: ONBOARDING_MENU_SIZE.width, height: ONBOARDING_MENU_SIZE.height },
    selected: false,
    name: 'line-onboarding-resume-menu',
    chatBarText: '登録を再開',
    areas: [
      {
        bounds: { x: 0, y: 0, width: ONBOARDING_MENU_SIZE.width, height: ONBOARDING_MENU_SIZE.height },
        action: {
          type: 'postback',
          label: '登録を再開する',
          // displayText は付けない（Requirement 2.6: この面は本 spec で変えない）。
          data: encodePostback({ kind: 'resume' }),
        },
      },
    ],
  };
}

/**
 * 完了後メニュー（Requirements 2.1, 2.2, 2.3, 2.4）。店舗特定済みオーナーへ個別に張る。
 *
 * 上段はレポートの 3 導線で、data は符号器（@fwlm/line-report）が作る店舗も頁も持たない形だけを使う。
 * displayText を付けるのは、タップした導線の文言をオーナー自身の発言としてトークに残すためである（2.3）。
 * 下段左は詳細画面（LIFF）、下段右は既存のステータス確認（テキスト送信）である。
 *
 * 第2フェーズ（2.7）は、下段を 833 幅の 3 区画に割り直して 3 つ目に「Google 連携」を置く。
 * 上段 3 区画と下段の既存 2 導線のラベル・action は変えない。
 */
export function buildCompletedRichMenu(liffStoreDetailUrl: string): RichMenuObject {
  if (liffStoreDetailUrl.length === 0) {
    throw new Error('buildCompletedRichMenu: LIFF_STORE_DETAIL_URL is required');
  }

  const reportAreas: RichMenuArea[] = REPORT_COLUMNS.map(({ kind, x, width }) => ({
    bounds: { x, y: 0, width, height: COMPLETED_ROW_HEIGHT },
    action: {
      type: 'postback',
      label: REPORT_LABELS[kind],
      data: encodeReportPostback({ kind, storeId: null, page: 0 }),
      displayText: REPORT_LABELS[kind],
    },
  }));

  return {
    size: { width: COMPLETED_MENU_SIZE.width, height: COMPLETED_MENU_SIZE.height },
    // 5 つの導線を常設する面なので、既定で開いた状態にする（畳まれていると導線に気づけない）。
    selected: true,
    name: 'line-onboarding-completed-menu',
    // チャットバーの文字は、開く面の呼び名（14 文字以内）。導線が 5 つになり、特定の 1 つを
    // 名乗らせると他の導線が隠れて見えるため「メニュー」とする。
    chatBarText: 'メニュー',
    areas: [
      ...reportAreas,
      {
        bounds: { x: 0, y: COMPLETED_ROW_HEIGHT, width: COMPLETED_BOTTOM_WIDTH, height: COMPLETED_ROW_HEIGHT },
        // Requirement 2.4: 既存の詳細画面を LINE 内で開く。店舗の指定は付けない
        // （メニューは店舗の文脈を持たない。画面側が対象店舗を確定させる）。
        action: { type: 'uri', label: '詳細を見る', uri: liffStoreDetailUrl },
      },
      {
        bounds: {
          x: COMPLETED_BOTTOM_WIDTH,
          y: COMPLETED_ROW_HEIGHT,
          width: COMPLETED_BOTTOM_WIDTH,
          height: COMPLETED_ROW_HEIGHT,
        },
        // Requirement 2.2/2.5: 既存の導線をそのまま残す。テキストとして送られ、
        // 店舗特定済みオーナーの振り分け口（src/owner/router.ts）がステータス案内を返す。
        action: { type: 'message', label: 'ステータス確認', text: 'ステータス確認' },
      },
    ],
  };
}
