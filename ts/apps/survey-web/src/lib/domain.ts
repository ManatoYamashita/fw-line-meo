// survey-web の共有ドメイン型。SessionToken(3.2)・PromptBuilder(3.5)・DraftGenerator(3.6)・
// API(4.x) が同一定義を参照し、下書き生成の「素材」形状を単一化する（並列実装時の二重定義を防ぐ）。

export type Star = 1 | 2 | 3 | 4 | 5;

// AI 下書き生成の素材。客が選んだ事実のみを保持する（storeName は表示用・PII は含めない）。
export interface DraftMaterial {
  storeName: string;
  star: Star;
  aspectLabels: string[]; // 選択済み観点の label（seed 由来）
  comment?: string; // 一言（任意・≤200 字・デリミタ内でのみ使用）
}
