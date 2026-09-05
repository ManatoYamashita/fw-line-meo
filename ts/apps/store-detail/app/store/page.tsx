'use client';

// 詳細閲覧画面（Task 5.3）。
//
// design.md「TS / store-detail」Responsibilities & Constraints:
//   認可: liff.getIDToken() → サーバーで /oauth2/v2.1/verify（lib/liff-auth.ts・task 5.1 の責務）
//   表示: 当日サマリー・自店/競合の星評価とクチコミ総数・直近30日の自店順位/評価推移・Google 帰属表示
//   書込 API を一切持たない（4.2 の構造的担保）
// design.md「LIFF URL 契約」:
//   Flex ボタン → https://liff.line.me/{liffId} が本ページを起動する。storeId は LIFF URL に
//   含めない（認可主体は ID トークンの sub のみ）。本ページは liff.init() → liff.getIDToken() →
//   GET /api/detail（Authorization: Bearer）の流れを自ら行う。
//
// task 5.4（Issue #61・多店舗オーナー）:
//   認可済み店舗が複数あるとサーバーは表示対象を決められず 409 と候補一覧を返す。本ページは
//   それを「異常」ではなく「選択待ち」として描画し、選ばれた storeId を `/store?storeId=` の
//   アプリ内 URL 経由でサーバーへヒントとして渡す。ヒントはサーバー側で必ず sub 由来の認可済み
//   集合の内部でのみ解釈されるため、この URL パラメータが認可主体を変えることはない
//   （design.md「クライアント入力の不変条件」）。
//
// liff.init / liff.getIDToken はブラウザ専用 API のため、このページ自体を Client Component とする
// （'use client'。survey-web の survey-shell.tsx と同じ「クライアント合成シェル」パターンに倣う）。
//
// 構造的な no-write 保証（4.2）: このファイルは <form>・<button>・<input>・<textarea>・<select> の
// いずれも一切レンダリングしない（純粋な読取専用の表示のみ）。店舗選択は <a> リンクで行う
// ——「表示する対象を選ぶ」は本来ナビゲーションであり、リンクはデータを送信できないため、
// <button> を導入するより厳格な保証を維持できる。書込系 fetch（POST/PUT/DELETE/PATCH）も
// 一切呼び出さない — 発行するのは `/api/detail` への GET のみ（test/store-page.test.tsx で検証）。
//
// 意匠（ui-airbnb-surfaces task 3.1）:
//   版面・主見出し・処理中・通知を共通部品から描く。判断の正典は docs/design/design-language.md
//   （版面は §7.9、見出しの階層は §6、余白は §3）であり、ここでは結論も数値も転記せず参照する。
//   **面の側に色を書かない**（色は部品側が theme.css のトークンから解決する）。
//
//   使える部品は上記の no-write 保証で決まる。`Button` / `Input` / `Select` / `Textarea` は
//   この面では**使ってはならない**（他の面では正解でも、ここでは要件 3.1 に真正面から反する）。
//   PageShell は <div>／Heading は <h1>-<h6>／Spinner は <span>／Alert は <div> しか描かない。
//
// 意匠（ui-airbnb-surfaces task 3.2 / 3.3）:
//   順位の巨大表示・自店の評価・新着・競合をカードへ寄せ、推移を表の部品へ移す。
//   巨大表示の段は docs/design/design-language.md の 7.3 節（暫定であることも同節が持つ）、
//   前日比を色ではなく矢印で示す判断は 7.7 節、表を表のまま装飾する判断は 7.2 節が正典であり、
//   ここでは結論も数値も転記せず参照する。追加した部品も <div> / <span> / 表要素しか描かない。
//
//   **節の見出しは容器の外に置く。** 面の中で規則を 1 つに保つためであり、こうしておくと
//   0 件のときに空状態の部品が容器をそのまま置き換えられる（見出しは分岐の外に残る）。
//
//   **要件 2.3 の「次に取れる操作への導線」はこの面では満たせない。** 0 件の案内に導線を
//   足すにはリンクか押しボタンが要るが、リンクの個数は検証が固定しており（要件 3.3）、
//   押しボタンは要件 3.1 が禁じる。空状態の部品は押しボタンを内包しないので、children を
//   渡さない限りこの制約と両立する。ここでは対象が無い旨の提示までとする。
//
//   **一覧が空であることの案内は 3 つとも同じ部品で描く**（競合 0 件・推移 0 件・新着 0 件）。
//   task 3.3 のタスク文が名指しするのは前 2 つだが、3 つ目も同じ役割であり、素の段落のまま
//   残すと同一役割が同じ面の中で 2 通りに描かれて要件 1.2 が壊れる（店舗選択の見出しと同型）。
//   一方、当日サマリーの「準備中」と「取得できませんでした」はここへ含めない。**一覧が空**
//   なのではなく当日の行そのものが無い／取得に失敗した状態であり、役割が異なる。

import { useEffect, useState } from 'react';
import liff from '@line/liff';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { Card, CardContent } from '@fwlm/ui/components/card';
import { EmptyState } from '@fwlm/ui/components/empty-state';
import { Heading } from '@fwlm/ui/components/heading';
import { PageShell } from '@fwlm/ui/components/page-shell';
import { Spinner } from '@fwlm/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '@fwlm/ui/components/table';

import type { DailySummaryCompetitor, DailySummaryNewReview } from '@fwlm/db';
// lib/data.ts / lib/contract.ts が定義する実際のレスポンス形状を型としてのみ取り込む
// （import type は実行時コードを一切バンドルしない — pg 等 Node 専用依存をクライアントへ持ち込まない）。
import type { StoreDetailSummary, StoreDetailTrendPoint } from '../../lib/data';
import type { StoreDetailResponse, StoreRef, StoreSelectionRequiredBody } from '../../lib/contract';

// --- 文言（flex.ts / task 4.1 と同一の Google 帰属表示テキストに揃える） --------------------

const GOOGLE_ATTRIBUTION_TEXT = 'データ提供: Google Maps';
const NO_COMPETITORS_TEXT = '競合が見つかっていません（自店のみの計測です）';
const NO_NEW_REVIEWS_TEXT = '新着なし';
const NO_SUMMARY_TEXT = '本日分のデータはまだ準備中です。しばらくしてから再度お試しください。';
const FAILED_SUMMARY_TEXT = '本日のポジションを取得できませんでした。';
const LIFF_ERROR_MESSAGE = 'LINE 連携でエラーが発生しました。LINE アプリからこの画面を開き直してください。';
const AUTH_ERROR_MESSAGE = '認証に失敗しました。LINE アプリを開き直してください。';
const NOT_FOUND_MESSAGE = '店舗情報を取得できませんでした。';
const SERVER_ERROR_MESSAGE = 'サーバーエラーが発生しました。時間をおいて再度お試しください。';
const NETWORK_ERROR_MESSAGE = '通信に失敗しました。時間をおいて再度お試しください。';
const SELECT_STORE_HEADING = '表示する店舗を選んでください';
const SWITCH_STORE_LABEL = '店舗を切り替える';

// --- 画面状態 ------------------------------------------------------------------------

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  /** 認可済み店舗が複数あり、どれを表示するかがまだ決まっていない（異常ではない）。 */
  | { readonly status: 'select'; readonly stores: readonly StoreRef[] }
  | { readonly status: 'ready'; readonly data: StoreDetailResponse };

// --- LIFF ID トークン解決（liff.init → isLoggedIn → getIDToken） -----------------------

type IdTokenResolution =
  | { readonly kind: 'ok'; readonly idToken: string }
  | { readonly kind: 'redirecting' } // liff.login() がリダイレクトを開始した。読み込み中のまま待つ。
  | { readonly kind: 'failed' };

async function resolveIdToken(): Promise<IdTokenResolution> {
  const liffId = process.env.NEXT_PUBLIC_LIFF_ID;
  if (!liffId) {
    return { kind: 'failed' };
  }

  await liff.init({ liffId });

  if (!liff.isLoggedIn()) {
    liff.login();
    return { kind: 'redirecting' };
  }

  const idToken = liff.getIDToken();
  if (!idToken) {
    return { kind: 'failed' };
  }

  return { kind: 'ok', idToken };
}

// --- 表示対象のヒント（アプリ内 URL のクエリ） ------------------------------------------

/**
 * `/store?storeId=...` のヒントを読む。
 *
 * `useSearchParams` ではなく `window.location` を使うのは、(1) 静的プリレンダ時に要求される
 * Suspense 境界を避けるため、(2) この値の読み取りが（liff.init と同じく）クライアント専用の
 * 副作用の中で 1 回だけ起これば十分で、サーバー描画との差分が原理的に生じないため。
 * 呼出は useEffect 内に限ること（レンダリング中に呼ぶと hydration mismatch を招く）。
 */
function readStoreIdHint(): string | null {
  const hint = new URLSearchParams(window.location.search).get('storeId');
  return hint && hint.length > 0 ? hint : null;
}

/** 選択画面のリンク先。ヒントは必ずエンコードし、クエリを分断・増殖させない。 */
function storeHref(storeId: string): string {
  return `/store?storeId=${encodeURIComponent(storeId)}`;
}

// --- /api/detail 呼出（GET のみ・Authorization ヘッダで認可） --------------------------

type DetailFetchResult =
  | { readonly ok: true; readonly data: StoreDetailResponse }
  /** 409: 表示対象が決まらないので候補から選ばせる（異常ではない）。 */
  | { readonly ok: false; readonly kind: 'select'; readonly stores: readonly StoreRef[] }
  | { readonly ok: false; readonly kind: 'error'; readonly message: string };

async function fetchStoreDetail(idToken: string, storeIdHint: string | null): Promise<DetailFetchResult> {
  const url = storeIdHint === null ? '/api/detail' : `/api/detail?storeId=${encodeURIComponent(storeIdHint)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${idToken}` },
  });

  if (res.ok) {
    const data = (await res.json()) as StoreDetailResponse;
    return { ok: true, data };
  }
  if (res.status === 409) {
    const body = (await res.json()) as StoreSelectionRequiredBody;
    return { ok: false, kind: 'select', stores: body.stores };
  }
  if (res.status === 401) {
    return { ok: false, kind: 'error', message: AUTH_ERROR_MESSAGE };
  }
  if (res.status === 404) {
    return { ok: false, kind: 'error', message: NOT_FOUND_MESSAGE };
  }
  return { ok: false, kind: 'error', message: SERVER_ERROR_MESSAGE };
}

// --- 表示ヘルパー（flex.ts と同一の順位比較・文言規約） ---------------------------------

function formatRankDiff(rank: number | null, rankPrev: number | null): string | null {
  if (rank === null || rankPrev === null) {
    return null;
  }
  if (rank < rankPrev) {
    return '↑ 上昇';
  }
  if (rank > rankPrev) {
    return '↓ 下降';
  }
  return '→ 変動なし';
}

function formatRatingDiff(rating: string | null, ratingPrev: string | null): string | null {
  if (rating === null || ratingPrev === null) {
    return null;
  }
  const diff = Number(rating) - Number(ratingPrev);
  if (Number.isNaN(diff) || diff === 0) {
    return null;
  }
  const sign = diff > 0 ? '+' : '';
  return `前日比 ${sign}${diff.toFixed(1)}`;
}

// --- サブコンポーネント ----------------------------------------------------------------

function NewReviewsList({
  count,
  reviews,
}: {
  readonly count: number;
  readonly reviews: readonly DailySummaryNewReview[];
}): React.JSX.Element {
  if (count <= 0) {
    // 空状態の部品へ移す。**導線（children）は渡さない**（冒頭の要件 2.3 の注記を参照）。
    return (
      <EmptyState>
        <p>{NO_NEW_REVIEWS_TEXT}</p>
      </EmptyState>
    );
  }
  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <p>{count}件の新着クチコミ</p>
        {/* 一覧の意味論（list / listitem）を保つ。カードの並びへ置き換えない（正典 7.2 節と同じ規律）。 */}
        <ul className="flex flex-col gap-2">
          {reviews.map((review, index) => (
            <li key={`${review.authorName}-${review.publishTime}-${index}`}>
              {review.authorName}さん ★{review.rating}「{review.textExcerpt}」
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function SummarySection({ summary }: { readonly summary: StoreDetailSummary | null }): React.JSX.Element {
  if (summary === null) {
    return (
      <section className="flex flex-col gap-4">
        <Heading level={2}>今日のポジション</Heading>
        {/* 「まだ準備中」は一覧が空なのではなく当日の行そのものが無い状態である。
            空状態の部品は一覧が空のときの案内であり、ここへ広げると意味がずれる。 */}
        <p>{NO_SUMMARY_TEXT}</p>
      </section>
    );
  }

  if (summary.status === 'failed') {
    return (
      <section className="flex flex-col gap-4">
        <Heading level={2}>今日のポジション（{summary.summaryDate}）</Heading>
        {/* 取得に失敗した旨。通知の部品（既定・危険とも読み上げ領域を持つ）へは載せない。
            これはページ全体の失敗ではなく節の状態であり、読み上げを割り込ませる理由がない。 */}
        <p>{FAILED_SUMMARY_TEXT}</p>
      </section>
    );
  }

  const rankDiff = formatRankDiff(summary.rank, summary.rankPrev);
  const ratingDiff = formatRatingDiff(summary.rating, summary.ratingPrev);

  return (
    <section className="flex flex-col gap-4">
      <Heading level={2}>今日のポジション（{summary.summaryDate}）</Heading>
      <Card>
        <CardContent>
          {/* 順位の数値だけを巨大表示にする（正典 7.3 節）。段は 6 節の文字サイズの最大段であり、
           * 面の側は任意の値を持たない。**暫定であり、この段は主見出しと同じ寸法である**ため、
           * 「プロダクト全体で 1 箇所」という一意性はここでは主張しない（追跡は Issue #185）。
           *
           * 数値を子要素へ切り出しても、この段落が読み上げる内容は 1 文字も変わらない
           * （前後の文言は直下のテキストノードのまま残る）。
           *
           * 前日比は `formatRankDiff` が返す上下の矢印を伴う文言をそのまま置く（正典 7.7 節）。
           * 独立した要素を与えないので、増減を色だけで伝えることが構造的に起こりえない。 */}
          <p>
            {summary.rank !== null && summary.rankTotal !== null ? (
              <>
                {`近隣${summary.rankTotal}店中 `}
                <span className="text-2xl font-bold">{summary.rank}</span>
                {'位'}
              </>
            ) : (
              '順位情報がありません'
            )}
            {rankDiff !== null ? `（前日比: ${rankDiff}）` : ''}
          </p>
        </CardContent>
      </Card>
      <Heading level={3}>自店の評価</Heading>
      <Card>
        <CardContent>
          <p>
            ★{summary.rating ?? '—'}（クチコミ{' '}
            {summary.reviewCount !== null ? `${summary.reviewCount}件` : '—'}）
            {ratingDiff !== null ? `（${ratingDiff}）` : ''}
          </p>
        </CardContent>
      </Card>
      <Heading level={3}>新着クチコミ</Heading>
      <NewReviewsList count={summary.newReviewCount} reviews={summary.newReviews} />
    </section>
  );
}

function CompetitorsSection({
  competitors,
}: {
  readonly competitors: readonly DailySummaryCompetitor[];
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-4">
      <Heading level={2}>競合との比較</Heading>
      {competitors.length === 0 ? (
        <EmptyState>
          <p>{NO_COMPETITORS_TEXT}</p>
        </EmptyState>
      ) : (
        <Card>
          <CardContent>
            <ul className="flex flex-col gap-2">
              {competitors.map((competitor, index) => (
                <li key={`${competitor.name}-${index}`}>
                  {competitor.name}: ★{competitor.rating ?? '—'}（クチコミ{' '}
                  {competitor.reviewCount ?? '—'}件） 星差 {competitor.starDiff ?? '—'}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </section>
  );
}

function TrendSection({ trend }: { readonly trend: readonly StoreDetailTrendPoint[] }): React.JSX.Element {
  return (
    <section className="flex flex-col gap-4">
      <Heading level={2}>直近30日の推移</Heading>
      {trend.length === 0 ? (
        <EmptyState>
          <p>推移データがありません</p>
        </EmptyState>
      ) : (
        // 横方向の捲りは表の **外側** が持つ（正典 7.2 節・要件 2.5）。この容器がこの面で
        // 唯一の捲れる領域であり、e2e（store-surface.spec.ts）の宣言と対になっている。
        // 列見出しの文字列は 1 文字も変えない（要件 2.2）。scope は部品の既定が与える。
        <TableContainer label="直近30日の推移">
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>日付</TableHeaderCell>
                <TableHeaderCell>順位</TableHeaderCell>
                <TableHeaderCell>評価</TableHeaderCell>
                <TableHeaderCell>クチコミ数</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {trend.map((point) => (
                <TableRow key={point.capturedOn}>
                  {/* 数値の列だけ右寄せ＋等幅数字にする（正典 7.2 節）。日付の列は既定のまま。 */}
                  <TableCell>{point.capturedOn}</TableCell>
                  <TableCell numeric>{point.rank ?? '—'}</TableCell>
                  <TableCell numeric>{point.rating ?? '—'}</TableCell>
                  <TableCell numeric>{point.reviewCount ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </section>
  );
}

/**
 * 店舗選択（Issue #61）。
 *
 * 選択肢は <a> リンクであり <button> を使わない。「表示する対象を選ぶ」はナビゲーションで
 * あるうえ、リンクはデータを送信できないため、4.2 の no-write 保証をより厳格な形で維持できる。
 * next/link を使わないのは意図的で、クライアント側遷移では URL だけが変わって
 * `useEffect(..., [])` が再発火せず、新しいヒントでの再フェッチが起きないため。
 */
function StoreSelector({ stores }: { readonly stores: readonly StoreRef[] }): React.JSX.Element {
  return (
    // 節の見出しは面の中で 1 通りに描く（要件 1.2）。この h2 は task 3.1 の時点でどのタスクにも
    // 割り当てられておらず、親が task 3.3 へ割り当てた。他の 5 つが部品になるのにここだけ素の
    // タグが残ると、同一役割が同じ面の中で 2 通りに描かれることになる。
    <section className="flex flex-col gap-4">
      <Heading level={2}>{SELECT_STORE_HEADING}</Heading>
      <ul className="flex flex-col gap-2">
        {stores.map((store) => (
          <li key={store.storeId}>
            <a href={storeHref(store.storeId)}>{store.name}</a>
          </li>
        ))}
      </ul>
    </section>
  );
}

// --- ページ本体 ------------------------------------------------------------------------

export default function StorePage(): React.JSX.Element {
  const [state, setState] = useState<ViewState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    async function run(): Promise<void> {
      let tokenResult: IdTokenResolution;
      try {
        tokenResult = await resolveIdToken();
      } catch {
        tokenResult = { kind: 'failed' };
      }

      if (cancelled) {
        return;
      }
      if (tokenResult.kind === 'redirecting') {
        // liff.login() がリダイレクトを開始済み。ページ遷移が起こるため読み込み中のまま待つ。
        return;
      }
      if (tokenResult.kind === 'failed') {
        setState({ status: 'error', message: LIFF_ERROR_MESSAGE });
        return;
      }

      let detailResult: DetailFetchResult;
      try {
        detailResult = await fetchStoreDetail(tokenResult.idToken, readStoreIdHint());
      } catch {
        detailResult = { ok: false, kind: 'error', message: NETWORK_ERROR_MESSAGE };
      }

      if (cancelled) {
        return;
      }
      if (detailResult.ok) {
        setState({ status: 'ready', data: detailResult.data });
      } else if (detailResult.kind === 'select') {
        setState({ status: 'select', stores: detailResult.stores });
      } else {
        setState({ status: 'error', message: detailResult.message });
      }
    }

    void run();

    return () => {
      cancelled = true;
    };
  }, []);

  // 4 つの分岐はいずれも自前の主要領域を持っていた。版面の部品は既定で main を描くため、
  // 素の <main> を **置換** する（内側へ入れると主要領域が 2 つになる）。
  if (state.status === 'loading') {
    return (
      <PageShell width="sm" className="flex flex-col gap-6">
        <Heading level={1}>店舗詳細</Heading>
        {/* Spinner 自身も role="status" を持つため、読み上げはこの行に一本化する。
         * 図形は装飾として扱い aria-hidden で支援技術から外す。文言は可視のテキストのまま残す
         * （Spinner の aria-label へ移すと sr-only の子要素へ落ち、動き低減設定でない実ブラウザ
         * では進行状態の手掛かりが回転だけになる・要件 4.5）。文言は 1 文字も変えない。 */}
        <p role="status" className="flex items-center gap-2">
          <Spinner aria-hidden />
          読み込み中です…
        </p>
      </PageShell>
    );
  }

  if (state.status === 'error') {
    return (
      <PageShell width="sm" className="flex flex-col gap-6">
        <Heading level={1}>店舗詳細</Heading>
        {/* 危険を伝える変種は読み上げ役割 alert を自ら持つ。文言の側へ role を重ねると
            領域が二重になるため、文言は説明の受け口へ置くだけにする。 */}
        <Alert variant="destructive">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      </PageShell>
    );
  }

  if (state.status === 'select') {
    // 選択待ちは異常ではないため role="alert" は使わない（支援技術に警告として読ませない）。
    // 通知の部品も置かない。既定の変種は role="status" のライブリージョンであり、
    // 「候補から選ぶ」という通常の画面状態を読み上げの割り込みに乗せる理由がない。
    return (
      <PageShell width="sm" className="flex flex-col gap-6">
        <Heading level={1}>店舗詳細</Heading>
        <StoreSelector stores={state.stores} />
      </PageShell>
    );
  }

  const { data } = state;
  return (
    <PageShell width="sm" className="flex flex-col gap-6">
      {/* 多店舗オーナーにとって「今どの店を見ているか」は必須の文脈（要件 4.7）。
       * 主見出しは店名そのものであり、装飾も日付も内包しない（日付は各節の h2 側にある）。 */}
      <Heading level={1}>{data.storeName}</Heading>
      {data.stores.length >= 2 ? (
        // storeId を持たない /store へ戻る → サーバーが再び 409 を返し選択画面に着地する。
        <p>
          <a href="/store">{SWITCH_STORE_LABEL}</a>
        </p>
      ) : null}
      <SummarySection summary={data.summary} />
      <CompetitorsSection competitors={data.competitors} />
      <TrendSection trend={data.trend} />
      <p>{GOOGLE_ATTRIBUTION_TEXT}</p>
    </PageShell>
  );
}
