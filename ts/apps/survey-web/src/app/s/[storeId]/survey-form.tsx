'use client';

import type { SurveyFormProps } from './types';

// 回答フォーム（葉コンポーネント）。実 UI は Task 4.4 で実装する最小プレースホルダ。
// シェル(4.3)が定義する SurveyFormProps 契約に従い、API 呼出はシェルが所有する。
export function SurveyForm(props: SurveyFormProps): React.ReactElement {
  return <div data-testid="survey-form">選択肢 {props.aspects.length} 件</div>;
}
