// E2E 専用の LIFF スタブ（Issue #53）。
//
// 実ブラウザでは `liff.init` が必ず失敗する（LIFF SDK は LINE クライアント外／未宣言の
// エンドポイントを拒否し、ログイン状態が無ければ access.line.me へ遷移する）。そのため
// 店舗詳細は実ブラウザで一度も開けず、横スクロールの実測ができなかった。
//
// このモジュールは `next.config.ts` の `resolveAlias` により、**サーバー側 env
// `E2E_STUB_IDP=1` が立っているビルドでだけ** `@line/liff` の代わりに束ねられる。
// env が無ければ差し替えは起きず本物が使われる（fail-closed）。面のソースは 1 行も変えていない。
//
// 公開する 4 つは `app/store/page.tsx` の `resolveIdToken()` が呼ぶ全量である。

/** スタブが束ねられたことを実測するための印。`scripts/check-e2e-idp-stub-isolation.sh` が参照する。 */
export const E2E_LIFF_STUB_MARKER = 'e2e-liff-stub-9f3c2a';

const liff = {
  init: async (_config: { liffId: string }): Promise<void> => {},
  isLoggedIn: (): boolean => true,
  // 到達したら「ログイン状態を偽れていない」ということなので、黙って遷移させず落とす。
  login: (): void => {
    throw new Error('E2E スタブ: liff.login() へ到達した（ログイン状態の偽装が効いていない）');
  },
  getIDToken: (): string | null => E2E_LIFF_STUB_MARKER,
};

export default liff;
