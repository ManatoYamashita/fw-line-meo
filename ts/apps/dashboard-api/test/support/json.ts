// テストが応答本文を検証するための型付き読み出し（Issue #66）。
//
// Node の undici 型では `Response.json()` の戻り値が `unknown` である。検証側が本文の
// プロパティへ触るには「どの形を期待して読むか」を明示する必要があり、本モジュールは
// その入口を 1 箇所に集約する（`any` は使わない = eslint no-explicit-any の設計原則）。
// 既存の `.db.test.ts` が使う `(await res.json()) as { ... }` と等価な省略記法である。

/** エラー封筒。src/http.ts の jsonError が返す形と対応する。 */
export interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

/**
 * Response 本文を JSON として読み、期待する形として返す。
 * 型引数を省略した場合はエラー封筒（{ error: { code, message } }）として扱う。
 */
export async function readJson<T = ErrorBody>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
