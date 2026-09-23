import { expect, type Page, type Request } from '@playwright/test';

// 店舗詳細 E2E の固定データ（Issue #53）。
//
// DB を起こさず page.route() で供給する。実データに寄せるのではなく、**面を最も横へ広げる
// 値**を意図的に置いている。横スクロールの検証は「最悪ケースで溢れないこと」を測るものであり、
// たまたま短い名前のシードで緑になっても何も担保しない。
//
// 形は lib/contract.ts の StoreDetailResponse に一致させる（型で縛らないのは、面のソースから
// import すると e2e が面の内部構造へ依存するため。形が壊れたときは描画の assert が落ちる）。
// ただし**形そのものはこのモジュールの中で型として宣言する**（Issue #286）。既定の応答から
// 派生させた応答（推移 0 件・競合 1 店など）を作るには、派生体と既定が同じ形であることを
// 型で確かめられる必要があるためである。面のソースへは依然として依存しない。

/** 推移の 1 点。値の欠落は null で表す（Places が 0 件店の rating を省くのと同じ形）。 */
interface TrendPoint {
  readonly capturedOn: string;
  readonly rank: number | null;
  readonly rating: string | null;
  readonly reviewCount: number | null;
}

/** 競合 1 店の比較行。 */
interface CompetitorRow {
  readonly name: string;
  readonly rating: number | null;
  readonly reviewCount: number | null;
  readonly starDiff: number | null;
}

/**
 * 新着クチコミ 1 件。
 *
 * 後ろの 3 つは Places の帰属情報で、Go が空でないときだけ書く（Issue #287）。面は
 * googleMapsUri と authorName が揃った口コミだけ内容を出すので、既定の応答は揃った形にする。
 */
interface NewReview {
  readonly authorName: string;
  readonly publishTime: string;
  readonly rating: number;
  readonly textExcerpt: string;
  readonly authorUri?: string;
  readonly authorPhotoUri?: string;
  readonly googleMapsUri?: string;
}

/** 詳細 API の応答の形。 */
interface DetailResponse {
  readonly storeId: string;
  readonly storeName: string;
  readonly stores: readonly { readonly storeId: string; readonly name: string }[];
  readonly summary: {
    readonly summaryDate: string;
    readonly status: string;
    readonly rank: number | null;
    readonly rankTotal: number | null;
    readonly rankPrev: number | null;
    readonly rating: string | null;
    readonly reviewCount: number | null;
    readonly ratingPrev: string | null;
    readonly reviewCountPrev: number | null;
    readonly newReviewCount: number;
    readonly newReviews: readonly NewReview[];
    readonly googleMapsReviewsUri: string | null;
  };
  readonly competitors: readonly CompetitorRow[];
  readonly trend: readonly TrendPoint[];
}

/** 実在店舗名のうち長い部類（seed.sql と同じ店舗）。主見出しを最も横へ広げる。 */
export const STORE_NAME = 'スターバックス コーヒー リザーブ ロースタリー 東京';

export const STORE_ID = '44444444-4444-4444-4444-444444444444';

function trendPoints(count: number): TrendPoint[] {
  const points: TrendPoint[] = [];
  for (let i = 0; i < count; i += 1) {
    const day = String(i + 1).padStart(2, '0');
    points.push({
      capturedOn: `2026-08-${day}`,
      rank: 3 + (i % 4),
      rating: (4.0 + (i % 10) / 10).toFixed(1),
      // 4 桁台。桁数が増えるほど表は横へ広がるため、現実に起こりうる上限側を置く。
      // 最終日は 2274 件になる。iPhone 幅で末尾の 1 桁が欠けた Issue #286 の報告値を、そのまま網に置く。
      reviewCount: 2071 + i * 7,
    });
  }
  return points;
}

export const DETAIL_RESPONSE: DetailResponse = {
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
        authorUri: 'https://www.google.com/maps/contrib/100000000000000000001',
        // 画像は取りに行かせない（外部への通信を e2e に持ち込まない）。読み込めない URL でも、
        // 面が img を描くこと・その分の幅を取ることは測れる。
        authorPhotoUri: 'https://lh3.googleusercontent.com/a/e2e-avatar-1',
        googleMapsUri: 'https://www.google.com/maps/reviews/data=e2e-review-1',
      },
      {
        authorName: '山田',
        publishTime: '2026-08-30T11:40:00Z',
        rating: 3,
        textExcerpt: '混雑していて席を確保するまで時間がかかりました。',
        authorUri: 'https://www.google.com/maps/contrib/100000000000000000002',
        authorPhotoUri: 'https://lh3.googleusercontent.com/a/e2e-avatar-2',
        googleMapsUri: 'https://www.google.com/maps/reviews/data=e2e-review-2',
      },
    ],
    // 店舗の口コミ一覧の URL（Issue #303）。新着 2 件を 2 件とも出せているので、この面に一覧への
    // 導線は現れない（URL を持っているだけでは増えない）。値を持つ形で置くのは、本番の行と同じ
    // 形にしておくためである。
    googleMapsReviewsUri: 'https://www.google.com/maps/place//data=e2e-store-reviews',
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
};

// --- 既定の応答から派生させた応答（Issue #286） --------------------------------------------
//
// 自動 a11y 監査と横スクロールの実測が当たっていなかった表示状態を作るための応答である。
// いずれも既定の応答からの差分で書き、競合や推移のほかの性質（長い店名・4 桁のクチコミ数）は保つ。

/** 7 日の窓の始点。既定の推移の終点（8/30）から遡った 7 日目にあたる。 */
const SHORT_WINDOW_START = '2026-08-24';

/**
 * グラフ 0 件の応答。**7 日の窓に入る点だけ**順位を欠落させる。
 *
 * 応答を丸ごと空にしないのは、2 つの出どころ（30 日の窓と 7 日の窓）が食い違う fixture を最低 1 つ
 * 置くという規律（tasks.md の Implementation Notes）に従うためである。既定の 30 日では線が描かれ、
 * 「7日」を押した瞬間に選択中の指標の値が窓から消えて、グラフが空状態へ落ちる。
 */
const GRAPH_EMPTY_RESPONSE: DetailResponse = {
  ...DETAIL_RESPONSE,
  trend: DETAIL_RESPONSE.trend.map((point) =>
    point.capturedOn >= SHORT_WINDOW_START ? { ...point, rank: null } : point,
  ),
};

/** 推移 0 件の応答。窓そのものが作れないので、節は見出しと案内だけになり、選択肢も表も消える。 */
const NO_TREND_RESPONSE: DetailResponse = { ...DETAIL_RESPONSE, trend: [] };

/** 競合 1 店の応答。検索欄の下限（2 店）を下回るので、検索欄と件数の文言ごと消える。名前の長い店を残す。 */
const SINGLE_COMPETITOR_RESPONSE: DetailResponse = {
  ...DETAIL_RESPONSE,
  competitors: DETAIL_RESPONSE.competitors.slice(0, 1),
};

/** 競合 0 件の応答。検索欄が消えたうえで、一覧そのものが空状態の案内に置き換わる。 */
const NO_COMPETITOR_RESPONSE: DetailResponse = { ...DETAIL_RESPONSE, competitors: [] };

/**
 * 記録が窓に満たない応答（Issue #286 項目 1）。推移を 8/1〜8/5 の 5 日ぶんにする。
 *
 * 終点は 8/5 なので、既定の 30 日の窓の公称の始点は 7/7 まで遡り、値を読んだ最初の日（8/1）と
 * 食い違う。登録から日の浅い店がこの状態にあたる。**この面で、要約の組に期間が添う唯一の状態である。**
 */
const SHORT_HISTORY_RESPONSE: DetailResponse = { ...DETAIL_RESPONSE, trend: trendPoints(5) };

/**
 * 指標ごとに要約期間が違う応答。7 日の窓のうち、順位と評価だけ最初の 3 日を欠落させる。
 * クチコミ数は 7 日を埋めるため、期間注記は前 2 組だけに現れる。
 */
const DIVERGENT_SUMMARY_RESPONSE: DetailResponse = {
  ...DETAIL_RESPONSE,
  trend: trendPoints(7).map((point, index) =>
    index < 3 ? { ...point, rank: null, rating: null } : point,
  ),
};

/** 順位だけ最終日の 1 件にした応答。「記録 8/7」という単日の書式を実ブラウザで描く。 */
const SINGLE_DAY_SUMMARY_RESPONSE: DetailResponse = {
  ...DETAIL_RESPONSE,
  trend: trendPoints(7).map((point, index) =>
    index < 6 ? { ...point, rank: null } : point,
  ),
};

// --- 面を開く手順 ----------------------------------------------------------------------
//
// 横スクロール実測（store-surface.spec.ts）と自動 a11y 監査（a11y-audit.spec.ts）の双方が
// 同じ手順で開く。複写にしないのは、前提 assert が片方だけ古びても誰も検出できないためで、
// これは @fwlm/e2e-support を切り出したのと同じ理由による（Issue #53）。

/** 詳細の取得の経路。面が出すサーバーへの要求は、この経路への GET の 1 本だけである。 */
const DETAIL_API_PATH = '/api/detail';

/** page.route() に渡す経路のパターン。unroute にも同じ値を使う。 */
const DETAIL_API_GLOB = `**${DETAIL_API_PATH}*`;

/**
 * 詳細データを固定 fixture で供給する。DB も LINE の検証エンドポイントも起こさない。
 *
 * **先に unroute してから route を登録する**（Issue #286）。監査は 1 つの page で 11 の状態を
 * 回すので、状態ごとに route を足すと登録が積み上がる。「後から登録した経路が先に当たる」という
 * 挙動に寄りかからず、明示で外してから入れる。なお、古い経路が勝った場合は供給した応答と
 * 描画が食い違うので、各状態の expectView（推移の表の有無・競合の件数）が赤になる。
 */
export async function stubDetailApi(page: Page, response: DetailResponse = DETAIL_RESPONSE): Promise<void> {
  await page.unroute(DETAIL_API_GLOB);
  await page.route(DETAIL_API_GLOB, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(response),
    });
  });
}

/** Google の帰属表示。どの表示状態でも面に出ている（面が本体を描けていることの手掛かりの 1 つ）。 */
const ATTRIBUTION_TEXT = 'データ提供: Google Maps';

/**
 * 面が「エラー画面ではなく本体」を描いていることを先に固定する。
 *
 * これが無いと、LIFF の差し替えが効かずエラー文言だけの画面になったときに、後続の assert は
 * 当然のように緑を返す。**測る対象が消えたことを緑と読まないための前置きである。**
 * a11y 監査にとっても同じで、空の画面には違反が出ようがない。
 *
 * 推移の表は、応答に推移の点が 1 つも無いと描かれない（Issue #286 で足した状態）。そこで
 * **「表があるときだけ確かめる」形にはしない。** 期待する件数を応答から値として導き、assert 自体は
 * どの状態でも必ず実行する。条件で assert ごと飛ばすと、表が消えた状態だけが前提の網の外へ出る。
 * なお、どの応答も推移の点はすべて既定の 30 日の窓に入る（表の行数は点の数と等しい）。
 */
export async function openStoreSurface(page: Page, response: DetailResponse = DETAIL_RESPONSE): Promise<void> {
  await stubDetailApi(page, response);
  await page.goto('/store');
  await expect(page.getByRole('heading', { level: 1, name: response.storeName })).toBeVisible();
  await expect(page.getByText(ATTRIBUTION_TEXT)).toBeVisible();
  const hasTrend = response.trend.length > 0;
  await expect(page.getByRole('table')).toHaveCount(hasTrend ? 1 : 0);
  await expect(page.getByRole('row')).toHaveCount(hasTrend ? response.trend.length + 1 : 0);
}

// --- 表示状態の一覧 ----------------------------------------------------------------------
//
// 横スクロールの実測と自動 a11y 監査は、既定の表示だけでなく、操作で入れる状態にも当てる
// （store-detail-trend-dashboard の要件 9.4・Issue #265。応答で作る状態は Issue #286 で足した）。
// 状態の一覧は、面を開く手順と同じこのモジュールに置く。監査の spec が状態を得る経路を fixtures の
// 1 箇所に保つためであり、別の fixture モジュールへ分けると、a11y 監査の前提の検査
// （scripts/check-a11y-audit-preconditions.sh）が求める「開く手順と前提 assert の同居」が崩れる。
//
// 各状態の入口は、次の順に進む。
//   1. その状態の応答を供給し、既存の開き方（openStoreSurface）で面を開く。
//   2. 操作する（操作を伴わない状態もある）。
//   3. 操作後の状態を確かめる。操作が効かないまま既定の表示を測って緑になる、という空振りを防ぐため、
//      選択状態・見出し・行数・件数の文言を、その状態で描かれているはずの値と照合する。
//   4. 最後に、詳細の取得がちょうど 1 回だったことを確かめる。操作はサーバーへ追加の要求を送らない
//      （要件 7.3）。実ブラウザでは、操作が遷移や再読み込みを起こすと 2 回目の取得として現れる。

/**
 * その状態で面に描かれている、構造契約に関わる部品の数（Issue #286）。
 *
 * **3 項目とも必須である。** 省略できる項目を作ると「宣言していない」という状態が生まれ、0 件が
 * 強制の外へ出る。0 は「そこに無いことを宣言した」であって「測っていない」ではない。
 */
interface SurfaceStructure {
  /** 札の入れ子（ラベルの中の並べの箱、その中の radio）の数。推移を描けないときは 0。 */
  readonly chipNesting: number;
  /** 検索欄の並べの箱の数。競合が 2 店に満たないときは 0。 */
  readonly searchField: number;
  /**
   * 実際に横へ捲れる領域（推移の表の容器）の数。
   *
   * `trendTables` から導かない。**表が残ったまま容器が横の捲りを失う事故**こそがこの宣言の
   * 守備範囲であり、表の有無から導くとその事故に反応しなくなる。
   */
  readonly tableScrollRegions: number;
}

/** 表示状態の 1 つ。`open` は面を開いてその状態へ進め、操作が効いたことを確かめてから返る。 */
export interface StoreSurfaceState {
  /** 状態の名前。検査の失敗の報告に使う。 */
  readonly name: string;
  readonly structure: SurfaceStructure;
  readonly open: (page: Page) => Promise<void>;
}

/**
 * 操作の後で、面が描いているはずの表示。
 *
 * **省略できる項目を 1 つも置かない**（Issue #286）。文言は配列で、件数は数で書く。空の配列と 0 は
 * 「その状態には無い」という実在の表明であり、条件分岐ではない。状態を足すときに書き忘れると
 * 型検査が赤くなるので、「宣言していない」という状態が存在しえない。
 */
interface ExpectedView {
  /** 選ばれている札の名前（期間と指標）。推移を描けないときは空。 */
  readonly checkedChips: readonly string[];
  /** 面にある radio の総数。推移を描けないときは 0。 */
  readonly chipCount: number;
  /**
   * グラフの名前（説明文）の冒頭の文（指標と期間を述べる文）。名前がこの文を含むことで照合する（部分一致）。
   * 指標と期間の札が、札の選択状態だけでなくグラフにも効いたことを確かめる。説明文の日付は「8月1日」の
   * 書式である（figcaption の「8/1」とは書式が違う）。グラフが空状態へ落ちる状態では空になる。
   */
  readonly chartNames: readonly string[];
  /** 推移の節の見出し。どの状態でも 1 つある（節そのものは消えない）。 */
  readonly trendHeading: string;
  /** 推移の節の読み上げ領域（role="status"）の文言。選択肢が無い状態では空。 */
  readonly trendStatusTexts: readonly string[];
  /** 推移の節の空状態の文言。グラフ 0 件と推移 0 件で中身が違う。 */
  readonly trendEmptyTexts: readonly string[];
  /** 推移の表の数。 */
  readonly trendTables: number;
  /** 推移の表のデータ行の数（列見出しの行を除く）。 */
  readonly trendRows: number;
  /**
   * 期間の要約の組に添えた期間の文言（Issue #286 項目 1）。公称の窓と食い違う組にだけ出るので、
   * 記録が窓を埋めている状態では空になる。既定の応答は 8/1〜8/30 の連続した 30 日で、30 日の窓とも
   * 7 日の窓とも食い違わない。出る側には短い履歴・指標ごとの欠落・単日記録を置く。
   */
  readonly summaryNotes: readonly string[];
  /** 競合の一覧に残る店の数。 */
  readonly visibleCompetitors: number;
  /** 競合の節の読み上げ領域（role="status"）の文言。検索欄が無い状態では空。 */
  readonly competitorStatusTexts: readonly string[];
  /** 競合の節の空状態の文言。 */
  readonly competitorEmptyTexts: readonly string[];
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

/** 競合が 1 店も無いときの案内（面から import せず逐語で写す。面の文言を変えればここが赤くなる）。 */
const NO_COMPETITORS_TEXT = '競合が見つかっていません（自店のみの計測です）';

/** 推移の点が 1 つも無いときの案内。 */
const NO_TREND_TEXT = '推移データはまだありません（毎朝の集計後に表示されます）';

/** 窓の中に選択中の指標の値が無いときの案内（2026-09-18 の画面レビューで空状態の部品へ寄せた）。 */
const NO_METRIC_IN_WINDOW_TEXT =
  'この期間（8/24〜8/30）は順位の記録がありません。ほかの項目や期間に切り替えると表示できることがあります。';

/** 競合の件数の文言。0 件のときだけ回復方法が続く。 */
function competitorCountText(visible: number): string {
  const count = `競合${COMPETITOR_TOTAL}店のうち${visible}店を表示`;
  return visible === 0 ? `${count}。${NO_MATCH_TEXT}` : count;
}

/**
 * 既定の表示。fixture の推移は 8/1〜8/30 の連続した 30 日なので、既定の 30 日の窓には 30 行が入る。
 * 7 日の窓は、終点の 8/30 を含めて遡った 7 日（8/24〜8/30）で、7 行が入る。
 * 最新の点（8/30）は順位 4 位・評価 4.9 である（trendPoints の式から導かれる値をここへ写す）。
 */
const DEFAULT_VIEW: ExpectedView = {
  checkedChips: ['30日', '順位'],
  chipCount: 5,
  chartNames: ['順位の推移、8月1日から8月30日まで。'],
  trendHeading: '直近30日の推移',
  trendStatusTexts: ['順位の推移、直近30日。最新 4位（8/30）。'],
  trendEmptyTexts: [],
  trendTables: 1,
  trendRows: 30,
  // 8/1〜8/30 が 30 日の窓をちょうど埋めるので、どの組にも期間が添わない。
  summaryNotes: [],
  visibleCompetitors: COMPETITOR_TOTAL,
  competitorStatusTexts: [competitorCountText(COMPETITOR_TOTAL)],
  competitorEmptyTexts: [],
};

/** 推移を描けている通常幅の構造（札 5・検索欄 1・横捲りを担える表の容器 1）。 */
const DEFAULT_STRUCTURE: SurfaceStructure = { chipNesting: 5, searchField: 1, tableScrollRegions: 1 };

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

/** 節の中だけを見るための locator（見出しの祖先の section）。 */
function sectionOf(page: Page, headingName: string): ReturnType<Page['locator']> {
  return page
    .getByRole('heading', { level: 2, name: headingName, exact: true })
    .locator('xpath=ancestor::section[1]');
}

/** 操作の後の表示を、期待する表示と照合する。**どの項目の assert も無条件に走る。** */
async function expectView(page: Page, view: ExpectedView): Promise<void> {
  // 選択状態: 期待する札が選ばれ、選ばれている札の数と radio の総数が宣言と一致する。
  for (const chip of view.checkedChips) {
    await expect(page.getByRole('radio', { name: chip, exact: true })).toBeChecked();
  }
  await expect(page.getByRole('radio', { checked: true })).toHaveCount(view.checkedChips.length);
  await expect(page.getByRole('radio')).toHaveCount(view.chipCount);

  // グラフ: 期待する名前のグラフが 1 つずつあり、グラフの総数が宣言と一致する
  // （0 件の宣言は「グラフが 1 つも無い」ことの表明であり、空状態へ落ちたことの裏付けになる）。
  for (const chartName of view.chartNames) {
    await expect(page.getByRole('img', { name: chartName })).toBeVisible();
  }
  await expect(page.getByRole('img')).toHaveCount(view.chartNames.length);

  // 推移の節: 見出し・読み上げ領域・空状態・表・行数。節の中だけを見るのは、競合の節にも
  // 読み上げ領域と空状態があるためである。
  const trend = sectionOf(page, view.trendHeading);
  await expect(trend).toHaveCount(1);
  await expect(trend.getByRole('status')).toHaveText([...view.trendStatusTexts]);
  await expect(trend.locator('[data-slot="empty-state"]').locator('p')).toHaveText([...view.trendEmptyTexts]);
  await expect(trend.getByRole('table')).toHaveCount(view.trendTables);
  await expect(trend.getByRole('row')).toHaveCount(view.trendRows === 0 ? 0 : view.trendRows + 1);
  // 要約の組に添えた期間（Issue #286 項目 1）。値は素のテキストノードで、注記だけが span なので、
  // この locator は注記だけを拾う。値を span で包む改変が入れば、ここが余分な要素を数えて赤になる。
  await expect(trend.locator('dl dd > span')).toHaveText([...view.summaryNotes]);

  // 競合の節: 件数の文言と一覧に残る店の数、空状態の案内。
  //
  // 0 件のときは、件数の文言に回復方法が続く（2026-09-18 の画面レビュー）。0 件の案内は一覧の側の
  // 空状態が持つが、そちらは役割を持たないので、入力欄に留まったままの利用者には「0店を表示」しか
  // 届かなかった。**0 件以外では続かないことも、この期待値が同時に固定する。**
  //
  // 見える案内は空状態の側にある。**空状態に限って数える**。件数の文言にも同じ文が入るようになったので、
  // 節の全体から文字で数えると 0 件のとき 2 になり、見える案内が消えても件数の文言だけで 1 に見えてしまう。
  const competitors = sectionOf(page, '競合との比較');
  await expect(competitors.getByRole('status')).toHaveText([...view.competitorStatusTexts]);
  await expect(competitors.locator('li')).toHaveCount(view.visibleCompetitors);
  await expect(competitors.locator('[data-slot="empty-state"]').locator('p')).toHaveText([
    ...view.competitorEmptyTexts,
  ]);
}

/** 状態の入口を作る。`operate` を省くと、開いたままの表示を確かめる。 */
function surfaceState(
  name: string,
  spec: {
    readonly response?: DetailResponse;
    readonly view: ExpectedView;
    readonly structure: SurfaceStructure;
    readonly operate?: (page: Page) => Promise<void>;
  },
): StoreSurfaceState {
  return {
    name,
    structure: spec.structure,
    open: async (page) => {
      const detail = recordDetailRequests(page);
      await openStoreSurface(page, spec.response ?? DETAIL_RESPONSE);
      if (spec.operate !== undefined) {
        await spec.operate(page);
      }
      await expectView(page, spec.view);
      expect(detail.requests, `${name}: 詳細の取得は面を開いたときの 1 回だけのはず`).toEqual([
        `GET ${DETAIL_API_PATH}`,
      ]);
      detail.stop();
    },
  };
}

/**
 * 横スクロールの実測と自動 a11y 監査を当てる、11 の表示状態（要件 9.4・Issue #286）。回った状態の数と、
 * 状態ごとの構造の件数の総和は、使う側の spec が宣言と完全一致で固定する。
 *
 * 前の 4 つは操作で入る状態、後の 7 つは応答で入る状態である。応答で入る状態は 2026-09-19 まで
 * 自動監査が一度も当たっていなかった（Issue #286 の項目 6）。**画面レビューの指摘 M1・M2 は、
 * そのうち「グラフ 0 件」の中に住んでいた指摘である。** 最後の 3 状態は期間注記の表示網である。
 *
 * 最初の 4 状態は差分（spread）で書き、応答で入る 7 状態は全項目を書く。後者は差分が多く、spread だと
 * 何を既定から継いだのかが読めなくなるためである。なお spread で書いた状態は、`ExpectedView` に
 * 項目を足したとき既定の値を黙って継ぐ。項目を足すときは、その 4 状態の値を個別に見直すこと。
 */
export const STORE_SURFACE_STATES: readonly StoreSurfaceState[] = [
  surfaceState('既定', { view: DEFAULT_VIEW, structure: DEFAULT_STRUCTURE }),
  surfaceState('指標＝評価', {
    view: {
      ...DEFAULT_VIEW,
      checkedChips: ['30日', '評価'],
      chartNames: ['評価の推移、8月1日から8月30日まで。'],
      trendStatusTexts: ['評価の推移、直近30日。最新 4.9（8/30）。'],
    },
    structure: DEFAULT_STRUCTURE,
    operate: async (page) => {
      await page.getByRole('radio', { name: '評価', exact: true }).click();
    },
  }),
  surfaceState('期間＝7 日', {
    view: {
      ...DEFAULT_VIEW,
      checkedChips: ['7日', '順位'],
      chartNames: ['順位の推移、8月24日から8月30日まで。'],
      trendHeading: '直近7日の推移',
      trendStatusTexts: ['順位の推移、直近7日。最新 4位（8/30）。'],
      trendRows: 7,
    },
    structure: DEFAULT_STRUCTURE,
    operate: async (page) => {
      await page.getByRole('radio', { name: '7日', exact: true }).click();
    },
  }),
  surfaceState('検索 0 件', {
    view: {
      ...DEFAULT_VIEW,
      visibleCompetitors: 0,
      competitorStatusTexts: [competitorCountText(0)],
      competitorEmptyTexts: [NO_MATCH_TEXT],
    },
    structure: DEFAULT_STRUCTURE,
    operate: async (page) => {
      await page.getByRole('searchbox', { name: '店名で絞り込む' }).fill(NO_MATCH_QUERY);
    },
  }),
  // --- ここから、応答で入る 7 状態（Issue #286） ---
  surfaceState('グラフ 0 件', {
    response: GRAPH_EMPTY_RESPONSE,
    view: {
      checkedChips: ['7日', '順位'],
      chipCount: 5,
      // グラフは空状態へ落ちるので、role="img" は 1 つも無い。
      chartNames: [],
      trendHeading: '直近7日の推移',
      // M1 の網。選択の結果を読み上げへ届ける領域は、記録が無い期間でも残る。
      trendStatusTexts: ['順位の推移、直近7日。この期間は記録がありません。'],
      // M2 の網。素の段落ではなく空状態の部品で描き、文言に窓の期間が入る。
      trendEmptyTexts: [NO_METRIC_IN_WINDOW_TEXT],
      // 表は残る（順位の列が「—」になるだけで、行は窓の点の数だけある）。
      trendTables: 1,
      trendRows: 7,
      // 順位は組そのものが記号になり、評価とクチコミ数は 7 日の窓（8/24〜8/30）を埋めている。
      summaryNotes: [],
      visibleCompetitors: COMPETITOR_TOTAL,
      competitorStatusTexts: [competitorCountText(COMPETITOR_TOTAL)],
      competitorEmptyTexts: [],
    },
    structure: DEFAULT_STRUCTURE,
    operate: async (page) => {
      await page.getByRole('radio', { name: '7日', exact: true }).click();
    },
  }),
  surfaceState('推移 0 件', {
    response: NO_TREND_RESPONSE,
    view: {
      // 窓が作れないので選択肢そのものが無い。**この面で唯一、札が 0 件になる状態である。**
      checkedChips: [],
      chipCount: 0,
      chartNames: [],
      trendHeading: '直近30日の推移',
      // 選択肢が無いので状態通知も無い（page.tsx の TrendSection が明示でそう定めている）。
      trendStatusTexts: [],
      trendEmptyTexts: [NO_TREND_TEXT],
      trendTables: 0,
      trendRows: 0,
      // 窓が無いので要約の組そのものが描かれない。
      summaryNotes: [],
      visibleCompetitors: COMPETITOR_TOTAL,
      competitorStatusTexts: [competitorCountText(COMPETITOR_TOTAL)],
      competitorEmptyTexts: [],
    },
    // 表が無いので捲れる領域も無い。
    structure: { chipNesting: 0, searchField: 1, tableScrollRegions: 0 },
  }),
  surfaceState('競合 1 店', {
    response: SINGLE_COMPETITOR_RESPONSE,
    view: {
      checkedChips: ['30日', '順位'],
      chipCount: 5,
      chartNames: ['順位の推移、8月1日から8月30日まで。'],
      trendHeading: '直近30日の推移',
      trendStatusTexts: ['順位の推移、直近30日。最新 4位（8/30）。'],
      trendEmptyTexts: [],
      trendTables: 1,
      trendRows: 30,
      summaryNotes: [],
      // 一覧は描かれるが、検索欄の下限（2 店）を下回るので検索欄と件数の文言が消える。
      // **一覧を描きながら検索欄が無いのは、この状態だけの組み合わせである。**
      visibleCompetitors: 1,
      competitorStatusTexts: [],
      competitorEmptyTexts: [],
    },
    structure: { chipNesting: 5, searchField: 0, tableScrollRegions: 1 },
  }),
  surfaceState('競合 0 店', {
    response: NO_COMPETITOR_RESPONSE,
    view: {
      checkedChips: ['30日', '順位'],
      chipCount: 5,
      chartNames: ['順位の推移、8月1日から8月30日まで。'],
      trendHeading: '直近30日の推移',
      trendStatusTexts: ['順位の推移、直近30日。最新 4位（8/30）。'],
      trendEmptyTexts: [],
      trendTables: 1,
      trendRows: 30,
      summaryNotes: [],
      visibleCompetitors: 0,
      competitorStatusTexts: [],
      competitorEmptyTexts: [NO_COMPETITORS_TEXT],
    },
    structure: { chipNesting: 5, searchField: 0, tableScrollRegions: 1 },
  }),
  // --- ここから、記録が窓に満たない状態（Issue #286 項目 1） ---
  surfaceState('記録が窓に満たない', {
    response: SHORT_HISTORY_RESPONSE,
    view: {
      checkedChips: ['30日', '順位'],
      chipCount: 5,
      // 公称の窓は 7/7〜8/5。横軸はこの範囲に固定され、線は 8/1 からしか伸びない。
      chartNames: ['順位の推移、7月7日から8月5日まで。'],
      trendHeading: '直近30日の推移',
      trendStatusTexts: ['順位の推移、直近30日。最新 3位（8/5）。'],
      trendEmptyTexts: [],
      trendTables: 1,
      trendRows: 5,
      // **この面で唯一、要約の組に期間が添う状態である。** 3 組とも 8/1〜8/5 しか読んでいないので
      // 3 つ出る。組ごとに独立して判定しても、この応答では 3 組が同じ日になる。
      summaryNotes: ['記録 8/1〜8/5', '記録 8/1〜8/5', '記録 8/1〜8/5'],
      visibleCompetitors: COMPETITOR_TOTAL,
      competitorStatusTexts: [competitorCountText(COMPETITOR_TOTAL)],
      competitorEmptyTexts: [],
    },
    structure: DEFAULT_STRUCTURE,
  }),
  surfaceState('指標ごとに要約期間が違う', {
    response: DIVERGENT_SUMMARY_RESPONSE,
    view: {
      checkedChips: ['7日', '順位'],
      chipCount: 5,
      chartNames: ['順位の推移、8月1日から8月7日まで。'],
      trendHeading: '直近7日の推移',
      trendStatusTexts: ['順位の推移、直近7日。最新 5位（8/7）。'],
      trendEmptyTexts: [],
      trendTables: 1,
      trendRows: 7,
      summaryNotes: ['記録 8/4〜8/7', '記録 8/4〜8/7'],
      visibleCompetitors: COMPETITOR_TOTAL,
      competitorStatusTexts: [competitorCountText(COMPETITOR_TOTAL)],
      competitorEmptyTexts: [],
    },
    structure: DEFAULT_STRUCTURE,
    operate: async (page) => {
      await page.getByRole('radio', { name: '7日', exact: true }).click();
    },
  }),
  surfaceState('要約の記録が 1 日だけ', {
    response: SINGLE_DAY_SUMMARY_RESPONSE,
    view: {
      checkedChips: ['7日', '順位'],
      chipCount: 5,
      chartNames: ['順位の推移、8月1日から8月7日まで。'],
      trendHeading: '直近7日の推移',
      trendStatusTexts: ['順位の推移、直近7日。最新 5位（8/7）。'],
      trendEmptyTexts: [],
      trendTables: 1,
      trendRows: 7,
      summaryNotes: ['記録 8/7'],
      visibleCompetitors: COMPETITOR_TOTAL,
      competitorStatusTexts: [competitorCountText(COMPETITOR_TOTAL)],
      competitorEmptyTexts: [],
    },
    structure: DEFAULT_STRUCTURE,
    operate: async (page) => {
      await page.getByRole('radio', { name: '7日', exact: true }).click();
    },
  }),
];
