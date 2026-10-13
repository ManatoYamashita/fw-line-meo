// アンケートページの共有型（合成シェル 4.3 が定義し、葉コンポーネント 4.4/4.5 が参照する契約）。

export interface AspectOption {
  code: string;
  label: string;
}

export interface SurveyAnswer {
  star: number;
  aspectCodes: string[]; // 良かった点
  concernCodes: string[]; // 気になった点（Issue #221）
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
  // 生成に成功するたびにシェルが進める番号。再生成が前と同じ文面を返しても、成功したなら編集内容を置き換える
  // （文面の比較だけだと、客が直した文章が残ったまま「別の口コミ文を作成しました」と通知してしまう）。
  draftRevision?: number;
  generationFailed: boolean;
  regenerationsLeft: number;
  googleReviewUrl: string;
  onRegenerate: () => void;
  // 投稿導線が押されたことをシェルへ知らせる（Issue #137・Requirement 5.8）。通知の送り方と載せる
  // token はシェルが決める。パネルはリンクの遷移を変えない。
  onReviewLinkOpen: () => void;
  regenerating: boolean;
}
