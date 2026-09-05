// 読み上げ領域から「実際に読み上げられる文字列」と「実際に見える文字列」を別々に取り出す
// テスト専用ヘルパー（ui-airbnb-surfaces task 4.2）。
//
// dashboard-web と store-detail の test/live-region.ts と同一の実装である。**面をまたぐコードを
// 作らない**という design.md「Architecture Pattern and Boundary Map」の方針に従い、共有パッケージへは
// 切り出さずに面ごとに置く（テスト専用モジュールであり、vitest の既定 include に載らないので
// 単体では実行されない）。共有すべきと判断するなら、それは本 spec ではなく部品層側の課題である。
//
// 処理中の表示は「文言を可視テキストのまま残し、回転する図形を aria-hidden の装飾として添える」
// 形で組む。この形が保たれていることは、textContent 1 本では確かめられない。
//
//  - announcedText: aria-hidden の部分木を **除いた** 文字列。支援技術が読み上げる内容そのもの。
//    共通部品の Spinner はラッパ自身に role="status" を持ち、内部に読み上げ用の文言 span を
//    抱えている。装飾として添えたのに aria-hidden を付け忘れると、読み上げ領域が 2 つになり、
//    この値も「読み込み中生成中…」のように二重になる。
//
//  - ownText: 要素の **直下のテキストノード** だけを繋いだ文字列。文言が sr-only の子要素へ
//    落ちていない（= 動き低減設定でなくても実ブラウザで見える）ことを、クラス名の有無ではなく
//    構造で確かめる。処理中の表示を `<Spinner aria-label="…" />` の 1 要素へ置き換えると、
//    文言は Spinner 内部の sr-only span へ移り、この値は空になる。
//    announcedText だけでは同じ値を返してしまい、この差し替えを緑のまま通す
//    （dashboard-web の task 2.2 / 2.5 で実測済み）。

/** 空白の連なりを 1 つに畳んで前後を落とす（DOM 上の改行・字下げを比較対象から外す）。 */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 支援技術へ読み上げられる文字列（aria-hidden の部分木を除く）。 */
export function announcedText(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  // React は aria-hidden の真偽値を文字列 "true" として描画する。
  Array.from(clone.querySelectorAll('[aria-hidden="true"]')).forEach((hidden) => {
    hidden.remove();
  });
  return normalize(clone.textContent ?? '');
}

/** 要素の直下のテキストノードだけを繋いだ文字列（子要素の中身を含まない）。 */
export function ownText(element: Element): string {
  return normalize(
    Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join(''),
  );
}
