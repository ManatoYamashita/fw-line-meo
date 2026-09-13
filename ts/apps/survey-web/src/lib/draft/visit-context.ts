// 下書きが「来店の経緯・動機・同行者・来店歴」を創作していないかを検出する純関数（Issue #254）。
//
// アンケートはこれらを一切尋ねない。したがって客の一言に書かれていない限り、下書きに現れたら創作である。
// 本番 E2E（2026-09-13）では、書き出しの候補「訪問のきっかけから始める」のもとで「〇〇駅前を通る際に
// 立ち寄りました」「雰囲気を目当てに訪れましたが」が生成された。既存の detectAspectMentions
// （factuality.ts）は「客が選ばなかった評価軸への言及」しか見ないため、この型は 1 件も拾えなかった。
//
// この関数は実 API を呼ばない。評価（eval/）から使う。検出器自身の正しさは
// test/visit-context-detect.test.ts が検証する（実 API 不要・CI で常時実行）。

export interface VisitContextLexicon {
  readonly [category: string]: readonly RegExp[];
}

export interface VisitContextClaim {
  /** 創作が検出された分類（circumstance / motive / companion / history） */
  readonly category: string;
  /** 実際に本文へ現れた箇所（証拠として残す） */
  readonly matchedText: string;
}

/**
 * 下書き本文から、来店の経緯・動機などの創作を検出する。
 *
 * @param draft 生成された下書き本文
 * @param comment 客の一言（未入力なら undefined）。ここに同じ分類の記述があれば、その分類は素材由来として数えない
 * @param lexicon 分類ごとの検出パターン
 * @returns 検出した創作の一覧（同じ分類で複数当たっても分類ごとに 1 件へ畳む）
 */
export function detectVisitContextClaims(
  draft: string,
  comment: string | undefined,
  lexicon: VisitContextLexicon,
): VisitContextClaim[] {
  const claims: VisitContextClaim[] = [];

  for (const [category, patterns] of Object.entries(lexicon)) {
    // 客が一言に自分で書いた事情は、素材に含まれる事実であって創作ではない。言い換え（「友達と来た」を
    // 「友人と訪れました」と書く等）も創作に数えないよう、判定は分類単位で行う（誤検出を避ける側に倒す）。
    if (comment !== undefined && patterns.some((p) => p.test(comment))) continue;

    for (const pattern of patterns) {
      const hit = pattern.exec(draft);
      if (hit !== null) {
        claims.push({ category, matchedText: hit[0] });
        break;
      }
    }
  }

  return claims;
}

/** lexicon の JSON（`{"_comment": ..., "patterns": {...}}`）から、分類ごとの正規表現を組み立てる。 */
export function readVisitContextLexicon(raw: unknown): VisitContextLexicon {
  if (typeof raw !== 'object' || raw === null || !('patterns' in raw)) {
    throw new Error('visit-context lexicon の形式が不正です（patterns が存在しません）');
  }
  const patterns = (raw as { patterns: unknown }).patterns;
  if (typeof patterns !== 'object' || patterns === null) {
    throw new Error('visit-context lexicon の patterns が object ではありません');
  }
  const lexicon: Record<string, RegExp[]> = {};
  for (const [category, list] of Object.entries(patterns as Record<string, unknown>)) {
    if (!Array.isArray(list) || list.length === 0 || !list.every((s) => typeof s === 'string' && s.length >= 2)) {
      throw new Error(`visit-context lexicon の patterns.${category} は 2 文字以上の文字列の配列（1 件以上）である必要があります`);
    }
    // g / y フラグは付けない。付けると exec / test が lastIndex を持ち越し、呼ぶたびに結果が変わる。
    lexicon[category] = list.map((source: string) => new RegExp(source));
  }
  return lexicon;
}
