import type { ResolvedStructuredAnswer } from '../structured-answer';

// structured survey の回答から下書きを作る口（Issue #438 で接続・Issue #439 で中身を実装した）。
//
// /api/responses の structured の分岐は、回答を検証し（validateStructuredAnswer）、回答時点の表示名へ解決した
// 素材（resolveStructuredAnswer・Target の名前は snapshot）をここへ渡す。/api/drafts の再生成も、sessionToken に
// 封入した同じ素材を渡す（店舗が後から名前を変えても、同じ回答の再生成で別の商品名にならない）。
//
// 本番の実装は Natural LLM Realizer（structured/realizer.ts）。legacy の生成器（prompt.ts・aspectLabels を前提にした
// 素材）へは structured の素材を押し込まない（Target 名や Target ごとの facet を legacy の観点として読み替えない）。

/** 生成器へ渡す素材。店名は表示用で、PII は含めない。 */
export interface StructuredDraftMaterial extends ResolvedStructuredAnswer {
  storeName: string;
}

export type StructuredDraftResult =
  /** 下書きを作らなかった（claim が無い＝星だけ・一言だけの回答）。客の画面は回答済み（Google の投稿導線）へ進む。 */
  | { readonly kind: 'unavailable' }
  /**
   * 下書き。source は通常 `llm`（hard gate を通った生成）で、2 回とも通らなかった・生成に失敗したときだけ
   * `fallback`（claim からの決定的なテンプレート）。attempts は LLM を呼んだ回数（1〜2）。
   */
  | { readonly kind: 'draft'; readonly draft: string; readonly source: 'llm' | 'fallback'; readonly attempts: number };

export interface StructuredDraftPort {
  prepare(material: StructuredDraftMaterial): Promise<StructuredDraftResult>;
}

/**
 * 下書きを作らない口（Stage 2 の暫定実装だったもの）。テストで「生成しない」場合を表すのに残す。本番では使わない。
 * 素材は記録しない（客が選んだ内容・一言の本文をログへ残さない）。
 */
export const pendingStructuredDraft: StructuredDraftPort = {
  prepare: () => Promise.resolve({ kind: 'unavailable' }),
};
