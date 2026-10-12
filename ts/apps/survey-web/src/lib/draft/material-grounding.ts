// 下書きが素材に無い固有名詞・数値・日付を創作していないかを検出する純関数（Issue #222）。
//
// Requirement 3.2 は「素材に含まれない体験・事実・固有名詞」を禁じる。既存の 2 軸
// （factuality.ts の未選択の観点・visit-context.ts の来店の経緯）は、実在しない料理名・駅名・
// 待ち時間・「先週末に」といった形を 1 件も拾えなかった。いずれも Google の 2026-04 改定が禁止の
// 実体として名指しする「実体験に基づかないコンテンツ」として読まれうる。
//
// 形態素解析も LLM 判定も使わず、正規表現と語彙で決定的に判定する（外部依存を持たず、検出器の正しさを
// CI で両方向に固定できるようにするため）。代わりに測るのは創作率の下限である。語彙の設計方針と既知の
// 限界は material-grounding-lexicon.json に書いてある。
//
// この関数は実 API を呼ばない。評価（eval/）から使う。検出器自身の正しさは
// test/material-grounding-detect.test.ts が検証する（実 API 不要・CI で常時実行）。

import { detectVisitContextClaims, readVisitContextLexicon, type VisitContextLexicon } from './visit-context';

/** 判定軸。eval のレポートはこの順で軸ごとに分けて出す。 */
export const GROUNDING_AXES = ['properNoun', 'number', 'dateTime'] as const;
export type GroundingAxis = (typeof GROUNDING_AXES)[number];

export interface GroundingClaim {
  readonly axis: GroundingAxis;
  /** 軸の中の分類（dateTime: relativeDay など・number: digits・properNoun: place / person / latin / dish） */
  readonly kind: string;
  /** 実際に本文へ現れた箇所（証拠として残す） */
  readonly matchedText: string;
}

/** 照合に使う素材。星評価と観点は固有名詞・数値・日付の出所にならないので持たない。 */
export interface GroundingSource {
  readonly storeName: string;
  readonly comment?: string;
}

interface NameRule {
  /** 捕捉グループ 1 が名前を取り出すパターン */
  readonly patterns: readonly RegExp[];
  /** 名前がこのいずれかで終わるなら一般名詞として数えない */
  readonly stop: readonly string[];
}

export interface GroundingLexicon {
  readonly dateTime: VisitContextLexicon;
  readonly properNoun: { readonly place: NameRule; readonly person: NameRule };
  readonly latinAllow: readonly string[];
  /** 料理・飲み物の語 → 素材に由来すると見なす手がかり（語そのものは常に手がかりに含む） */
  readonly dish: { readonly [term: string]: readonly string[] };
}

/**
 * 星の数を数値で読み上げたか（「評価は5点」「5段階中2」）。Issue #254 のレビューで eval に置いた軸で、
 * 数値の軸はこれに当たった箇所を除く（1 つの出力を 2 軸で二重に数えない）。eval から移したもので、
 * 文字列は移設前と同一である（既存の実測値と比較できるように保つ）。
 */
export const STAR_NARRATION = /評価は\s*[1-5１-５]|[1-5１-５]\s*段階|星\s*[1-5１-５]|★\s*[1-5１-５]|[1-5１-５]\s*点(?!心)|[1-5１-５]つ星/;

// 算用数字（桁区切りと小数を含む）と、証拠として残す直後の単位（ひらがな・句読点の手前まで 2 文字）。
const NUMBER = /(\d+(?:,\d{3})*(?:\.\d+)?)([^\s\d、。,.!?！？「」()（）ぁ-ん]{0,2})/g;
const LATIN = /[A-Za-z][A-Za-z'&-]*/g;

/**
 * 下書き本文から、素材に無い固有名詞・数値・日付を検出する。
 *
 * @param draft 生成された下書き本文
 * @param source 素材（店名と客の一言）。ここに現れる名前・数値・日付の事情は創作として数えない
 * @param lexicon 読み込み済みの語彙
 * @returns 検出した創作の一覧（軸・分類・本文の箇所が同じものは 1 件へ畳む）
 */
export function detectUngroundedClaims(
  draft: string,
  source: GroundingSource,
  lexicon: GroundingLexicon,
): GroundingClaim[] {
  const storeName = source.storeName.normalize('NFKC');
  const comment = source.comment?.normalize('NFKC');
  const sourceText = `${storeName}\n${comment ?? ''}`;
  const sourceLower = sourceText.toLowerCase();
  // 店名は素材そのもの。先に取り除く。数値・固有名詞は下で素材と照合するが、日付・時刻は一言の手がかり
  // でしか除外しないので、店名の中の日付の語（「クリスマス食堂」）はここで外さないと創作として数えてしまう。
  // 空白で置き換えるのは、前後の文字が繋がって別の語に化けないようにするため。
  // モデルは店名の空白を詰めて書くことがある（Issue #222 の実測で「定食屋 あおば」→「定食屋あおば」が 60 件中 4 件）
  // ので、詰めた形も取り除く。
  let text = draft.normalize('NFKC');
  for (const name of new Set([storeName, storeName.replace(/\s+/g, '')])) {
    if (name.trim() !== '') text = text.split(name).join(' ');
  }

  const claims: GroundingClaim[] = [];
  const seen = new Set<string>();
  const push = (axis: GroundingAxis, kind: string, matchedText: string) => {
    const key = `${axis}\u0000${kind}\u0000${matchedText}`;
    if (seen.has(key)) return;
    seen.add(key);
    claims.push({ axis, kind, matchedText });
  };

  // 日付・時刻: 分類ごとに一言の手がかりで除外する（意味論は visit-context と同じ）。
  for (const c of detectVisitContextClaims(text, comment, lexicon.dateTime)) push('dateTime', c.category, c.matchedText);

  // 数値: 値で照合する（一言「40分ほど」から下書き「40分」は拾わない・「1,000」と「1000」は同じ値）。
  const sourceNumbers = new Set([...sourceText.matchAll(NUMBER)].map((m) => numericValue(m[1]!)));
  // 星の読み上げ（別の軸）と、日付の軸のパターンに当たった範囲を伏せてから数える。伏せるのは実際に当たった
  // 範囲だけにする（「日」「時」の前の数字を一律に外すと、日付の軸が拾わない「3日間」がどこにも数えられない）。
  let numberText = text.replace(new RegExp(STAR_NARRATION.source, 'g'), ' ');
  for (const patterns of Object.values(lexicon.dateTime.patterns)) {
    for (const pattern of patterns) numberText = numberText.replace(new RegExp(pattern.source, 'g'), ' ');
  }
  for (const m of numberText.matchAll(NUMBER)) {
    if (sourceNumbers.has(numericValue(m[1]!))) continue;
    push('number', 'digits', m[0]);
  }

  // 駅名・商店街・人名: 名前が素材に含まれるか、一般名詞（stop）で終わるなら数えない。
  for (const [kind, rule] of Object.entries(lexicon.properNoun)) {
    for (const pattern of rule.patterns) {
      // 語彙の正規表現は g を持たない（状態を持ち越さない）。全件を拾うため、呼ぶたびに複製する。
      for (const m of text.matchAll(new RegExp(pattern.source, 'g'))) {
        const name = m[1] ?? '';
        if (rule.stop.some((s) => name.endsWith(s))) continue;
        if (sourceText.includes(name)) continue;
        push('properNoun', kind, m[0]);
      }
    }
  }

  // 英字の語: 素材に大小を無視して含まれなければ創作（一言の "good"・店名の "ONIBUS" は数えない）。
  const allow = new Set(lexicon.latinAllow.map((w) => w.toLowerCase()));
  for (const m of text.matchAll(LATIN)) {
    const word = m[0].toLowerCase();
    if (allow.has(word) || sourceLower.includes(word)) continue;
    push('properNoun', 'latin', m[0]);
  }

  // 料理・飲み物: 長い語から照合し、当たった箇所を伏せる（パンケーキの中のケーキを二重に数えない）。
  let dishText = text;
  const terms = Object.keys(lexicon.dish).sort((a, b) => b.length - a.length);
  for (const term of terms) {
    if (!dishText.includes(term)) continue;
    dishText = dishText.split(term).join(' ');
    const hints = [term, ...(lexicon.dish[term] ?? [])];
    if (hints.some((h) => sourceLower.includes(h.toLowerCase()))) continue;
    push('properNoun', 'dish', term);
  }

  return claims;
}

function numericValue(digits: string): string {
  return digits.replaceAll(',', '');
}

/** 語彙の JSON を読み込む。形式が不正なら止める（黙って空の語彙にしない）。 */
export function readGroundingLexicon(raw: unknown): GroundingLexicon {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('material-grounding lexicon が object ではありません');
  }
  const { dateTime, properNoun, latinAllow, dish } = raw as Record<string, unknown>;
  return {
    dateTime: readVisitContextLexicon(dateTime, 'material-grounding lexicon の dateTime'),
    properNoun: {
      place: readNameRule(properNoun, 'place'),
      person: readNameRule(properNoun, 'person'),
    },
    latinAllow: readStringList(latinAllow, 'latinAllow'),
    dish: readDish(dish),
  };
}

function readNameRule(properNoun: unknown, kind: 'place' | 'person'): NameRule {
  const rule = typeof properNoun === 'object' && properNoun !== null ? (properNoun as Record<string, unknown>)[kind] : undefined;
  if (typeof rule !== 'object' || rule === null) {
    throw new Error(`material-grounding lexicon の properNoun.${kind} がありません`);
  }
  const { patterns, stop } = rule as Record<string, unknown>;
  const sources = readStringList(patterns, `properNoun.${kind}.patterns`);
  if (sources.length === 0) throw new Error(`material-grounding lexicon の properNoun.${kind}.patterns が空です`);
  return {
    patterns: sources.map((s) => {
      const re = new RegExp(s);
      // 捕捉グループが無いと名前を取り出せず、素材との照合も stop も黙って効かなくなる。
      if (new RegExp(`${s}|`).exec('')!.length < 2) {
        throw new Error(`material-grounding lexicon の properNoun.${kind} のパターンに捕捉グループがありません: ${s}`);
      }
      return re;
    }),
    stop: readStringList(stop, `properNoun.${kind}.stop`),
  };
}

function readDish(value: unknown): Record<string, string[]> {
  if (typeof value !== 'object' || value === null || Object.keys(value).length === 0) {
    throw new Error('material-grounding lexicon の dish は 1 語以上の object である必要があります');
  }
  const out: Record<string, string[]> = {};
  for (const [term, hints] of Object.entries(value)) {
    if (term.length < 2) throw new Error(`material-grounding lexicon の dish の語は 2 文字以上である必要があります: ${term}`);
    out[term] = readStringList(hints, `dish.${term}`);
  }
  return out;
}

function readStringList(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || !value.every((s) => typeof s === 'string' && s.length > 0)) {
    throw new Error(`material-grounding lexicon の ${where} は空でない文字列の配列である必要があります`);
  }
  return value as string[];
}
