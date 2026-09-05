// E2E 専用の Firebase Auth スタブ（Issue #53）。
//
// 実ブラウザでこの面を開くと 2 段で止まる。build-arg 未注入なら `getAuth()` が
// `auth/invalid-api-key` を投げて状態が `loading` から動かず、注入済みでも未ログインなら
// `onAuthStateChanged(null)` → `/login` へ送られ、唯一の操作が Google の実ポップアップを開く。
// どちらの経路でも管理データは 1 行も描画されず、横スクロールを測る対象が存在しない。
//
// このモジュールは `next.config.ts` の `resolveAlias` により、**サーバー側 env
// `E2E_STUB_IDP=1` が立っているビルドでだけ** `firebase/auth` の代わりに束ねられる。
// env が無ければ差し替えは起きず本物が使われる（fail-closed）。面のソースは 1 行も変えていない。
//
// 公開する 5 つは `src/lib/firebase.ts` と `src/lib/auth-context.tsx` が呼ぶ全量である。

/** スタブが束ねられたことを実測するための印。ID トークンとしてそのまま流す。 */
export const E2E_FIREBASE_AUTH_STUB_MARKER = 'e2e-firebase-auth-stub-4d7b13';

/** ログイン画面そのものを測れるようにするための切替口。既定はログイン済み。 */
const SIGNED_OUT_KEY = 'e2e-auth-signed-out';

interface StubUser {
  readonly uid: string;
  getIdToken(): Promise<string>;
}

interface StubAuth {
  currentUser: StubUser | null;
}

const stubUser: StubUser = {
  uid: 'e2e-operator',
  getIdToken: async () => E2E_FIREBASE_AUTH_STUB_MARKER,
};

function initiallySignedOut(): boolean {
  try {
    return globalThis.localStorage?.getItem(SIGNED_OUT_KEY) === '1';
  } catch {
    // 保存領域が使えない環境ではログイン済みを既定にする（判定不能を未ログインへ倒さない）。
    return false;
  }
}

const auth: StubAuth = { currentUser: initiallySignedOut() ? null : stubUser };
const listeners = new Set<(user: StubUser | null) => void>();

function notify(): void {
  for (const listener of listeners) listener(auth.currentUser);
}

export function getAuth(_app?: unknown): StubAuth {
  return auth;
}

export function onAuthStateChanged(
  _auth: StubAuth,
  callback: (user: StubUser | null) => void,
): () => void {
  listeners.add(callback);
  // 本物と同じく非同期で初回を流す（同期に流すと React の初期描画順が本番と変わる）。
  queueMicrotask(() => {
    if (listeners.has(callback)) callback(auth.currentUser);
  });
  return () => {
    listeners.delete(callback);
  };
}

export class GoogleAuthProvider {}

export async function signInWithPopup(_auth: StubAuth, _provider: GoogleAuthProvider): Promise<void> {
  auth.currentUser = stubUser;
  notify();
}

export async function signOut(_auth: StubAuth): Promise<void> {
  auth.currentUser = null;
  notify();
}
