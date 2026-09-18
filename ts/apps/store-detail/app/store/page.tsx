'use client';

// 詳細閲覧画面（Task 5.3）。
//
// design.md「TS / store-detail」Responsibilities & Constraints:
//   認可: liff.getIDToken() → サーバーで /oauth2/v2.1/verify（lib/liff-auth.ts・task 5.1 の責務）
//   表示: 当日サマリー・自店/競合の星評価とクチコミ総数・直近30日の自店順位/評価推移・Google 帰属表示
//   書込 API を一切持たない（4.2 の構造的担保）
// design.md「LIFF URL 契約」:
//   完了後リッチメニューの「詳細を見る」→ https://liff.line.me/{liffId} が本ページを起動する。
//   認可主体は ID トークンの sub のみである。本ページは liff.init() → liff.getIDToken() →
//   GET /api/detail（Authorization: Bearer）の流れを自ら行う。
//   Issue #256 以降、推移のレポートの「30日の推移を詳細画面で見る」だけは LIFF URL へ
//   `?storeId=` を付けて起動する。この値は下の task 5.4 のヒントと同じ扱いで、サーバー側が
//   必ず sub 由来の認可済み集合の内部でのみ解釈するため、認可主体を変えることはない
//   （届かなければ、単一店舗は正しく表示され、複数店舗は選択画面に着地する）。
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
//   **要件 2.3 の「次に取れる操作への導線」はこの面では提示しない。理由は歯止めではなく、
//   提示すべき操作そのものが存在しないことである。** 競合の範囲設定は第 2 フェーズ、推移は
//   翌朝の日次バッチが埋め、新着を増やす口コミ QR には発行 UI が無い（Issue #152）。この面が持つ
//   リンクは店舗切り替えの 2 種類だけで、0 件の状態を解消する行き先は無い。
//   要件 3.1（書込要素 0 件）と 3.3（個数固定）は、その不在を構造として保証しているにすぎず、
//   **緩めても導線は現れない**（「3.3 と両立しない」と書くと歯止めを外せば解決するように読める）。
//   その代わり、空状態の文言で異常ではなく次回更新を待つ状態だと伝える。空状態の部品は
//   押しボタンを内包しないので、children を渡さない限り上記の制約と両立する。
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
// 評価・星差の整形と文言は LINE のレポート（line-webhook）と共有する（Issue #255）。root の `@fwlm/db` からの
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

// --- 文言（LINE の通知・レポートと同一の Google 帰属表示テキストに揃える） --------------------

const GOOGLE_ATTRIBUTION_TEXT = 'データ提供: Google Maps';
const NO_COMPETITORS_TEXT = '競合が見つかっていません（自店のみの計測です）';
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

// --- 表示ヘルパー（LINE のレポートと同一の順位比較・文言規約） ---------------------------------

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

function formatReviewCountDiff(current: number | null, previous: number | null): string | null {
  if (current === null || previous === null) {
    return null;
  }
  const diff = current - previous;
  const sign = diff > 0 ? '+' : '';
  return `${sign}${diff}件`;
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
            <ul className="divide-y">
              {competitors.map((competitor, index) => {
                // 星差は「自店 − 競合」を符号つき小数 1 桁で出す（Flex と同じ関数）。評価の無い店、
                // または自店に評価が無い日は null で、星差の指標そのものを出さない（Issue #255）。
                const starDiff = formatStarDiff(competitor.starDiff);
                return (
                  <li className="grid gap-3 py-4 first:pt-0 last:pb-0" key={`${competitor.name}-${index}`}>
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
          カードの内側へ置かないのは、カードの内容の容器に面から余白を足さないため（意匠の検査が
          競合カードを「面が何も足していない容器」の基準に使っている）。 */}
      {hasUnratedCompetitor(competitors) ? <p className="text-sm">{UNRATED_EXCLUDED_NOTE}</p> : null}
    </section>
  );
}

function TrendSection({ trend }: { readonly trend: readonly StoreDetailTrendPoint[] }): React.JSX.Element {
  const first = trend[0];
  const latest = trend.at(-1);
  const reviewCountDiff = formatReviewCountDiff(latest?.reviewCount ?? null, first?.reviewCount ?? null);

  return (
    <section className="flex flex-col gap-4">
      <Heading level={2}>直近30日の推移</Heading>
      {trend.length === 0 ? (
        <EmptyState>
          <p>{NO_TREND_TEXT}</p>
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          <Card>
            <CardContent className="flex flex-col gap-4">
              <p className="font-semibold">表示期間の変化</p>
              <dl className="grid gap-4 sm:grid-cols-3">
                <Metric
                  label="順位"
                  value={first?.rank != null && latest?.rank != null ? `${first.rank}位 → ${latest.rank}位` : '—'}
                />
                <Metric
                  label="評価"
                  value={first?.rating != null && latest?.rating != null ? `${first.rating} → ${latest.rating}` : '—'}
                />
                <Metric label="クチコミ増減" value={reviewCountDiff ?? '—'} />
              </dl>
            </CardContent>
          </Card>
          {/* 横方向の捲りは表の **外側** が持つ（正典 7.2 節・要件 2.5）。この容器がこの面で
              唯一の捲れる領域であり、e2e（store-surface.spec.ts）の宣言と対になっている。
              列見出しの文字列は 1 文字も変えない（要件 2.2）。scope は部品の既定が与える。 */}
          <TableContainer label="直近30日の推移">
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
        </div>
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
      <TrendSection trend={data.trend} />
      <footer>
        <p className="text-sm">{GOOGLE_ATTRIBUTION_TEXT}</p>
      </footer>
    </PageShell>
  );
}
