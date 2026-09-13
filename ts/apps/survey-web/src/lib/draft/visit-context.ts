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
  /** 下書き側の検出パターン（分類ごと）。明確な過去の事情だけを拾う */
  readonly patterns: { readonly [category: string]: readonly RegExp[] };
  /** 一言に同じ分類の事情が書かれているかの緩い手がかり（部分一致の語）。下書き側より広く取る */
  readonly commentHints: { readonly [category: string]: readonly string[] };
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
 * @param comment 客の一言（未入力なら undefined）。ここに同じ分類の事情があれば、その分類は素材由来として数えない
 * @param lexicon 分類ごとの検出パターンと、一言の手がかり
 * @returns 検出した創作の一覧（同じ分類で複数当たっても分類ごとに 1 件へ畳む）
 */
export function detectVisitContextClaims(
  draft: string,
  comment: string | undefined,
  lexicon: VisitContextLexicon,
): VisitContextClaim[] {
  const claims: VisitContextClaim[] = [];

  for (const [category, patterns] of Object.entries(lexicon.patterns)) {
    // 客が一言に自分で書いた事情は、素材に含まれる事実であって創作ではない。一言は下書きの言い回しと
    // 一致するとは限らない（一言「初めて行った」→ 下書き「初めて訪れました」）ので、下書き側より広い
    // 手がかりで判定し、当たれば分類ごと数えない（誤検出を避ける側に倒す）。
    if (comment !== undefined && mentionsCategory(comment, category, patterns, lexicon)) continue;

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

function mentionsCategory(
  comment: string,
  category: string,
  patterns: readonly RegExp[],
  lexicon: VisitContextLexicon,
): boolean {
  const hints = lexicon.commentHints[category] ?? [];
  return hints.some((hint) => comment.includes(hint)) || patterns.some((p) => p.test(comment));
}

/**
 * lexicon の JSON（`{"_comment", "placeholders", "patterns", "commentHints"}`）を組み立てる。
 * パターン中の `{NAME}` は placeholders.NAME へ置き換える（過去形の後置条件を 1 か所で持つため）。
 */
export function readVisitContextLexicon(raw: unknown): VisitContextLexicon {
  if (typeof raw !== 'object' || raw === null || !('patterns' in raw) || !('commentHints' in raw)) {
    throw new Error('visit-context lexicon の形式が不正です（patterns と commentHints が要ります）');
  }
  const { placeholders = {}, patterns, commentHints } = raw as {
    placeholders?: unknown;
    patterns: unknown;
    commentHints: unknown;
  };
  const names = asStringRecord(placeholders, 'placeholders');
  const rawPatterns = asStringListRecord(patterns, 'patterns');
  const hints = asStringListRecord(commentHints, 'commentHints');

  // 分類は両方向で一致させる。片方にしか無い分類は、一言の除外か検出のどちらかが黙って効かなくなる。
  const a = Object.keys(rawPatterns).sort().join(',');
  const b = Object.keys(hints).sort().join(',');
  if (a !== b) {
    throw new Error(`visit-context lexicon の patterns と commentHints の分類が一致しません（${a} / ${b}）`);
  }

  const compiled: Record<string, RegExp[]> = {};
  for (const [category, list] of Object.entries(rawPatterns)) {
    compiled[category] = list.map((source) => {
      const expanded = source.replace(/\{([A-Z_]+)\}/g, (_, name: string) => {
        const value = names[name];
        if (value === undefined) {
          throw new Error(`visit-context lexicon の patterns.${category} が未定義の置き換え {${name}} を使っています`);
        }
        return value;
      });
      // g / y フラグは付けない。付けると exec / test が lastIndex を持ち越し、呼ぶたびに結果が変わる。
      return new RegExp(expanded);
    });
  }
  return { patterns: compiled, commentHints: hints };
}

function asStringRecord(value: unknown, where: string): Record<string, string> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`visit-context lexicon の ${where} が object ではありません`);
  }
  for (const [key, v] of Object.entries(value)) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`visit-context lexicon の ${where}.${key} は空でない文字列である必要があります`);
    }
  }
  return value as Record<string, string>;
}

function asStringListRecord(value: unknown, where: string): Record<string, string[]> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`visit-context lexicon の ${where} が object ではありません`);
  }
  for (const [key, list] of Object.entries(value)) {
    if (!Array.isArray(list) || list.length === 0 || !list.every((s) => typeof s === 'string' && s.length >= 2)) {
      throw new Error(`visit-context lexicon の ${where}.${key} は 2 文字以上の文字列の配列（1 件以上）である必要があります`);
    }
  }
  return value as Record<string, string[]>;
}
