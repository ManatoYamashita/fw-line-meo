import { expect, type Page, type Request } from '@playwright/test';

// 店舗詳細 E2E の固定データ（Issue #53）。
//
// DB を起こさず page.route() で供給する。実データに寄せるのではなく、**面を最も横へ広げる
// 値**を意図的に置いている。横スクロールの検証は「最悪ケースで溢れないこと」を測るものであり、
// たまたま短い名前のシードで緑になっても何も担保しない。
//
// 形は lib/contract.ts の StoreDetailResponse に一致させる（型で縛らないのは、面のソースから
// import すると e2e が面の内部構造へ依存するため。形が壊れたときは描画の assert が落ちる）。

/** 実在店舗名のうち長い部類（seed.sql と同じ店舗）。主見出しを最も横へ広げる。 */
export const STORE_NAME = 'スターバックス コーヒー リザーブ ロースタリー 東京';

export const STORE_ID = '44444444-4444-4444-4444-444444444444';

function trendPoints(count: number): Array<{
  capturedOn: string;
  rank: number | null;
  rating: string | null;
  reviewCount: number | null;
}> {
  const points = [];
  for (let i = 0; i < count; i += 1) {
    const day = String(i + 1).padStart(2, '0');
    points.push({
      capturedOn: `2026-08-${day}`,
      rank: 3 + (i % 4),
      rating: (4.0 + (i % 10) / 10).toFixed(1),
      // 4 桁台。桁数が増えるほど表は横へ広がるため、現実に起こりうる上限側を置く。
      reviewCount: 1200 + i * 7,
    });
  }
  return points;
}

export const DETAIL_RESPONSE = {
  storeId: STORE_ID,
  storeName: STORE_NAME,
  // 単店。複数店にすると「店舗を切り替える」リンクが増え、面の構成が変わる。
  stores: [{ storeId: STORE_ID, name: STORE_NAME }],
  summary: {
    summaryDate: '2026-08-30',
    status: 'succeeded',
    rank: 3,
    rankTotal: 24,
    rankPrev: 5,
    rating: '4.3',
    reviewCount: 1432,
    ratingPrev: '4.2',
    reviewCountPrev: 1425,
    newReviewCount: 2,
    newReviews: [
      {
        authorName: '長い表示名を持つ投稿者のケース',
        publishTime: '2026-08-30T09:12:00Z',
        rating: 5,
        textExcerpt: '焙煎の香りが素晴らしく、席の間隔も広くて落ち着いて過ごせました。',
      },
      {
        authorName: '山田',
        publishTime: '2026-08-30T11:40:00Z',
        rating: 3,
        textExcerpt: '混雑していて席を確保するまで時間がかかりました。',
      },
    ],
  },
  // 星差は「自店 − 競合」（自店 4.3 に対して 4.5 の店は -0.2）。
  competitors: [
    { name: '近隣の競合店舗としては最も名前の長いケース 丸の内本店', rating: 4.5, reviewCount: 2310, starDiff: -0.2 },
    { name: '喫茶店 B', rating: 4.1, reviewCount: 880, starDiff: 0.2 },
    { name: '喫茶店 C', rating: 4.0, reviewCount: 655, starDiff: 0.3 },
    { name: '喫茶店 D', rating: 3.8, reviewCount: 431, starDiff: 0.5 },
    { name: '喫茶店 E', rating: 3.6, reviewCount: 210, starDiff: 0.7 },
  ],
  // 保持窓の上限（直近 30 日）。行数が最大のときに測る。
  trend: trendPoints(30),
} as const;

// --- 面を開く手順 ----------------------------------------------------------------------
//
// 横スクロール実測（store-surface.spec.ts）と自動 a11y 監査（a11y-audit.spec.ts）の双方が
// 同じ手順で開く。複写にしないのは、前提 assert が片方だけ古びても誰も検出できないためで、
// これは @fwlm/e2e-support を切り出したのと同じ理由による（Issue #53）。

/** 詳細の取得の経路。面が出すサーバーへの要求は、この経路への GET の 1 本だけである。 */
const DETAIL_API_PATH = '/api/detail';

/** 詳細データを固定 fixture で供給する。DB も LINE の検証エンドポイントも起こさない。 */
export async function stubDetailApi(page: Page): Promise<void> {
  await page.route(`**${DETAIL_API_PATH}*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(DETAIL_RESPONSE),
    });
  });
}

/**
 * 面が「エラー画面ではなく本体」を描いていることを先に固定する。
 *
 * これが無いと、LIFF の差し替えが効かずエラー文言だけの画面になったときに、後続の assert は
 * 当然のように緑を返す。**測る対象が消えたことを緑と読まないための前置きである。**
 * a11y 監査にとっても同じで、空の画面には違反が出ようがない。
 */
export async function openStoreSurface(page: Page): Promise<void> {
  await stubDetailApi(page);
  await page.goto('/store');
  await expect(page.getByRole('heading', { level: 1, name: STORE_NAME })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(DETAIL_RESPONSE.trend.length + 1);
}

// --- 表示状態の一覧 ----------------------------------------------------------------------
//
// 横スクロールの実測と自動 a11y 監査は、既定の表示だけでなく、操作で入れる状態にも当てる
// （store-detail-trend-dashboard の要件 9.4・Issue #265）。状態の一覧は、面を開く手順と同じこの
// モジュールに置く。監査の spec が状態を得る経路を fixtures の 1 箇所に保つためであり、別の
// fixture モジュールへ分けると、a11y 監査の前提の検査（scripts/check-a11y-audit-preconditions.sh）が
// 求める「開く手順と前提 assert の同居」が崩れる。
//
// 各状態の入口は、次の順に進む。
//   1. 既存の開き方（openStoreSurface）で面を開く。
//   2. 操作する。
//   3. 操作後の状態を確かめる。操作が効かないまま既定の表示を測って緑になる、という空振りを防ぐため、
//      選択状態・見出し・行数・件数の文言を、その状態で描かれているはずの値と照合する。
//   4. 最後に、詳細の取得がちょうど 1 回だったことを確かめる。操作はサーバーへ追加の要求を送らない
//      （要件 7.3）。実ブラウザでは、操作が遷移や再読み込みを起こすと 2 回目の取得として現れる。

/** 表示状態の 1 つ。`open` は面を開いてその状態へ進め、操作が効いたことを確かめてから返る。 */
export interface StoreSurfaceState {
  /** 状態の名前。検査の失敗の報告に使う。 */
  readonly name: string;
  readonly open: (page: Page) => Promise<void>;
}

/** 操作の後で、面が描いているはずの表示。 */
interface ExpectedView {
  /** 選ばれている期間の札の名前。 */
  readonly period: string;
  /** 選ばれている指標の札の名前。 */
  readonly metric: string;
  /**
   * グラフの名前（説明文）の冒頭の文（指標と期間を述べる文）。名前がこの文を含むことで照合する（部分一致）。
   * 指標と期間の札が、札の選択状態だけでなくグラフにも効いたことを確かめる。説明文の日付は「8月1日」の
   * 書式である（figcaption の「8/1」とは書式が違う）。
   */
  readonly chartName: string;
  /** 推移の節の見出し。 */
  readonly trendHeading: string;
  /** 推移の表のデータ行の数（列見出しの行を除く）。 */
  readonly trendRows: number;
  /** 競合の一覧に残る店の数。 */
  readonly visibleCompetitors: number;
}

/**
 * 検索 0 件の状態で打つ検索語。どの競合の名前にも含まれない、区切りの無い長い英字列にする。
 * 長い検索語は、狭い幅で検索欄が溢れないことを確かめる材料にもなる（要件 6.4）。
 */
const NO_MATCH_QUERY = 'NoCompetitorNameContainsThisVeryLongLatinSearchTermWithoutAnySpaces';

/** 競合の総数（評価の無い店も数える）。件数の文言の「競合{総数}店」になる。 */
const COMPETITOR_TOTAL = DETAIL_RESPONSE.competitors.length;

/**
 * 絞り込みの結果が 0 件のときの案内。空状態の見える文言であり、件数の文言（role="status"）が
 * 読み上げる回復方法でもある（2026-09-18 の画面レビュー）。
 */
const NO_MATCH_TEXT = '該当する競合がいません。店名の一部で絞り込み直すか、入力を消すと一覧に戻ります。';

/**
 * 既定の表示。fixture の推移は 8/1〜8/30 の連続した 30 日なので、既定の 30 日の窓には 30 行が入る。
 * 7 日の窓は、終点の 8/30 を含めて遡った 7 日（8/24〜8/30）で、7 行が入る。
 */
const DEFAULT_VIEW: ExpectedView = {
  period: '30日',
  metric: '順位',
  chartName: '順位の推移、8月1日から8月30日まで。',
  trendHeading: '直近30日の推移',
  trendRows: 30,
  visibleCompetitors: COMPETITOR_TOTAL,
};

/**
 * 詳細の取得（`/api/detail` への要求）を、呼んだ時点から記録する。記録は「メソッド 経路」の文字列で持つ。
 * スタブ（stubDetailApi）の応答の回数ではなく、ページが出した要求そのものを数える。
 * 数えるのは、照合する時点までに出た要求だけである。操作の後に遅れて出る要求（間を置いてから送る要求など）は、
 * この記録の範囲の外にある（250ms 遅らせた要求は捕まらないことを実測した）。
 */
function recordDetailRequests(page: Page): { readonly requests: readonly string[]; readonly stop: () => void } {
  const requests: string[] = [];
  const listener = (request: Request): void => {
    const { pathname } = new URL(request.url());
    if (pathname === DETAIL_API_PATH) {
      requests.push(`${request.method()} ${pathname}`);
    }
  };
  page.on('request', listener);
  return {
    requests,
    stop: () => {
      page.off('request', listener);
    },
  };
}

/** 操作の後の表示を、期待する表示と照合する。 */
async function expectView(page: Page, view: ExpectedView): Promise<void> {
  // 選択状態: 期間と指標の札が 1 つずつ選ばれ、それが期待する札である。
  await expect(page.getByRole('radio', { name: view.period, exact: true })).toBeChecked();
  await expect(page.getByRole('radio', { name: view.metric, exact: true })).toBeChecked();
  await expect(page.getByRole('radio', { checked: true })).toHaveCount(2);
  await expect(page.getByRole('img', { name: view.chartName })).toBeVisible();

  // 見出しと行数: 推移の節の見出しと表は、選んだ期間の窓に揃う。
  await expect(page.getByRole('heading', { level: 2, name: view.trendHeading, exact: true })).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(view.trendRows + 1);

  // 件数の文言と一覧: 一覧に残る店の数と文言が一致し、0 件のときだけ空状態の案内が出る。
  //
  // 0 件のときは、件数の文言に回復方法が続く（2026-09-18 の画面レビュー）。0 件の案内は一覧の側の
  // 空状態が持つが、そちらは役割を持たないので、入力欄に留まったままの利用者には「0店を表示」しか
  // 届かなかった。**0 件以外では続かないことも、この期待値が同時に固定する。**
  const competitors = page
    .getByRole('heading', { level: 2, name: '競合との比較' })
    .locator('xpath=ancestor::section[1]');
  const count = `競合${COMPETITOR_TOTAL}店のうち${view.visibleCompetitors}店を表示`;
  await expect(competitors.getByRole('status')).toHaveText(
    view.visibleCompetitors === 0 ? `${count}。${NO_MATCH_TEXT}` : count,
  );
  await expect(competitors.locator('li')).toHaveCount(view.visibleCompetitors);
  // 見える案内は空状態の側にある。**空状態に限って数える**。件数の文言にも同じ文が入るようになったので、
  // 節の全体から文字で数えると 0 件のとき 2 になり、見える案内が消えても件数の文言だけで 1 に見えてしまう。
  await expect(competitors.locator('[data-slot="empty-state"]').getByText(NO_MATCH_TEXT)).toHaveCount(
    view.visibleCompetitors === 0 ? 1 : 0,
  );
}

/** 状態の入口を作る。`operate` を省くと、開いたままの既定の表示を確かめる。 */
function surfaceState(
  name: string,
  view: ExpectedView,
  operate?: (page: Page) => Promise<void>,
): StoreSurfaceState {
  return {
    name,
    open: async (page) => {
      const detail = recordDetailRequests(page);
      await openStoreSurface(page);
      if (operate !== undefined) {
        await operate(page);
      }
      await expectView(page, view);
      expect(detail.requests, `${name}: 詳細の取得は面を開いたときの 1 回だけのはず`).toEqual([
        `GET ${DETAIL_API_PATH}`,
      ]);
      detail.stop();
    },
  };
}

/**
 * 横スクロールの実測と自動 a11y 監査を当てる、4 つの表示状態（要件 9.4）。回った状態の数は、使う側の
 * spec が宣言と完全一致で固定する。
 */
export const STORE_SURFACE_STATES: readonly StoreSurfaceState[] = [
  surfaceState('既定', DEFAULT_VIEW),
  surfaceState(
    '指標＝評価',
    { ...DEFAULT_VIEW, metric: '評価', chartName: '評価の推移、8月1日から8月30日まで。' },
    async (page) => {
      await page.getByRole('radio', { name: '評価', exact: true }).click();
    },
  ),
  surfaceState(
    '期間＝7 日',
    {
      ...DEFAULT_VIEW,
      period: '7日',
      chartName: '順位の推移、8月24日から8月30日まで。',
      trendHeading: '直近7日の推移',
      trendRows: 7,
    },
    async (page) => {
      await page.getByRole('radio', { name: '7日', exact: true }).click();
    },
  ),
  surfaceState('検索 0 件', { ...DEFAULT_VIEW, visibleCompetitors: 0 }, async (page) => {
    await page.getByRole('searchbox', { name: '店名で絞り込む' }).fill(NO_MATCH_QUERY);
  }),
];
