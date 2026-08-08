// テストがレスポンス本文を読むための最小ヘルパ（Issue #70）。
//
// このリポジトリの tsconfig は DOM lib を持たず `types: ["node"]` のため、`Response.json()` の
// 戻り値は `any` ではなく `unknown` である。したがって `(await res.json()).error.code` は
// 型検査を通らない。テストが型検査の対象外だった間はこれが露見していなかった。
//
// 期待する形を呼び出し側で明示させることで、「そのエンドポイントが何を返すはずか」を
// テスト自身に書き残す。`any` は設計原則で禁止されているため使わない。

/** レスポンス本文を、テストが期待する形として読む。 */
export async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** src/http.ts が全エンドポイントで統一しているエラー封筒。 */
export interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}
