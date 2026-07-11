// アンケートページの共有型（合成シェル 4.3 が定義し、葉コンポーネント 4.4/4.5 が参照する契約）。

export interface AspectOption {
  code: string;
  label: string;
}

export interface SurveyAnswer {
  star: number;
  aspectCodes: string[];
  comment?: string;
}

// 回答フォーム（葉・4.4）の props 契約。
export interface SurveyFormProps {
  aspects: AspectOption[];
  onSubmit: (answer: SurveyAnswer) => void;
  submitting: boolean;
}

// 下書きパネル（葉・4.5）の props 契約。API 呼出はシェルが所有し、パネルはコールバックのみ。
export interface DraftPanelProps {
  draft: string;
  generationFailed: boolean;
  regenerationsLeft: number;
  googleReviewUrl: string;
  onRegenerate: () => void;
  regenerating: boolean;
}
