// クラス名結合ユーティリティ（design.md「@fwlm/ui — theme.css / components」の cn 相当）。
//
// shadcn 標準の cn は clsx + tailwind-merge に依存するが、本タスク（テーマ CSS と器の作成）では
// 外部依存の追加を最小限に留めるため、依存ゼロの最小実装とする。Tailwind の競合クラス解決
// （tailwind-merge）とオブジェクト/配列記法（clsx）への対応は、コンポーネントをベンダリングする
// タスク 6.1 で shadcn 標準へ整合させる方針。

/** cn の入力に許容する値（文字列と偽値のみ・偽値は結果から除外される）。 */
export type ClassValue = string | false | null | undefined;

/** 与えられた class 値のうち非空文字列のみを半角スペース区切りで結合する。 */
export function cn(...inputs: ClassValue[]): string {
  return inputs
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ');
}
