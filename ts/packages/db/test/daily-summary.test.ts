import { describe, expect, it } from 'vitest';
import type { DailySummaryCompetitor } from '../src/types.js';
import {
  SELF_UNRATED_RANK_TEXT,
  UNRATED_EXCLUDED_NOTE,
  UNRATED_LABEL,
  formatRatingLabel,
  formatStarDiff,
  hasUnratedCompetitor,
  isUnratedSelf,
  normalizeSnapshotRating,
  normalizeSummaryRatings,
  type SummaryRatingFields,
} from '../src/daily-summary.js';

// Issue #255: Google に評価が無い店（クチコミ 0 件）の読込時の正規化と表示整形。
//
// 旧 Go は評価の欠落をゼロ値 0 として書いていた（本番の実測: 競合 5 店のうち 1 店が rating 0・
// reviewCount 0 で、比較集合の最下位に数えられ rank_total を 1 つ水増ししていた）。新 Go は null を
// 書き、比較集合から外す。どちらの形を受け取っても、表示の前に同じ形へ揃うことを表で固定する。

function row(overrides: Partial<SummaryRatingFields> = {}): SummaryRatingFields {
  return {
    rating: '4.3',
    rating_prev: '4.3',
    rank: 1,
    rank_total: 3,
    rank_prev: 1,
    competitors: [
      { name: '競合イチ', rating: 4.0, reviewCount: 300, starDiff: 0.3 },
      { name: '競合ニ', rating: 3.9, reviewCount: 200, starDiff: 0.4 },
    ],
    ...overrides,
  };
}

/** jsonb から来る値は型に反した形でも届きうる（契約違反の再現用）。 */
function rawCompetitor(value: Record<string, unknown>): DailySummaryCompetitor {
  return value as unknown as DailySummaryCompetitor;
}

describe('normalizeSummaryRatings', () => {
  it('全店に評価がある行はそのまま返す', () => {
    const input = row();
    expect(normalizeSummaryRatings(input)).toEqual({
      rating: '4.3',
      rating_prev: '4.3',
      rank: 1,
      rank_total: 3,
      rank_prev: 1,
      competitors: input.competitors,
    });
  });

  it('旧 Go の評価 0 の競合を「評価なし」にし、母数をその件数だけ戻す（自店の順位は変えない）', () => {
    const result = normalizeSummaryRatings(
      row({
        rank: 1,
        rank_total: 6,
        competitors: [
          { name: '競合イチ', rating: 4.0, reviewCount: 300, starDiff: 0.3 },
          { name: '競合ニ', rating: 3.9, reviewCount: 200, starDiff: 0.4 },
          { name: '競合サン', rating: 3.7, reviewCount: 100, starDiff: 0.6 },
          { name: '競合ヨン', rating: 0, reviewCount: 0, starDiff: 4.3 },
          { name: '競合ゴ', rating: 0, reviewCount: 0, starDiff: 4.3 },
        ],
      }),
    );
    expect(result.rank).toBe(1);
    expect(result.rank_total).toBe(4);
    expect(result.competitors.slice(3)).toEqual([
      { name: '競合ヨン', rating: null, reviewCount: 0, starDiff: null },
      { name: '競合ゴ', rating: null, reviewCount: 0, starDiff: null },
    ]);
    expect(result.competitors.slice(0, 3).map((c) => c.starDiff)).toEqual([0.3, 0.4, 0.6]);
  });

  it('新 Go の null はそのまま読み、母数を二重に引かない', () => {
    const result = normalizeSummaryRatings(
      row({
        rank: 2,
        rank_total: 3,
        competitors: [
          { name: '競合イチ', rating: 4.5, reviewCount: 100, starDiff: -0.2 },
          { name: '競合ニ', rating: 4.0, reviewCount: 30, starDiff: 0.3 },
          { name: '競合サン', rating: null, reviewCount: 0, starDiff: null },
        ],
      }),
    );
    expect(result.rank_total).toBe(3);
    expect(result.competitors[2]).toEqual({ name: '競合サン', rating: null, reviewCount: 0, starDiff: null });
  });

  it.each([
    ['null', null],
    ["'0.0'（旧 Go のゼロ値）", '0.0'],
  ])('自店の評価が %s なら、順位と全競合の星差を持たせない（競合の評価は残す）', (_label, rating) => {
    const result = normalizeSummaryRatings(
      row({
        rating,
        rating_prev: rating,
        rank: 3,
        rank_total: 3,
        rank_prev: 3,
        competitors: [
          { name: '競合イチ', rating: 4.5, reviewCount: 120, starDiff: -4.5 },
          { name: '競合ニ', rating: 0, reviewCount: 0, starDiff: 0 },
        ],
      }),
    );
    expect(result).toEqual({
      rating: null,
      rating_prev: null,
      rank: null,
      rank_total: null,
      rank_prev: null,
      competitors: [
        { name: '競合イチ', rating: 4.5, reviewCount: 120, starDiff: null },
        { name: '競合ニ', rating: null, reviewCount: 0, starDiff: null },
      ],
    });
  });

  it("前日が評価なし（rating_prev '0.0'）なら前日の評価と順位を持たせない", () => {
    const result = normalizeSummaryRatings(row({ rating_prev: '0.0', rank_prev: 3 }));
    expect(result.rating_prev).toBeNull();
    expect(result.rank_prev).toBeNull();
    expect(result.rank).toBe(1);
  });

  it('前日の記録が無い（R3.7）ときは null のまま', () => {
    const result = normalizeSummaryRatings(row({ rating_prev: null, rank_prev: null }));
    expect(result.rating_prev).toBeNull();
    expect(result.rank_prev).toBeNull();
  });

  it('数値でない評価（契約違反の文字列など）は評価として扱わず、母数も補正しない', () => {
    const result = normalizeSummaryRatings(
      row({
        rank_total: 3,
        competitors: [
          rawCompetitor({ name: '競合イチ', rating: '4.2', reviewCount: 50, starDiff: '0.1' }),
          rawCompetitor({ name: '競合ニ', reviewCount: 0 }),
        ],
      }),
    );
    expect(result.rank_total).toBe(3);
    expect(result.competitors).toEqual([
      { name: '競合イチ', rating: null, reviewCount: 50, starDiff: null },
      { name: '競合ニ', rating: null, reviewCount: 0, starDiff: null },
    ]);
  });

  it('補正後の母数が自店の順位を下回る行は旧 Go の形ではないので、母数を推測で直さない', () => {
    const result = normalizeSummaryRatings(
      row({
        rank: 3,
        rank_total: 3,
        competitors: [
          { name: '競合イチ', rating: 4.5, reviewCount: 100, starDiff: -0.2 },
          { name: '競合ニ', rating: 0, reviewCount: 0, starDiff: 4.3 },
        ],
      }),
    );
    expect(result.rank_total).toBe(3);
    expect(result.competitors[1]).toEqual({ name: '競合ニ', rating: null, reviewCount: 0, starDiff: null });
  });

  it('例外を投げない（competitors が配列でない行も空の一覧として読む）', () => {
    const broken = { ...row(), competitors: null } as unknown as SummaryRatingFields;
    expect(() => normalizeSummaryRatings(broken)).not.toThrow();
    expect(normalizeSummaryRatings(broken).competitors).toEqual([]);
  });
});

describe('normalizeSnapshotRating', () => {
  it.each([
    [{ rating: '4.5', rank: 2 }, { rating: '4.5', rank: 2 }],
    [{ rating: '0.0', rank: 3 }, { rating: null, rank: null }],
    [{ rating: null, rank: 3 }, { rating: null, rank: null }],
  ])('%j → %j', (input, expected) => {
    expect(normalizeSnapshotRating(input)).toEqual(expected);
  });
});

describe('formatRatingLabel', () => {
  it.each([
    [4.5, '★4.5'],
    [4, '★4.0'],
    ['4.2', '★4.2'],
    ['4.0', '★4.0'],
    [null, UNRATED_LABEL],
    [0, UNRATED_LABEL],
    ['0.0', UNRATED_LABEL],
  ] as const)('%j → %s', (input, expected) => {
    expect(formatRatingLabel(input)).toBe(expected);
  });
});

describe('formatStarDiff', () => {
  it.each([
    [0.3, '+0.3'],
    [1, '+1.0'],
    [-0.2, '-0.2'],
    [0, '0.0'],
    // 丸めると 0 になる負の値に符号を付けない（toFixed だけだと '-0.0' になる）。
    [-0.04, '0.0'],
    [-0, '0.0'],
    // Go の丸め（math.Round(v*10)/10）が残す 2 進誤差を吸収する。
    [0.30000000000000004, '+0.3'],
  ])('%s → %s', (input, expected) => {
    expect(formatStarDiff(input)).toBe(expected);
  });

  it('null（どちらかが評価なし）は null を返し、呼出元は星差を出さない', () => {
    expect(formatStarDiff(null)).toBeNull();
  });
});

describe('hasUnratedCompetitor / isUnratedSelf', () => {
  it('評価の無い競合がいるときだけ真', () => {
    expect(hasUnratedCompetitor([{ name: 'A', rating: null, reviewCount: 0, starDiff: null }])).toBe(true);
    expect(hasUnratedCompetitor([{ name: 'A', rating: 4.0, reviewCount: 1, starDiff: 0.1 }])).toBe(false);
    expect(hasUnratedCompetitor([])).toBe(false);
  });

  it('取得失敗（failed）は「自店に評価が無い日」と区別する', () => {
    expect(isUnratedSelf('ready', null)).toBe(true);
    expect(isUnratedSelf('no_competitors', null)).toBe(true);
    expect(isUnratedSelf('failed', null)).toBe(false);
    expect(isUnratedSelf('ready', '4.3')).toBe(false);
  });
});

describe('表示文言', () => {
  it('Flex と LIFF が共有する文言を固定する', () => {
    expect(UNRATED_LABEL).toBe('評価なし');
    expect(UNRATED_EXCLUDED_NOTE).toBe('評価のない店は順位に含めていません');
    expect(SELF_UNRATED_RANK_TEXT).toBe('まだ Google の評価が無いため、順位は出せません');
  });
});
