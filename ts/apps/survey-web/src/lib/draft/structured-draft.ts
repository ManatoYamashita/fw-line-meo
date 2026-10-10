import type { ResolvedStructuredAnswer, UnselectedTarget } from '../structured-answer';

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
  /**
   * 回答の検証に使った同じ定義の active な Target のうち、客が選ばなかったもの（unselectedTargetsOf）。
   * **事後検証（未回答の Target の混入）だけが使い、LLM へは渡さない。** 店舗が公開しているメニュー名で、客の回答ではない。
   * Issue #439 の runtime / eval の揃えより前に発行した sessionToken には無い（無ければ照合しない）。
   */
  unselectedTargets?: UnselectedTarget[];
}

export type StructuredDraftResult =
  /** 下書きを作らなかった（claim が無い＝星だけ・一言だけの回答）。客の画面は回答済み（Google の投稿導線）へ進む。 */
  | { readonly kind: 'unavailable' }
  /**
   * 下書き。**必ず LLM の通常生成の文**（factuality の hard gate を通った文）。attempts は LLM を呼んだ回数（1〜3）。
   * 決定的な safe fallback の文はここに入れない（本番の応答では使わない）。
   */
  | { readonly kind: 'draft'; readonly draft: string; readonly source: 'llm'; readonly attempts: number }
  /**
   * 下書きを作れなかった（generation error）。最大回数まで factuality の違反・生成の失敗が続いた。客の画面は既存の
   * 「下書きの生成に失敗しました」（再試行と投稿導線）を出す。
   */
  | { readonly kind: 'failed'; readonly attempts: number };

/**
 * 下書きを作る口。初回の生成（/api/responses）も「別の文章を生成」（/api/drafts）も、同じ素材で同じ処理をもう一度
 * 実行するだけである（再生成のために構成を変える指示は足さない。前回の下書きは受け取らない）。
 */
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
