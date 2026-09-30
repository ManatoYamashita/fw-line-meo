// 下書きが素材の外から「具体的な属性・事前の期待・再訪の意向」を補っていないかを検出する純関数（Issue #339）。
//
// 本番 E2E（2026-09-25）で、星 1・良かった点「雰囲気」・気になった点「雰囲気」・一言なしの素材から
// 「開放的で落ち着いた雰囲気」「コーヒーの香り漂う空間」「期待して伺いました」「改めて様子を見てみたい」が
// 生成された。既存の軸はどれも拾えなかった。
//   - detectAspectMentions（factuality.ts）: 客が **選ばなかった** 観点しか見ない。選んだ観点をどう書いたかは見ない
//   - detectVisitContextClaims（visit-context.ts）: 過去の来店の事情だけを数え、将来の意向は設計上数えない
//
// 形式と意味論は visit-context と同じである（分類ごとの正規表現と、一言に同じ分類の事情があれば数えない除外）。
// 検出ロジックは visit-context のものをそのまま使い、ここでは語彙と、分類名の約束だけを持つ。
//
// この関数は実 API を呼ばない。評価（eval/）と、本番の事後検証（generator.ts）の両方から使う。
// 本番で作り直しの引き金にするのは `expectation`（来店前の期待）の分類だけである（Issue #413）。再訪の意向と
// 観点の属性は発生が多く、属性は言い換えとの境界が曖昧なので、eval で測るだけにしている。検出器自身の正しさは
// test/embellishment-detect.test.ts が検証する（実 API 不要・CI で常時実行）。

import { detectVisitContextClaims, readVisitContextLexicon, type VisitContextLexicon } from './visit-context';

export type EmbellishmentLexicon = VisitContextLexicon;

export interface EmbellishmentClaim {
  /** expectation（事前の期待）／ intention（再訪の意向）／ attribute:<観点の code>（観点の具体的な属性） */
  readonly category: string;
  /** 実際に本文へ現れた箇所（証拠として残す） */
  readonly matchedText: string;
}

/** 照合に使う素材。店名に現れる語（「静かな森」など）は創作として数えない。 */
export interface EmbellishmentSource {
  readonly storeName: string;
  readonly comment?: string;
}

const ATTRIBUTE_PREFIX = 'attribute:';
const FIXED_CATEGORIES = ['expectation', 'intention'] as const;

/** 属性の分類が指す観点の code を返す（属性の分類でなければ undefined）。 */
export function attributeAspectOf(category: string): string | undefined {
  return category.startsWith(ATTRIBUTE_PREFIX) ? category.slice(ATTRIBUTE_PREFIX.length) : undefined;
}

/**
 * 下書き本文から、素材の外から補った属性・事前の期待・再訪の意向を検出する。
 *
 * @param draft 生成された下書き本文
 * @param source 素材（店名と客の一言）。一言に同じ分類の事情があれば、その分類は素材由来として数えない
 * @param lexicon 読み込み済みの語彙
 * @returns 検出した補完の一覧（同じ分類で複数当たっても分類ごとに 1 件へ畳む）
 */
export function detectEmbellishments(
  draft: string,
  source: EmbellishmentSource,
  lexicon: EmbellishmentLexicon,
): EmbellishmentClaim[] {
  // 店名は素材そのもの。先に取り除く（material-grounding と同じ扱い。空白を詰めた形も取り除く）。
  // 空白で置き換えるのは、前後の文字が繋がって別の語に化けないようにするため。
  let text = draft;
  for (const name of new Set([source.storeName, source.storeName.replace(/\s+/g, '')])) {
    if (name.trim() !== '') text = text.split(name).join(' ');
  }
  return detectVisitContextClaims(text, source.comment, lexicon);
}

/**
 * 語彙の JSON を読み込む。分類は expectation / intention / attribute:<code> だけを許す
 * （綴りの誤りで、属性の分類が観点に結びつかないまま黙って数えられることを防ぐ）。
 */
export function readEmbellishmentLexicon(raw: unknown): EmbellishmentLexicon {
  const lexicon = readVisitContextLexicon(raw, 'embellishment lexicon');
  for (const category of Object.keys(lexicon.patterns)) {
    const fixed = (FIXED_CATEGORIES as readonly string[]).includes(category);
    const aspect = attributeAspectOf(category);
    if (!fixed && (aspect === undefined || !/^[a-z]+$/.test(aspect))) {
      throw new Error(
        `embellishment lexicon の分類 ${category} は expectation / intention / attribute:<観点の code> のいずれかである必要があります`,
      );
    }
  }
  return lexicon;
}
