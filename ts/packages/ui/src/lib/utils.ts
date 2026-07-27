// クラス名結合ユーティリティ（shadcn 標準の cn）。
//
// タスク 2 では外部依存を持たない簡易実装だったが、タスク 6.1 で shadcn(base=Base UI) の
// コンポーネントをソース取込したため、それらが前提とする標準実装（clsx + tailwind-merge）へ
// 整合させた。clsx が条件分岐・配列・オブジェクト記法を正規化し、tailwind-merge が
// 後勝ちで競合する Tailwind ユーティリティ（例: 既定の px-2.5 と呼び出し側の px-4）を解決する。
// この 2 段構えが無いと、className による上書きが「両方のクラスが残って順序依存で決まる」
// 不安定な挙動になる。
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export type { ClassValue };

/** 複数の class 値を結合し、競合する Tailwind ユーティリティを後勝ちで解決した文字列を返す。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
