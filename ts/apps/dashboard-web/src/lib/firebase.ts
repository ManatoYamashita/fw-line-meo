import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';

// Firebase JS SDK（Google ログイン）のクライアント初期化。
//
// NEXT_PUBLIC_* はクライアントバンドルへ next build 時にインライン化される値であり、
// Cloud Run のランタイム env 注入では反映されない。したがって Dockerfile の build-arg
// （ARG + ENV・next build 前）で焼き込む前提で参照する（機械強制: scripts/check-next-public-buildargs.sh）。
// 参照する 4 変数のうち 3 つ（FIREBASE_*）を本ファイルが、残る API_BASE_URL を api.ts が参照する。
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
};

// Next.js は同一モジュールを複数回評価しうるため、getApps() で二重初期化を防ぐ。
function getFirebaseApp(): FirebaseApp {
  return getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
}

let authInstance: Auth | null = null;

// Auth インスタンス（signInWithPopup / onAuthStateChanged / signOut / getIdToken で使用）を遅延取得する。
// getAuth() はクライアント実行時（ログイン操作・useEffect）にのみ呼ぶ。build 時のサーバー
// プリレンダで getAuth() を評価すると、build-arg 未注入の空 apiKey で auth/invalid-api-key を投げて
// next build が失敗するため、モジュール評価時には呼ばない（PR #22 と同型の build-arg 問題を回避）。
// トークンは Firebase SDK が管理・自動更新する（localStorage への独自保存はしない）。
export function getFirebaseAuth(): Auth {
  if (authInstance === null) {
    authInstance = getAuth(getFirebaseApp());
  }
  return authInstance;
}
