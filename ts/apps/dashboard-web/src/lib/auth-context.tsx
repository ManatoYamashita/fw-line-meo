'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  GoogleAuthProvider,
  getRedirectResult,
  onAuthStateChanged,
  signInWithRedirect,
  signOut as firebaseSignOut,
} from 'firebase/auth';
import { getFirebaseAuth } from './firebase';
import { notifyActionError, notifyActionSuccess } from './action-feedback';
import { getMe, type Me } from './api';

// ログイン状態の状態機械（design: dashboard-web AuthProvider の State 契約）。
//   loading      … 初期化・/me 解決中
//   signedOut    … 未認証（ログイン導線を出す）
//   unregistered … Google 認証は成功したが登録済み利用者でない／無効化済み（403）→ 案内のみ
//   ready        … 登録済み・有効。ロール別機能を提示可能
export type AuthStatus = 'loading' | 'signedOut' | 'unregistered' | 'ready';

export interface AuthContextValue {
  status: AuthStatus;
  me: Me | null;
  isSigningIn: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthErrorCopy {
  readonly title: string;
  readonly description: string;
}

// Firebase SDK の code/message は分類だけに使い、そのまま表示しない。
// IndexedDB の IO error など端末固有の内部情報を利用者へ露出させないためである。
function signInErrorCopy(error: unknown): AuthErrorCopy | null {
  const record = error !== null && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const code = typeof record.code === 'string' ? record.code : '';
  const detail = typeof record.message === 'string' ? record.message.toLowerCase() : '';

  if (code === 'auth/redirect-cancelled-by-user') return null;
  if (code === 'auth/network-request-failed') {
    return {
      title: 'ログインできませんでした',
      description: '通信状況を確認して、もう一度お試しください。',
    };
  }
  if (
    code === 'auth/web-storage-unsupported' ||
    detail.includes('indexeddb') ||
    detail.includes('unable to create writable file') ||
    detail.includes('quota') ||
    detail.includes('storage')
  ) {
    return {
      title: 'ログイン情報を保存できませんでした',
      description: '端末の空き容量を確認し、ブラウザを再起動してからもう一度お試しください。',
    };
  }
  return {
    title: 'ログインできませんでした',
    description: 'ブラウザを再起動するか、時間をおいてもう一度お試しください。',
  };
}

// ログインはリダイレクト方式で行う。押した後はページごと Google へ移り、戻ってきたときには
// 画面のメモリ（下の signInAttempt）が消えている。「利用者が押したログインの戻り」を、初回の
// セッション復元と区別するため、押したことをこのタブの sessionStorage に印として残す。
// 保存領域が使えない端末では印を残せないが、ログインそのものは通る（成功の通知が出ないだけ）。
const SIGN_IN_PENDING_KEY = 'fwlm-sign-in-pending';

function readSignInPending(): boolean {
  try {
    return window.sessionStorage.getItem(SIGN_IN_PENDING_KEY) === '1';
  } catch {
    return false;
  }
}

function markSignInPending(): void {
  try {
    window.sessionStorage.setItem(SIGN_IN_PENDING_KEY, '1');
  } catch {
    // swallowed-exception: intentional — 印を残せなくてもログインは進める（成功の通知が出ないだけ）。
  }
}

function clearSignInPending(): void {
  try {
    window.sessionStorage.removeItem(SIGN_IN_PENDING_KEY);
  } catch {
    // swallowed-exception: intentional — 消せない印は次の未ログイン判定で読み捨てられる。
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);

  // 未登録/無効による「意図的サインアウト」中フラグ。
  // firebaseSignOut は onAuthStateChanged を null で再発火させるため、そのコールバックが
  // status を 'signedOut' に上書きして案内（unregistered）を打ち消すのを防ぐ。
  const handlingUnregistered = useRef(false);
  // 初回のセッション復元と、利用者が押したログインを区別する。後者の完了時だけ成功を通知する。
  const signInAttempt = useRef(false);

  useEffect(() => {
    let active = true;
    // getAuth() はクライアント（useEffect）でのみ評価する（build 時プリレンダでは呼ばない）。
    const auth = getFirebaseAuth();

    // Google から戻ってきた直後なら、/me が確定するまで処理中の表示を続ける。
    if (readSignInPending()) {
      signInAttempt.current = true;
      setIsSigningIn(true);
    }
    // リダイレクト方式の失敗は、戻ってきた後にここで受け取る。成功した利用者は下の
    // onAuthStateChanged が受け取るので、ここでは失敗だけを扱う。
    getRedirectResult(auth).catch((error: unknown) => {
      if (!active) return;
      clearSignInPending();
      signInAttempt.current = false;
      setIsSigningIn(false);
      const copy = signInErrorCopy(error);
      if (copy !== null) notifyActionError(copy);
    });

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!active) return;

      if (!user) {
        if (handlingUnregistered.current) return; // 意図的サインアウト中は案内状態を維持
        // Google の画面から「戻る」で帰ってきた場合も、ここで処理中を解く。
        clearSignInPending();
        signInAttempt.current = false;
        setIsSigningIn(false);
        setMe(null);
        setStatus('signedOut');
        return;
      }

      // 認証済み: dashboard-api の GET /me で登録状態を確認する。
      handlingUnregistered.current = false;
      setStatus('loading');
      const result = await getMe({ getToken: () => user.getIdToken() });
      if (!active) return;

      if (result.ok) {
        setMe(result.value);
        setStatus('ready');
        setIsSigningIn(false);
        if (signInAttempt.current) {
          notifyActionSuccess({ title: 'ログインしました。' });
        }
        clearSignInPending();
        signInAttempt.current = false;
        return;
      }

      // 403(未登録/無効) 等は管理情報を一切描画しない。Firebase から即サインアウトする（Req 1.3）。
      handlingUnregistered.current = true;
      try {
        await firebaseSignOut(auth);
      } catch {
        // swallowed-exception: intentional — セッション破棄に失敗しても管理情報は描画せず、
        // 利用者向け案内へ進む。認証SDKの内部エラーは画面にも開発者向け出力にも露出させない。
      }
      if (!active) return;
      clearSignInPending();
      signInAttempt.current = false;
      setIsSigningIn(false);
      setMe(null);
      if (result.code === 'forbidden') {
        setStatus('unregistered');
        notifyActionError({
          title: 'このアカウントでは利用できません',
          description: 'ご利用をご希望の場合は、運営までお問い合わせください。',
        });
      } else {
        setStatus('signedOut');
        notifyActionError({
          title: 'ログインを完了できませんでした',
          description: '通信状況を確認し、時間をおいてもう一度お試しください。',
        });
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  // リダイレクト方式（同じタブで Google へ移り、戻ってくる）。
  //
  // 以前はポップアップ方式だった。リダイレクト方式は、authDomain が面と別ドメイン
  // （firebaseapp.com）だとブラウザのサードパーティストレージ分離で戻りを受け取れないため避けていた。
  // authDomain を dashboard.firstweb-works.com にし、/__/auth/ を dashboard-web が中継する構成へ
  // 移した（next.config.ts）ので、この制約は無くなった。ポップアップ方式は、ブラウザによっては
  // Google の画面を前に出さない新しいタブで開き、利用者はボタンが回り続ける理由に気づけなかった。
  const signIn = useCallback(async () => {
    if (signInAttempt.current) return;
    signInAttempt.current = true;
    setIsSigningIn(true);
    markSignInPending();
    try {
      await signInWithRedirect(getFirebaseAuth(), new GoogleAuthProvider());
      // 成功するとページごと Google へ移る。戻ってきた後は onAuthStateChanged が /me 解決へ進む。
    } catch (error) {
      clearSignInPending();
      signInAttempt.current = false;
      setIsSigningIn(false);
      const copy = signInErrorCopy(error);
      // 利用者自身が閉じた場合は失敗扱いにせず、元の状態へ静かに戻す。
      if (copy !== null) notifyActionError(copy);
    }
  }, []);

  const signOut = useCallback(async () => {
    handlingUnregistered.current = false;
    clearSignInPending();
    signInAttempt.current = false;
    setIsSigningIn(false);
    await firebaseSignOut(getFirebaseAuth());
    // onAuthStateChanged(null) でも 'signedOut' になるが、モック環境でも決定的に反映するため明示する（Req 1.4）。
    setMe(null);
    setStatus('signedOut');
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, me, isSigningIn, signIn, signOut }),
    [status, me, isSigningIn, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error('useAuth は AuthProvider の内側で使用してください。');
  }
  return ctx;
}
