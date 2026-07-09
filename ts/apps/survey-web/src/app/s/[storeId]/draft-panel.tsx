'use client';

import type { DraftPanelProps } from './types';

// 下書きパネル（葉コンポーネント）。実 UI は Task 4.5 で実装する最小プレースホルダ。
// シェル(4.3)が定義する DraftPanelProps 契約に従い、再生成/投稿の実行はシェルが所有する。
export function DraftPanel(props: DraftPanelProps): React.ReactElement {
  return <div data-testid="draft-panel">{props.draft}</div>;
}
