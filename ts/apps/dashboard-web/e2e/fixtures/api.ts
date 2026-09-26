// 管理ダッシュボード E2E の固定データ（Issue #53）。
//
// dashboard-api も DB も起こさず page.route() で供給する。実データに寄せるのではなく、
// **面を最も横へ広げる値**を意図的に置いている。横スクロールの検証は「最悪ケースで溢れない
// こと」を測るものであり、短い名前のシードでたまたま緑になっても何も担保しない。
//
// ロールは operator を使う。agency には見えない「担当代理店」列が加わり、店舗一覧が
// 最も列数の多い状態になるためである（BASE_COLUMN_COUNT + 1）。

import { expect, type Page } from '@playwright/test';

/**
 * API のベースオリジン。**面自身（127.0.0.1:3110）と必ず別にする。**
 *
 * 同一オリジンにすると `**\/stores` のような横取り規則が `/stores` への文書要求まで掴み、
 * ページ遷移そのものが壊れる。ビルド時の NEXT_PUBLIC_API_BASE_URL と同値でなければ
 * 取得が失敗し、各テストの前提 assert が落ちる（fail-closed）。
 */
export const API_ORIGIN = 'http://127.0.0.1:3199';

/** 実在しうる長さの上限側を置く。列幅を決めるのはここである。 */
const LONG_STORE_NAME = 'スターバックス コーヒー リザーブ ロースタリー 東京 中目黒店';
const LONG_AGENCY_NAME = '株式会社ロングネームマーケティングパートナーズ 首都圏支社';

export const ME = {
  id: '00000000-0000-0000-0000-0000000000aa',
  role: 'operator',
  agencyId: null,
  agencyName: null,
  displayName: '運営ユーザー',
} as const;

/**
 * 代理店ロールの利用者（Issue #283）。
 *
 * 帯の案内リンクは運営の 5 本から 3 本へ減るが、**ロールの表示は「運営」より 1 字長い**ので、
 * 帯の 1 段目は代理店の方が広い。運営だけを測ると包含関係にならないため、この口を持つ。
 */
export const AGENCY_ME = {
  id: '00000000-0000-0000-0000-0000000000bb',
  role: 'agency',
  agencyId: '22222222-2222-2222-2222-222222222222',
  agencyName: LONG_AGENCY_NAME,
  displayName: '代理店ユーザー',
} as const;

export const STORES = [
  {
    id: '44444444-4444-4444-4444-444444444444',
    name: LONG_STORE_NAME,
    placeStatus: 'confirmed',
    competitorConfigured: true,
    ownerId: '33333333-3333-3333-3333-333333333333',
    ownerDisplayName: 'オーナー太郎',
    agencyId: '22222222-2222-2222-2222-222222222222',
    agencyName: LONG_AGENCY_NAME,
    createdAt: '2026-08-01T09:00:00.000Z',
    suspendedAt: null,
  },
  {
    id: '44444444-4444-4444-4444-444444444445',
    name: '喫茶 短名',
    placeStatus: 'pending',
    competitorConfigured: false,
    ownerId: '33333333-3333-3333-3333-333333333334',
    ownerDisplayName: null,
    agencyId: '22222222-2222-2222-2222-222222222222',
    agencyName: LONG_AGENCY_NAME,
    createdAt: '2026-08-02T09:00:00.000Z',
    suspendedAt: null,
  },
] as const;

export const AGENCIES = [
  {
    id: '22222222-2222-2222-2222-222222222222',
    operatorId: '11111111-1111-1111-1111-111111111111',
    name: LONG_AGENCY_NAME,
    createdAt: '2026-07-15T09:00:00.000Z',
  },
] as const;

export const DASHBOARD_USERS = [
  {
    id: ME.id,
    role: 'operator',
    operatorId: '11111111-1111-1111-1111-111111111111',
    agencyId: null,
    email: 'operator-with-a-long-address@example.co.jp',
    displayName: '運営ユーザー',
    disabled: false,
    createdAt: '2026-07-01T09:00:00.000Z',
  },
  {
    id: '00000000-0000-0000-0000-0000000000bb',
    role: 'agency',
    operatorId: '11111111-1111-1111-1111-111111111111',
    agencyId: '22222222-2222-2222-2222-222222222222',
    // **行を折り返せる位置を持たない値にする**（区切りは点だけ。ハイフンの後ろでは折り返せるが、
    // 点の後ろでは折り返さない）。ハイフンで区切った値だと、見出し・列がたまたま折り返して幅に
    // 収まり、区切りの無い実在のアドレス（yamada.hanako@… の形）で起きる溢れを見逃す。実際、
    // ハイフンの値のままでは、編集パネルの見出しがカードの外へ出る退行を E2E が拾えなかった
    // （dashboard-user-edit tasks 3.5 の独立レビュー）。
    email: 'agency.member.with.a.long.address@example.co.jp',
    displayName: '代理店ユーザー',
    disabled: true,
    createdAt: '2026-07-20T09:00:00.000Z',
  },
] as const;

export const INVITE_CODES = [
  {
    id: '55555555-5555-5555-5555-555555555551',
    agencyId: '22222222-2222-2222-2222-222222222222',
    code: 'ABCD-EFGH-IJKL',
    disabled: false,
    createdAt: '2026-08-10T09:00:00.000Z',
  },
  {
    id: '55555555-5555-5555-5555-555555555552',
    agencyId: '22222222-2222-2222-2222-222222222222',
    code: 'MNOP-QRST-UVWX',
    disabled: true,
    createdAt: '2026-08-11T09:00:00.000Z',
  },
] as const;

export const OWNERS = [
  {
    id: '33333333-3333-3333-3333-333333333333',
    displayName: 'オーナー太郎',
    onboardingStatus: 'store_identified',
    createdAt: '2026-08-01T09:00:00.000Z',
  },
] as const;

export const CATEGORIES = [
  { code: 'cafe', label: 'カフェ・喫茶店' },
  { code: 'ramen', label: 'ラーメン' },
] as const;

/** パス（クエリを除く）ごとの 200 応答。ここに無いパスは 404 で返し、黙って素通りさせない。 */
const RESPONSES: Record<string, unknown> = {
  '/me': { user: ME },
  '/stores': { stores: STORES },
  '/owners': { owners: OWNERS },
  '/agencies': { agencies: AGENCIES },
  '/dashboard-users': { users: DASHBOARD_USERS },
  '/invite-codes': { inviteCodes: INVITE_CODES },
  '/categories': { categories: CATEGORIES },
};

/**
 * QR 応答の代わりに返す 1×1 の PNG（Issue #179）。
 *
 * **実物の QR は置かない。** 実物は完全な店舗 ID を含む URL を符号化しており、画像として
 * リポジトリへ置くことは実値を書くことと同じである（store-qr-issuance-ui tasks.md の規律）。
 * ここで要るのは「PNG として読み込める非空のバイト列」だけで、符号化の中身は要らない。
 */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** QR エンドポイントのパス（クエリは除いた形で照合する）。 */
const QR_PATH = /^\/stores\/[^/]+\/qr\.png$/;

/** 停止・再開のエンドポイント（store-suspension Issue #252）。捕獲は店舗 ID と操作。 */
const SUSPENSION_PATH = /^\/stores\/([^/]+)\/(suspend|resume)$/;

/** 停止の操作で置く停止時刻。値そのものは画面に出ないので、固定値でよい。 */
const SUSPENDED_AT = '2026-09-23T09:00:00.000Z';

/**
 * dashboard-api への呼び出しを固定 fixture で置き換える。
 *
 * 未知のパスは 404 のエラー封筒で返す。素通りさせると実在しないサーバーへ出て行って
 * ネットワークエラーになり、原因が「fixture の取りこぼし」だと読み取れなくなる。
 *
 * QR だけは JSON ではなく PNG を返す（`RESPONSES` の表に載せられない形のため先に分岐する）。
 *
 * **停止・再開だけは状態を持つ**（store-suspension Issue #252）。POST で店舗の停止時刻を書き換え、
 * 以後の `/stores` はその状態を返す。応答を固定値にすると、画面が読み直した一覧に停止が現れず、
 * 「停止すると表示が変わる」ことを測れない（押下の後に画面が推測で表示を書き換える退行も、
 * 読み直しを省く退行も、固定値の一覧では区別が付かない）。状態は呼び出しごと（＝ページごと）に
 * 持ち、テストの間で漏れない。
 */
export async function stubDashboardApi(
  page: Page,
  options: { readonly me?: unknown } = {},
): Promise<void> {
  // ロールの差し替えは `/me` の 1 件だけを覆う。表全体を作り替えると、覆ったつもりで
  // 他の応答まで変わっていたときに気づけない。
  const responses: Record<string, unknown> =
    options.me === undefined ? RESPONSES : { ...RESPONSES, '/me': { user: options.me } };
  // 店舗 ID → 停止時刻。初期値は STORES の値で、停止・再開の POST だけが書き換える。
  const suspendedAt = new Map<string, string | null>(
    STORES.map((store) => [store.id, store.suspendedAt]),
  );
  await page.route(`${API_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (QR_PATH.test(path)) {
      await route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG });
      return;
    }
    const suspension = SUSPENSION_PATH.exec(path);
    if (suspension !== null && request.method() === 'POST') {
      const id = decodeURIComponent(suspension[1]!);
      if (!suspendedAt.has(id)) {
        // 範囲外・不存在は同じ 404（Requirement 1.4）。fixture の取りこぼしとは別の封筒にする。
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'not_found', message: '店舗が見つかりません' } }),
        });
        return;
      }
      // 既に同じ状態でも 200 で現在の状態を返す（冪等・Requirement 1.5）。停止時刻は最初の停止を保つ。
      const next = suspension[2] === 'suspend' ? (suspendedAt.get(id) ?? SUSPENDED_AT) : null;
      suspendedAt.set(id, next);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ store: { id, suspendedAt: next } }),
      });
      return;
    }
    const body =
      path === '/stores' && request.method() === 'GET'
        ? { stores: STORES.map((store) => ({ ...store, suspendedAt: suspendedAt.get(store.id) })) }
        : responses[path];
    if (body === undefined) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'e2e_fixture_missing', message: `fixture 未定義のパス: ${path}` },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

// --- 面を開く手順 ----------------------------------------------------------------------
//
// 横スクロール実測（dashboard-surfaces.spec.ts）と自動 a11y 監査（a11y-audit.spec.ts）の
// 双方が同じ定義を使う。複写にしないのは、前提 assert が片方だけ古びても誰も検出できない
// ためで、これは @fwlm/e2e-support を切り出したのと同じ理由による（Issue #53）。

/** 未ログイン状態で開く（既定はログイン済み）。ログイン画面そのものを測るために使う。 */
export async function startSignedOut(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('e2e-auth-signed-out', '1');
    } catch {
      // 保存領域が使えない文脈（about:blank 等）では何もしない。
    }
  });
}

/**
 * ログイン時に端末の保存領域エラーが起きた状態を開く（Issue #342）。
 *
 * 内部エラー文が漏れず、利用者が次に取る行動を示した Toast が出ることを前提 assert にする。
 * ボタンが再び操作可能になることも固定し、失敗後に処理中のまま固まる退行を緑にしない。
 */
export async function openLoginStorageFailureToast(page: Page): Promise<void> {
  await startSignedOut(page);
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('e2e-auth-sign-in-error', 'storage');
    } catch {
      // 保存領域が使えない文脈（about:blank 等）では何もしない。
    }
  });
  await stubDashboardApi(page);
  await page.goto('/login');

  const signInButton = page.getByRole('button', { name: 'Google でログイン' });
  await expect(signInButton).toBeEnabled();
  await signInButton.click();

  await expect(page.getByText('ログイン情報を保存できませんでした')).toBeVisible();
  await expect(page.getByText(/端末の空き容量を確認/)).toBeVisible();
  await expect(page.getByText(/IndexedDB|IO error|writable file/i)).toHaveCount(0);
  await expect(signInButton).toBeEnabled();
}

/**
 * 一覧面を開き、**表が実際に描かれている**ことを先に固定する。
 *
 * これが無いと、認証の差し替えが効かず「読み込み中...」だけの画面になったときに、後続の
 * assert は当然のように緑を返す。測る対象が消えたことを緑と読まないための前置きである。
 * a11y 監査にとっても同じで、空の画面には違反が出ようがない。
 */
export async function openListSurface(
  page: Page,
  path: string,
  heading: string,
  expectedRows: number,
): Promise<void> {
  await stubDashboardApi(page);
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(expectedRows);
}

/**
 * 代理店ロールで店舗一覧を開く（Issue #283・帯の 1 段目が最も広い状態）。
 *
 * `DASHBOARD_SURFACES` には入れない。あの一覧は「監査と横スクロールの実測が回す面」であり、
 * ここはロールの差だけを見る補助の口である（面を増やすと、面の数を宣言している側が一斉に動く）。
 */
export async function openStoreListAsAgency(page: Page): Promise<void> {
  await stubDashboardApi(page, { me: AGENCY_ME });
  await page.goto('/stores');
  await expect(page.getByRole('heading', { level: 1, name: '店舗一覧' })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
}

export interface DashboardSurface {
  readonly where: string;
  /** 表や主要部品が現れるまでの操作と、本体が描けていることの前提 assert。 */
  readonly open: (page: Page) => Promise<void>;
  /**
   * 素の `<select>` 由来の既知の溢れを持つ面か（Issue #186）。
   * 横スクロールの spec はこの印で `test.fail` 側と通常側を振り分ける。
   */
  readonly knownOverflow: boolean;
}

/**
 * 店舗一覧から QR パネルを開き、**掲示面が実際に描けている**ことを先に固定する（Issue #179）。
 *
 * `goto` は持たない。開く手順は `openListSurface` に一本化し、ここは同じ面の中で
 * パネルを開くだけである（Issue #53 の所有権の規律を壊さないため）。
 *
 * 前提 assert は掲示面（`data-print-region`）の可視。これが無いと、取得が失敗して
 * エラー表示になった状態を監査対象と取り違える。**失敗画面には違反が出ようがない。**
 */
export async function openStoreQrPanel(page: Page): Promise<void> {
  await openListSurface(page, '/stores', '店舗一覧', 3);
  await page.getByRole('button', { name: new RegExp(`${STORES[0].name} の QR 発行`) }).click();
  await expect(page.locator('[data-print-region]')).toBeVisible();
}

/**
 * 利用者管理から編集パネルを開き、**パネルが実際に描けている**ことを先に固定する（Issue #259）。
 *
 * `goto` は持たない。`openStoreQrPanel` と同じく、開く手順は `openListSurface` に一本化し、
 * ここは同じ面の中でパネルを開くだけである。
 *
 * 対象は `DASHBOARD_USERS[1]`（代理店・無効化済み）。代理店ロールなので所属代理店の選択が加わり、
 * パネルが最も横に広い状態になる。編集ボタンは**完全一致の名前**で押す。部分一致にすると、
 * 名前が前方で重なる利用者を fixture へ足したときに、別の行のパネルを黙って開きうる。
 *
 * 前提 assert はパネルにしか無い要素（level 2 の見出し・保存ボタン）で置く。一覧にもある要素で
 * 置くと、押下が効かずパネルが開かなかった状態でも前提が通り、一覧だけを監査して緑を返す。
 * 所属代理店の選択は、上の「最も横に広い状態」の前提を固定する。代理店一覧の取得が失敗すると
 * パネルはロールと所属を固定表示にするため（dashboard-user-edit Req 1.14）、見出しと保存ボタン
 * だけでは狭い状態へ変わったことを検出できない。登録フォームにも同名の選択があるので、
 * パネルの置き場所である表の内側に絞って探す。
 */
export async function openUserEditPanel(page: Page): Promise<void> {
  const target = DASHBOARD_USERS[1];
  await openListSurface(page, '/admin/users', '利用者管理', 3);
  await page.getByRole('button', { name: `${target.email} を編集`, exact: true }).click();
  const table = page.getByRole('table');
  await expect(
    table.getByRole('heading', { level: 2, name: `${target.email} の編集`, exact: true }),
  ).toBeVisible();
  await expect(table.getByRole('combobox', { name: '所属代理店', exact: true })).toBeVisible();
  await expect(table.getByRole('button', { name: '保存', exact: true })).toBeVisible();
}

/**
 * 店舗一覧から停止の確認ダイアログを開き、**ダイアログが実際に描けている**ことを先に固定する
 * （store-suspension Issue #252・Requirement 1.6）。
 *
 * `goto` は持たない。開く手順は `openListSurface` に一本化し、ここは同じ面の中でダイアログを
 * 開くだけである（`openStoreQrPanel` と同じ所有権の規律）。
 *
 * 前提 assert はダイアログにしか無い要素（alertdialog の役割と名前・確定の押しボタン）で置く。
 * 一覧にもある要素で置くと、押下が効かずダイアログが開かなかった状態でも前提が通り、一覧だけを
 * 監査して緑を返す。停止の押しボタンは**完全一致の名前**で押す（店名が前方で重なる店舗を
 * fixture へ足したときに、別の行のダイアログを黙って開かないため）。
 */
export async function openStoreSuspendDialog(page: Page): Promise<void> {
  const target = STORES[0];
  await openListSurface(page, '/stores', '店舗一覧', 3);
  await page.getByRole('button', { name: `${target.name} を停止`, exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: `${target.name} を停止しますか？` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '停止する', exact: true })).toBeVisible();
}

/**
 * 自動 a11y 監査だけが回す、一覧の上に重なる後続状態（store-suspension Issue #252）。
 *
 * **`DASHBOARD_SURFACES` へは入れない。** あの一覧は横スクロールと携帯端末の幅の配置の実測も
 * 回しており、それらは「帯の操作要素に捲らずに届く」「一覧表のセルが縦に並んでいない」といった
 * 下の面そのものの性質を測る。モーダルが開いた状態では下の面は覆われて操作できないのが正しく、
 * 同じ宣言で測ると設計どおりの状態を退行として扱うことになる。下の面の配置は、ダイアログを
 * 開く前の「店舗一覧」で測られている。
 *
 * それでも**監査からは外さない。** 同じ URL の後続状態は、面の一覧に明示しない限り構造的に
 * 一度も監査されない（QR パネル・編集パネルと同じ罠）。
 */
export interface OverlaySurface extends Pick<DashboardSurface, 'where' | 'open'> {
  /** 重なった部品だけに絞って監査するときのセレクタ（下の一覧を含めずに部品の規則数を数える）。 */
  readonly selector: string;
}

export const OVERLAY_SURFACES: readonly OverlaySurface[] = [
  {
    where: '店舗一覧の停止の確認ダイアログ',
    open: openStoreSuspendDialog,
    selector: '[role="alertdialog"]',
  },
];

/**
 * 自動 a11y 監査だけが回す、操作結果の通知状態（Issue #342）。
 *
 * Toast はモーダルではなく下の面を操作不能にしないため、`OVERLAY_SURFACES` とは分ける。
 * ただし URL だけを開く通常面では現れない後続状態なので、明示しなければ監査から漏れる。
 */
/**
 * 通知（Toast）の表示の動きが終わるまで待つ（Issue #359）。
 *
 * Toast は不透明度を 0 から 1 へ 400ms かけて上げる。**表示された直後に色の対比を測ると、
 * 白に混ざった途中の色を測る。** axe は不透明度を合成した色で判定するため、最終の色
 * （--destructive・白地で 6 を超える）では満たす対比が、途中では 2.48〜4.27 に落ちて赤になった
 * （ローカルで 40 回中 18 回。CI の main でも同じ形で落ちていた）。
 *
 * 不透明度が 1 に届いたことを先に待ち、そのうえで要素の中の動きがすべて終わるのを待つ。
 * 前者だけだと、不透明度以外の動き（位置・高さ）が残ったまま測ることがある。
 */
export async function waitForToastsSettled(page: Page): Promise<void> {
  const toasts = page.locator('[data-sonner-toast]');
  await expect(toasts.first()).toBeVisible();
  await expect(toasts.first()).toHaveCSS('opacity', '1');
  await toasts.evaluateAll(async (elements) => {
    await Promise.all(
      elements.flatMap((element) => element.getAnimations({ subtree: true }).map((animation) => animation.finished)),
    );
  });
}

export const ACTION_RESULT_SURFACES: readonly OverlaySurface[] = [
  {
    where: 'ログインの保存領域エラー通知',
    open: openLoginStorageFailureToast,
    selector: '[data-sonner-toast]',
  },
];

/**
 * 管理ダッシュボードの検証対象 8 面。**面を足したらここへ足す。**
 *
 * 自動で拾うのは自動 a11y 監査（`a11y-audit.spec.ts`）と携帯端末の幅の配置の実測
 * （`mobile-layout.spec.ts`。面ごとの宣言 `LAYOUT` にも足すこと）である。横スクロールの実測
 * （`dashboard-surfaces.spec.ts`）は面ごとに手書きで、捲れる領域の件数を宣言する。
 */
export const DASHBOARD_SURFACES: readonly DashboardSurface[] = [
  {
    where: '店舗一覧',
    knownOverflow: false,
    open: async (page) => {
      await openListSurface(page, '/stores', '店舗一覧', 3);
    },
  },
  {
    // QR パネルは店舗一覧の中で開く後続状態であり、Issue #179 まで自動 a11y 監査の対象外だった
    // （客向けの下書き画面が同じ形で漏れていたのと同型。PR #218 のレビューで判明した）。
    where: '店舗一覧の QR パネル',
    knownOverflow: false,
    open: openStoreQrPanel,
  },
  {
    where: '代理店管理',
    knownOverflow: false,
    open: async (page) => {
      await openListSurface(page, '/admin/agencies', '代理店管理', 2);
    },
  },
  {
    where: 'ログイン',
    knownOverflow: false,
    open: async (page) => {
      await startSignedOut(page);
      await stubDashboardApi(page);
      await page.goto('/login');
      await expect(page.getByRole('heading', { level: 1, name: 'ログイン' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Google でログイン' })).toBeEnabled();
    },
  },
  {
    where: '招待コード',
    knownOverflow: true,
    open: async (page) => {
      await stubDashboardApi(page);
      await page.goto('/invite-codes');
      await expect(page.getByRole('heading', { level: 1, name: '招待コード' })).toBeVisible();
      // operator は代理店を選ぶまで一覧を出さない（Req 5.4）。選択して初めて表が現れる。
      await page.getByLabel('代理店').selectOption(AGENCIES[0].id);
      await expect(page.getByRole('table')).toBeVisible();
      await expect(page.getByRole('row')).toHaveCount(3);
    },
  },
  {
    where: '利用者管理',
    knownOverflow: true,
    open: async (page) => {
      await openListSurface(page, '/admin/users', '利用者管理', 3);
    },
  },
  {
    // 編集パネルは利用者管理の中で開く後続状態である。一覧の URL だけを監査しても、パネルは
    // 構造的に一度も監査されない（QR パネルと同じ理由で、面として明示する・Issue #259）。
    where: '利用者管理の編集パネル',
    knownOverflow: false,
    open: openUserEditPanel,
  },
  {
    where: '店舗登録',
    knownOverflow: true,
    open: async (page) => {
      await stubDashboardApi(page);
      await page.goto('/stores/new');
      await expect(page.getByRole('heading', { level: 1, name: '店舗登録' })).toBeVisible();
      await expect(page.getByRole('heading', { level: 2, name: 'オーナー選択' })).toBeVisible();
      await expect(page.getByRole('combobox').first()).toBeVisible();
    },
  },
];
