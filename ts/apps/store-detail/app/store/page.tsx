'use client';

// 詳細閲覧画面（Task 5.3）。
//
// design.md「TS / store-detail」Responsibilities & Constraints:
//   認可: liff.getIDToken() → サーバーで /oauth2/v2.1/verify（lib/liff-auth.ts・task 5.1 の責務）
//   表示: 当日サマリー・自店/競合の星評価とクチコミ総数・直近30日の自店順位/評価推移・Google 帰属表示
//   書込 API を一切持たない（4.2 の構造的担保）
// design.md「LIFF URL 契約」:
//   Flex ボタン → https://liff.line.me/{liffId} が本ページを起動する。storeId は URL に含めない
//   （認可主体は ID トークンの sub のみ）。本ページは liff.init() → liff.getIDToken() →
//   GET /api/detail（Authorization: Bearer）の流れを自ら行う。
//
// liff.init / liff.getIDToken はブラウザ専用 API のため、このページ自体を Client Component とする
// （'use client'。survey-web の survey-shell.tsx と同じ「クライアント合成シェル」パターンに倣う）。
//
// 構造的な no-write 保証（4.2）: このファイルは <form>・<button>・<input>・<textarea>・<select> の
// いずれも一切レンダリングしない（純粋な読取専用の表示のみ）。書込系 fetch（POST/PUT/DELETE/PATCH）
// も一切呼び出さない — 発行するのは `/api/detail` への GET のみ（test/store-page.test.tsx で検証）。

import { useEffect, useState } from 'react';
import liff from '@line/liff';

import type { DailySummaryCompetitor, DailySummaryNewReview } from '@fwlm/db';
// lib/data.ts（task 5.2・触れない）が定義する実際のレスポンス形状を型としてのみ取り込む
// （import type は実行時コードを一切バンドルしない — pg 等 Node 専用依存をクライアントへ持ち込まない）。
import type { StoreDetailResult, StoreDetailSummary, StoreDetailTrendPoint } from '../../lib/data';

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

// --- 画面状態 ------------------------------------------------------------------------

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly data: StoreDetailResult };

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

// --- /api/detail 呼出（GET のみ・Authorization ヘッダで認可） --------------------------

type DetailFetchResult =
  | { readonly ok: true; readonly data: StoreDetailResult }
  | { readonly ok: false; readonly message: string };

async function fetchStoreDetail(idToken: string): Promise<DetailFetchResult> {
  const res = await fetch('/api/detail', {
    method: 'GET',
    headers: { Authorization: `Bearer ${idToken}` },
  });

  if (res.ok) {
    const data = (await res.json()) as StoreDetailResult;
    return { ok: true, data };
  }
  if (res.status === 401) {
    return { ok: false, message: AUTH_ERROR_MESSAGE };
  }
  if (res.status === 404) {
    return { ok: false, message: NOT_FOUND_MESSAGE };
  }
  return { ok: false, message: SERVER_ERROR_MESSAGE };
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
        detailResult = await fetchStoreDetail(tokenResult.idToken);
      } catch {
        detailResult = { ok: false, message: NETWORK_ERROR_MESSAGE };
      }

      if (cancelled) {
        return;
      }
      if (detailResult.ok) {
        setState({ status: 'ready', data: detailResult.data });
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

  const { data } = state;
  return (
    <main>
      <h1>店舗詳細</h1>
      <SummarySection summary={data.summary} />
      <CompetitorsSection competitors={data.competitors} />
      <TrendSection trend={data.trend} />
      <p>{GOOGLE_ATTRIBUTION_TEXT}</p>
    </main>
  );
}
