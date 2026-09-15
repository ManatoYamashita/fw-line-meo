// 日次サマリー（daily_summaries）の読込時の正規化と、評価・星差の表示整形（Issue #255）。
//
// Google の星評価は 1.0〜5.0 で定義されており、クチコミ 0 件の店は Places API の応答に rating を
// 持たない。旧 Go はこの欠落を float64 のゼロ値 0 として書いていたため、daily_summaries には
// 「評価 0 の店」が残っている（本番の実測: 競合 5 店のうち 1 店が 30 日分すべて rating 0・
// reviewCount 0 で、比較集合の最下位に数えられ rank_total を 1 つ水増ししていた）。新 Go は null を
// 書き、比較集合から外す。読込側はどちらの形を受け取っても同じ形へ揃えてから表示する。
//
// ⚠️ このモジュールは store-detail のクライアント画面（'use client'）にも同梱される。値の import を
//    1 つも持たない純関数だけで構成し、`@fwlm/db/daily-summary` のサブパスからだけ公開する。
//    root の `@fwlm/db` から再エクスポートしないのは、root が pg を含むため（IDE の自動 import が
//    root を選ぶと pg がクライアントへ入る）。値 import の禁止は ts/eslint.config.js の
//    no-restricted-imports が機械強制する。

import type { DailySummaryCompetitor, DailySummaryStatus } from './types.js';

// --- 表示文言（Flex と LIFF で同じものを使う） ------------------------------------------

/** 評価の無い店（クチコミ 0 件）の評価の表示。 */
export const UNRATED_LABEL = '評価なし';

/** 評価の無い競合が一覧にいるとき、一覧の下に添える注記。 */
export const UNRATED_EXCLUDED_NOTE = '評価のない店は順位に含めていません';

/** 自店に評価が無い日に、順位の位置へ出す文。 */
export const SELF_UNRATED_RANK_TEXT = 'まだ Google の評価が無いため、順位は出せません';

// --- 正規化 ------------------------------------------------------------------------

/** 正規化の対象になる、日次サマリーの評価・順位まわりの列。 */
export interface SummaryRatingFields {
  readonly rating: string | null; // numeric(2,1)（pg は文字列で返す）
  readonly rating_prev: string | null; // numeric(2,1)
  readonly rank: number | null;
  readonly rank_total: number | null;
  readonly rank_prev: number | null;
  readonly competitors: readonly DailySummaryCompetitor[];
}

/** 正規化後の同じ列。呼出元は `{ ...row, ...normalizeSummaryRatings(row) }` で行へ戻す。 */
export interface NormalizedSummaryRatings {
  readonly rating: string | null;
  readonly rating_prev: string | null;
  readonly rank: number | null;
  readonly rank_total: number | null;
  readonly rank_prev: number | null;
  readonly competitors: DailySummaryCompetitor[];
}

/** numeric(2,1) の文字列表現（自店の rating 列）が評価を持つか。null・'0.0'・数値でない値は持たない。 */
function isRatedColumn(value: string | null): boolean {
  return value !== null && Number(value) > 0;
}

/**
 * jsonb 内の評価値（競合の rating）を「評価か null」に揃える。
 *
 * 数値だけを評価として受け取る。Go は JSON の数値か null しか書かないため、それ以外（文字列など）は
 * 契約違反であり、評価として表示しない。0 以下は旧 Go のゼロ値（= 評価なし）として読む。
 */
function ratingFromJson(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function isObject(value: unknown): boolean {
  return value !== null && typeof value === 'object';
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 日次サマリーの評価・順位まわりの列を、評価の無い店を null で表す形へ揃える。
 *
 * - 競合の rating が 0（旧 Go のゼロ値）や null なら「評価なし」（rating・starDiff とも null）
 * - 自店が評価なし（rating が null か '0.0'）なら rating・rank・rank_total・rank_prev と
 *   全競合の starDiff を null にする（評価が無い店に順位は付けない・比べる元が無い）
 * - 旧 Go の行で自店に評価があるときは、rank_total から「評価 0 の競合」の数を引く。評価 0 の店は
 *   常に最下位に数えられていたので自店の順位は正しく、母数だけがちょうどその件数ぶん多い。
 *   新 Go の行は 0 ではなく null を書くので、この補正は二重には効かない
 * - rating_prev が '0.0'（前日は評価なし）なら rating_prev・rank_prev を null にする
 *
 * 例外は投げない（配信ジョブはオーナー単位の隔離の外でこれを呼ぶため、1 行の不整合で全体を止めない）。
 *
 * 旧 Go の行（評価 0）のための母数の補正は、Go が評価なしを null で書くようになって（Issue #255）
 * から 30 日（スナップショット・サマリーの保持期間）が過ぎ、本番に rating 0 の行が残っていない
 * ことを確かめたら撤去できる。0 を「評価なし」と読む規則そのものは、評価の定義域（1.0〜5.0）から
 * 導かれるので残してよい。
 */
export function normalizeSummaryRatings(row: SummaryRatingFields): NormalizedSummaryRatings {
  const selfRated = isRatedColumn(row.rating);
  // jsonb から来た値は型どおりとは限らない。オブジェクトでない要素（null など）は表示できないので
  // 読み飛ばす（ここで投げると、配信ジョブではその時刻の全オーナーの配信が止まる）。
  const rawCompetitors: readonly DailySummaryCompetitor[] = Array.isArray(row.competitors)
    ? row.competitors.filter((competitor) => isObject(competitor))
    : [];

  let legacyZeroCount = 0;
  const competitors = rawCompetitors.map((competitor): DailySummaryCompetitor => {
    const rawRating: unknown = competitor.rating;
    if (rawRating === 0) {
      legacyZeroCount += 1;
    }
    const rating = ratingFromJson(rawRating);
    return {
      name: competitor.name,
      rating,
      reviewCount: competitor.reviewCount,
      starDiff: selfRated && rating !== null ? finiteOrNull(competitor.starDiff) : null,
    };
  });

  const previousRated = isRatedColumn(row.rating_prev);
  const ratingPrev = previousRated ? row.rating_prev : null;

  if (!selfRated) {
    return { rating: null, rating_prev: ratingPrev, rank: null, rank_total: null, rank_prev: null, competitors };
  }

  // 補正後の母数が自店の順位を下回るなら、その行は旧 Go の形ではない。推測で直さず元の値を残す。
  const correctedTotal = row.rank_total === null ? null : row.rank_total - legacyZeroCount;
  const rankTotal =
    correctedTotal !== null && correctedTotal >= (row.rank ?? 1) ? correctedTotal : row.rank_total;

  return {
    rating: row.rating,
    rating_prev: ratingPrev,
    rank: row.rank,
    rank_total: rankTotal,
    rank_prev: previousRated ? row.rank_prev : null,
    competitors,
  };
}

/** 推移の 1 点（rating_snapshots の自店行）。評価の無い日は順位も持たない。 */
export function normalizeSnapshotRating(point: { readonly rating: string | null; readonly rank: number | null }): {
  readonly rating: string | null;
  readonly rank: number | null;
} {
  return isRatedColumn(point.rating) ? { rating: point.rating, rank: point.rank } : { rating: null, rank: null };
}

// --- 表示整形 ------------------------------------------------------------------------

/**
 * 評価を表示用の文字列にする。評価があれば `★4.0`（小数 1 桁）、無ければ「評価なし」。
 * 自店の numeric 文字列（'4.2'）と競合の数値（4）のどちらも受け取る。
 */
export function formatRatingLabel(rating: number | string | null): string {
  if (rating === null) {
    return UNRATED_LABEL;
  }
  const value = Number(rating);
  return Number.isFinite(value) && value > 0 ? `★${value.toFixed(1)}` : UNRATED_LABEL;
}

/**
 * 星差（自店 − 競合）を符号つき小数 1 桁の文字列にする（+0.3 / -0.2 / 0.0）。
 * null（どちらかが評価なし）は null を返し、呼出元は星差そのものを出さない。
 * 丸めた結果が 0 なら符号を付けない（`-0.0` を出さない）。
 */
export function formatStarDiff(diff: number | null): string | null {
  if (diff === null || !Number.isFinite(diff)) {
    return null;
  }
  const rounded = Math.round(diff * 10) / 10;
  if (rounded === 0) {
    return '0.0';
  }
  return rounded > 0 ? `+${rounded.toFixed(1)}` : rounded.toFixed(1);
}

/** 競合一覧に評価の無い店がいるか（注記を出すかの判定）。 */
export function hasUnratedCompetitor(competitors: readonly DailySummaryCompetitor[]): boolean {
  return competitors.some((competitor) => competitor.rating === null);
}

/**
 * 自店に評価が無い日か。取得失敗（failed）は別の状態なので含めない。
 * 評価の判定は formatRatingLabel と同じ規則にする（null・'0.0' は評価なし）。正規化の前の行を
 * 渡されても、見出しと本文で判定が食い違わないようにするため。
 */
export function isUnratedSelf(status: DailySummaryStatus, rating: string | null): boolean {
  return status !== 'failed' && !isRatedColumn(rating);
}
