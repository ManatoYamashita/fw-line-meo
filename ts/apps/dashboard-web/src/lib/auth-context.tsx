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
  onAuthStateChanged,
  signInWithPopup,
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

  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return null;
  if (code === 'auth/popup-blocked') {
    return {
      title: 'ログイン画面を開けませんでした',
      description: 'ブラウザでポップアップを許可して、もう一度お試しください。',
    };
  }
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
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!active) return;

      if (!user) {
        if (handlingUnregistered.current) return; // 意図的サインアウト中は案内状態を維持
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
        signInAttempt.current = false;
        return;
      }

      // 403(未登録/無効) 等は管理情報を一切描画しない。Firebase から即サインアウトする（Req 1.3）。
      handlingUnregistered.current = true;
      try {
        await firebaseSignOut(auth);
      } catch {
        // セッション破棄に失敗しても管理情報は描画せず、下の利用者向け案内へ進む。
      }
      if (!active) return;
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

  // ポップアップ方式のみ（redirect 方式は使わない: ブラウザのサードパーティストレージ分離問題）。
  const signIn = useCallback(async () => {
    if (signInAttempt.current) return;
    signInAttempt.current = true;
    setIsSigningIn(true);
    try {
      await signInWithPopup(getFirebaseAuth(), new GoogleAuthProvider());
      // 成功後は onAuthStateChanged が発火し /me 解決へ進む。/me が確定するまで処理中を保つ。
    } catch (error) {
      signInAttempt.current = false;
      setIsSigningIn(false);
      const copy = signInErrorCopy(error);
      // 利用者自身が閉じた場合は失敗扱いにせず、元の状態へ静かに戻す。
      if (copy !== null) notifyActionError(copy);
    }
  }, []);

  const signOut = useCallback(async () => {
    handlingUnregistered.current = false;
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
