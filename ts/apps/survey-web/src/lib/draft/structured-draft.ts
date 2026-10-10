import type { ResolvedStructuredAnswer } from '../structured-answer';

// structured survey の回答から下書きを作る口（Issue #438 で接続・Issue #439 で中身を実装する）。
//
// /api/responses の structured の分岐は、回答を検証し（validateStructuredAnswer）、回答時点の表示名へ解決した
// 素材（resolveStructuredAnswer）をここへ渡す。**下書きの生成そのものは Issue #439 の責務** で、
// 自然な文章へ組み立てる生成器（Natural LLM Realizer）がこの口を実装する。
//
// Stage 2（Issue #438）の時点の実装は pendingStructuredDraft だけで、**下書きを作らない**。legacy の生成器
// （prompt.ts・aspectLabels を前提にした素材）へ structured の素材を押し込まない。押し込むと、Target 名や
// Target ごとの facet を legacy の観点として読み替えることになり、Issue #435 の「別の evidence を互いへ読み替えない」
// 規律が崩れる。客の画面は、下書きの代わりに回答の受付と Google の投稿導線を出す（全評価で同一）。

/** 生成器へ渡す素材。店名は表示用で、PII は含めない。 */
export interface StructuredDraftMaterial extends ResolvedStructuredAnswer {
  storeName: string;
}

export type StructuredDraftResult =
  /** 下書きを作らなかった（Stage 2 の暫定・本番の最終生成ではない）。 */
  { readonly kind: 'unavailable' };

export interface StructuredDraftPort {
  prepare(material: StructuredDraftMaterial): Promise<StructuredDraftResult>;
}

/**
 * Stage 2 の暫定実装。素材を受け取るだけで、下書きは作らない（Issue #439 で置き換える）。
 * 素材は記録しない（客が選んだ内容・一言の本文をログへ残さない）。
 */
export const pendingStructuredDraft: StructuredDraftPort = {
  prepare: () => Promise.resolve({ kind: 'unavailable' }),
};
