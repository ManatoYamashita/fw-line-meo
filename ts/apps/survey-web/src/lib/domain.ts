// survey-web の共有ドメイン型。SessionToken(3.2)・PromptBuilder(3.5)・DraftGenerator(3.6)・
// API(4.x) が同一定義を参照し、下書き生成の「素材」形状を単一化する（並列実装時の二重定義を防ぐ）。

export type Star = 1 | 2 | 3 | 4 | 5;

// AI 下書き生成の素材。客が選んだ事実のみを保持する（storeName は表示用・PII は含めない）。
export interface DraftMaterial {
  storeName: string;
  star: Star;
  aspectLabels: string[]; // 選択済み観点の label（seed 由来）
  comment?: string; // 一言（任意・≤200 字・デリミタ内でのみ使用）
  // 客が **選ばなかった** 観点の label（Issue #132）。プロンプトで明示的に禁止するために持つ。
  // 「素材に含まれる事実のみを書く」という抽象的な指示だけでは守られず、実測で未選択軸への
  // 言及が 63.9%（雰囲気に限れば 70.4%）発生していた。禁止対象を名指しするために必要になる。
  //
  // optional なのは、この項目を持たない旧 sessionToken が /api/drafts の再生成で復元され
  // うるため。その場合は禁止句が出ない＝従来の挙動へ安全に劣化する（生成が壊れることはない）。
  unselectedAspectLabels?: string[];
}
