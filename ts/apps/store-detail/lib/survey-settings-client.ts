// 設定画面（app/store/survey-settings）から /api/survey-settings を呼ぶクライアント側の通信（Issue #437）。
//
// このファイルはクライアントバンドルに取り込まれる（ts/eslint.config.js の no-restricted-imports の対象）。
// 認可は Authorization ヘッダの LIFF ID トークンだけで、店舗は `?storeId=` のヒント（詳細画面と同じ）でしか
// 指さない。本文に storeId は入れない。

import type { StoreRef } from './contract';
import type { SurveySettingsResponse } from './survey-settings-contract';

export type SurveySettingsCallResult =
  | { readonly ok: true; readonly data: SurveySettingsResponse }
  /** 409 STORE_SELECTION_REQUIRED: 複数店舗のオーナーが店を選んでいない。 */
  | { readonly ok: false; readonly kind: 'select'; readonly stores: readonly StoreRef[] }
  | {
      readonly ok: false;
      readonly kind: 'error';
      readonly status: number;
      readonly code: string;
      readonly message: string;
      readonly supportCode?: string;
    };

const NETWORK_ERROR_MESSAGE = '通信に失敗しました。電波の良いところで、もう一度お試しください。';
const SERVER_ERROR_MESSAGE = 'サーバーエラーが発生しました。時間をおいて再度お試しください。';
const AUTH_ERROR_MESSAGE = '認証に失敗しました。LINE アプリからこの画面を開き直してください。';

function withHint(path: string, storeIdHint: string | null): string {
  return storeIdHint === null ? path : `${path}?storeId=${encodeURIComponent(storeIdHint)}`;
}

function readError(body: unknown): { code: string; message: string; supportCode?: string } | null {
  if (typeof body !== 'object' || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code !== 'string' || typeof message !== 'string') return null;
  const supportCode = (body as { supportCode?: unknown }).supportCode;
  return { code, message, ...(typeof supportCode === 'string' ? { supportCode } : {}) };
}

/** 設定 API を 1 回呼ぶ。通信の失敗も含め、例外を投げずに結果で返す。 */
export async function callSurveySettings(
  idToken: string,
  storeIdHint: string | null,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  path: string,
  body?: unknown,
): Promise<SurveySettingsCallResult> {
  let res: Response;
  try {
    res = await fetch(withHint(path, storeIdHint), {
      method,
      headers: {
        Authorization: `Bearer ${idToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return { ok: false, kind: 'error', status: 0, code: 'NETWORK', message: NETWORK_ERROR_MESSAGE };
  }

  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }

  if (res.ok) return { ok: true, data: parsed as SurveySettingsResponse };
  if (res.status === 409 && readError(parsed)?.code === 'STORE_SELECTION_REQUIRED') {
    return { ok: false, kind: 'select', stores: (parsed as { stores: readonly StoreRef[] }).stores };
  }
  const error = readError(parsed);
  if (res.status === 401) {
    return { ok: false, kind: 'error', status: 401, code: 'UNAUTHORIZED', message: AUTH_ERROR_MESSAGE };
  }
  if (error && res.status < 500) {
    return { ok: false, kind: 'error', status: res.status, ...error };
  }
  return {
    ok: false,
    kind: 'error',
    status: res.status,
    code: error?.code ?? 'INTERNAL',
    message: SERVER_ERROR_MESSAGE,
    ...(error?.supportCode ? { supportCode: error.supportCode } : {}),
  };
}
