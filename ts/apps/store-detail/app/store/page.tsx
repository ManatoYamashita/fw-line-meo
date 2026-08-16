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

import { useEffect, useState } from 'react';
import liff from '@line/liff';

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
    return <p>{NO_NEW_REVIEWS_TEXT}</p>;
  }
  return (
    <div>
      <p>{count}件の新着クチコミ</p>
      <ul>
        {reviews.map((review, index) => (
          <li key={`${review.authorName}-${review.publishTime}-${index}`}>
            {review.authorName}さん ★{review.rating}「{review.textExcerpt}」
          </li>
        ))}
      </ul>
    </div>
  );
}

function SummarySection({ summary }: { readonly summary: StoreDetailSummary | null }): React.JSX.Element {
  if (summary === null) {
    return (
      <section>
        <h2>今日のポジション</h2>
        <p>{NO_SUMMARY_TEXT}</p>
      </section>
    );
  }

  if (summary.status === 'failed') {
    return (
      <section>
        <h2>今日のポジション（{summary.summaryDate}）</h2>
        <p>{FAILED_SUMMARY_TEXT}</p>
      </section>
    );
  }

  const rankDiff = formatRankDiff(summary.rank, summary.rankPrev);
  const ratingDiff = formatRatingDiff(summary.rating, summary.ratingPrev);

  return (
    <section>
      <h2>今日のポジション（{summary.summaryDate}）</h2>
      <p>
        {summary.rank !== null && summary.rankTotal !== null
          ? `近隣${summary.rankTotal}店中 ${summary.rank}位`
          : '順位情報がありません'}
        {rankDiff !== null ? `（前日比: ${rankDiff}）` : ''}
      </p>
      <h3>自店の評価</h3>
      <p>
        ★{summary.rating ?? '—'}（クチコミ{' '}
        {summary.reviewCount !== null ? `${summary.reviewCount}件` : '—'}）
        {ratingDiff !== null ? `（${ratingDiff}）` : ''}
      </p>
      <h3>新着クチコミ</h3>
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
    <section>
      <h2>競合との比較</h2>
      {competitors.length === 0 ? (
        <p>{NO_COMPETITORS_TEXT}</p>
      ) : (
        <ul>
          {competitors.map((competitor, index) => (
            <li key={`${competitor.name}-${index}`}>
              {competitor.name}: ★{competitor.rating ?? '—'}（クチコミ{' '}
              {competitor.reviewCount ?? '—'}件） 星差 {competitor.starDiff ?? '—'}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TrendSection({ trend }: { readonly trend: readonly StoreDetailTrendPoint[] }): React.JSX.Element {
  return (
    <section>
      <h2>直近30日の推移</h2>
      {trend.length === 0 ? (
        <p>推移データがありません</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">日付</th>
              <th scope="col">順位</th>
              <th scope="col">評価</th>
              <th scope="col">クチコミ数</th>
            </tr>
          </thead>
          <tbody>
            {trend.map((point) => (
              <tr key={point.capturedOn}>
                <td>{point.capturedOn}</td>
                <td>{point.rank ?? '—'}</td>
                <td>{point.rating ?? '—'}</td>
                <td>{point.reviewCount ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
    <section>
      <h2>{SELECT_STORE_HEADING}</h2>
      <ul>
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

  if (state.status === 'loading') {
    return (
      <main>
        <h1>店舗詳細</h1>
        <p>読み込み中です…</p>
      </main>
    );
  }

  if (state.status === 'error') {
    return (
      <main>
        <h1>店舗詳細</h1>
        <p role="alert">{state.message}</p>
      </main>
    );
  }

  if (state.status === 'select') {
    // 選択待ちは異常ではないため role="alert" は使わない（支援技術に警告として読ませない）。
    return (
      <main>
        <h1>店舗詳細</h1>
        <StoreSelector stores={state.stores} />
      </main>
    );
  }

  const { data } = state;
  return (
    <main>
      {/* 多店舗オーナーにとって「今どの店を見ているか」は必須の文脈（要件 4.7）。 */}
      <h1>{data.storeName}</h1>
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
    </main>
  );
}
