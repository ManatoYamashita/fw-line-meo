// @vitest-environment jsdom
//
// 回答画面の版面（ui-airbnb-surfaces task 4.1・Requirements 1.1 / 1.5）。
//
// この面の版面は着手前まで面の側が直接持っており（`mx-auto w-full max-w-xl px-5 py-8`）、
// それを共通の外枠部品へ置換した。置換そのものを見る検証はこのファイルが初出である。
// 掴めるものが無い状態では次が丸ごと素通りする。
//
//   - 主要領域が 1 つであること（外枠部品を入れ子にする改変。主要領域の単一性に依存する
//     検証は survey-web の E2E と管理ダッシュボードの多数のテストに及ぶ）
//   - 版面の段の取り違え（本文系ではなく一覧系を選ぶ）
//   - **面の側で余白を上書きしないこと**（要件 1.5・タスク本文の第 1 箇条書き）
//
// 意匠の実値はここへ 1 つも書かない。部品の cva を呼んで差し引き、**面の側が足した分**だけを見る。
// 実値を転記すると必ず古びる（正典 §6・7.10 のガードで既に採った作法）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { headingVariants } from '@fwlm/ui/components/heading';
import { pageShellVariants } from '@fwlm/ui/components/page-shell';

import type { SurveyPageData } from '../src/app/s/[storeId]/page-data';

// 描画だけを見るため、データ取得は差し替える。`buildDeps` は評価されるが、その中の閉包は
// ここでは 1 つも呼ばれないので DB 接続は起きない（署名鍵だけ環境から与える）。
vi.mock('../src/app/s/[storeId]/page-data', () => ({
  loadSurveyPageData: vi.fn(),
}));

import SurveyPage from '../src/app/s/[storeId]/page';
import { loadSurveyPageData } from '../src/app/s/[storeId]/page-data';

const STORE_ID = '44444444-4444-4444-4444-444444444444';
const STORE_NAME = '海鮮酒場 うみのて';

const READY: SurveyPageData = {
  kind: 'ready',
  store: { id: STORE_ID, name: STORE_NAME },
  aspects: [
    { code: 'taste', label: '味' },
    { code: 'service', label: '接客' },
  ],
  pageToken: 'test-page-token',
  googleReviewUrl: 'https://search.google.com/local/writereview?placeid=test',
};

const UNAVAILABLE: SurveyPageData = { kind: 'unavailable' };

beforeEach(() => {
  vi.stubEnv('SESSION_SIGNING_KEY', 'test-signing-key-for-page-render');
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.mocked(loadSurveyPageData).mockReset();
});

async function renderPage(data: SurveyPageData): Promise<void> {
  vi.mocked(loadSurveyPageData).mockResolvedValue(data);
  render(await SurveyPage({ params: Promise.resolve({ storeId: STORE_ID }) }));
}

function classesOf(element: Element): string[] {
  return (element.getAttribute('class') ?? '').split(/\s+/).filter((value) => value.length > 0);
}

/**
 * 部品が自分で持つユーティリティと、描画結果のユーティリティを**両方向で**突き合わせる。
 *
 * 片方向（部品 → 描画）だけだと面の側の追記が素通りし、逆だけだと部品の値の欠落が素通りする。
 * 両方が空であることは 2 つの集合が相等であることと同じで、幅の段の取り違え（`max-w-*` の
 * 差し替え）も面の側の余白の上書きも同時に落ちる。
 */
function compareUtilities(
  element: Element,
  own: string,
): { missing: string[]; extras: string[]; actual: string[] } {
  const expected = own.split(/\s+/).filter((value) => value.length > 0);
  const actual = classesOf(element);
  return {
    missing: expected.filter((utility) => !actual.includes(utility)),
    extras: actual.filter((utility) => !expected.includes(utility)),
    actual,
  };
}

/** 主要領域を 1 つに解決したうえで返す。0 個でも 2 個でも例外になる。 */
function theMain(): HTMLElement {
  const mains = screen.getAllByRole('main');
  expect(mains, `主要領域が ${mains.length} 個あります（1 ページに 1 つ）`).toHaveLength(1);
  return mains[0]!;
}

describe('回答画面の版面（共通の外枠部品への置換）', () => {
  // 2 分岐とも同じ要求を満たす。分岐ごとに余白を変えていたのが着手前の姿であり、
  // 片方だけ直して満足する改変を落とすため、同じ検査を両方に当てる。
  for (const branch of [
    { label: '回答可能', data: READY },
    { label: '回答不可', data: UNAVAILABLE },
  ] as const) {
    describe(`${branch.label}の分岐`, () => {
      it('主要領域がちょうど 1 つで、外枠の部品を通っている', async () => {
        await renderPage(branch.data);
        const main = theMain();
        expect(main.tagName).toBe('MAIN');
        // 素の main への差し戻しをここで落とす。
        expect(main.getAttribute('data-slot'), '版面が部品を通っていません').toBe('page-shell');

        // 外枠の部品そのものが 1 つであることは、主要領域の個数とは別に要る。
        // 入れ子の内側を主要領域以外の要素として描くと（部品は as でそれを許している）、
        // 主要領域は 1 つのままで版面だけが二重になり、左右余白と幅の上限が二度掛かる。
        // 上の theMain() はこの形を通してしまうので、ここで数える。
        expect(
          document.querySelectorAll('[data-slot="page-shell"]'),
          '外枠の部品が入れ子になっています（版面が二重に掛かります）',
        ).toHaveLength(1);
      });

      it('版面の段は本文系で、面の側は独自の値を 1 つも足さない（要件 1.5）', async () => {
        await renderPage(branch.data);
        const main = theMain();

        // 段の宣言そのもの。描画結果から段が読めることを先に固定する。
        expect(main.getAttribute('data-width'), '版面の段が本文系ではありません').toBe('sm');

        const { missing, extras, actual } = compareUtilities(
          main,
          pageShellVariants({ width: 'sm' }),
        );
        // **否定の前に非空アンカーを置く。** クラスを 1 つも読めていないと、以下の
        // 「差が無い」は抽出の破綻を成功と読む。
        expect(actual.length, '版面のクラスを 1 つも読み取れていません').toBeGreaterThan(0);
        expect(missing, `部品が持つ版面の値が描画結果から欠けています: ${actual.join(' ')}`).toEqual(
          [],
        );
        expect(
          extras,
          `面の側が版面へ独自の値を足しています（幅・余白は部品の段が持つ）: ${actual.join(' ')}`,
        ).toEqual([]);
      });
    });
  }

  it('回答可能なら店名がページ見出しとして 1 つだけ描かれ、面の側は下余白だけを足す', async () => {
    await renderPage(READY);

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings, 'ページ見出しが 1 つではありません').toHaveLength(1);
    const heading = headings[0]!;
    // 読み上げられる名前は店名そのもの（Requirement 3.2: 名前を変えない）。
    expect(heading.textContent).toBe(STORE_NAME);
    expect(heading.getAttribute('data-slot'), '見出しが部品を通っていません').toBe('heading');
    expect(heading.getAttribute('data-level')).toBe('1');

    // 見出しの寸法・太さ・行間は階層（level）から部品が導く。面の側が持つのは版面上の下余白だけで、
    // 着手前にあった字間の独自指定はここに戻ってこない。
    const { missing, extras, actual } = compareUtilities(heading, headingVariants({ size: '2xl' }));
    expect(actual.length, '見出しのクラスを 1 つも読み取れていません').toBeGreaterThan(0);
    expect(missing, `部品が持つ見出しの値が欠けています: ${actual.join(' ')}`).toEqual([]);
    expect(extras, `面の側が見出しへ足したユーティリティ: ${actual.join(' ')}`).toEqual(['mb-8']);
  });

  it('回答不可ならページ見出しを描かず、案内文だけを出す', async () => {
    await renderPage(UNAVAILABLE);

    expect(screen.queryAllByRole('heading'), '回答不可の分岐に見出しがあります').toHaveLength(0);
    // 文言は相等で固定する。包含だと追記が素通りする。
    expect(theMain().textContent).toBe('このアンケートは現在ご利用いただけません。');
  });
});
