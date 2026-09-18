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
// 構造的な no-write 保証（4.2）: このファイルは <form>・<button>・<textarea>・<select> のいずれも
// 一切レンダリングしない（書込の手段となる要素を描かない）。<input> は次の 2 種類だけを許す。どちらも
// 取得済みのデータの見え方を切り替えるだけで書込の手段ではなく、Issue #265 で改定した構造契約の許可
// リストに従う（正典は test/store-page.test.tsx の「構造契約（許可リスト方式）」、判断は
// docs/design/design-language.md §7.18）。
//   - 競合の検索欄（competitor-search.tsx）。当日の競合が 2 店以上のときだけ描く。
//   - 期間と指標の選択肢の札（trend-controls.tsx）が描く隠し radio。推移を描けるときだけ描く。
// 店舗選択は <a> リンクで行う——「表示する対象を選ぶ」は本来ナビゲーションであり、リンクはデータを
// 送信できないため、<button> を導入するより厳格な保証を維持できる。書込系 fetch（POST/PUT/DELETE/PATCH）も
// 一切呼び出さない — 発行するのは `/api/detail` への GET のみ（test/store-page.test.tsx で検証）。
//
// 意匠（ui-airbnb-surfaces task 3.1）:
//   版面・主見出し・処理中・通知を共通部品から描く。判断の正典は docs/design/design-language.md
//   （版面は §7.9、見出しの階層は §6、余白は §3）であり、ここでは結論も数値も転記せず参照する。
//   **面の側に色を書かない**（色は部品側が theme.css のトークンから解決する）。唯一の例外は推移グラフの
//   部品（trend-chart.tsx）で、店舗詳細の面で色を書くのはそこに限る（§7.18・Issue #265）。書いてよい色の
//   語彙も §7.18 が閉じた集合として定め、test/trend-chart.test.tsx が完全一致で固定する。このファイル
//   自身と、選択肢の札・検索欄・件数の文言は色を書かない。
//
//   使える部品は上記の no-write 保証で決まる。`Button` / `Select` / `Textarea` はこの面では
//   **使ってはならない**（他の面では正解でも、ここでは書込の手段となり、要件 3.1 に真正面から反する）。
//   `Input` は、競合の検索欄（competitor-search.tsx）の中でだけ、検索の種類で name を持たない形で使う
//   （要件 3.1 の 2026-09-13 の訂正にある許可リスト・Issue #265）。ほかの場所で使うと構造契約の検査が赤になる。
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
//   **要件 2.3 の「次に取れる操作への導線」はこの面では提示しない。理由は歯止めではなく、
//   提示すべき操作そのものが存在しないことである。** 競合の範囲設定は第 2 フェーズ、推移は
//   翌朝の日次バッチが埋め、新着を増やす口コミ QR には発行 UI が無い（Issue #152）。この面が持つ
//   リンクは店舗切り替えの 2 種類だけで、0 件の状態を解消する行き先は無い。
//   要件 3.1（書込要素 0 件）と 3.3（個数固定）は、その不在を構造として保証しているにすぎず、
//   **緩めても導線は現れない**（「3.3 と両立しない」と書くと歯止めを外せば解決するように読める）。
//   その代わり、空状態の文言で異常ではなく次回更新を待つ状態だと伝える。空状態の部品は
//   押しボタンを内包しないので、children を渡さない限り上記の制約と両立する。
//   競合の検索が 0 件の状態（Issue #265）だけは、解消する操作（検索語を変える・空にする）がある。ただし
//   その操作は検索欄そのものとして空状態の直前に見えているので、空状態の文言でその方法を伝えるだけにし、
//   別の導線は置かない（store-detail-trend-dashboard の要件 4.9）。
//
//   **導線が生まれる条件**: 口コミ QR の発行 UI（Issue #152 の周辺）か、競合範囲のオーナー設定
//   （第 2 フェーズ）が入った時点で 2.3 の後件は満たせるようになる。そのとき空状態へ導線を
//   足す判断をやり直し、リンクの個数を固定している検査の宣言も更新すること。
//   文言は「推移データはまだありません（毎朝の集計後に表示されます）」「新着なし（前回の集計以降、
//   新しいクチコミはありません）」とし、利用者が異常ではなく次回集計を待つ状態だと判断できるようにする。
//
//   **一覧が空であることの案内は 3 つとも同じ部品で描く**（競合 0 件・推移 0 件・新着 0 件）。
//   task 3.3 のタスク文が名指しするのは前 2 つだが、3 つ目も同じ役割であり、素の段落のまま
//   残すと同一役割が同じ面の中で 2 通りに描かれて要件 1.2 が壊れる（店舗選択の見出しと同型）。
//   Issue #265 で足した、競合の検索が 0 件のときの案内も同じ役割なので、同じ部品で描く。
//   一方、当日サマリーの「準備中」と「取得できませんでした」はここへ含めない。**一覧が空**
//   なのではなく当日の行そのものが無い／取得に失敗した状態であり、役割が異なる。

import { useEffect, useState } from 'react';
import liff from '@line/liff';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { Badge } from '@fwlm/ui/components/badge';
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
// 評価・星差の整形と文言は Flex（delivery-job）と共有する（Issue #255）。root の `@fwlm/db` からの
// 値 import は pg をクライアントへ持ち込むので禁止だが、`@fwlm/db/daily-summary` は値の import を
// 1 つも持たない純関数だけのサブパスで、ここからの値 import は許される。どちらも
// ts/eslint.config.js の no-restricted-imports が機械強制する。
import {
  SELF_UNRATED_RANK_TEXT,
  UNRATED_EXCLUDED_NOTE,
  formatRatingLabel,
  formatStarDiff,
  hasUnratedCompetitor,
  isUnratedSelf,
} from '@fwlm/db/daily-summary';
// lib/data.ts / lib/contract.ts が定義する実際のレスポンス形状を型としてのみ取り込む
// （import type は実行時コードを一切バンドルしない — pg 等 Node 専用依存をクライアントへ持ち込まない）。
import type { StoreDetailSummary, StoreDetailTrendPoint } from '../../lib/data';
import type { StoreDetailResponse, StoreRef, StoreSelectionRequiredBody } from '../../lib/contract';
import {
  DEFAULT_METRIC,
  DEFAULT_PERIOD,
  formatMetricValue,
  formatShortDate,
  metricExtent,
  metricName,
  selectTrendWindow,
  summarizeWindow,
  type TrendMetric,
  type TrendPeriodDays,
  type TrendWindow,
} from '../../lib/trend-view';
import { SEARCH_MIN_COMPETITORS, filterCompetitors } from '../../lib/competitor-filter';
import { CompetitorSearch } from './competitor-search';
import { TrendChart } from './trend-chart';
import { TrendControls } from './trend-controls';

// --- 文言（flex.ts / task 4.1 と同一の Google 帰属表示テキストに揃える） --------------------

const GOOGLE_ATTRIBUTION_TEXT = 'データ提供: Google Maps';
const NO_COMPETITORS_TEXT = '競合が見つかっていません（自店のみの計測です）';
// 画面に出ていない名前で部品を呼ばない（2026-09-18 の画面レビュー）。可視ラベルは「店名で絞り込む」、
// 件数の文言も「…を表示」なので、案内の側も「絞り込む」「入力」の語彙にそろえる。
// この文言は、件数の文言（role="status"）が 0 件のときに読み上げる回復方法でもある。
const NO_MATCHING_COMPETITORS_TEXT =
  '該当する競合がいません。店名の一部で絞り込み直すか、入力を消すと一覧に戻ります。';
const NO_NEW_REVIEWS_TEXT = '新着なし（前回の集計以降、新しいクチコミはありません）';
const NO_TREND_TEXT = '推移データはまだありません（毎朝の集計後に表示されます）';
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
  | { readonly ok: false; readonly kind: 'error'; readonly message: string; readonly supportCode?: string };

function supportCodeFromResponse(body: unknown): string | undefined {
  if (body !== null && typeof body === 'object' && 'supportCode' in body) {
    const value = (body as { supportCode?: unknown }).supportCode;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

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
    return { ok: false, kind: 'error', message: AUTH_ERROR_MESSAGE, supportCode: supportCodeFromResponse(await res.json()) };
  }
  if (res.status === 404) {
    return { ok: false, kind: 'error', message: NOT_FOUND_MESSAGE, supportCode: supportCodeFromResponse(await res.json()) };
  }
  return { ok: false, kind: 'error', message: SERVER_ERROR_MESSAGE, supportCode: supportCodeFromResponse(await res.json()) };
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

/** 件数の増減を符号つきで書く（増えたときだけ「+」を付ける）。前日比と期間の変化で同じ書式を使う。 */
function formatSignedCount(diff: number): string {
  const sign = diff > 0 ? '+' : '';
  return `${sign}${diff}件`;
}

function formatReviewCountDiff(current: number | null, previous: number | null): string | null {
  if (current === null || previous === null) {
    return null;
  }
  return formatSignedCount(current - previous);
}

// --- サブコンポーネント ----------------------------------------------------------------

function Metric({
  label,
  value,
  prominent = false,
}: {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly prominent?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm">{label}</dt>
      <dd className={prominent ? 'text-lg font-semibold tabular-nums' : 'font-medium tabular-nums'}>{value}</dd>
    </div>
  );
}

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
      <CardContent className="flex flex-col gap-4">
        <p className="flex items-baseline gap-1">
          <span className="text-2xl font-bold tabular-nums">{count}</span>
          <span>件の新着クチコミ</span>
        </p>
        {/* 一覧の意味論（list / listitem）を保つ。カードの並びへ置き換えない（正典 7.2 節と同じ規律）。 */}
        <ul className="divide-y">
          {reviews.map((review, index) => (
            <li className="grid gap-1 py-4 first:pt-0 last:pb-0" key={`${review.authorName}-${review.publishTime}-${index}`}>
              <div className="flex items-start justify-between gap-4">
                <span className="font-semibold">{review.authorName}さん </span>
                <span className="shrink-0 tabular-nums">★{review.rating}</span>
              </div>
              <p>「{review.textExcerpt}」</p>
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
  const reviewCountDiff = formatReviewCountDiff(summary.reviewCount, summary.reviewCountPrev);
  // 自店に Google の評価が無い日は順位を持たない（Issue #255）。取得失敗や欠損とは別の状態として描く。
  const unratedSelf = isUnratedSelf(summary.status, summary.rating);

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Heading level={2}>今日のポジション（{summary.summaryDate}）</Heading>
        <Card>
          <CardContent className="flex flex-col gap-4">
            {/* 順位の数値だけを巨大表示にする（正典 7.3 節）。段は 6 節の文字サイズの最大段であり、
             * 面の側は任意の値を持たない。**暫定であり、この段は主見出しと同じ寸法である**ため、
             * 「プロダクト全体で 1 箇所」という一意性はここでは主張しない（追跡は Issue #185）。
             *
             * 前日比は `formatRankDiff` が返す上下の矢印を伴う文言をそのまま置く（正典 7.7 節）。
             * Badge に分離しても矢印と文言を残すため、増減を色だけで伝えない。 */}
            <dl>
              <div className="flex flex-col gap-1">
                <dt className="text-sm">
                  {!unratedSelf && summary.rankTotal !== null ? `近隣${summary.rankTotal}店中` : '近隣順位'}
                </dt>
                <dd className="flex flex-wrap items-baseline gap-2">
                  {unratedSelf ? (
                    <span className="font-medium">{SELF_UNRATED_RANK_TEXT}</span>
                  ) : summary.rank !== null && summary.rankTotal !== null ? (
                    <>
                      <span className="text-2xl font-bold tabular-nums">{summary.rank}</span>
                      <span>位</span>
                    </>
                  ) : (
                    <span className="font-medium">順位情報がありません</span>
                  )}
                  {rankDiff !== null ? (
                    <>
                      {' '}
                      <Badge variant="secondary">前日比: {rankDiff}</Badge>
                    </>
                  ) : null}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </div>
      <div className="flex flex-col gap-2">
        <Heading level={3}>自店の評価</Heading>
        <Card>
          <CardContent className="flex flex-col gap-4">
            <dl className="grid grid-cols-2 gap-4">
              <Metric label="Google 評価" prominent value={formatRatingLabel(summary.rating)} />
              <Metric
                label="クチコミ"
                prominent
                value={summary.reviewCount !== null ? `${summary.reviewCount}件` : '—'}
              />
              {ratingDiff !== null ? <Metric label="評価の前日比" value={ratingDiff.replace('前日比 ', '')} /> : null}
              {reviewCountDiff !== null ? <Metric label="クチコミの前日比" value={reviewCountDiff} /> : null}
            </dl>
          </CardContent>
        </Card>
      </div>
      <div className="flex flex-col gap-2">
        <Heading level={3}>新着クチコミ</Heading>
        <NewReviewsList count={summary.newReviewCount} reviews={summary.newReviews} />
      </div>
    </section>
  );
}

/**
 * 競合の節（store-detail-trend-dashboard task 4.2・Issue #265）。この節のコメントが指す要件と決定（D8）は、
 * 特に断らない限り同 spec（.kiro/specs/store-detail-trend-dashboard）の requirements.md と research.md のもの
 * である。
 */
function CompetitorsSection({
  competitors,
}: {
  readonly competitors: readonly DailySummaryCompetitor[];
}): React.JSX.Element {
  // 検索語は、この節の中だけに持つ（決定 D8）。URL にも端末にも残さないので、開き直すと空の検索語に戻る
  // （要件 4.11）。ほかの節はこの状態を読まないので、検索は順位・グラフ・表・要約を変えない（要件 4.10）。
  const [query, setQuery] = useState('');

  // 検索欄は、当日の競合が 2 店以上のときだけ出す（要件 4.1・4.2）。出していないときは、見えない検索語で
  // 一覧を絞り込まないよう、空の検索語として扱う。
  const searchable = competitors.length >= SEARCH_MIN_COMPETITORS;

  // 行の key は、絞り込む前の並びの位置から作る。絞り込み後の位置を使うと、絞り込むたびに同じ店へ別の key が
  // 付き、行が作り直される。店名は一意ではない（同じ名前の店が近隣に 2 つありうる）ので、位置を必ず含める。
  const rows = competitors.map((competitor, position) => ({
    name: competitor.name,
    competitor,
    rowKey: `${competitor.name}-${position}`,
  }));
  // 一覧は、店名に検索語を含む店だけを元の並び（rank 順）のまま残す（要件 4.3〜4.6）。総数は評価の無い店も数える。
  const { visible, total } = filterCompetitors(rows, searchable ? query : '');

  return (
    // 見出しとその内容を近い間隔（gap-2）で束ね、束と束の間をその 2 倍以上（gap-6）空ける。
    // 2026-09-18 の画面レビューまで、この節は全体が gap-4 の一律で、見出し・操作・一覧・注記が
    // 等間隔に並んでいた。SummarySection が同じ面で既に 24/8 の梯子を持っており、それにそろえる。
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Heading level={2}>競合との比較</Heading>
        {/* 検索欄と件数の文言は、一覧の Card の外に置く。0 件のときは Card が空状態に置き換わるので、中に置くと
            検索欄ごと消えてしまう（§7.18）。 */}
        {searchable ? (
          <CompetitorSearch
            query={query}
            onQueryChange={setQuery}
            total={total}
            visibleCount={visible.length}
            zeroHint={NO_MATCHING_COMPETITORS_TEXT}
          />
        ) : null}
      </div>
      <div className="flex flex-col gap-2">
        {competitors.length === 0 ? (
          <EmptyState>
            <p>{NO_COMPETITORS_TEXT}</p>
          </EmptyState>
        ) : visible.length === 0 ? (
          // 絞り込みの結果が 0 件の案内（要件 4.9）。導線（children の中のリンクや押しボタン）は置かない。
          // role も付けない。件数の文言（role="status"）が同じ文言を読み上げるので、付けると二重になる。
          <EmptyState>
            <p>{NO_MATCHING_COMPETITORS_TEXT}</p>
          </EmptyState>
        ) : (
          <Card>
            <CardContent>
              <ul className="divide-y">
                {visible.map(({ competitor, rowKey }) => {
                  // 星差は「自店 − 競合」を符号つき小数 1 桁で出す（Flex と同じ関数）。評価の無い店、
                  // または自店に評価が無い日は null で、星差の指標そのものを出さない（Issue #255）。
                  const starDiff = formatStarDiff(competitor.starDiff);
                  return (
                    <li className="grid gap-3 py-4 first:pt-0 last:pb-0" key={rowKey}>
                      <p className="font-semibold">{competitor.name}</p>
                      <dl className="grid grid-cols-3 gap-3">
                        <Metric label="評価" value={formatRatingLabel(competitor.rating)} />
                        <Metric
                          label="クチコミ"
                          value={competitor.reviewCount !== null ? `${competitor.reviewCount}件` : '—'}
                        />
                        {starDiff !== null ? <Metric label="星差" value={starDiff} /> : null}
                      </dl>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        )}
        {/* 評価の無い店は順位の比較集合に入らない。一覧には残るので、「近隣N店中」の N と一覧の件数が
            食い違う理由を、該当する店がいるときだけ一覧の下に添える（Flex の注記と同じ文言）。
            判定は、絞り込んだ結果ではなく当日の全件から行う。注記が説明するのは N と全件の食い違いであり、
            検索で評価の無い店が一覧から外れても、その食い違いは残るためである。
            カードの内側へ置かないのは、カードの内容の容器に面から余白を足さないため（意匠の検査が
            競合カードを「面が何も足していない容器」の基準に使っている）。注記は一覧を説明するので、
            一覧と同じ束に入れる。 */}
        {hasUnratedCompetitor(competitors) ? <p className="text-sm">{UNRATED_EXCLUDED_NOTE}</p> : null}
      </div>
    </section>
  );
}

/**
 * 「表示期間の変化」の 3 組。指標ごとに、窓の中で値が記録されている最初と最後の日から作り、値が 1 件も
 * 無い組は「—」にする（store-detail-trend-dashboard の要件 3.4・3.5）。
 */
function WindowSummaryList({ trendWindow }: { readonly trendWindow: TrendWindow }): React.JSX.Element {
  const summary = summarizeWindow(trendWindow);
  return (
    <dl className="grid gap-4 sm:grid-cols-3">
      <Metric
        label="順位"
        value={summary.rank !== null ? `${summary.rank.first}位 → ${summary.rank.last}位` : '—'}
      />
      <Metric
        label="評価"
        value={summary.rating !== null ? `${summary.rating.first} → ${summary.rating.last}` : '—'}
      />
      {/* 「クチコミ数の増減」。指標の名前を「クチコミ数」に統一したうえで、この組だけが差分であることを
          「の増減」で示す（2026-09-18 の画面レビュー）。同じカードに実数の推移が並ぶので、実数と差分が
          似た名前で隣り合わないようにする。 */}
      <Metric
        label="クチコミ数の増減"
        value={summary.reviewCountDiff !== null ? formatSignedCount(summary.reviewCountDiff) : '—'}
      />
    </dl>
  );
}

/**
 * 推移の節（store-detail-trend-dashboard task 4.1・Issue #265）。この節のコメントが指す要件と決定（D1・D8）は、
 * 特に断らない限り同 spec（.kiro/specs/store-detail-trend-dashboard）の requirements.md と research.md のもの
 * である。
 */
function TrendSection({
  trend,
  rankTotal,
}: {
  readonly trend: readonly StoreDetailTrendPoint[];
  /** 当日サマリーの母数（近隣の店の数）。グラフの順位の軸の下端にだけ使う。 */
  readonly rankTotal: number | null;
}): React.JSX.Element {
  // 期間と指標は、この節の中だけに持つ（決定 D8）。URL にも端末にも残さないので、
  // 開き直すと既定の選択に戻る（要件 2.3・2.9）。ほかの節はこの状態を読まない（要件 3.8）。
  const [period, setPeriod] = useState<TrendPeriodDays>(DEFAULT_PERIOD);
  const [metric, setMetric] = useState<TrendMetric>(DEFAULT_METRIC);

  // 要約・グラフ・現在値・表と、節の見出し・表の名前は、ここで 1 回だけ切り出した窓から導く
  // （決定 D1・docs/design/design-language.md §7.18）。切り替えると、どれもこの窓に揃って追随する
  // （要件 3.1〜3.3）。入力は最大 30 点なので、描画のたびに導き直し、メモ化しない。
  const trendWindow = selectTrendWindow(trend, period);
  const title = `直近${period}日の推移`;

  // 日付を解釈できる点が 1 つも無いときは窓が作れない。推移 0 件と同じく既存の案内を出し、
  // 選択肢は出さない（要件 2.8）。選択肢が無いので、この分岐には状態通知も要らない。
  if (trendWindow === null) {
    return (
      <section className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Heading level={2}>{title}</Heading>
          <EmptyState>
            <p>{NO_TREND_TEXT}</p>
          </EmptyState>
        </div>
      </section>
    );
  }

  // 選択の結果を読み上げへ届ける文言（2026-09-18 の画面レビュー）。
  //
  // 指標の札が効く先はグラフだけであり、そのグラフは role="img" の名前でしか内容を持たない。名前は
  // 読み上げ領域ではないので、順位 → 評価と切り替えても読み上げ利用者には何も起きなかった。記録の無い
  // 指標へ切り替えたときは、その名前ごと消えていた。期間の札も、DOM 順で制御より前にある見出しと、
  // 表の容器の名前を書き換える。ここに 1 つだけ、選択が変わるたびに書き換わる領域を置いて引き受ける。
  //
  // 空の案内そのものに role を付けないのは、その要素が内容と同時に挿入されるからである（挿入と同時の
  // 通知は読み上げが安定しない）。この領域は窓がある限り留まるので、書き換えとして通知される。
  // 既知の限界は検索の件数の文言と同じで、面が初めて描かれる 1 回だけは内容と同時の挿入になる。
  const latest = metricExtent(trendWindow, metric).last;
  const trendStatus = `${metricName(metric)}の推移、直近${period}日。${
    latest === null
      ? 'この期間は記録がありません。'
      : `最新 ${formatMetricValue(metric, latest.value)}（${formatShortDate(latest.date)}）。`
  }`;

  return (
    // 見出しと、その節の表示を選ぶ操作を近い間隔（gap-2）で束ね、束と結果の間をその 2 倍以上（gap-6）
    // 空ける。2026-09-18 の画面レビューまでは節も操作の内側も gap-4 の 16px で、期間群と指標群の間隔と、
    // 操作の塊とカードの間隔が同値だった（どこまでが操作の塊かが読めない）。梯子は SummarySection に
    // 合わせてある。
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Heading level={2}>{title}</Heading>
        {/* 選択肢は要約のカードの外に置く。期間は下の表示のすべてに効くので、カードの中に置くと
            効く範囲がカードの中だけに見える（§7.18）。 */}
        <TrendControls period={period} onPeriodChange={setPeriod} metric={metric} onMetricChange={setMetric} />
        <p role="status" className="sr-only">
          {trendStatus}
        </p>
      </div>
      <Card>
        <CardContent className="flex flex-col gap-4">
          {/* グラフは選択肢のすぐ下に置く（2026-09-18 の画面レビュー）。指標の札が効く先はグラフだけ
              なので、間に指標が効かない 3 組を挟むと、押した結果が画面の 2 つ下（320px では約 200px 下）
              に出ることになる。要約は表の前という §7.17 の定めのまま、グラフの下に残る。 */}
          <TrendChart window={trendWindow} metric={metric} rankTotal={rankTotal} />
          <p className="font-semibold">表示期間の変化</p>
          <WindowSummaryList trendWindow={trendWindow} />
        </CardContent>
      </Card>
      {/* 横方向の捲りは表の **外側** が持つ（正典 7.2 節・ui-airbnb-surfaces の要件 2.5）。この容器がこの面で
          唯一の捲れる領域であり、e2e（store-surface.spec.ts）の宣言と対になっている。
          列見出しの文字列は 1 文字も変えない（ui-airbnb-surfaces の要件 2.2）。scope は部品の既定が与える。
          行は窓の点をそのまま描く。グラフの各点の値は、同じ日付の行で確かめられる（要件 3.7）。 */}
      <TableContainer label={title}>
        <Table className="min-w-sm">
          <TableHead>
            <TableRow>
              <TableHeaderCell>日付</TableHeaderCell>
              <TableHeaderCell>順位</TableHeaderCell>
              <TableHeaderCell>評価</TableHeaderCell>
              <TableHeaderCell>クチコミ数</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {trendWindow.points.map((point) => (
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
        setState({
          status: 'error',
          message: detailResult.supportCode
            ? `${detailResult.message}（サポートコード: ${detailResult.supportCode}）`
            : detailResult.message,
        });
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
      <header className="flex flex-col gap-2">
        <Heading level={1}>{data.storeName}</Heading>
        {data.stores.length >= 2 ? (
          // storeId を持たない /store へ戻る → サーバーが再び 409 を返し選択画面に着地する。
          <p>
            <a href="/store">{SWITCH_STORE_LABEL}</a>
          </p>
        ) : null}
      </header>
      <SummarySection summary={data.summary} />
      <CompetitorsSection competitors={data.competitors} />
      <TrendSection trend={data.trend} rankTotal={data.summary?.rankTotal ?? null} />
      <footer>
        <p className="text-sm">{GOOGLE_ATTRIBUTION_TEXT}</p>
      </footer>
    </PageShell>
  );
}
