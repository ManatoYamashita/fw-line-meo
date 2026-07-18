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
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [me, setMe] = useState<Me | null>(null);

  // 未登録/無効による「意図的サインアウト」中フラグ。
  // firebaseSignOut は onAuthStateChanged を null で再発火させるため、そのコールバックが
  // status を 'signedOut' に上書きして案内（unregistered）を打ち消すのを防ぐ。
  const handlingUnregistered = useRef(false);

  useEffect(() => {
    let active = true;
    // getAuth() はクライアント（useEffect）でのみ評価する（build 時プリレンダでは呼ばない）。
    const auth = getFirebaseAuth();
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!active) return;

      if (!user) {
        if (handlingUnregistered.current) return; // 意図的サインアウト中は案内状態を維持
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
        return;
      }

      // 403(未登録/無効) 等は管理情報を一切描画しない。Firebase から即サインアウトする（Req 1.3）。
      handlingUnregistered.current = true;
      await firebaseSignOut(auth);
      if (!active) return;
      setMe(null);
      setStatus(result.code === 'forbidden' ? 'unregistered' : 'signedOut');
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  // ポップアップ方式のみ（redirect 方式は使わない: ブラウザのサードパーティストレージ分離問題）。
  const signIn = useCallback(async () => {
    await signInWithPopup(getFirebaseAuth(), new GoogleAuthProvider());
    // 成功後は onAuthStateChanged が発火し /me 解決へ進む。
  }, []);

  const signOut = useCallback(async () => {
    handlingUnregistered.current = false;
    await firebaseSignOut(getFirebaseAuth());
    // onAuthStateChanged(null) でも 'signedOut' になるが、モック環境でも決定的に反映するため明示する（Req 1.4）。
    setMe(null);
    setStatus('signedOut');
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, me, signIn, signOut }),
    [status, me, signIn, signOut],
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
