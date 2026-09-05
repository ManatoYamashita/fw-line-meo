import { expect, type Page } from '@playwright/test';

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
  competitors: [
    { name: '近隣の競合店舗としては最も名前の長いケース 丸の内本店', rating: 4.5, reviewCount: 2310, starDiff: 0.2 },
    { name: '喫茶店 B', rating: 4.1, reviewCount: 880, starDiff: -0.2 },
    { name: '喫茶店 C', rating: 4.0, reviewCount: 655, starDiff: -0.3 },
    { name: '喫茶店 D', rating: 3.8, reviewCount: 431, starDiff: -0.5 },
    { name: '喫茶店 E', rating: 3.6, reviewCount: 210, starDiff: -0.7 },
  ],
  // 保持窓の上限（直近 30 日）。行数が最大のときに測る。
  trend: trendPoints(30),
} as const;

// --- 面を開く手順 ----------------------------------------------------------------------
//
// 横スクロール実測（store-surface.spec.ts）と自動 a11y 監査（a11y-audit.spec.ts）の双方が
// 同じ手順で開く。複写にしないのは、前提 assert が片方だけ古びても誰も検出できないためで、
// これは @fwlm/e2e-support を切り出したのと同じ理由による（Issue #53）。

/** 詳細データを固定 fixture で供給する。DB も LINE の検証エンドポイントも起こさない。 */
export async function stubDetailApi(page: Page): Promise<void> {
  await page.route('**/api/detail*', async (route) => {
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
