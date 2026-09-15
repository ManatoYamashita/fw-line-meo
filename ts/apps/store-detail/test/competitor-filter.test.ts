// store-detail-trend-dashboard task 2.3（Issue #265）: 競合店名の検索語の正規化と、競合一覧の絞り込みの
// 純関数（lib/competitor-filter.ts）を検証する。
//
// 照合の規則は要件 4.3〜4.6 と、design.md の competitor-filter の契約のとおりである。
// - 検索語と店名の両方を、NFKC 正規化 → 小文字化 → カタカナ（U+30A1〜U+30F6）をひらがなへ畳み込む
//   → 前後の空白を除く、の順に正規化してから比べる。
// - 照合は文字列の包含（部分一致）で判定し、正規表現を使わない。記号はそのまま一致する。
// - 一覧は渡された並び（rank 順）の部分列にする。正規化した検索語が空なら全件を返す。
// - 総数は常に全件の数で、評価の無い店も数える。
//
// 期待する正規化の結果と店名の並びは、実装と同じ計算で作らずリテラルで書く。同じ計算で期待値を作ると、
// 計算の誤りが両側で打ち消し合って検査が緑のまま素通りするためである。
//
// 店名はすべて架空の名前にする（このリポジトリは公開されている）。
//
// このファイルは node 環境で走る（DOM を使わない）。
import { describe, expect, it } from 'vitest';

import type { DailySummaryCompetitor } from '@fwlm/db';

import { SEARCH_MIN_COMPETITORS, filterCompetitors, normalizeForSearch } from '../lib/competitor-filter';
import { UNRATED_COMPETITOR_FROM_GO } from './fixtures/unrated-competitor';

// --- テスト用の競合 --------------------------------------------------------------------

/** 評価を持つ競合を 1 店作る。上書きした項目だけが変わる。 */
function competitor(
  name: string,
  values: Partial<Omit<DailySummaryCompetitor, 'name'>> = {},
): DailySummaryCompetitor {
  return { name, rating: 4.0, reviewCount: 50, starDiff: 0.1, ...values };
}

/** 評価の無い競合を 1 店作る（Go の日次バッチが書く形と同じく、評価と差が null になる）。 */
function unratedCompetitor(name: string): DailySummaryCompetitor {
  return { name, rating: null, reviewCount: 0, starDiff: null };
}

/** 絞り込んだ結果の店名を、並びのまま取り出す。 */
function visibleNames(competitors: readonly DailySummaryCompetitor[], rawQuery: string): readonly string[] {
  return filterCompetitors(competitors, rawQuery).visible.map((c) => c.name);
}

// 当日の競合 5 店（rank 順）。店名の表記を、全角カタカナ・大文字の英字・評価なし・半角カナ・全角英数字に
// 散らしてある。この並びは店名の文字コード順とも評価の順とも異なるので、並べ替えると順序の検査が赤になる。
// 一覧は凍結しておき、渡された配列をその場で並べ替える実装は例外で落とす。
const CAFE = competitor('カフェ・サンプル', { rating: 4.5 });
const BISTRO = competitor('BISTRO Sample', { rating: 4.4 });
/** 評価の無い店。名前は「競合サン」で、Go の言語間試験の固定データと同じ値である。 */
const UNRATED: DailySummaryCompetitor = UNRATED_COMPETITOR_FROM_GO;
const GARDEN = competitor('ｶﾞｰﾃﾞﾝ競合', { rating: 3.8 });
const FULL_WIDTH = competitor('ＣＡＦＥ競合２号', { rating: 4.1 });
const COMPETITORS: readonly DailySummaryCompetitor[] = Object.freeze([CAFE, BISTRO, UNRATED, GARDEN, FULL_WIDTH]);

// --- 定数 ------------------------------------------------------------------------------

describe('SEARCH_MIN_COMPETITORS', () => {
  it('検索欄を出す競合の数の下限は 2 店である（要件 4.1・4.2）', () => {
    expect(SEARCH_MIN_COMPETITORS).toBe(2);
  });
});

// --- 正規化 ----------------------------------------------------------------------------

describe('normalizeForSearch', () => {
  it('半角カナを全角にしてから、ひらがなへ畳み込む（半角の濁点は前の仮名と結合する）', () => {
    expect(normalizeForSearch('ｶﾌｪ')).toBe('かふぇ');
    expect(normalizeForSearch('ｶﾞｰﾃﾞﾝ')).toBe('がーでん');
    expect(normalizeForSearch('ｳﾞｨﾗ')).toBe('ゔぃら');
  });

  it('全角の英数字と記号を半角にし、英字を小文字にする', () => {
    expect(normalizeForSearch('ＣＡＦＥ２号')).toBe('cafe2号');
    expect(normalizeForSearch('BISTRO Sample')).toBe('bistro sample');
    expect(normalizeForSearch('（本店）')).toBe('(本店)');
  });

  it('カタカナの範囲（U+30A1〜U+30F6）の両端と、ヴ・小書きの仮名をひらがなへ畳み込む', () => {
    // U+30A1（小書きのア）→ U+3041、U+30F6（小書きのケ）→ U+3096、U+30F4（ヴ）→ U+3094
    expect(normalizeForSearch('ァ')).toBe('ぁ');
    expect(normalizeForSearch('ヶ')).toBe('ゖ');
    expect(normalizeForSearch('ヴ')).toBe('ゔ');
    expect(normalizeForSearch('ッ')).toBe('っ');
    expect(normalizeForSearch('サンプル')).toBe('さんぷる');
  });

  it('カタカナの範囲の外にある文字と、ひらがな・漢字は変えない', () => {
    // U+30A0（゠）は範囲の直前、U+30F7（ヷ）は範囲の直後。U+30FB（中黒）と U+30FC（長音記号）は
    // ひらがなの文でも使う記号、U+30FD（踊り字）は design が定める範囲の外である。
    for (const text of ['゠', 'ヷ', '・', 'ー', 'ヽ', 'さんぷる', '競合']) {
      expect(normalizeForSearch(text)).toBe(text);
    }
  });

  it('前後の空白（半角・全角・タブ・改行）を除き、内側の空白は残して半角にする', () => {
    expect(normalizeForSearch(' 　\tカフェ　サンプル\n ')).toBe('かふぇ さんぷる');
  });

  it('空文字と、空白だけの文字列は、空文字になる', () => {
    for (const text of ['', ' ', '　　', '\t\n', ' 　 ']) {
      expect(normalizeForSearch(text)).toBe('');
    }
  });

  it('正規表現の記号は変えない', () => {
    expect(normalizeForSearch('(本店).*[')).toBe('(本店).*[');
  });

  it('正規化した結果をもう一度正規化しても変わらない', () => {
    for (const text of ['ｶﾞｰﾃﾞﾝ競合', 'ＣＡＦＥ競合２号', 'BISTRO Sample', ' ヴィラ・サンプル ', '（本店）']) {
      const once = normalizeForSearch(text);
      expect(normalizeForSearch(once)).toBe(once);
    }
  });
});

// --- 絞り込み --------------------------------------------------------------------------

describe('filterCompetitors', () => {
  describe('表記の揺れを区別しない（要件 4.4）', () => {
    it('半角カナの検索語が、全角カタカナの店名に一致する', () => {
      expect(visibleNames(COMPETITORS, 'ｶﾌｪ')).toEqual(['カフェ・サンプル']);
    });

    it('全角カタカナの検索語が、半角カナの店名に一致する（濁点つき）', () => {
      expect(visibleNames(COMPETITORS, 'ガーデン')).toEqual(['ｶﾞｰﾃﾞﾝ競合']);
    });

    it('全角英字の検索語が、半角英字の店名に一致する', () => {
      expect(visibleNames(COMPETITORS, 'ｂｉｓｔｒｏ')).toEqual(['BISTRO Sample']);
    });

    it('半角英数字の検索語が、全角英数字の店名に一致する', () => {
      expect(visibleNames(COMPETITORS, 'cafe')).toEqual(['ＣＡＦＥ競合２号']);
      expect(visibleNames(COMPETITORS, '2号')).toEqual(['ＣＡＦＥ競合２号']);
    });

    it('英字の大文字と小文字を区別しない', () => {
      expect(visibleNames(COMPETITORS, 'bistro')).toEqual(['BISTRO Sample']);
      expect(visibleNames(COMPETITORS, 'sAmPlE')).toEqual(['BISTRO Sample']);
      expect(visibleNames(COMPETITORS, 'CAFE')).toEqual(['ＣＡＦＥ競合２号']);
    });

    it('ひらがなの検索語が、カタカナの店名に一致する', () => {
      expect(visibleNames(COMPETITORS, 'かふぇ')).toEqual(['カフェ・サンプル']);
    });

    it('カタカナの検索語が、ひらがなの店名に一致する', () => {
      const competitors = [competitor('すし処さんぷる'), competitor('競合A')];
      expect(visibleNames(competitors, 'スシ')).toEqual(['すし処さんぷる']);
    });

    it('長音記号・ヴ・小書きの仮名を含む表記も、ひらがなとカタカナの違いを区別しない', () => {
      const competitors = [competitor('ラーメン競合'), competitor('ヴィラ・サンプル'), competitor('きっさ競合')];
      expect(visibleNames(competitors, 'らーめん')).toEqual(['ラーメン競合']);
      expect(visibleNames(competitors, 'ゔぃら')).toEqual(['ヴィラ・サンプル']);
      expect(visibleNames(competitors, 'ｳﾞｨﾗ')).toEqual(['ヴィラ・サンプル']);
      expect(visibleNames(competitors, 'キッサ')).toEqual(['きっさ競合']);
    });
  });

  describe('部分一致で絞り込む（要件 4.3）', () => {
    it('店名の先頭・途中・末尾のどこに現れる検索語でも一致する', () => {
      expect(visibleNames(COMPETITORS, 'サンプル')).toEqual(['カフェ・サンプル']);
      expect(visibleNames(COMPETITORS, 'ample')).toEqual(['BISTRO Sample']);
      // 「競合サン」は先頭、「ｶﾞｰﾃﾞﾝ競合」は末尾、「ＣＡＦＥ競合２号」は途中に現れる。
      expect(visibleNames(COMPETITORS, '競合')).toEqual(['競合サン', 'ｶﾞｰﾃﾞﾝ競合', 'ＣＡＦＥ競合２号']);
    });

    it('濁点の有無は区別し、清音の検索語は濁音を含む店名に一致しない', () => {
      // 「ｶﾞｰﾃﾞﾝ競合」は正規化で「がーでん競合」になる。濁点を分解する正規化（NFKD）では「か」を含んでしまう。
      expect(visibleNames(COMPETITORS, 'か')).toEqual(['カフェ・サンプル']);
      expect(visibleNames(COMPETITORS, 'ｶ')).toEqual(['カフェ・サンプル']);
    });

    it('どの店名にも含まれない検索語では一覧が 0 件になり、総数は変わらない', () => {
      const result = filterCompetitors(COMPETITORS, 'zzzzzzzzzzzzzzzzzzzz');
      expect(result.visible).toEqual([]);
      expect(result.total).toBe(5);
    });

    it('店名そのものを検索語にすると、その店が一覧に残る', () => {
      for (const item of COMPETITORS) {
        expect(filterCompetitors(COMPETITORS, item.name).visible).toContain(item);
      }
    });
  });

  describe('検索語の前後の空白を無視する（要件 4.4）', () => {
    it('前後の半角・全角の空白、タブ、改行を無視する', () => {
      expect(visibleNames(COMPETITORS, '  サンプル　')).toEqual(['カフェ・サンプル']);
      expect(visibleNames(COMPETITORS, '　\tbistro \n')).toEqual(['BISTRO Sample']);
    });

    it('空白だけの検索語は空として扱い、全件を返す', () => {
      for (const rawQuery of [' ', '   ', '　', '\t\n', ' 　 ']) {
        const result = filterCompetitors(COMPETITORS, rawQuery);
        expect(result.visible).toEqual(COMPETITORS);
        expect(result.total).toBe(5);
      }
    });

    it('内側の空白は除かず、全角の空白は半角の空白と同じに扱う', () => {
      expect(visibleNames(COMPETITORS, 'BISTRO　Sample')).toEqual(['BISTRO Sample']);
      expect(visibleNames(COMPETITORS, 'bistrosample')).toEqual([]);
    });
  });

  describe('正規表現を使わず、記号をそのまま照合する', () => {
    const SYMBOLS: readonly DailySummaryCompetitor[] = Object.freeze([
      competitor('競合(本店)'),
      competitor('Sample.Cafe'),
      competitor('居酒屋*サンプル'),
      competitor('競合A'),
    ]);

    it('括弧・点・星印は、その文字を含む店名にだけ一致する', () => {
      expect(visibleNames(SYMBOLS, '(')).toEqual(['競合(本店)']);
      expect(visibleNames(SYMBOLS, ')')).toEqual(['競合(本店)']);
      expect(visibleNames(SYMBOLS, '.')).toEqual(['Sample.Cafe']);
      expect(visibleNames(SYMBOLS, '*')).toEqual(['居酒屋*サンプル']);
    });

    it('全角の括弧の検索語が、半角の括弧の店名に一致する', () => {
      expect(visibleNames(SYMBOLS, '（本店）')).toEqual(['競合(本店)']);
    });

    it('正規表現として解釈すると例外になる検索語でも、例外を投げずに文字どおり照合する', () => {
      expect(visibleNames(SYMBOLS, '(本店')).toEqual(['競合(本店)']);
      expect(visibleNames(SYMBOLS, '*サンプル')).toEqual(['居酒屋*サンプル']);
      expect(visibleNames(SYMBOLS, '[')).toEqual([]);
      expect(visibleNames(SYMBOLS, '\\')).toEqual([]);
    });

    it('正規表現として解釈すると広く一致する検索語は、文字どおりにしか一致しない', () => {
      expect(visibleNames(SYMBOLS, '.*')).toEqual([]);
      expect(visibleNames(SYMBOLS, '競合.')).toEqual([]);
      expect(visibleNames(SYMBOLS, '^競合')).toEqual([]);
      expect(visibleNames(SYMBOLS, '競合|居酒屋')).toEqual([]);
      expect(visibleNames(SYMBOLS, 'sample.')).toEqual(['Sample.Cafe']);
    });
  });

  describe('空の検索語では全件を返す（要件 4.5）', () => {
    it('空文字なら、全件を渡された順で返す', () => {
      const result = filterCompetitors(COMPETITORS, '');
      expect(result.visible).toEqual(COMPETITORS);
      COMPETITORS.forEach((item, index) => {
        expect(result.visible[index]).toBe(item);
      });
      expect(result.total).toBe(5);
    });

    it('競合が 0 店なら、検索語に依らず一覧も総数も 0 である', () => {
      expect(filterCompetitors([], '')).toEqual({ visible: [], total: 0 });
      expect(filterCompetitors([], 'かふぇ')).toEqual({ visible: [], total: 0 });
    });
  });

  describe('評価の無い店も対象と総数に含める（要件 4.6）', () => {
    it('評価の無い店も、店名が一致すれば一覧に残る', () => {
      const result = filterCompetitors(COMPETITORS, 'さん');
      expect(result.visible.map((c) => c.name)).toEqual(['カフェ・サンプル', '競合サン']);
      expect(result.visible[1]).toBe(UNRATED);
      expect(result.visible[1]?.rating).toBeNull();
    });

    it('総数は、絞り込みの結果に依らず、評価の無い店を含む全件の数である', () => {
      for (const rawQuery of ['', 'かふぇ', '競合', 'さん', 'zzzzzzzzzzzzzzzzzzzz']) {
        expect(filterCompetitors(COMPETITORS, rawQuery).total).toBe(5);
      }
    });

    it('評価の無い店だけの一覧でも、全件を数えて絞り込む', () => {
      const competitors = [UNRATED, unratedCompetitor('競合B')];
      expect(filterCompetitors(competitors, '')).toEqual({ visible: competitors, total: 2 });
      expect(filterCompetitors(competitors, 'b')).toEqual({ visible: [competitors[1]], total: 2 });
    });
  });

  describe('渡された並びを保つ（要件 4.3）', () => {
    it('一致した店を、渡された順（rank 順）のまま返す', () => {
      // 店名の順（A・B・C）でも評価の順でもない並び。
      const competitors = Object.freeze([
        competitor('競合C', { rating: 3.5 }),
        competitor('競合A', { rating: 4.8 }),
        unratedCompetitor('競合B'),
        competitor('カフェ・サンプル', { rating: 4.9 }),
      ]);
      expect(visibleNames(competitors, '競合')).toEqual(['競合C', '競合A', '競合B']);
      expect(visibleNames(competitors, '')).toEqual(['競合C', '競合A', '競合B', 'カフェ・サンプル']);
    });

    it('一覧の要素は渡された競合そのもので、店名は正規化する前の表記のまま', () => {
      const garden = filterCompetitors(COMPETITORS, 'ガーデン').visible;
      expect(garden[0]).toBe(GARDEN);
      expect(garden[0]?.name).toBe('ｶﾞｰﾃﾞﾝ競合');

      const fullWidth = filterCompetitors(COMPETITORS, 'cafe').visible;
      expect(fullWidth[0]).toBe(FULL_WIDTH);
      expect(fullWidth[0]?.name).toBe('ＣＡＦＥ競合２号');
    });

    it('渡された一覧を書き換えない', () => {
      const competitors = [CAFE, BISTRO, UNRATED, GARDEN, FULL_WIDTH];
      filterCompetitors(competitors, '競合');
      filterCompetitors(competitors, '');
      expect(competitors).toHaveLength(5);
      [CAFE, BISTRO, UNRATED, GARDEN, FULL_WIDTH].forEach((item, index) => {
        expect(competitors[index]).toBe(item);
      });
      expect(CAFE.name).toBe('カフェ・サンプル');
      expect(GARDEN.name).toBe('ｶﾞｰﾃﾞﾝ競合');
    });
  });
});
